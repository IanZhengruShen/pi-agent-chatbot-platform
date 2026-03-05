/**
 * TenantBridge: tenant-aware agent bridge.
 *
 * Extends WsBridge to:
 * - Inject server-managed API keys from the database
 * - Use the ProcessPool for process lifecycle management
 * - Support WebSocket reconnection to existing processes
 * - Block client-side set_api_key (keys managed via REST)
 * - Detach/reattach: sessions run in background when WS disconnects
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as readline from "node:readline";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { WebSocket } from "ws";
import { resolvePiCommand } from "./utils/resolve-command.js";
import type { CryptoService } from "./services/crypto.js";
import type { ProcessPool } from "./services/process-pool.js";
import type { StorageService } from "./services/storage.js";
import type { SessionStatusService } from "./services/session-status-service.js";
import type { OutputBufferService } from "./services/output-buffer.js";
import { resolveSkillsForUser, type ResolvedSkills } from "./services/skill-resolver.js";
import { resolveFilesForUser, type ResolvedFiles } from "./services/file-resolver.js";
import { resolveMemoryForUser, type ResolvedMemory } from "./services/memory-resolver.js";
import { issueMemoryToken, revokeMemoryToken } from "./auth/memory-tokens.js";
import { AgentExecutor } from "./services/agent-executor.js";
import type { Database } from "./db/types.js";
import { WsBridge, type BridgeOptions } from "./ws-bridge.js";

export interface AuthUser {
	userId: string;
	teamId: string;
	email: string;
	role: string;
}

export interface TenantBridgeOptions extends BridgeOptions {
	user: AuthUser;
	sessionId?: string;
	processPool: ProcessPool;
	crypto: CryptoService;
	db: Database;
	storage: StorageService;
	sessionStatusService: SessionStatusService;
	outputBufferService: OutputBufferService;
	/** Curated skill IDs from agent profile (undefined = all visible skills) */
	profileSkillIds?: string[];
	/** File IDs from agent profile to inject via --file args */
	profileFileIds?: string[];
	/** Agent profile ID for session metadata tracking */
	agentProfileId?: string;
}

export class TenantBridge extends WsBridge {
	private user: AuthUser;
	private sessionId: string | undefined;
	private processPool: ProcessPool;
	private crypto: CryptoService;
	private db: Database;
	private storage: StorageService;
	private sessionStatusService: SessionStatusService;
	private outputBufferService: OutputBufferService;
	private resolvedSkills: ResolvedSkills | null = null;
	private resolvedFiles: ResolvedFiles | null = null;
	private resolvedMemory: ResolvedMemory | null = null;
	private memoryToken: string | null = null;
	private tempSystemPromptFile: string | null = null;
	private pendingMessages: string[] = [];
	private ready = false;
	private conversationHistory: Array<{ role: string; content: any }> | null = null;
	private detached = false;

	constructor(ws: WebSocket, options: TenantBridgeOptions) {
		super(ws, options);
		this.user = options.user;
		this.sessionId = options.sessionId;
		this.processPool = options.processPool;
		this.crypto = options.crypto;
		this.db = options.db;
		this.storage = options.storage;
		this.sessionStatusService = options.sessionStatusService;
		this.outputBufferService = options.outputBufferService;
	}

	/**
	 * Override start(): register WebSocket handlers immediately (to capture
	 * early messages), then async-initialize keys + skills + process.
	 */
	override start(): void {
		// Register WS handlers eagerly so messages arriving during async
		// startup are buffered instead of lost.
		this.wireUpWebSocket();

		this.startAsync().catch((err) => {
			console.error("[tenant-bridge] Failed to start:", err);
			this.ws.close(1011, "Failed to initialize agent");
		});
	}

