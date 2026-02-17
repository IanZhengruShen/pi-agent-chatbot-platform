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

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import type { Database, ProviderKeyRow, ScheduledJobRow, UserFileRow } from "../db/types.js";
import type { CryptoService } from "../services/crypto.js";
import type { StorageService } from "../services/storage.js";
import { OAuthService } from "../services/oauth-service.js";
import { resolveSkillsForUser, type ResolvedSkills } from "../services/skill-resolver.js";

export interface JobExecutionResult {
	status: "success" | "failed" | "timeout";
	output?: string;
	error?: string;
	usage?: { input: number; output: number; cache_read?: number; cache_write?: number };
}

const PROVIDER_ENV_MAP: Record<string, string> = {
	anthropic: "ANTHROPIC_API_KEY",
	openai: "OPENAI_API_KEY",
	"azure-openai": "AZURE_OPENAI_API_KEY",
	google: "GEMINI_API_KEY",
	"google-gemini-cli": "GEMINI_API_KEY",
};

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
	let tempDir: string | null = null;
	let resolvedSkills: ResolvedSkills | null = null;
	let process: ChildProcess | null = null;

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

		// 2. Resolve skills for the user
		resolvedSkills = await resolveSkillsForUser(db, storage, user.id, user.team_id);

		// 3. Download user files to temp directory
		const filePaths: string[] = [];
		if (job.file_ids && job.file_ids.length > 0) {
			tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-job-files-"));

			const fileResult = await db.query<UserFileRow>(
				`SELECT id, filename, storage_key FROM user_files WHERE id = ANY($1)`,
				[job.file_ids],
			);

			for (const file of fileResult.rows) {
				const filePath = path.join(tempDir, file.filename);
				const data = await storage.download(file.storage_key);
				await fs.writeFile(filePath, data);
				filePaths.push(filePath);
			}
		}

		// 4. Build environment with provider keys
		const env = { ...process.env };

		// 4a. Inject team-level provider keys
		const keyResult = await db.query<ProviderKeyRow>(
			`SELECT provider, encrypted_dek, encrypted_key, iv, key_version FROM provider_keys WHERE team_id = $1`,
			[user.team_id],
		);

		for (const row of keyResult.rows) {
			try {
				const apiKey = crypto.decrypt({
					encryptedDek: row.encrypted_dek,
					encryptedData: row.encrypted_key,
					iv: row.iv,
					keyVersion: row.key_version,
				});

				const envVar = PROVIDER_ENV_MAP[row.provider] || `${row.provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
				env[envVar] = apiKey;
			} catch (err) {
				console.error(`[job-executor] Failed to decrypt key for provider ${row.provider}:`, err);
			}
		}

		// 4b. Inject OAuth credentials (overrides team keys)
		const oauthService = new OAuthService(db, crypto);
		const oauthProviderEnvMap: Record<string, string> = {
			anthropic: "ANTHROPIC_API_KEY",
			"openai-codex": "OPENAI_API_KEY",
			"github-copilot": "ANTHROPIC_API_KEY",
			"google-gemini-cli": "GEMINI_API_KEY",
			"google-antigravity": "GEMINI_API_KEY",
		};

		for (const [providerId, envVar] of Object.entries(oauthProviderEnvMap)) {
			try {
				const apiKey = await oauthService.getApiKey(providerId as any, { userId: user.id });
				if (apiKey) {
					env[envVar] = apiKey;
				}
			} catch {
				// No OAuth credentials for this provider - ignore
			}
		}

		// 5. Build command args
		const { command, args } = resolveCommand(job, resolvedSkills, filePaths);

		console.log(`[job-executor] Spawning job ${job.id}: ${command} ${args.join(" ")}`);

		// 6. Spawn process
		process = spawn(command, args, {
			cwd: process.cwd(),
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		// 7. Execute with timeout
		const result = await executeWithTimeout(process, job.prompt, JOB_EXECUTION_TIMEOUT_MS);

		return result;
	} catch (err: any) {
		console.error(`[job-executor] Job ${job.id} failed:`, err);
		return {
			status: "failed",
			error: err.message || String(err),
		};
	} finally {
		// Cleanup
		if (process && !process.killed) {
			await terminateProcess(process, 5000);
		}
		if (resolvedSkills) {
			resolvedSkills.cleanup();
		}
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
		}
	}
}

/**
 * Resolve the command and args for spawning pi --mode rpc.
 */
function resolveCommand(
	job: ScheduledJobRow,
	resolvedSkills: ResolvedSkills | null,
	filePaths: string[],
): { command: string; args: string[] } {
	let command: string;
	let commandArgs: string[];

	if (process.env.PI_CLI_PATH) {
		command = "node";
		commandArgs = [process.env.PI_CLI_PATH];
	} else {
		const candidates = [
			path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../coding-agent/dist/cli.js"),
			path.resolve(process.cwd(), "../coding-agent/dist/cli.js"),
			path.resolve(process.cwd(), "node_modules/@mariozechner/pi-coding-agent/dist/cli.js"),
		];

		const found = candidates.find((c) => existsSync(c));
		if (found) {
			command = "node";
			commandArgs = [found];
		} else {
			command = "pi";
			commandArgs = [];
		}
	}

	const args = [...commandArgs, "--mode", "rpc"];

	// Add provider and model if specified
	if (job.provider) args.push("--provider", job.provider);
	if (job.model_id) args.push("--model", job.model_id);

	// Add skills
	if (resolvedSkills) {
		for (const skillPath of resolvedSkills.skillPaths) {
			args.push("--skill", skillPath);
		}
	}

	// Add files
	for (const filePath of filePaths) {
		args.push("--file", filePath);
	}

	return { command, args };
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
