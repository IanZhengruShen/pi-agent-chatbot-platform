/**
 * TaskQueueService: polls for pending tasks, spawns pi --mode rpc processes,
 * streams progress via SSE, and collects artifacts on completion.
 */

import { type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type { Database, TaskRow, TaskArtifactRow } from "../db/types.js";
import type { StorageService } from "./storage.js";
import { AgentExecutor } from "./agent-executor.js";
import { ArtifactCollector } from "./artifact-collector.js";
import { deliverResult } from "../scheduler/delivery.js";

export interface TaskProgressEvent {
	type: "progress" | "output" | "complete" | "task_error" | "cancelled";
	taskId: string;
	data: any;
}

const POLL_INTERVAL_MS = parseInt(process.env.TASK_QUEUE_POLL_INTERVAL_MS || "5000", 10);
const MAX_CONCURRENT = parseInt(process.env.TASK_QUEUE_MAX_CONCURRENT || "10", 10);
const EXECUTION_TIMEOUT_MS = parseInt(process.env.TASK_EXECUTION_TIMEOUT_MS || "1800000", 10); // 30 min
const PROGRESS_DB_DEBOUNCE_MS = 5000;

export class TaskQueueService {
	private activeExecutions = new Map<string, { process: ChildProcess; cleanup: () => Promise<void> }>();
	private subscribers = new Map<string, Set<(event: TaskProgressEvent) => void>>();
	private pollingTimer?: ReturnType<typeof setInterval>;
	private stopping = false;

	constructor(
		private db: Database,
		private storage: StorageService,
		private executor: AgentExecutor,
		private artifactCollector: ArtifactCollector,
	) {}

	async start(): Promise<void> {
		console.log(`[task-queue] Starting (poll: ${POLL_INTERVAL_MS}ms, max concurrent: ${MAX_CONCURRENT})`);

		// Recover stale tasks from previous crashes
		await this.recoverStaleTasks();

		// Start polling
		this.pollingTimer = setInterval(() => {
			this.pollAndRun().catch((err) => {
				console.error("[task-queue] Poll cycle failed:", err);
			});
		}, POLL_INTERVAL_MS);
		this.pollingTimer.unref();
	}

	async shutdown(): Promise<void> {
		console.log("[task-queue] Shutting down...");
		this.stopping = true;

		if (this.pollingTimer) {
			clearInterval(this.pollingTimer);
			this.pollingTimer = undefined;
		}

		// SIGTERM all active tasks
		for (const [taskId, { process: proc }] of this.activeExecutions) {
			console.log(`[task-queue] Terminating task ${taskId}`);
			try { proc.kill("SIGTERM"); } catch {}
		}

		// Wait for active executions to finish (with timeout)
		if (this.activeExecutions.size > 0) {
			console.log(`[task-queue] Waiting for ${this.activeExecutions.size} task(s)...`);
			await Promise.race([
				Promise.all(
					Array.from(this.activeExecutions.keys()).map(
						(id) => new Promise<void>((resolve) => {
							const entry = this.activeExecutions.get(id);
							if (!entry) return resolve();
							entry.process.on("exit", () => resolve());
							// Already sent SIGTERM above
						}),
					),
				),
				new Promise((resolve) => setTimeout(resolve, 10_000)),
			]);
		}

		console.log("[task-queue] Shutdown complete");
	}

	/**
	 * Subscribe to progress events for a task. Returns unsubscribe function.
	 */
	subscribe(taskId: string, cb: (event: TaskProgressEvent) => void): () => void {
		let subs = this.subscribers.get(taskId);
		if (!subs) {
			subs = new Set();
			this.subscribers.set(taskId, subs);
		}
		subs.add(cb);

		return () => {
			subs!.delete(cb);
			if (subs!.size === 0) {
				this.subscribers.delete(taskId);
			}
		};
	}

	/**
	 * Cancel a task (set cancel_requested, SIGTERM if running).
	 */
	async cancelTask(taskId: string, userId: string): Promise<boolean> {
		// Verify ownership
		const result = await this.db.query<TaskRow>(
			`SELECT id, user_id, status FROM tasks WHERE id = $1`,
			[taskId],
		);
		if (result.rows.length === 0) return false;
		const task = result.rows[0];
		if (task.user_id !== userId) return false;

		if (task.status === "pending") {
			// Not yet claimed — just mark cancelled
			await this.db.query(
				`UPDATE tasks SET status = 'cancelled', finished_at = now() WHERE id = $1 AND status = 'pending'`,
				[taskId],
			);
			this.emit(taskId, { type: "cancelled", taskId, data: {} });
			return true;
		}

		if (task.status === "claimed" || task.status === "running") {
			// Mark cancel_requested
			await this.db.query(
				`UPDATE tasks SET cancel_requested = true WHERE id = $1`,
				[taskId],
			);

			// SIGTERM if we have the process
			const active = this.activeExecutions.get(taskId);
			if (active) {
				try { active.process.kill("SIGTERM"); } catch {}
			}
			return true;
		}

		return false;
	}

	/** Get stats for healthcheck. */
	stats(): { active: number; pending?: number } {
		return { active: this.activeExecutions.size };
	}

	// ---------------------------------------------------------------------------
	// Internal
	// ---------------------------------------------------------------------------

	private async pollAndRun(): Promise<void> {
		if (this.stopping) return;
		const available = MAX_CONCURRENT - this.activeExecutions.size;
		if (available <= 0) return;

		for (let i = 0; i < available; i++) {
			const task = await this.claimNextTask();
			if (!task) break;
			// Fire and forget — errors handled internally
			this.runTask(task).catch((err) => {
				console.error(`[task-queue] Unexpected error in runTask ${task.id}:`, err);
			});
		}
	}

	private async claimNextTask(): Promise<TaskRow | null> {
		try {
			const result = await this.db.query<TaskRow>(
				`UPDATE tasks
				 SET status = 'claimed', claimed_at = now(), worker_pid = $1
				 WHERE id = (
				   SELECT id FROM tasks
				   WHERE status = 'pending'
				   ORDER BY created_at
				   LIMIT 1
				   FOR UPDATE SKIP LOCKED
				 )
				 RETURNING *`,
				[process.pid],
			);
			return result.rows[0] || null;
		} catch (err) {
			console.error("[task-queue] Failed to claim task:", err);
			return null;
		}
	}

	private async runTask(task: TaskRow): Promise<void> {
		let cwdPath: string | null = null;
		let spawnResult: Awaited<ReturnType<AgentExecutor["spawn"]>> | null = null;

		try {
			// Create a temp working directory for the task
			cwdPath = await fs.mkdtemp(path.join(os.tmpdir(), `pi-task-${task.id.slice(0, 8)}-`));

			// Spawn the process
			spawnResult = await this.executor.spawn({
				userId: task.user_id,
				teamId: task.team_id,
				provider: task.provider || undefined,
				model: task.model_id || undefined,
				fileIds: task.file_ids || undefined,
				cwd: cwdPath,
			});

			const child = spawnResult.process;

			// Track active execution
			this.activeExecutions.set(task.id, { process: child, cleanup: spawnResult.cleanup });

			// Update status to running
			await this.db.query(
				`UPDATE tasks SET status = 'running', started_at = now(), cwd_path = $1 WHERE id = $2`,
				[cwdPath, task.id],
			);

			this.emit(task.id, { type: "progress", taskId: task.id, data: { percent: 0, message: "Starting..." } });

			// Collect pre-execution file paths (to exclude from artifact collection)
			const preExistingFiles = new Set(spawnResult.filePaths);

			// Execute and collect output
			const result = await this.executeTask(child, task);

			// Check if cancelled
			const refreshed = await this.db.query<TaskRow>(`SELECT cancel_requested FROM tasks WHERE id = $1`, [task.id]);
			if (refreshed.rows[0]?.cancel_requested) {
				await this.db.query(
					`UPDATE tasks SET status = 'cancelled', finished_at = now() WHERE id = $1`,
					[task.id],
				);
				this.emit(task.id, { type: "cancelled", taskId: task.id, data: {} });
				return;
			}

			if (result.status === "success") {
				// Collect artifacts
				const artifacts = await this.artifactCollector.collect(task.id, cwdPath, preExistingFiles);

				// Truncate output if too large
				let output = result.output;
				if (output && output.length > 100_000) {
					output = output.substring(0, 100_000) + "\n\n[Output truncated]";
				}

				await this.db.query(
					`UPDATE tasks SET status = 'success', output = $1, usage = $2, finished_at = now() WHERE id = $3`,
					[output, JSON.stringify(result.usage), task.id],
				);

				this.emit(task.id, {
					type: "complete",
					taskId: task.id,
					data: { output, usage: result.usage, artifacts },
				});

				// Optional delivery
				if (task.delivery) {
					try {
						await deliverResult(
							task.delivery,
							`Task: ${task.prompt.slice(0, 50)}`,
							{ status: "success", output: output || undefined, usage: result.usage },
						);
					} catch (err) {
						console.error(`[task-queue] Delivery failed for task ${task.id}:`, err);
					}
				}
			} else {
				await this.db.query(
					`UPDATE tasks SET status = $1, error = $2, usage = $3, finished_at = now() WHERE id = $4`,
					[result.status, result.error, JSON.stringify(result.usage), task.id],
				);

				this.emit(task.id, {
					type: "task_error",
					taskId: task.id,
					data: { error: result.error, status: result.status },
				});
			}
		} catch (err: any) {
			console.error(`[task-queue] Task ${task.id} failed:`, err);
			await this.db.query(
				`UPDATE tasks SET status = 'failed', error = $1, finished_at = now() WHERE id = $2`,
				[err.message || String(err), task.id],
			).catch(() => {});

			this.emit(task.id, {
				type: "task_error",
				taskId: task.id,
				data: { error: err.message || String(err), status: "failed" },
			});
		} finally {
			this.activeExecutions.delete(task.id);
			// Kill the process if still running (it stays alive in RPC mode)
			if (spawnResult && !spawnResult.process.killed) {
				spawnResult.process.kill("SIGTERM");
			}
			if (spawnResult) {
				await spawnResult.cleanup();
			}
			// Clean up temp cwd after a delay (allow artifact downloads)
			if (cwdPath) {
				setTimeout(() => {
					fs.rm(cwdPath!, { recursive: true, force: true }).catch(() => {});
				}, 60_000);
			}
		}
	}

	private executeTask(
		child: ChildProcess,
		task: TaskRow,
	): Promise<{ status: "success" | "failed" | "timeout"; output?: string; error?: string; usage?: any }> {
		return new Promise((resolve) => {
			let output = "";
			let error = "";
			let usage: any = null;
			let timedOut = false;
			let resolved = false;
			let lastProgressWrite = 0;
			const toolCallNames = new Map<string, string>();

			const done = (result: { status: "success" | "failed" | "timeout"; output?: string; error?: string; usage?: any }) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timer);
				resolve(result);
			};

			const timer = setTimeout(() => {
				timedOut = true;
				try { child.kill("SIGTERM"); } catch {}
				done({ status: "timeout", error: "Task exceeded timeout" });
			}, EXECUTION_TIMEOUT_MS);

			// Read stdout (RPC JSON lines)
			if (child.stdout) {
				const rl = readline.createInterface({ input: child.stdout });
				rl.on("line", (line) => {
					try {
						const msg = JSON.parse(line);

						// Diagnostic logging — mirrors [rpc→ws] in agent-service.ts
						console.log(`[task-queue] [${task.id.slice(0, 8)}] rpc→ ${msg.type || "unknown"}`);

						// Collect streaming text and track tool call names from message_update
						if (msg.type === "message_update" && msg.message?.content) {
							let fullText = "";
							for (const block of msg.message.content) {
								if (block.type === "text") {
									fullText += block.text;
								} else if (block.type === "toolCall" && block.id && block.name) {
									toolCallNames.set(block.id, block.name);
								}
							}
							if (fullText && fullText !== output) {
								output = fullText;
								this.emit(task.id, {
									type: "output",
									taskId: task.id,
									data: { text: fullText },
								});
								// Progress: last non-empty line as snippet
								const lastLine = fullText.split("\n").filter(Boolean).pop() || "";
								const snippet = lastLine.length > 120 ? lastLine.slice(0, 120) + "..." : lastLine;
								const progressData = { message: snippet };
								this.emit(task.id, { type: "progress", taskId: task.id, data: progressData });

								const now = Date.now();
								if (now - lastProgressWrite >= PROGRESS_DB_DEBOUNCE_MS) {
									lastProgressWrite = now;
									this.db.query(
										`UPDATE tasks SET progress = $1 WHERE id = $2`,
										[JSON.stringify(progressData), task.id],
									).catch(() => {});
								}
							}
						}

						// Collect usage from message_end
						if (msg.type === "message_end" && msg.message?.role === "assistant" && msg.message.usage) {
							usage = msg.message.usage;
						}

						// Tool execution start — show tool name as progress
						if (msg.type === "tool_execution_start" && msg.toolCallId) {
							const toolName = toolCallNames.get(msg.toolCallId) || "tool";
							const progressData = { message: `Running ${toolName}...` };
							this.emit(task.id, { type: "progress", taskId: task.id, data: progressData });

							const now = Date.now();
							if (now - lastProgressWrite >= PROGRESS_DB_DEBOUNCE_MS) {
								lastProgressWrite = now;
								this.db.query(
									`UPDATE tasks SET progress = $1 WHERE id = $2`,
									[JSON.stringify(progressData), task.id],
								).catch(() => {});
							}
						}

						// agent_end signals task complete
						if (msg.type === "agent_end") {
							done({ status: "success", output: output || "Task completed successfully", usage });
						}

						// Error: prompt command failed (e.g. missing API key, invalid model)
						if (msg.type === "response" && msg.success === false) {
							done({ status: "failed", error: msg.error || "Prompt command rejected by agent" });
						}

						// Error: turn ended with an error message
						if (msg.type === "turn_end" && msg.message?.errorMessage) {
							error = msg.message.errorMessage;
						}

						// Auto-respond to extension_ui_request so the process doesn't hang
						if (msg.type === "extension_ui_request" && child.stdin) {
							const { id, method } = msg;
							console.log(`[task-queue] [${task.id.slice(0, 8)}] auto-responding to extension_ui_request: ${method}`);
							let response: any;
							if (method === "confirm") {
								response = { type: "extension_ui_response", id, confirmed: true };
							} else if (method === "select" && msg.options?.length > 0) {
								response = { type: "extension_ui_response", id, value: msg.options[0] };
							} else if (method === "input") {
								response = { type: "extension_ui_response", id, cancelled: true };
							} else {
								// notify, setStatus, setTitle — no response needed
								// For unknown methods, cancel to unblock
								response = { type: "extension_ui_response", id, cancelled: true };
							}
							if (response) {
								child.stdin.write(JSON.stringify(response) + "\n");
							}
						}
					} catch {
						// Non-JSON output
						console.log(`[task-queue] [${task.id.slice(0, 8)}] non-json stdout: ${line.slice(0, 200)}`);
					}
				});
			}

			// Read stderr
			if (child.stderr) {
				child.stderr.on("data", (data: Buffer) => {
					error += data.toString();
				});
			}

			// Handle process exit
			child.on("exit", (code) => {
				if (timedOut) return;
				if (code === 0) {
					done({ status: "success", output: output || "Task completed successfully", usage });
				} else {
					done({ status: "failed", error: error || `Process exited with code ${code}` });
				}
			});

			child.on("error", (err) => {
				done({ status: "failed", error: `Failed to spawn process: ${err.message}` });
			});

			// Send prompt using pi RPC protocol format
			if (child.stdin) {
				const message = JSON.stringify({
					type: "prompt",
					id: `task-${task.id}`,
					message: task.prompt,
				});
				child.stdin.write(message + "\n");
			}
		});
	}

	private emit(taskId: string, event: TaskProgressEvent): void {
		const subs = this.subscribers.get(taskId);
		if (subs) {
			for (const cb of subs) {
				try { cb(event); } catch {}
			}
		}
	}

	private async recoverStaleTasks(): Promise<void> {
		// Reset tasks that were claimed/running by a now-dead process
		const result = await this.db.query(
			`UPDATE tasks SET status = 'pending', claimed_at = NULL, worker_pid = NULL
			 WHERE status IN ('claimed', 'running') AND worker_pid IS NOT NULL AND worker_pid != $1
			 RETURNING id`,
			[process.pid],
		);

		if (result.rowCount && result.rowCount > 0) {
			console.log(`[task-queue] Recovered ${result.rowCount} stale task(s)`);
		}
	}
}