	private async startAsync(): Promise<void> {
		const opts = this.options as TenantBridgeOptions;

		// Check generating limit before proceeding
		const generatingCount = await this.sessionStatusService.getGeneratingCount(this.user.userId, this.db);
		if (generatingCount >= 3) {
			this.ws.close(4031, "Max 3 concurrent generating sessions");
			return;
		}

		// Run all async prep work in parallel — these are independent of each other
		const [envKeys] = await Promise.all([
			// 1. Fetch and inject provider keys + OAuth credentials
			new AgentExecutor({ db: this.db, crypto: this.crypto, storage: this.storage })
				.buildEnv(this.user.userId, this.user.teamId),

			// 2. Resolve skills for this user (filtered by profile if set)
			resolveSkillsForUser(
				this.db, this.storage, this.user.userId, this.user.teamId,
				opts.profileSkillIds,
			).then(skills => {
				this.resolvedSkills = skills;
				if (skills.skillPaths.length > 0) {
					console.log(`[tenant-bridge] Resolved ${skills.skillPaths.length} skill(s)`);
				}
			}).catch(err => {
				console.error("[tenant-bridge] Failed to resolve skills:", err);
			}),

			// 3. Resolve files from agent profile
			(opts.profileFileIds && opts.profileFileIds.length > 0
				? resolveFilesForUser(
					this.db, this.storage, this.user.userId,
					opts.profileFileIds,
				).then(files => {
					this.resolvedFiles = files;
					if (files.filePaths.length > 0) {
						console.log(`[tenant-bridge] Resolved ${files.filePaths.length} file(s)`);
					}
				}).catch(err => {
					console.error("[tenant-bridge] Failed to resolve files:", err);
				})
				: Promise.resolve()
			),

			// 4. Write system prompt to temp file if provided
			(this.options.systemPrompt
				? (async () => {
					const promptFile = path.join(os.tmpdir(), `pi-sysprompt-${randomUUID()}.md`);
					await fs.writeFile(promptFile, this.options.systemPrompt!);
					this.tempSystemPromptFile = promptFile;
				})()
				: this.options.appendSystemPrompt
					? (async () => {
						const promptFile = path.join(os.tmpdir(), `pi-appendprompt-${randomUUID()}.md`);
						await fs.writeFile(promptFile, this.options.appendSystemPrompt!);
						this.tempSystemPromptFile = promptFile;
					})()
					: Promise.resolve()
			),

			// 5. Resolve user memories for injection
			resolveMemoryForUser(this.db, this.user.userId)
				.then(memory => { this.resolvedMemory = memory; })
				.catch(err => {
					console.error("[tenant-bridge] Failed to resolve memories:", err);
				}),

			// 6. Fetch conversation history for existing sessions (scoped to user)
			(this.sessionId
				? this.db.query<{ role: string; content: any }>(
					`SELECT m.role, m.content FROM messages m
					 JOIN sessions s ON s.id = m.session_id
					 WHERE m.session_id = $1 AND s.user_id = $2
					 ORDER BY m.ordinal ASC LIMIT 200`,
					[this.sessionId, this.user.userId],
				).then(result => {
					if (result.rows.length > 0) {
						this.conversationHistory = result.rows;
						console.log(`[tenant-bridge] Fetched ${result.rows.length} history message(s) for session ${this.sessionId}`);
					}
				}).catch(err => {
					console.error("[tenant-bridge] Failed to fetch conversation history:", err);
				})
				: Promise.resolve()
			),
		]);

		Object.assign(this.extraEnv, envKeys);

		// Issue memory token for the extension to authenticate internal API calls
		this.memoryToken = issueMemoryToken(this.user.userId, this.user.teamId);

		// Audit log: batch INSERT all provider key decryptions (non-blocking)
		const providers = Object.keys(envKeys);
		if (providers.length > 0) {
			const values = providers.map((_, i) => `($1, $2, $${i + 3}, 'decrypt')`).join(", ");
			this.db.query(
				`INSERT INTO provider_key_audit_log (team_id, user_id, provider, action) VALUES ${values}`,
				[this.user.teamId, this.user.userId, ...providers],
			).catch(() => {});
		}

		// Inject conversation history into system prompt for session continuity
		if (this.conversationHistory && this.conversationHistory.length > 0) {
			const historyBlock = this.formatConversationHistory(this.conversationHistory);
			if (this.tempSystemPromptFile) {
				// Append to existing system prompt file
				const existing = await fs.readFile(this.tempSystemPromptFile, "utf-8");
				await fs.writeFile(this.tempSystemPromptFile, existing + "\n\n" + historyBlock);
			} else {
				// Create a new append-system-prompt file
				const promptFile = path.join(os.tmpdir(), `pi-history-${randomUUID()}.md`);
				await fs.writeFile(promptFile, historyBlock);
				this.tempSystemPromptFile = promptFile;
				// Mark that this is an append prompt (not a replacement)
				if (!this.options.systemPrompt) {
					this.options.appendSystemPrompt = historyBlock;
				}
			}
			console.log(`[tenant-bridge] Injected ${this.conversationHistory.length} history messages into system prompt`);
		}

		// Check for existing process (reconnection) — verify user ownership
		const existingSessionId = this.sessionId;
		if (existingSessionId) {
			const existing = this.processPool.get(existingSessionId);
			if (existing && existing.userId === this.user.userId) {
				console.log(`[tenant-bridge] Reattaching to existing process for session ${existingSessionId}`);
				this.process = existing.process;
				this.processPool.touch(existingSessionId);

				// Flush buffered output from detached period
				try {
					const bufferedLines = await this.outputBufferService.flushOrdered(existingSessionId);
					if (bufferedLines.length > 0) {
						console.log(`[tenant-bridge] Sending ${bufferedLines.length} buffered line(s) to client`);
						for (const line of bufferedLines) {
							try { this.ws.send(line); } catch {}
						}
					}
				} catch (err) {
					console.error("[tenant-bridge] Failed to flush output buffer:", err);
				}

				this.wireUpProcess();
				this.detached = false;
				this.flushPendingMessages();

				// Register owner for SSE fan-out
				this.sessionStatusService.registerOwner(existingSessionId, this.user.userId);

				return;
			} else if (existing) {
				console.warn(`[tenant-bridge] User ${this.user.userId} tried to reattach to process owned by ${existing.userId}`);
			}
		}

		// Spawn new process via pool
		const sessionId = existingSessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		this.sessionId = sessionId;

		const info = this.processPool.acquire({
			sessionId,
			userId: this.user.userId,
			teamId: this.user.teamId,
			spawnFn: () => this.createProcess(),
		});

		this.process = info.process;

		// Register owner for SSE fan-out and set initial status
		this.sessionStatusService.registerOwner(sessionId, this.user.userId);
		this.sessionStatusService.setStatus(sessionId, "idle", this.db);

		this.wireUpProcess();
		this.flushPendingMessages();
	}

