/**
 * Provider API key management routes.
 *
 * Admin-only CRUD for team provider keys with envelope encryption.
 * Keys are never returned in API responses — only provider name + status.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { getDatabase } from "../db/index.js";
import type { ProviderKeyRow } from "../db/types.js";
import { requireAuth } from "../auth/middleware.js";
import { requireRole } from "../auth/permissions.js";
import type { CryptoService } from "../services/crypto.js";
import { PROVIDER_ENV_MAP } from "../ws-bridge.js";
import { asyncRoute } from "../utils/async-handler.js";

const VALID_PROVIDERS = new Set(Object.keys(PROVIDER_ENV_MAP));

export function createProviderKeysRouter(crypto: CryptoService): Router {
	const router = Router();

	// All routes require admin role
	router.use(requireAuth, requireRole("admin"));

	// -----------------------------------------------------------------------
	// GET / — List configured providers (never returns actual keys)
	// -----------------------------------------------------------------------
	router.get("/", asyncRoute(async (req, res) => {
		const db = getDatabase();
		const result = await db.query<Pick<ProviderKeyRow, "provider" | "config" | "updated_at">>(
			`SELECT provider, config, updated_at FROM provider_keys WHERE team_id = $1 ORDER BY provider`,
			[req.user!.teamId],
		);

		const keys = result.rows.map((row) => ({
			provider: row.provider,
			hasKey: true,
			config: row.config,
			updatedAt: row.updated_at,
		}));

		res.json({ success: true, data: { keys } });
	}));

	// -----------------------------------------------------------------------
	// POST / — Create or update a provider key
	// -----------------------------------------------------------------------
	router.post("/", asyncRoute(async (req, res) => {
		const { provider, apiKey, config } = req.body;

		if (!provider || typeof provider !== "string") {
			res.status(400).json({ success: false, error: "provider is required" });
			return;
		}
		if (!apiKey || typeof apiKey !== "string") {
			res.status(400).json({ success: false, error: "apiKey is required" });
			return;
		}
		if (!VALID_PROVIDERS.has(provider)) {
			res.status(400).json({
				success: false,
				error: `Invalid provider. Valid providers: ${Array.from(VALID_PROVIDERS).join(", ")}`,
			});
			return;
		}

		// Validate config if provided
		let validatedConfig: Record<string, unknown> = {};
		if (config && typeof config === "object" && !Array.isArray(config)) {
			if (provider === "azure-openai") {
				const allowedFields = ["baseUrl", "resourceName", "apiVersion", "deploymentNameMap"];
				for (const [key, value] of Object.entries(config)) {
					if (!allowedFields.includes(key)) continue;
					if (value !== undefined && value !== null && value !== "" && typeof value !== "string") {
						res.status(400).json({ success: false, error: `config.${key} must be a string` });
						return;
					}
					if (value) validatedConfig[key] = value;
				}
				// Validate baseUrl is a valid URL
				if (validatedConfig.baseUrl) {
					try {
						new URL(validatedConfig.baseUrl as string);
					} catch {
						res.status(400).json({ success: false, error: "config.baseUrl must be a valid URL" });
						return;
					}
				}
			}
		}

		const envelope = crypto.encrypt(apiKey);
		const db = getDatabase();

		await db.query(
			`INSERT INTO provider_keys (team_id, provider, encrypted_dek, encrypted_key, iv, key_version, config)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)
			 ON CONFLICT (team_id, provider)
			 DO UPDATE SET encrypted_dek = $3, encrypted_key = $4, iv = $5,
			              key_version = $6, config = $7, updated_at = now()`,
			[
				req.user!.teamId,
				provider,
				envelope.encryptedDek,
				envelope.encryptedData,
				envelope.iv,
				envelope.keyVersion,
				JSON.stringify(validatedConfig),
			],
		);

		// Audit log
		await db.query(
			`INSERT INTO provider_key_audit_log (team_id, user_id, provider, action)
			 VALUES ($1, $2, $3, $4)`,
			[req.user!.teamId, req.user!.userId, provider, "create"],
		);

		res.status(201).json({ success: true, data: { provider } });
	}));

	// -----------------------------------------------------------------------
	// DELETE /:provider — Delete a provider key
	// -----------------------------------------------------------------------
	router.delete("/:provider", asyncRoute(async (req, res) => {
		const { provider } = req.params;

		const db = getDatabase();
		const result = await db.query(
			`DELETE FROM provider_keys WHERE team_id = $1 AND provider = $2`,
			[req.user!.teamId, provider],
		);

		if (result.rowCount === 0) {
			res.status(404).json({ success: false, error: "Provider key not found" });
			return;
		}

		// Audit log
		await db.query(
			`INSERT INTO provider_key_audit_log (team_id, user_id, provider, action)
			 VALUES ($1, $2, $3, $4)`,
			[req.user!.teamId, req.user!.userId, provider, "delete"],
		);

		res.json({ success: true });
	}));

	return router;
}
