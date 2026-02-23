/**
 * Agent memory management routes.
 *
 * CRUD for persistent user memories that are injected into agent sessions.
 * Also provides internal endpoints for the agent memory extension.
 */

import { Router } from "express";
import { getDatabase } from "../db/index.js";
import type { AgentMemoryRow } from "../db/types.js";
import { requireAuth } from "../auth/middleware.js";
import { asyncRoute } from "../utils/async-handler.js";
import { validateMemoryToken } from "../auth/memory-tokens.js";

const MAX_CONTENT_SIZE = 10 * 1024; // 10KB
const VALID_CATEGORIES = ["preference", "fact", "instruction", "general"];

export function createMemoryRouter(): Router {
	const router = Router();

	// -----------------------------------------------------------------------
	// Public endpoints (browser-facing, JWT auth)
	// -----------------------------------------------------------------------

	// GET / — List memories (with optional search, category filter, pagination)
	router.get("/", requireAuth, asyncRoute(async (req, res) => {
		const db = getDatabase();
		const userId = req.user!.userId;
		const q = req.query.q as string | undefined;
		const category = req.query.category as string | undefined;
		const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
		const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

		let query: string;
		const params: any[] = [userId];

		if (q) {
			query = `SELECT * FROM agent_memories
				WHERE user_id = $1 AND search_vector @@ plainto_tsquery('english', $2)
				${category ? "AND category = $3" : ""}
				ORDER BY pinned DESC, ts_rank(search_vector, plainto_tsquery('english', $2)) DESC, updated_at DESC
				LIMIT $${category ? 4 : 3} OFFSET $${category ? 5 : 4}`;
			params.push(q);
			if (category) params.push(category);
			params.push(limit, offset);
		} else {
			query = `SELECT * FROM agent_memories
				WHERE user_id = $1
				${category ? "AND category = $2" : ""}
				ORDER BY pinned DESC, updated_at DESC
				LIMIT $${category ? 3 : 2} OFFSET $${category ? 4 : 3}`;
			if (category) params.push(category);
			params.push(limit, offset);
		}

		const result = await db.query<AgentMemoryRow>(query, params);

		// Get total count for pagination
		let countQuery: string;
		const countParams: any[] = [userId];
		if (q) {
			countQuery = `SELECT count(*)::int as total FROM agent_memories
				WHERE user_id = $1 AND search_vector @@ plainto_tsquery('english', $2)
				${category ? "AND category = $3" : ""}`;
			countParams.push(q);
			if (category) countParams.push(category);
		} else {
			countQuery = `SELECT count(*)::int as total FROM agent_memories
				WHERE user_id = $1 ${category ? "AND category = $2" : ""}`;
			if (category) countParams.push(category);
		}

		const countResult = await db.query<{ total: number }>(countQuery, countParams);

		res.json({
			success: true,
			data: {
				memories: result.rows,
				total: countResult.rows[0]?.total || 0,
			},
		});
	}));

	// POST / — Create a memory
	router.post("/", requireAuth, asyncRoute(async (req, res) => {
		const db = getDatabase();
		const userId = req.user!.userId;
		const { content, category, pinned } = req.body;

		if (!content || typeof content !== "string" || content.trim().length === 0) {
			res.status(400).json({ success: false, error: "content is required" });
			return;
		}
		if (content.length > MAX_CONTENT_SIZE) {
			res.status(400).json({ success: false, error: `content must be under ${MAX_CONTENT_SIZE / 1024}KB` });
			return;
		}
		if (category && !VALID_CATEGORIES.includes(category)) {
			res.status(400).json({ success: false, error: `category must be one of: ${VALID_CATEGORIES.join(", ")}` });
			return;
		}

		const result = await db.query<AgentMemoryRow>(
			`INSERT INTO agent_memories (user_id, content, category, source, pinned)
			 VALUES ($1, $2, $3, 'manual', $4)
			 RETURNING *`,
			[userId, content.trim(), category || "general", pinned === true],
		);

		res.status(201).json({ success: true, data: { memory: result.rows[0] } });
	}));

	// PUT /:id — Update a memory
	router.put("/:id", requireAuth, asyncRoute(async (req, res) => {
		const db = getDatabase();
		const userId = req.user!.userId;
		const { content, category, pinned } = req.body;

		// Ownership check
		const existing = await db.query<AgentMemoryRow>(
			`SELECT * FROM agent_memories WHERE id = $1 AND user_id = $2`,
			[req.params.id, userId],
		);
		if (existing.rows.length === 0) {
			res.status(404).json({ success: false, error: "Memory not found" });
			return;
		}

		if (content !== undefined) {
			if (typeof content !== "string" || content.trim().length === 0) {
				res.status(400).json({ success: false, error: "content cannot be empty" });
				return;
			}
			if (content.length > MAX_CONTENT_SIZE) {
				res.status(400).json({ success: false, error: `content must be under ${MAX_CONTENT_SIZE / 1024}KB` });
				return;
			}
		}
		if (category !== undefined && !VALID_CATEGORIES.includes(category)) {
			res.status(400).json({ success: false, error: `category must be one of: ${VALID_CATEGORIES.join(", ")}` });
			return;
		}

		const result = await db.query<AgentMemoryRow>(
			`UPDATE agent_memories SET
				content = COALESCE($1, content),
				category = COALESCE($2, category),
				pinned = COALESCE($3, pinned),
				updated_at = now()
			 WHERE id = $4 AND user_id = $5
			 RETURNING *`,
			[
				content !== undefined ? content.trim() : null,
				category ?? null,
				pinned !== undefined ? pinned : null,
				req.params.id,
				userId,
			],
		);

		res.json({ success: true, data: { memory: result.rows[0] } });
	}));

	// DELETE /:id — Delete a memory
	router.delete("/:id", requireAuth, asyncRoute(async (req, res) => {
		const db = getDatabase();
		const userId = req.user!.userId;

		const result = await db.query(
			`DELETE FROM agent_memories WHERE id = $1 AND user_id = $2`,
			[req.params.id, userId],
		);

		if (result.rowCount === 0) {
			res.status(404).json({ success: false, error: "Memory not found" });
			return;
		}

		res.json({ success: true });
	}));

	// -----------------------------------------------------------------------
	// Internal endpoints (agent extension, memory-token auth)
	// -----------------------------------------------------------------------

	// POST /internal/save — Save a memory from the agent
	router.post("/internal/save", asyncRoute(async (req, res) => {
		const token = req.headers["x-memory-token"] as string;
		const tokenData = validateMemoryToken(token);
		if (!tokenData) {
			res.status(401).json({ success: false, error: "Invalid or expired memory token" });
			return;
		}

		const { content, category } = req.body;
		if (!content || typeof content !== "string" || content.trim().length === 0) {
			res.status(400).json({ success: false, error: "content is required" });
			return;
		}
		if (content.length > MAX_CONTENT_SIZE) {
			res.status(400).json({ success: false, error: `content must be under ${MAX_CONTENT_SIZE / 1024}KB` });
			return;
		}

		const db = getDatabase();
		const result = await db.query<AgentMemoryRow>(
			`INSERT INTO agent_memories (user_id, content, category, source)
			 VALUES ($1, $2, $3, 'agent')
			 RETURNING *`,
			[tokenData.userId, content.trim(), category && VALID_CATEGORIES.includes(category) ? category : "general"],
		);

		res.status(201).json({ success: true, data: { memory: result.rows[0] } });
	}));

	// POST /internal/search — Search memories from the agent
	router.post("/internal/search", asyncRoute(async (req, res) => {
		const token = req.headers["x-memory-token"] as string;
		const tokenData = validateMemoryToken(token);
		if (!tokenData) {
			res.status(401).json({ success: false, error: "Invalid or expired memory token" });
			return;
		}

		const { query, limit: rawLimit } = req.body;
		if (!query || typeof query !== "string") {
			res.status(400).json({ success: false, error: "query is required" });
			return;
		}

		const limit = Math.min(Math.max(parseInt(rawLimit) || 10, 1), 50);
		const db = getDatabase();

		const result = await db.query<AgentMemoryRow>(
			`SELECT id, content, category, pinned, source, created_at, updated_at,
				ts_rank(search_vector, plainto_tsquery('english', $2)) as rank
			 FROM agent_memories
			 WHERE user_id = $1 AND search_vector @@ plainto_tsquery('english', $2)
			 ORDER BY pinned DESC, rank DESC
			 LIMIT $3`,
			[tokenData.userId, query, limit],
		);

		res.json({ success: true, data: { memories: result.rows } });
	}));

	return router;
}
