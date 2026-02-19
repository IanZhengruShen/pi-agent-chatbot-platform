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


const JOB_EXECUTION_TIMEOUT_MS = parseInt(process.env.JOB_EXECUTION_TIMEOUT_MS || "300000", 10); // 5 minutes

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
	process: ChildProcess,
	prompt: string,
	timeoutMs: number,
): Promise<JobExecutionResult> {
	return new Promise((resolve) => {
		let output = "";
		let error = "";
		let usage: any = null;
		let timedOut = false;

		const timer = setTimeout(() => {
			timedOut = true;
			resolve({ status: "timeout", error: "Job execution exceeded 5 minute timeout" });
		}, timeoutMs);

		// Read stdout (RPC responses)
		if (process.stdout) {
			const rl = readline.createInterface({ input: process.stdout });
			rl.on("line", (line) => {
				try {
					const msg = JSON.parse(line);

					// Collect assistant output
					if (msg.type === "text" && msg.role === "assistant") {
						output += msg.text;
					}

					// Collect usage stats
					if (msg.type === "usage") {
						usage = msg.usage;
					}

					// Check for errors
					if (msg.type === "error") {
						error += msg.message || JSON.stringify(msg);
					}
				} catch {
					// Not JSON - might be debug output
					console.log(`[job-executor] stdout: ${line}`);
				}
			});
		}

		// Read stderr
		if (process.stderr) {
			process.stderr.on("data", (data) => {
				error += data.toString();
			});
		}

		// Handle process exit
		process.on("exit", (code) => {
			clearTimeout(timer);
			if (timedOut) return; // Already resolved

			if (code === 0) {
				resolve({
					status: "success",
					output: output || "Job completed successfully",
					usage,
				});
			} else {
				resolve({
					status: "failed",
					error: error || `Process exited with code ${code}`,
				});
			}
		});

		// Handle spawn errors
		process.on("error", (err) => {
			clearTimeout(timer);
			if (!timedOut) {
				resolve({ status: "failed", error: `Failed to spawn process: ${err.message}` });
			}
		});

		// Send the prompt via stdin
		if (process.stdin) {
			const message = JSON.stringify({
				type: "message",
				role: "user",
				content: prompt,
			});
			process.stdin.write(message + "\n");
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
