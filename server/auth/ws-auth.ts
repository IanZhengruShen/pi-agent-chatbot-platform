import type { IncomingMessage } from "node:http";
import { verifyJwt } from "./local-auth.js";
import type { AuthUser } from "./types.js";

/**
 * Extracts and validates JWT from WebSocket upgrade request.
 * Looks for ?token=<jwt> query parameter.
 * Returns null if invalid/missing.
 */
export function authenticateWsUpgrade(req: IncomingMessage): AuthUser | null {
	const url = new URL(req.url || "/", "http://localhost");
	const token = url.searchParams.get("token");

	if (!token) return null;

	const payload = verifyJwt(token);
	if (!payload) return null;

	return {
		userId: payload.sub,
		teamId: payload.teamId,
		email: payload.email,
		role: payload.role,
	};
}
