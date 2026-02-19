/**
 * Job Executor: spawns pi --mode rpc processes for scheduled jobs.
 *
 * Responsibilities:
 * - Spawn pi --mode rpc child process with team/user context
 * - Inject provider keys (team-level and OAuth)
 * - Resolve and inject skills
 * - Download and inject user files
 * - Execute prompt with timeout
 * - Collect output and usage stats
 * - Graceful termination (SIGTERM → SIGKILL)
 */

import { type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import type { Database, ScheduledJobRow } from "../db/types.js";
import type { CryptoService } from "../services/crypto.js";
import type { StorageService } from "../services/storage.js";
import { AgentExecutor } from "../services/agent-executor.js";

export interface JobExecutionResult {
	status: "success" | "failed" | "timeout";
	output?: string;
	error?: string;
	usage?: { input: number; output: number; cache_read?: number; cache_write?: number };
}


const JOB_EXECUTION_TIMEOUT_MS = parseInt(process.env.JOB_EXECUTION_TIMEOUT_MS || "1800000", 10); // 30 minutes

/**
 * Execute a scheduled job by spawning a pi --mode rpc process.
 */
export async function executeJob(
	job: ScheduledJobRow,
	db: Database,
	storage: StorageService,
	crypto: CryptoService,
): Promise<JobExecutionResult> {
	const executor = new AgentExecutor({ db, crypto, storage });
	let spawnResult: Awaited<ReturnType<AgentExecutor["spawn"]>> | null = null;
	let childProcess: ChildProcess | null = null;

	try {
		// 1. Fetch the user who created the job (to determine team context)
		const userResult = await db.query<{ id: string; team_id: string; email: string }>(
			`SELECT id, team_id, email FROM users WHERE id = $1`,
			[job.created_by],
		);
		if (userResult.rows.length === 0) {
			return { status: "failed", error: "Job creator user not found" };
		}
		const user = userResult.rows[0];

		// 2. Spawn via AgentExecutor (resolves keys, skills, files)
		console.log(`[job-executor] Spawning job ${job.id}`);
		spawnResult = await executor.spawn({
			userId: user.id,
			teamId: user.team_id,
			provider: job.provider || undefined,
			model: job.model_id || undefined,
			fileIds: job.file_ids || undefined,
		});
		childProcess = spawnResult.process;

		// 3. Execute with timeout
		const result = await executeWithTimeout(childProcess, job.prompt, JOB_EXECUTION_TIMEOUT_MS);

		return result;
	} catch (err: any) {
		console.error(`[job-executor] Job ${job.id} failed:`, err);
		return {
			status: "failed",
			error: err.message || String(err),
		};
	} finally {
		if (childProcess && !childProcess.killed) {
			await terminateProcess(childProcess, 5000);
		}
		if (spawnResult) {
			await spawnResult.cleanup();
		}
	}
}

/**
 * Execute the prompt with timeout and collect output.
 */
async function executeWithTimeout(
	childProcess: ChildProcess,
	prompt: string,
	timeoutMs: number,
): Promise<JobExecutionResult> {
	return new Promise((resolve) => {
		let output = "";
		let error = "";
		let usage: any = null;
		let timedOut = false;
		let resolved = false;
		const toolCallNames = new Map<string, string>();

		const done = (result: JobExecutionResult) => {
			if (resolved) return;
			resolved = true;
			clearTimeout(timer);
			resolve(result);
		};

		const timer = setTimeout(() => {
			timedOut = true;
			done({ status: "timeout", error: "Job execution exceeded 5 minute timeout" });
		}, timeoutMs);

		// Read stdout (RPC responses)
		if (childProcess.stdout) {
			const rl = readline.createInterface({ input: childProcess.stdout });
			rl.on("line", (line) => {
				try {
					const msg = JSON.parse(line);

					// Diagnostic logging
					console.log(`[job-executor] rpc→ ${msg.type || "unknown"}`);

					// Collect streaming text and track tool call names
					if (msg.type === "message_update" && msg.message?.content) {
						let fullText = "";
						for (const block of msg.message.content) {
							if (block.type === "text") {
								fullText += block.text;
							} else if (block.type === "toolCall" && block.id && block.name) {
								toolCallNames.set(block.id, block.name);
							}
						}
						if (fullText) output = fullText;
					}

					// Collect usage from message_end
					if (msg.type === "message_end" && msg.message?.role === "assistant" && msg.message.usage) {
						usage = msg.message.usage;
					}

					// agent_end signals completion
					if (msg.type === "agent_end") {
						done({
							status: "success",
							output: output || "Job completed successfully",
							usage,
						});
					}

					// Error: prompt command failed (e.g. missing API key)
					if (msg.type === "response" && msg.success === false) {
						done({ status: "failed", error: msg.error || "Prompt command rejected by agent" });
					}

					// Error: turn ended with an error message
					if (msg.type === "turn_end" && msg.message?.errorMessage) {
						error = msg.message.errorMessage;
					}

					// Auto-respond to extension_ui_request so the process doesn't hang
					if (msg.type === "extension_ui_request" && childProcess.stdin) {
						const { id, method } = msg;
						console.log(`[job-executor] auto-responding to extension_ui_request: ${method}`);
						let response: any;
						if (method === "confirm") {
							response = { type: "extension_ui_response", id, confirmed: true };
						} else if (method === "select" && msg.options?.length > 0) {
							response = { type: "extension_ui_response", id, value: msg.options[0] };
						} else if (method === "input") {
							response = { type: "extension_ui_response", id, cancelled: true };
						} else {
							response = { type: "extension_ui_response", id, cancelled: true };
						}
						if (response) {
							childProcess.stdin.write(JSON.stringify(response) + "\n");
						}
					}
				} catch {
					// Not JSON - might be debug output
					console.log(`[job-executor] stdout: ${line}`);
				}
			});
		}

		// Read stderr
		if (childProcess.stderr) {
			childProcess.stderr.on("data", (data) => {
				error += data.toString();
			});
		}

		// Handle process exit
		childProcess.on("exit", (code) => {
			if (timedOut) return;
			if (code === 0) {
				done({
					status: "success",
					output: output || "Job completed successfully",
					usage,
				});
			} else {
				done({
					status: "failed",
					error: error || `Process exited with code ${code}`,
				});
			}
		});

		// Handle spawn errors
		childProcess.on("error", (err) => {
			done({ status: "failed", error: `Failed to spawn process: ${err.message}` });
		});

		// Send the prompt using pi RPC protocol format
		if (childProcess.stdin) {
			const message = JSON.stringify({
				type: "prompt",
				id: "job-prompt",
				message: prompt,
			});
			childProcess.stdin.write(message + "\n");
		}
	});
}

/**
 * Terminate a process gracefully: SIGTERM → grace period → SIGKILL.
 */
async function terminateProcess(process: ChildProcess, gracePeriodMs: number): Promise<void> {
	return new Promise((resolve) => {
		try {
			process.kill("SIGTERM");
		} catch {}

		const forceKillTimer = setTimeout(() => {
			try {
				process.kill("SIGKILL");
			} catch {}
		}, gracePeriodMs);

		process.on("exit", () => {
			clearTimeout(forceKillTimer);
			resolve();
		});
	});
}
