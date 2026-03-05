/**
 * Team member management routes (admin-only).
 *
 * CRUD for users within the admin's team.
 * Supports both adding existing users (by email) and creating new users.
 */

import { Router } from "express";
import bcrypt from "bcryptjs";
import { getDatabase } from "../db/index.js";
import { requireAuth } from "../auth/middleware.js";
import { requireRole } from "../auth/permissions.js";
import { validatePassword, ValidationError } from "../auth/local-auth.js";
import { asyncRoute } from "../utils/async-handler.js";

const SALT_ROUNDS = 12;
const VALID_ROLES = new Set(["admin", "member"]);

export function createTeamMembersRouter(): Router {
	const router = Router();

	// All routes require admin role
	router.use(requireAuth, requireRole("admin"));

	// -----------------------------------------------------------------------
	// GET / — List team members
	// -----------------------------------------------------------------------
	router.get("/", asyncRoute(async (req, res) => {
		const db = getDatabase();
		const result = await db.query(
			`SELECT id, email, display_name, role, created_at, last_login
			 FROM users WHERE team_id = $1 ORDER BY created_at`,
			[req.user!.teamId],
		);

		res.json({ success: true, data: { members: result.rows } });
	}));

	// -----------------------------------------------------------------------
	// GET /search?email=... — Search for existing users (for adding to team)
	// -----------------------------------------------------------------------
	router.get("/search", asyncRoute(async (req, res) => {
		const email = req.query.email as string;
		if (!email || typeof email !== "string" || email.length < 2) {
			res.status(400).json({ success: false, error: "email query parameter required (min 2 chars)" });
			return;
		}

		const db = getDatabase();
		const result = await db.query(
			`SELECT id, email, display_name, team_id FROM users
			 WHERE email ILIKE $1 AND team_id != $2
			 ORDER BY email LIMIT 10`,
			[`%${email}%`, req.user!.teamId],
		);

		res.json({ success: true, data: { users: result.rows } });
	}));

	// -----------------------------------------------------------------------
	// POST / — Add a member to the team
	//
	// Two modes:
	// 1. { userId } — Move an existing user into admin's team
	// 2. { email, password, displayName?, role? } — Create a new user in admin's team
	// -----------------------------------------------------------------------
	router.post("/", asyncRoute(async (req, res) => {
		const db = getDatabase();
		const { userId, email, password, displayName, role } = req.body;

		const memberRole = role || "member";
		if (!VALID_ROLES.has(memberRole)) {
			res.status(400).json({ success: false, error: "role must be 'admin' or 'member'" });
			return;
		}

		// Mode 1: Add existing user by ID
		if (userId) {
			const { rows: target } = await db.query(
				"SELECT id, email, team_id FROM users WHERE id = $1",
				[userId],
			);
			if (target.length === 0) {
				res.status(404).json({ success: false, error: "User not found" });
				return;
			}
			if (target[0].team_id === req.user!.teamId) {
				res.status(409).json({ success: false, error: "User is already in your team" });
				return;
			}

			await db.query(
				"UPDATE users SET team_id = $1, role = $2 WHERE id = $3",
				[req.user!.teamId, memberRole, userId],
			);

			const { rows } = await db.query(
				"SELECT id, email, display_name, role, created_at, last_login FROM users WHERE id = $1",
				[userId],
			);

			res.status(200).json({ success: true, data: { member: rows[0] } });
			return;
		}

		// Mode 2: Create new user
		if (!email || typeof email !== "string") {
			res.status(400).json({ success: false, error: "email is required" });
			return;
		}
		if (!password || typeof password !== "string") {
			res.status(400).json({ success: false, error: "password is required" });
			return;
		}

		try {
			validatePassword(password);
		} catch (err) {
			if (err instanceof ValidationError) {
				res.status(400).json({ success: false, error: err.message });
				return;
			}
			throw err;
		}

		// Check for existing user with this email
		const { rows: existing } = await db.query(
			"SELECT id FROM users WHERE email = $1",
			[email],
		);
		if (existing.length > 0) {
			res.status(409).json({ success: false, error: "A user with this email already exists. Use the search to add them instead." });
			return;
		}

		const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

		const { rows } = await db.query(
			`INSERT INTO users (team_id, email, password_hash, display_name, role)
			 VALUES ($1, $2, $3, $4, $5)
			 RETURNING id, email, display_name, role, created_at`,
			[req.user!.teamId, email, passwordHash, displayName || null, memberRole],
		);

		res.status(201).json({ success: true, data: { member: rows[0] } });
	}));

	// -----------------------------------------------------------------------
	// PATCH /:userId — Change a member's role
	// -----------------------------------------------------------------------
	router.patch("/:userId", asyncRoute(async (req, res) => {
		const { userId } = req.params;
		const { role } = req.body;

		if (!role || !VALID_ROLES.has(role)) {
			res.status(400).json({ success: false, error: "role must be 'admin' or 'member'" });
			return;
		}

		const db = getDatabase();

		// Verify target is in the same team
		const { rows: target } = await db.query(
			"SELECT id, role FROM users WHERE id = $1 AND team_id = $2",
			[userId, req.user!.teamId],
		);
		if (target.length === 0) {
			res.status(404).json({ success: false, error: "User not found in your team" });
			return;
		}

		// Guard: cannot demote the last admin
		if (target[0].role === "admin" && role !== "admin") {
			const { rows: admins } = await db.query(
				"SELECT id FROM users WHERE team_id = $1 AND role = 'admin'",
				[req.user!.teamId],
			);
			if (admins.length <= 1) {
				res.status(400).json({ success: false, error: "Cannot demote the last admin" });
				return;
			}
		}

		await db.query(
			"UPDATE users SET role = $1 WHERE id = $2",
			[role, userId],
		);

		res.json({ success: true });
	}));

	// -----------------------------------------------------------------------
	// DELETE /:userId — Remove a member from the team
	// -----------------------------------------------------------------------
	router.delete("/:userId", asyncRoute(async (req, res) => {
		const { userId } = req.params;

		// Cannot remove self
		if (userId === req.user!.userId) {
			res.status(400).json({ success: false, error: "Cannot remove yourself" });
			return;
		}

		const db = getDatabase();

		// Verify target is in the same team
		const result = await db.query(
			"DELETE FROM users WHERE id = $1 AND team_id = $2",
			[userId, req.user!.teamId],
		);

		if (result.rowCount === 0) {
			res.status(404).json({ success: false, error: "User not found in your team" });
			return;
		}

		res.json({ success: true });
	}));

	return router;
}
