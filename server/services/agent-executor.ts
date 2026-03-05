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
import { PROVIDER_ENV_MAP, OAUTH_PROVIDER_ENV_MAP, PROVIDER_CONFIG_ENV_MAP } from "../utils/provider-env-map.js";
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
			`SELECT provider, encrypted_dek, encrypted_key, iv, key_version, config FROM provider_keys WHERE team_id = $1`,
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

				// Inject provider-specific config as env vars
				const configMap = PROVIDER_CONFIG_ENV_MAP[row.provider];
				if (configMap && row.config) {
					for (const [field, envName] of Object.entries(configMap)) {
						let value = row.config[field];
						if (value === undefined || value === null || value === "") continue;

						// Azure base URL needs /openai/v1 suffix for the AzureOpenAI SDK
						if (field === "baseUrl" && row.provider === "azure-openai") {
							let url = String(value).replace(/\/+$/, "");
							if (!url.endsWith("/openai/v1")) {
								url += "/openai/v1";
							}
							value = url;
						}

						env[envName] = String(value);
					}
				}
			} catch (err) {
				console.error(`[agent-executor] Failed to decrypt key for provider ${row.provider}:`, err);
			}
		}

		// OAuth credentials (override team keys) — batch all providers in parallel
		const oauthService = new OAuthService(this.db.pool, this.crypto);
		const oauthEntries = Object.entries(OAUTH_PROVIDER_ENV_MAP);
		const oauthResults = await Promise.allSettled(
			oauthEntries.map(([providerId]) => oauthService.getApiKey(providerId as any, { userId })),
		);
		for (let i = 0; i < oauthEntries.length; i++) {
			const result = oauthResults[i];
			if (result.status === "fulfilled" && result.value) {
				env[oauthEntries[i][1]] = result.value;
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

		const paths = await Promise.all(
			fileResult.rows.map(async (file) => {
				const filePath = path.join(targetDir, file.filename);
				const data = await this.storage.download(file.storage_key);
				await fs.writeFile(filePath, data);
				return filePath;
			}),
		);
		return paths;
	}

	/**
	 * Full spawn: resolve keys + skills + files → spawn pi --mode rpc.
	 */
	async spawn(opts: SpawnOptions): Promise<SpawnResult> {
		// Run independent prep steps in parallel
		const [extraEnv, resolvedSkills, { tempFilesDir, filePaths }] = await Promise.all([
			// 1. Build environment
			this.buildEnv(opts.userId, opts.teamId),
			// 2. Resolve skills
			resolveSkillsForUser(this.db, this.storage, opts.userId, opts.teamId),
			// 3. Download files if needed
			(async () => {
				if (opts.fileIds && opts.fileIds.length > 0) {
					const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-task-files-"));
					const paths = await this.downloadFiles(opts.fileIds, dir);
					return { tempFilesDir: dir, filePaths: paths };
				}
				return { tempFilesDir: null as string | null, filePaths: [] as string[] };
			})(),
		]);

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