	/**
	 * Mark bridge as ready and flush any messages buffered during async startup.
	 */
	private flushPendingMessages(): void {
		this.ready = true;
		if (this.pendingMessages.length > 0 && this.process?.stdin) {
			console.log(`[tenant-bridge] Flushing ${this.pendingMessages.length} buffered message(s)`);
			for (const msg of this.pendingMessages) {
				this.process.stdin.write(msg + "\n");
			}
			this.pendingMessages = [];
		}
	}

	/**
	 * Create the child process (used by processPool.acquire's spawnFn).
	 * Mirrors WsBridge.spawnProcess() logic but returns the ChildProcess
	 * without wiring up I/O (the pool manages lifecycle).
	 */
	private createProcess(): ChildProcess {
		const { command, commandArgs } = resolvePiCommand();
		const args = [...commandArgs, "--mode", "rpc"];
		if (this.options.provider) args.push("--provider", this.options.provider);
		if (this.options.model) args.push("--model", this.options.model);
		if (this.options.args) args.push(...this.options.args);

		// Inject system prompt from agent profile
		if (this.tempSystemPromptFile) {
			if (this.options.systemPrompt) {
				args.push("--system-prompt", this.tempSystemPromptFile);
			} else if (this.options.appendSystemPrompt) {
				args.push("--append-system-prompt", this.tempSystemPromptFile);
			}
		}

		// Inject resolved skill paths
		if (this.resolvedSkills) {
			for (const skillPath of this.resolvedSkills.skillPaths) {
				args.push("--skill", skillPath);
			}
		}

		// Inject resolved file paths
		if (this.resolvedFiles) {
			for (const filePath of this.resolvedFiles.filePaths) {
				args.push("--file", filePath);
			}
		}

		// Inject user memory file
		if (this.resolvedMemory?.filePath) {
			args.push("--file", this.resolvedMemory.filePath);
		}

		// Inject platform-wide extensions
		if (process.env.BRAVE_SEARCH_API_KEY) {
			const braveSearchExt = fileURLToPath(new URL("./extensions/brave-search.ts", import.meta.url));
			args.push("--extension", braveSearchExt);
		}

		// Inject agent memory extension
		if (this.memoryToken) {
			const memoryExt = fileURLToPath(new URL("./extensions/agent-memory.ts", import.meta.url));
			args.push("--extension", memoryExt);
		}

		// Inject push-to-viewer extension (always available)
		const pushToViewerExt = fileURLToPath(new URL("./extensions/push-to-viewer.ts", import.meta.url));
		args.push("--extension", pushToViewerExt);

		console.log(`[tenant-bridge] Spawning: ${command} ${args.join(" ")}`);

		return spawn(command, args, {
			cwd: this.options.cwd || process.cwd(),
			env: {
				...process.env,
				...this.extraEnv,
				...(this.memoryToken ? {
					CHATBOT_MEMORY_TOKEN: this.memoryToken,
					CHATBOT_SERVER_PORT: String(process.env.PORT || "3001"),
				} : {}),
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
	}

	/**
	 * Wire up process stdout/stderr to WebSocket (similar to parent's spawnProcess).
	 * Handles status tracking, detached buffering, and message persistence.
	 */
	private wireUpProcess(): void {
		if (!this.process) return;

		// Forward stderr to server console
		this.process.stderr?.on("data", (data: Buffer) => {
			console.error(`[rpc stderr] ${data.toString().trimEnd()}`);
		});

		// Close any existing readline before creating a new one
		this.rl?.close();

		// Set up line reader for stdout → WebSocket
		this.rl = readline.createInterface({
			input: this.process.stdout!,
			terminal: false,
		});

		this.rl.on("line", (line: string) => {
			// Status tracking: detect agent_start and turn_end events
			// Use fast string checks to avoid parsing every streaming token
			if (line.includes('"agent_start"')) {
				try {
					const parsed = JSON.parse(line);
					if (parsed.type === "agent_start" && this.sessionId) {
						this.processPool.markGenerating(this.sessionId);
						this.sessionStatusService.setStatus(this.sessionId, "generating", this.db);
					}
				} catch {}
			} else if (line.includes('"turn_end"')) {
				try {
					const parsed = JSON.parse(line);
					if (parsed.type === "turn_end" && this.sessionId) {
						this.processPool.markIdle(this.sessionId);
						this.sessionStatusService.setStatus(this.sessionId, "idle", this.db);
					}
				} catch {}
			}

			// Detached mode: buffer to DB instead of sending to WS
			if (this.detached) {
				if (this.sessionId) {
					this.outputBufferService.append(this.sessionId, line).catch(() => {});
				}

				// Persist message_end events to DB so they survive reconnection
				if (line.includes('"message_end"')) {
					this.persistDetachedMessage(line);
				}
				return;
			}

			// Normal mode: forward to WebSocket
			if (this.closed) return;
			try {
				if (process.env.LOG_LEVEL === "debug") {
					const parsed = JSON.parse(line);
					console.log(`[rpc→ws] ${parsed.type || "unknown"}${parsed.command ? ` (${parsed.command})` : ""}`);
				}
				// Always check for errors (fast indexOf check avoids parsing most lines)
				if (line.includes('"stopReason":"error"')) {
					try {
						const parsed = JSON.parse(line);
						if (parsed.type === "message_end" && parsed.message?.stopReason === "error") {
							console.error(`[rpc→ws] ERROR: ${parsed.message?.errorMessage || JSON.stringify(parsed.message)}`);
						}
					} catch { /* non-critical */ }
				}
				this.ws.send(line);
			} catch {
				// Non-JSON output or WS send error, ignore
			}
		});

		// Handle process exit
		this.process.on("exit", (code: number | null, signal: string | null) => {
			console.log(`[rpc] Process exited (code=${code}, signal=${signal})`);
		});

		this.process.on("error", (err: Error) => {
			console.error(`[rpc] Process error: ${err.message}`);
			if (!this.closed && !this.detached) {
				this.ws.close(1011, "RPC process error");
			}
		});

		console.log("[tenant-bridge] Process wired up");
	}

	/**
	 * Persist a message_end event to the database during detached mode.
	 * This ensures messages generated while the user is away are saved.
	 */
	private persistDetachedMessage(line: string): void {
		if (!this.sessionId) return;
		try {
			const parsed = JSON.parse(line);
			if (parsed.type !== "message_end" || !parsed.message) return;

			const msg = parsed.message;
			const role = msg.role || "assistant";
			const content = msg.content;
			if (!content) return;

			const contentJson = JSON.stringify(content);
			const usageJson = msg.usage ? JSON.stringify(msg.usage) : null;

			// Insert message into DB
			this.db.query(
				`INSERT INTO messages (id, session_id, ordinal, role, content, stop_reason, usage, created_at)
				 VALUES ($1, $2, (SELECT COALESCE(MAX(ordinal), -1) + 1 FROM messages WHERE session_id = $2),
				         $3, $4::jsonb, $5, $6::jsonb, NOW())`,
				[
					randomUUID(),
					this.sessionId,
					role,
					contentJson,
					msg.stopReason ?? null,
					usageJson,
				],
			).then(() => {
				// Update session message count
				this.db.query(
					`UPDATE sessions SET message_count = message_count + 1, last_modified = NOW() WHERE id = $1`,
					[this.sessionId],
				).catch(() => {});
			}).catch((err) => {
				console.error("[tenant-bridge] Failed to persist detached message:", err);
			});
		} catch {
			// Non-critical: if we can't parse or persist, the message is still in the output buffer
		}
	}

	/**
	 * Wire up WebSocket message/close/error handlers.
	 */
	private wireUpWebSocket(): void {
		this.ws.on("message", (data) => {
			if (this.closed) return;
			const message = data.toString();
			try {
				const parsed = JSON.parse(message);

				// Block client-side API key setting
				if (parsed.type === "bridge_set_api_key") {
					this.handleSetApiKey(parsed);
					return;
				}

				// Buffer messages until process is ready
				if (!this.ready || !this.process?.stdin) {
					this.pendingMessages.push(message);
					return;
				}

				// Forward to pi process stdin
				console.log(`[ws→rpc] ${parsed.type || "unknown"}${parsed.id ? ` (${parsed.id})` : ""}`);
				this.process.stdin.write(message + "\n");

				// Touch the process pool timer on activity
				if (this.sessionId) {
					this.processPool.touch(this.sessionId);
				}
			} catch {
				console.error("[tenant-bridge] Invalid JSON from WebSocket:", message);
			}
		});

		this.ws.on("close", () => {
			// If process is alive, detach instead of stopping
			if (this.sessionId && this.processPool.get(this.sessionId)) {
				this.detach();
			} else {
				this.stop();
			}
		});

		this.ws.on("error", (err) => {
			console.error("[tenant-bridge] WebSocket error:", err.message);
			if (this.sessionId && this.processPool.get(this.sessionId)) {
				this.detach();
			} else {
				this.stop();
			}
		});
	}

	/**
	 * Override handleSetApiKey: block it. Keys are managed via REST API.
	 */
	protected override handleSetApiKey(parsed: any): void {
		const { id } = parsed;
		this.ws.send(JSON.stringify({
			id,
			type: "bridge_response",
			command: "bridge_set_api_key",
			success: false,
			error: "API keys are managed by your team admin via the Provider Keys settings.",
		}));
	}

	/**
	 * Detach from WebSocket but keep process alive for background generation.
	 * Called when WS closes while process is still alive.
	 */
	private detach(): void {
		if (this.detached) return;
		this.detached = true;

		const processInfo = this.sessionId ? this.processPool.get(this.sessionId) : null;
		const isGenerating = processInfo?.generating ?? false;

		if (isGenerating) {
			// Process is actively generating — keep readline alive so output
			// flows into the detached handler (buffered to DB)
			console.log(`[tenant-bridge] Detaching (generating) — process stays alive for session ${this.sessionId}`);
		} else {
			// Process is idle — close readline and let pool's idle timer handle it
			this.rl?.close();
			this.rl = null;
			if (this.sessionId) {
				this.processPool.release(this.sessionId);
			}
			console.log(`[tenant-bridge] Detaching (idle) — released to pool for session ${this.sessionId}`);
		}

		// Do NOT clean up temp files — process still references them
		// Do NOT set closed = true — the rl handler needs to keep running for detached buffering
	}

	/**
	 * Format conversation history rows into a text block for the system prompt.
	 */
	private formatConversationHistory(rows: Array<{ role: string; content: any }>): string {
		const lines: string[] = ["## Previous Conversation", ""];
		for (const row of rows) {
			const label = row.role === "user" || row.role === "user-with-attachments" ? "User" : "Assistant";
			const text = this.extractTextFromContent(row.content);
			if (text) {
				lines.push(`${label}: ${text}`);
			}
		}
		return lines.join("\n");
	}

	/**
	 * Extract plain text from a message content field (string or JSONB array).
	 */
	private extractTextFromContent(content: any): string {
		if (typeof content === "string") return content.trim();
		if (Array.isArray(content)) {
			return content
				.filter((block: any) => block.type === "text")
				.map((block: any) => block.text || "")
				.join(" ")
				.trim();
		}
		return "";
	}

	/**
	 * Permanent shutdown: called when process dies or is explicitly stopped.
	 * Cleans up temp files and releases process.
	 */
	override stop(): void {
		if (this.closed) return;
		this.closed = true;

		// Detach readline
		this.rl?.close();
		this.rl = null;

		// Release to pool
		if (this.sessionId) {
			this.processPool.release(this.sessionId);
			this.sessionStatusService.setStatus(this.sessionId, "suspended", this.db);
		}

		// Clean up skill temp directories
		this.resolvedSkills?.cleanup();
		this.resolvedSkills = null;

		// Clean up file temp directories
		this.resolvedFiles?.cleanup();
		this.resolvedFiles = null;

		// Clean up memory temp file and revoke token
		this.resolvedMemory?.cleanup();
		this.resolvedMemory = null;
		revokeMemoryToken(this.memoryToken);
		this.memoryToken = null;

		// Clean up system prompt temp file
		if (this.tempSystemPromptFile) {
			fs.unlink(this.tempSystemPromptFile).catch(() => {});
			this.tempSystemPromptFile = null;
		}

		console.log("[tenant-bridge] Stopped and cleaned up");
	}
}
