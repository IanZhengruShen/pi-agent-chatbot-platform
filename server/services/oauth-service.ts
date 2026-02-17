/**
 * OAuth credential management service.
 *
 * Handles storage, retrieval, and automatic refresh of OAuth credentials
 * for subscription-based LLM providers (Anthropic Claude Pro, OpenAI Codex, etc.)
 */

import type { Pool } from "pg";
import type { CryptoService } from "./crypto.js";
import { getOAuthApiKey } from "@mariozechner/pi-ai";

export interface OAuthCredentials {
	refresh: string;
	access: string;
	expires: number; // Expiration timestamp in milliseconds
	[key: string]: unknown;
}

export interface StoredOAuthCredential {
	id: string;
	userId?: string;
	teamId?: string;
	provider: string;
	expiresAt: Date;
	createdAt: Date;
	updatedAt: Date;
}

interface OAuthCredentialRow {
	id: string;
	user_id?: string;
	team_id?: string;
	provider: string;
	encrypted_dek: Buffer;
	encrypted_refresh: Buffer;
	encrypted_access: Buffer;
	iv: Buffer;
	expires_at: Date;
	key_version: number;
	created_at: Date;
	updated_at: Date;
}

export type OAuthProviderId =
	| "anthropic"
	| "openai-codex"
	| "github-copilot"
	| "google-gemini-cli"
	| "google-antigravity";

export class OAuthService {
	constructor(
		private db: Pool,
		private crypto: CryptoService,
	) {}

	/**
	 * Store OAuth credentials for a user or team.
	 * Credentials are encrypted using envelope encryption.
	 */
	async storeCredentials(
		provider: OAuthProviderId,
		credentials: OAuthCredentials,
		options: { userId?: string; teamId?: string },
	): Promise<void> {
		if (!options.userId && !options.teamId) {
			throw new Error("Either userId or teamId must be provided");
		}
		if (options.userId && options.teamId) {
			throw new Error("Cannot specify both userId and teamId");
		}

		// Encrypt tokens
		const refreshEnvelope = this.crypto.encrypt(credentials.refresh);
		const accessEnvelope = this.crypto.encrypt(credentials.access);

		// Both tokens should use the same IV for the envelope
		const expiresAt = new Date(credentials.expires);

		const result = await this.db.query(
			`INSERT INTO oauth_credentials
			 (user_id, team_id, provider, encrypted_dek, encrypted_refresh, encrypted_access, iv, expires_at, key_version)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			 ON CONFLICT (user_id, provider) WHERE user_id IS NOT NULL
			 DO UPDATE SET
			   encrypted_dek = $4,
			   encrypted_refresh = $5,
			   encrypted_access = $6,
			   iv = $7,
			   expires_at = $8,
			   key_version = $9,
			   updated_at = now()
			 ON CONFLICT (team_id, provider) WHERE team_id IS NOT NULL
			 DO UPDATE SET
			   encrypted_dek = $4,
			   encrypted_refresh = $5,
			   encrypted_access = $6,
			   iv = $7,
			   expires_at = $8,
			   key_version = $9,
			   updated_at = now()
			 RETURNING id`,
			[
				options.userId || null,
				options.teamId || null,
				provider,
				refreshEnvelope.encryptedDek,
				refreshEnvelope.encryptedData,
				accessEnvelope.encryptedData,
				refreshEnvelope.iv,
				expiresAt,
				refreshEnvelope.keyVersion,
			],
		);

		// Audit log
		await this.db.query(
			`INSERT INTO oauth_audit_log (user_id, team_id, provider, action)
			 VALUES ($1, $2, $3, $4)`,
			[options.userId || null, options.teamId || null, provider, "store"],
		);

		console.log(`[oauth-service] Stored credentials for provider=${provider}, id=${result.rows[0].id}`);
	}

	/**
	 * Retrieve OAuth credentials for a user or team.
	 * Returns null if no credentials found.
	 */
	async getCredentials(
		provider: OAuthProviderId,
		options: { userId?: string; teamId?: string },
	): Promise<OAuthCredentials | null> {
		if (!options.userId && !options.teamId) {
			throw new Error("Either userId or teamId must be provided");
		}

		const result = await this.db.query<OAuthCredentialRow>(
			`SELECT * FROM oauth_credentials
			 WHERE provider = $1
			   AND (user_id = $2 OR team_id = $3)
			 LIMIT 1`,
			[provider, options.userId || null, options.teamId || null],
		);

		if (result.rows.length === 0) {
			return null;
		}

		const row = result.rows[0];

		// Decrypt tokens
		const refresh = this.crypto.decrypt({
			encryptedDek: row.encrypted_dek,
			encryptedData: row.encrypted_refresh,
			iv: row.iv,
			keyVersion: row.key_version,
		});

		const access = this.crypto.decrypt({
			encryptedDek: row.encrypted_dek,
			encryptedData: row.encrypted_access,
			iv: row.iv,
			keyVersion: row.key_version,
		});

		return {
			refresh,
			access,
			expires: row.expires_at.getTime(),
		};
	}

	/**
	 * Get an API key from OAuth credentials, automatically refreshing if needed.
	 * Returns null if no credentials found.
	 */
	async getApiKey(
		provider: OAuthProviderId,
		options: { userId?: string; teamId?: string },
	): Promise<string | null> {
		const credentials = await this.getCredentials(provider, options);
		if (!credentials) {
			return null;
		}

		// Use pi-ai's built-in refresh logic
		const result = await getOAuthApiKey(provider, credentials);
		if (!result) {
			console.error(`[oauth-service] Failed to get API key for provider=${provider}`);
			return null;
		}

		// If credentials were refreshed, store the new ones
		if (result.newCredentials) {
			await this.storeCredentials(provider, result.newCredentials, options);
		}

		return result.apiKey;
	}

	/**
	 * Delete OAuth credentials for a user or team.
	 */
	async deleteCredentials(
		provider: OAuthProviderId,
		options: { userId?: string; teamId?: string },
	): Promise<boolean> {
		if (!options.userId && !options.teamId) {
			throw new Error("Either userId or teamId must be provided");
		}

		const result = await this.db.query(
			`DELETE FROM oauth_credentials
			 WHERE provider = $1
			   AND (user_id = $2 OR team_id = $3)`,
			[provider, options.userId || null, options.teamId || null],
		);

		if (result.rowCount && result.rowCount > 0) {
			// Audit log
			await this.db.query(
				`INSERT INTO oauth_audit_log (user_id, team_id, provider, action)
				 VALUES ($1, $2, $3, $4)`,
				[options.userId || null, options.teamId || null, provider, "delete"],
			);
			return true;
		}

		return false;
	}

	/**
	 * List all OAuth credentials for a user or team.
	 * Returns only metadata, not the actual credentials.
	 */
	async listCredentials(options: {
		userId?: string;
		teamId?: string;
	}): Promise<StoredOAuthCredential[]> {
		if (!options.userId && !options.teamId) {
			throw new Error("Either userId or teamId must be provided");
		}

		const result = await this.db.query<OAuthCredentialRow>(
			`SELECT id, user_id, team_id, provider, expires_at, created_at, updated_at
			 FROM oauth_credentials
			 WHERE user_id = $1 OR team_id = $2
			 ORDER BY provider`,
			[options.userId || null, options.teamId || null],
		);

		return result.rows.map((row) => ({
			id: row.id,
			userId: row.user_id,
			teamId: row.team_id,
			provider: row.provider,
			expiresAt: row.expires_at,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		}));
	}
}
