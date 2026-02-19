/**
 * AgentExecutor: shared logic for spawning pi --mode rpc processes.
 *
 * Used by TenantBridge (chat), SchedulerWorker (cron jobs), and TaskQueueService
 * (background tasks). Consolidates provider key resolution, OAuth credential
 * injection, skill resolution, file download, and process spawning.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePiCommand } from "../utils/resolve-command.js";
import { PROVIDER_ENV_MAP, OAUTH_PROVIDER_ENV_MAP } from "../utils/provider-env-map.js";
import type { Database, ProviderKeyRow, UserFileRow } from "../db/types.js";
import type { CryptoService } from "./crypto.js";
import type { StorageService } from "./storage.js";
import { OAuthService } from "./oauth-service.js";
import { resolveSkillsForUser, type ResolvedSkills } from "./skill-resolver.js";

export interface SpawnOptions {
	userId: string;
	teamId: string;
	provider?: string;
	model?: string;
	skillIds?: string[];
	fileIds?: string[];
	cwd?: string;
	extraArgs?: string[];
	injectBraveSearch?: boolean;
}

export interface SpawnResult {
	process: ChildProcess;
	resolvedSkills: ResolvedSkills;
	tempFilesDir: string | null;
	filePaths: string[];
	cleanup: () => Promise<void>;
}

export class AgentExecutor {
	private db: Database;
	private crypto: CryptoService;
	private storage: StorageService;

	constructor(deps: { db: Database; crypto: CryptoService; storage: StorageService }) {
		this.db = deps.db;
		this.crypto = deps.crypto;
		this.storage = deps.storage;
	}

	/**
	 * Build environment variables with team provider keys + user OAuth overrides.
	 */
	async buildEnv(userId: string, teamId: string): Promise<Record<string, string>> {
		const env: Record<string, string> = {};

		// Team-level provider keys
		const keyResult = await this.db.query<ProviderKeyRow>(
			`SELECT provider, encrypted_dek, encrypted_key, iv, key_version FROM provider_keys WHERE team_id = $1`,
			[teamId],
		);

		for (const row of keyResult.rows) {
			try {
				const apiKey = this.crypto.decrypt({
					encryptedDek: row.encrypted_dek,
					encryptedData: row.encrypted_key,
					iv: row.iv,
					keyVersion: row.key_version,
				});
				const envVar = PROVIDER_ENV_MAP[row.provider] || `${row.provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
				env[envVar] = apiKey;
			} catch (err) {
				console.error(`[agent-executor] Failed to decrypt key for provider ${row.provider}:`, err);
			}
		}

		// OAuth credentials (override team keys)
		const oauthService = new OAuthService(this.db.pool, this.crypto);
		for (const [providerId, envVar] of Object.entries(OAUTH_PROVIDER_ENV_MAP)) {
			try {
				const apiKey = await oauthService.getApiKey(providerId as any, { userId });
				if (apiKey) {
					env[envVar] = apiKey;
				}
			} catch {
				// No OAuth credentials for this provider — ignore
			}
		}

		return env;
	}

	/**
	 * Download file_ids to targetDir, return absolute paths.
	 */
	async downloadFiles(fileIds: string[], targetDir: string): Promise<string[]> {
		const fileResult = await this.db.query<UserFileRow>(
			`SELECT id, filename, storage_key FROM user_files WHERE id = ANY($1)`,
			[fileIds],
		);

		const paths: string[] = [];
		for (const file of fileResult.rows) {
			const filePath = path.join(targetDir, file.filename);
			const data = await this.storage.download(file.storage_key);
			await fs.writeFile(filePath, data);
			paths.push(filePath);
		}
		return paths;
	}

	/**
	 * Full spawn: resolve keys + skills + files → spawn pi --mode rpc.
	 */
	async spawn(opts: SpawnOptions): Promise<SpawnResult> {
		// 1. Build environment
		const extraEnv = await this.buildEnv(opts.userId, opts.teamId);

		// 2. Resolve skills
		const resolvedSkills = await resolveSkillsForUser(
			this.db, this.storage, opts.userId, opts.teamId,
		);

		// 3. Download files if needed
		let tempFilesDir: string | null = null;
		const filePaths: string[] = [];
		if (opts.fileIds && opts.fileIds.length > 0) {
			tempFilesDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-task-files-"));
			const downloaded = await this.downloadFiles(opts.fileIds, tempFilesDir);
			filePaths.push(...downloaded);
		}

		// 4. Build command args
		const { command, commandArgs } = resolvePiCommand();
		const args = [...commandArgs, "--mode", "rpc"];
		if (opts.provider) args.push("--provider", opts.provider);
		if (opts.model) args.push("--model", opts.model);
		if (opts.extraArgs) args.push(...opts.extraArgs);

		for (const skillPath of resolvedSkills.skillPaths) {
			args.push("--skill", skillPath);
		}
		for (const filePath of filePaths) {
			args.push("--file", filePath);
		}

		// Inject Brave Search extension
		if (opts.injectBraveSearch !== false && process.env.BRAVE_SEARCH_API_KEY) {
			const braveSearchExt = fileURLToPath(new URL("../extensions/brave-search.ts", import.meta.url));
			args.push("--extension", braveSearchExt);
		}

		console.log(`[agent-executor] Spawning: ${command} ${args.join(" ")}`);

		// 5. Spawn
		const child = spawn(command, args, {
			cwd: opts.cwd || process.cwd(),
			env: { ...process.env, ...extraEnv },
			stdio: ["pipe", "pipe", "pipe"],
		});

		const cleanup = async () => {
			resolvedSkills.cleanup();
			if (tempFilesDir) {
				await fs.rm(tempFilesDir, { recursive: true, force: true }).catch(() => {});
			}
		};

		return { process: child, resolvedSkills, tempFilesDir, filePaths, cleanup };
	}
}
