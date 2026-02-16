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
