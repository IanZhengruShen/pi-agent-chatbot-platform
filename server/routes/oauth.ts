/**
 * OAuth subscription management routes.
 *
 * Handles OAuth flow for subscription-based LLM providers (Anthropic Claude Pro, etc.)
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { requireAuth } from "../auth/middleware.js";
import { OAuthService } from "../services/oauth-service.js";
import type { CryptoService } from "../services/crypto.js";
import { getDatabase } from "../db/index.js";
import { generatePKCE } from "../utils/pkce.js";

// OAuth provider configurations
const OAUTH_PROVIDERS = {
	anthropic: {
		clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
		authorizeUrl: "https://claude.ai/oauth/authorize",
		tokenUrl: "https://console.anthropic.com/v1/oauth/token",
		redirectUri: "https://console.anthropic.com/oauth/code/callback",
		scopes: "org:create_api_key user:profile user:inference",
	},
	"openai-codex": {
		clientId: "chatgpt-oauth-cli",
		authorizeUrl: "https://auth.openai.com/oauth/authorize",
		tokenUrl: "https://auth.openai.com/oauth/token",
		redirectUri: "http://localhost:1455/auth/callback",
		scopes: "openai profile email offline_access",
	},
};

// Temporary storage for PKCE verifiers (in production, use Redis)
const pkceStorage = new Map<string, { verifier: string; userId: string; expiresAt: number }>();

// Clean up expired PKCE entries every 10 minutes
setInterval(() => {
	const now = Date.now();
	for (const [key, value] of pkceStorage.entries()) {
		if (value.expiresAt < now) {
			pkceStorage.delete(key);
		}
	}
}, 10 * 60 * 1000);

export function createOAuthRouter(crypto: CryptoService): Router {
	const router = Router();
	const db = getDatabase();
	const oauthService = new OAuthService(db, crypto);

	// All routes require authentication
	router.use(requireAuth);

	// -----------------------------------------------------------------------
	// POST /:provider/start — Start OAuth flow for any provider
	// -----------------------------------------------------------------------
	router.post("/:provider/start", async (req: Request, res: Response) => {
		try {
			const { provider } = req.params;
			const userId = req.user!.userId;

			// Validate provider
			if (!(provider in OAUTH_PROVIDERS)) {
				res.status(400).json({ success: false, error: "Unsupported provider" });
				return;
			}

			const config = OAUTH_PROVIDERS[provider as keyof typeof OAUTH_PROVIDERS];

			// Generate PKCE challenge
			const { verifier, challenge } = await generatePKCE();

			// Store verifier temporarily (expires in 10 minutes)
			const stateKey = `${provider}-${userId}-${Date.now()}`;
			pkceStorage.set(stateKey, {
				verifier,
				userId,
				expiresAt: Date.now() + 10 * 60 * 1000,
			});

			// Build authorization URL
			const authParams = new URLSearchParams({
				code: "true",
				client_id: config.clientId,
				response_type: "code",
				redirect_uri: config.redirectUri,
				scope: config.scopes,
				code_challenge: challenge,
				code_challenge_method: "S256",
				state: stateKey,
			});

			// Provider-specific parameters
			if (provider === "openai-codex") {
				authParams.set("codex_cli_simplified_flow", "true");
				authParams.set("id_token_add_organizations", "true");
				authParams.set("originator", "pi");
			}

			const authUrl = `${config.authorizeUrl}?${authParams.toString()}`;

			res.json({
				success: true,
				data: {
					authUrl,
					state: stateKey,
				},
			});
		} catch (err) {
			console.error(`[oauth] POST /:provider/start error:`, err);
			res.status(500).json({ success: false, error: "Failed to start OAuth flow" });
		}
	});

	// -----------------------------------------------------------------------
	// POST /:provider/callback — Handle OAuth callback with authorization code
	// -----------------------------------------------------------------------
	router.post("/:provider/callback", async (req: Request, res: Response) => {
		try {
			const { provider } = req.params;
			const { code, state } = req.body;
			const userId = req.user!.userId;

			// Validate provider
			if (!(provider in OAUTH_PROVIDERS)) {
				res.status(400).json({ success: false, error: "Unsupported provider" });
				return;
			}

			if (!code || typeof code !== "string") {
				res.status(400).json({ success: false, error: "code is required" });
				return;
			}
			if (!state || typeof state !== "string") {
				res.status(400).json({ success: false, error: "state is required" });
				return;
			}

			// Retrieve and validate PKCE verifier
			const pkceData = pkceStorage.get(state);
			if (!pkceData) {
				res.status(400).json({ success: false, error: "Invalid or expired state" });
				return;
			}
			if (pkceData.userId !== userId) {
				res.status(403).json({ success: false, error: "State does not match user" });
				return;
			}

			// Clean up PKCE storage
			pkceStorage.delete(state);

			const config = OAUTH_PROVIDERS[provider as keyof typeof OAUTH_PROVIDERS];

			// Exchange code for tokens
			const tokenResponse = await fetch(config.tokenUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					grant_type: "authorization_code",
					client_id: config.clientId,
					code: code,
					state: state,
					redirect_uri: config.redirectUri,
					code_verifier: pkceData.verifier,
				}),
			});

			if (!tokenResponse.ok) {
				const error = await tokenResponse.text();
				console.error(`[oauth] Token exchange failed for ${provider}:`, error);
				res.status(400).json({ success: false, error: "Token exchange failed" });
				return;
			}

			const tokenData = (await tokenResponse.json()) as {
				access_token: string;
				refresh_token: string;
				expires_in: number;
			};

			// Calculate expiry time (current time + expires_in seconds - 5 min buffer)
			const expiresAt = Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000;

			// Store credentials
			await oauthService.storeCredentials(
				provider as any,
				{
					refresh: tokenData.refresh_token,
					access: tokenData.access_token,
					expires: expiresAt,
				},
				{ userId },
			);

			res.json({
				success: true,
				data: {
					provider,
					expiresAt: new Date(expiresAt).toISOString(),
				},
			});
		} catch (err) {
			console.error(`[oauth] POST /:provider/callback error:`, err);
			res.status(500).json({ success: false, error: "Failed to complete OAuth flow" });
		}
	});

	// -----------------------------------------------------------------------
	// GET /:provider/status — Check if user has OAuth credentials for provider
	// -----------------------------------------------------------------------
	router.get("/:provider/status", async (req: Request, res: Response) => {
		try {
			const { provider } = req.params;
			const userId = req.user!.userId;

			const credentials = await oauthService.getCredentials(provider as any, { userId });

			if (!credentials) {
				res.json({
					success: true,
					data: {
						connected: false,
					},
				});
				return;
			}

			res.json({
				success: true,
				data: {
					connected: true,
					expiresAt: new Date(credentials.expires).toISOString(),
					expired: credentials.expires < Date.now(),
				},
			});
		} catch (err) {
			console.error(`[oauth] GET /:provider/status error:`, err);
			res.status(500).json({ success: false, error: "Failed to check OAuth status" });
		}
	});

	// -----------------------------------------------------------------------
	// DELETE /:provider — Disconnect OAuth for provider
	// -----------------------------------------------------------------------
	router.delete("/:provider", async (req: Request, res: Response) => {
		try {
			const { provider } = req.params;
			const userId = req.user!.userId;

			const deleted = await oauthService.deleteCredentials(provider as any, { userId });

			if (!deleted) {
				res.status(404).json({ success: false, error: "No OAuth credentials found" });
				return;
			}

			res.json({ success: true });
		} catch (err) {
			console.error(`[oauth] DELETE /:provider error:`, err);
			res.status(500).json({ success: false, error: "Failed to disconnect OAuth" });
		}
	});

	// -----------------------------------------------------------------------
	// GET / — List all OAuth connections for user
	// -----------------------------------------------------------------------
	router.get("/", async (req: Request, res: Response) => {
		try {
			const userId = req.user!.userId;

			const credentials = await oauthService.listCredentials({ userId });

			res.json({
				success: true,
				data: {
					credentials: credentials.map((cred) => ({
						provider: cred.provider,
						expiresAt: cred.expiresAt.toISOString(),
						expired: cred.expiresAt.getTime() < Date.now(),
						createdAt: cred.createdAt.toISOString(),
						updatedAt: cred.updatedAt.toISOString(),
					})),
				},
			});
		} catch (err) {
			console.error("[oauth] GET / error:", err);
			res.status(500).json({ success: false, error: "Failed to list OAuth credentials" });
		}
	});

	return router;
}
