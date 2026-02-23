/**
 * Session-scoped tokens for the agent memory extension.
 *
 * Simple in-memory Map: TenantBridge issues a token when spawning a process,
 * the extension uses it to authenticate internal API calls, and the token is
 * revoked when the session ends.
 */

import { randomUUID } from "node:crypto";

interface TokenEntry {
	userId: string;
	teamId: string;
	expiresAt: number;
}

const tokens = new Map<string, TokenEntry>();

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL_MS = 60_000; // 60 seconds

/** Periodic cleanup of expired tokens. */
const cleanupInterval = setInterval(() => {
	const now = Date.now();
	for (const [key, entry] of tokens) {
		if (entry.expiresAt <= now) {
			tokens.delete(key);
		}
	}
}, CLEANUP_INTERVAL_MS);
cleanupInterval.unref();

/** Issue a memory token for a session. */
export function issueMemoryToken(userId: string, teamId: string): string {
	const token = randomUUID();
	tokens.set(token, {
		userId,
		teamId,
		expiresAt: Date.now() + TOKEN_TTL_MS,
	});
	return token;
}

/** Validate a memory token. Returns user data if valid, null otherwise. */
export function validateMemoryToken(token: string): { userId: string; teamId: string } | null {
	if (!token) return null;
	const entry = tokens.get(token);
	if (!entry) return null;
	if (entry.expiresAt <= Date.now()) {
		tokens.delete(token);
		return null;
	}
	return { userId: entry.userId, teamId: entry.teamId };
}

/** Revoke a memory token (called when session ends). */
export function revokeMemoryToken(token: string | null): void {
	if (token) tokens.delete(token);
}
