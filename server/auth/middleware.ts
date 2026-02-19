import type { RequestHandler } from "express";
import { verifyJwt } from "./local-auth.js";

/**
 * Express middleware that validates JWT from Authorization: Bearer <token> header.
 * Populates req.user with AuthUser.
 * Returns 401 if missing or invalid.
 */
export const requireAuth: RequestHandler = (req, res, next) => {
	const header = req.headers.authorization;
	if (!header?.startsWith("Bearer ")) {
		res.status(401).json({ success: false, error: "Missing authorization token" });
		return;
	}

	const token = header.slice(7);
	const payload = verifyJwt(token);
	if (!payload) {
		res.status(401).json({ success: false, error: "Invalid or expired token" });
		return;
	}

	req.user = {
		userId: payload.sub,
		teamId: payload.teamId,
		email: payload.email,
		role: payload.role,
	};

	next();
};

/**
 * Like requireAuth, but also accepts JWT from ?token= query parameter.
 * Needed for SSE (EventSource can't set headers).
 */
export const requireAuthOrToken: RequestHandler = (req, res, next) => {
	// Try Authorization header first
	const header = req.headers.authorization;
	const token = header?.startsWith("Bearer ")
		? header.slice(7)
		: (req.query.token as string | undefined);

	if (!token) {
		res.status(401).json({ success: false, error: "Missing authorization token" });
		return;
	}

	const payload = verifyJwt(token);
	if (!payload) {
		res.status(401).json({ success: false, error: "Invalid or expired token" });
		return;
	}

	req.user = {
		userId: payload.sub,
		teamId: payload.teamId,
		email: payload.email,
		role: payload.role,
	};

	next();
};
