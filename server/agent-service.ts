/**
 * TenantBridge: tenant-aware agent bridge.
 *
 * Extends WsBridge to:
 * - Inject server-managed API keys from the database
 * - Use the ProcessPool for process lifecycle management
 * - Support WebSocket reconnection to existing processes
 * - Block client-side set_api_key (keys managed via REST)
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
	private resolvedSkills: ResolvedSkills | null = null;
	private resolvedFiles: ResolvedFiles | null = null;
	private resolvedMemory: ResolvedMemory | null = null;
	private memoryToken: string | null = null;
	private tempSystemPromptFile: string | null = null;
	private pendingMessages: string[] = [];
	private ready = false;

	constructor(ws: WebSocket, options: TenantBridgeOptions) {
		super(ws, options);
		this.user = options.user;
		this.sessionId = options.sessionId;
		this.processPool = options.processPool;
		this.crypto = options.crypto;
		this.db = options.db;
		this.storage = options.storage;
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
		]);

		Object.assign(this.extraEnv, envKeys);

		// Issue memory token for the extension to authenticate internal API calls
		this.memoryToken = issueMemoryToken(this.user.userId, this.user.teamId);

		// Audit log: record key decryption for each provider (non-blocking)
		for (const key of Object.keys(envKeys)) {
			this.db.query(
				`INSERT INTO provider_key_audit_log (team_id, user_id, provider, action)
				 VALUES ($1, $2, $3, 'decrypt')`,
				[this.user.teamId, this.user.userId, key],
			).catch(() => {});
		}

		// 5. Check for existing process (reconnection)
		const existingSessionId = this.sessionId;
		if (existingSessionId) {
			const existing = this.processPool.get(existingSessionId);
			if (existing) {
				console.log(`[tenant-bridge] Reattaching to existing process for session ${existingSessionId}`);
				this.process = existing.process;
				this.processPool.touch(existingSessionId);
				this.wireUpProcess();
				this.flushPendingMessages();
				return;
			}
		}

		// 3. Spawn new process via pool
		const sessionId = existingSessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		this.sessionId = sessionId;

		const info = this.processPool.acquire({
			sessionId,
			userId: this.user.userId,
			teamId: this.user.teamId,
			spawnFn: () => this.createProcess(),
		});

		this.process = info.process;
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
	 */
	private wireUpProcess(): void {
		if (!this.process) return;

		// Forward stderr to server console
		this.process.stderr?.on("data", (data: Buffer) => {
			console.error(`[rpc stderr] ${data.toString().trimEnd()}`);
		});

		// Set up line reader for stdout → WebSocket
		this.rl = readline.createInterface({
			input: this.process.stdout!,
			terminal: false,
		});

		this.rl.on("line", (line: string) => {
			if (this.closed) return;
			try {
				const parsed = JSON.parse(line);
				console.log(`[rpc→ws] ${parsed.type || "unknown"}${parsed.command ? ` (${parsed.command})` : ""}`);
				if (parsed.type === "message_end" && parsed.message?.stopReason === "error") {
					console.error(`[rpc→ws] ERROR: ${parsed.message?.errorMessage || JSON.stringify(parsed.message)}`);
				}
				this.ws.send(line);
			} catch {
				// Non-JSON output, ignore
			}
		});

		// Handle process exit
		this.process.on("exit", (code: number | null, signal: string | null) => {
			console.log(`[rpc] Process exited (code=${code}, signal=${signal})`);
		});

		this.process.on("error", (err: Error) => {
			console.error(`[rpc] Process error: ${err.message}`);
			if (!this.closed) {
				this.ws.close(1011, "RPC process error");
			}
		});

		console.log("[tenant-bridge] Process wired up");
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
			this.stop();
		});

		this.ws.on("error", (err) => {
			console.error("[tenant-bridge] WebSocket error:", err.message);
			this.stop();
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
	 * Override stop(): release the process back to the pool (starts idle timer)
	 * instead of killing it immediately.
	 */
	override stop(): void {
		if (this.closed) return;
		this.closed = true;

		// Detach readline but don't close stdin (process stays alive in pool)
		this.rl?.close();
		this.rl = null;

		// Release to pool — starts idle timer but keeps process alive
		if (this.sessionId) {
			this.processPool.release(this.sessionId);
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

		console.log("[tenant-bridge] Released process to pool");
	}
}
