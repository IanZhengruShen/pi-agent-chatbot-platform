import type { Request, RequestHandler } from "express";

/**
 * Returns middleware that checks req.user.role matches the required role.
 * Returns 403 if the user's role is insufficient.
 */
export function requireRole(role: "admin"): RequestHandler {
	return (req, res, next) => {
		if (!req.user) {
			res.status(401).json({ success: false, error: "Not authenticated" });
			return;
		}
		if (req.user.role !== role) {
			res.status(403).json({ success: false, error: "Insufficient permissions" });
			return;
		}
		next();
	};
}

/** Check if the authenticated user owns a resource by user ID. */
export function isOwner(req: Request, resourceUserId: string): boolean {
	return req.user?.userId === resourceUserId;
}

/** Check if a resource belongs to the same team as the authenticated user. */
export function isSameTeam(req: Request, resourceTeamId: string): boolean {
	return req.user?.teamId === resourceTeamId;
}
