import { Router } from "express";
import { randomUUID } from "crypto";
import type { Request, Response } from "express";
import type { SessionRow, MessageRow } from "../db/types.js";
import { getDatabase } from "../db/index.js";
import { requireAuth } from "../auth/middleware.js";
import { isOwner } from "../auth/permissions.js";

const router = Router();

// All routes require authentication
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch a session by ID and verify ownership.
 * Sends 404 / 403 responses when appropriate and returns null.
 */
async function getOwnedSession(
	req: Request,
	res: Response,
): Promise<SessionRow | null> {
	const db = getDatabase();
	const { id } = req.params;

	const result = await db.query<SessionRow>(
		"SELECT * FROM sessions WHERE id = $1",
		[id],
	);

	if (result.rows.length === 0) {
		res.status(404).json({ success: false, error: "Session not found" });
		return null;
	}

	const session = result.rows[0];

	if (!isOwner(req, session.user_id)) {
		res.status(403).json({ success: false, error: "Forbidden" });
		return null;
	}

	return session;
}

// ---------------------------------------------------------------------------
// 1. GET / — List active sessions for the authenticated user
// ---------------------------------------------------------------------------
router.get("/", async (req: Request, res: Response) => {
	try {
		const db = getDatabase();
		const result = await db.query<SessionRow>(
			`SELECT * FROM sessions
			 WHERE user_id = $1 AND deleted_at IS NULL
			 ORDER BY last_modified DESC`,
			[req.user!.userId],
		);

		res.json({ success: true, data: { sessions: result.rows } });
	} catch (err) {
		console.error("[sessions] GET / error:", err);
		res.status(500).json({ success: false, error: "Internal server error" });
	}
});

// ---------------------------------------------------------------------------
// 2. POST / — Create a new session
// ---------------------------------------------------------------------------
router.post("/", async (req: Request, res: Response) => {
	try {
		const db = getDatabase();
		const { id, title, modelId, provider, thinkingLevel } = req.body;
		// Use client-provided ID if present, otherwise generate one
		const sessionId = id || randomUUID();
		const now = new Date();

		const result = await db.query<SessionRow>(
			`INSERT INTO sessions (id, user_id, title, model_id, provider, thinking_level, message_count, preview, created_at, last_modified)
			 VALUES ($1, $2, $3, $4, $5, $6, 0, '', $7, $7)
			 RETURNING *`,
			[
				sessionId,
				req.user!.userId,
				title ?? "New Session",
				modelId ?? null,
				provider ?? null,
				thinkingLevel ?? "default",
				now,
			],
		);

		res.status(201).json({ success: true, data: { session: result.rows[0] } });
	} catch (err) {
		console.error("[sessions] POST / error:", err);
		res.status(500).json({ success: false, error: "Internal server error" });
	}
});

// ---------------------------------------------------------------------------
// 3. GET /:id — Get session detail (with ownership check)
// ---------------------------------------------------------------------------
router.get("/:id", async (req: Request, res: Response) => {
	try {
		const session = await getOwnedSession(req, res);
		if (!session) return;

		res.json({ success: true, data: { session } });
	} catch (err) {
		console.error("[sessions] GET /:id error:", err);
		res.status(500).json({ success: false, error: "Internal server error" });
	}
});

// ---------------------------------------------------------------------------
// 4. PATCH /:id — Update session (with ownership check)
// ---------------------------------------------------------------------------
router.patch("/:id", async (req: Request, res: Response) => {
	try {
		const session = await getOwnedSession(req, res);
		if (!session) return;

		const db = getDatabase();
		const { title, modelId, provider, thinkingLevel } = req.body;

		const result = await db.query<SessionRow>(
			`UPDATE sessions
			 SET title = COALESCE($1, title),
			     model_id = COALESCE($2, model_id),
			     provider = COALESCE($3, provider),
			     thinking_level = COALESCE($4, thinking_level),
			     last_modified = NOW()
			 WHERE id = $5
			 RETURNING *`,
			[
				title ?? null,
				modelId ?? null,
				provider ?? null,
				thinkingLevel ?? null,
				session.id,
			],
		);

		res.json({ success: true, data: { session: result.rows[0] } });
	} catch (err) {
		console.error("[sessions] PATCH /:id error:", err);
		res.status(500).json({ success: false, error: "Internal server error" });
	}
});

// ---------------------------------------------------------------------------
// 5. DELETE /:id — Soft delete (with ownership check)
// ---------------------------------------------------------------------------
router.delete("/:id", async (req: Request, res: Response) => {
	try {
		const session = await getOwnedSession(req, res);
		if (!session) return;

		const db = getDatabase();
		await db.query("UPDATE sessions SET deleted_at = NOW() WHERE id = $1", [
			session.id,
		]);

		res.json({ success: true });
	} catch (err) {
		console.error("[sessions] DELETE /:id error:", err);
		res.status(500).json({ success: false, error: "Internal server error" });
	}
});

// ---------------------------------------------------------------------------
// 6. GET /:id/messages — Paginated messages (ordered by ordinal DESC)
// ---------------------------------------------------------------------------
router.get("/:id/messages", async (req: Request, res: Response) => {
	try {
		const session = await getOwnedSession(req, res);
		if (!session) return;

		const db = getDatabase();
		const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
		const limit = Math.max(1, Math.min(200, parseInt(req.query.limit as string, 10) || 50));
		const offset = (page - 1) * limit;

		const [messagesResult, countResult] = await Promise.all([
			db.query<MessageRow>(
				`SELECT * FROM messages
				 WHERE session_id = $1
				 ORDER BY ordinal DESC
				 LIMIT $2 OFFSET $3`,
				[session.id, limit, offset],
			),
			db.query<{ count: string }>(
				"SELECT COUNT(*)::text AS count FROM messages WHERE session_id = $1",
				[session.id],
			),
		]);

		const total = parseInt(countResult.rows[0].count, 10);

		res.json({
			success: true,
			data: {
				messages: messagesResult.rows,
				total,
				page,
				pageSize: limit,
				hasMore: offset + limit < total,
			},
		});
	} catch (err) {
		console.error("[sessions] GET /:id/messages error:", err);
		res.status(500).json({ success: false, error: "Internal server error" });
	}
});

// ---------------------------------------------------------------------------
// 7. POST /:id/messages — Append a single message
// ---------------------------------------------------------------------------
router.post("/:id/messages", async (req: Request, res: Response) => {
	try {
		const session = await getOwnedSession(req, res);
		if (!session) return;

		const db = getDatabase();
		const { role, content: rawContent, stopReason, usage } = req.body;
		const id = randomUUID();

		// Ensure content is a proper JavaScript object/array for JSONB
		let content = rawContent;
		if (typeof content === "string") {
			try {
				content = JSON.parse(content);
			} catch {
				// If parsing fails, treat as plain text message
				content = [{ type: "text", text: content }];
			}
		}

		const client = await db.getClient();
		try {
			await client.query("BEGIN");

			const ordinalResult = await client.query<{ next_ordinal: number }>(
				"SELECT COALESCE(MAX(ordinal), -1) + 1 AS next_ordinal FROM messages WHERE session_id = $1",
				[session.id],
			);
			const ordinal = ordinalResult.rows[0].next_ordinal;

			// Convert to JSON string for JSONB parameter
			const contentJson = JSON.stringify(content);
			const usageJson = usage ? JSON.stringify(usage) : null;

			const msgResult = await client.query<MessageRow>(
				`INSERT INTO messages (id, session_id, ordinal, role, content, stop_reason, usage, created_at)
				 VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, NOW())
				 RETURNING *`,
				[id, session.id, ordinal, role, contentJson, stopReason ?? null, usageJson],
			);

			await client.query(
				`UPDATE sessions
				 SET message_count = message_count + 1, last_modified = NOW()
				 WHERE id = $1`,
				[session.id],
			);

			await client.query("COMMIT");

			res.status(201).json({ success: true, data: { message: msgResult.rows[0] } });
		} catch (txErr) {
			await client.query("ROLLBACK");
			throw txErr;
		} finally {
			client.release();
		}
	} catch (err) {
		console.error("[sessions] POST /:id/messages error:", err);
		res.status(500).json({ success: false, error: "Internal server error" });
	}
});

// ---------------------------------------------------------------------------
// 8. POST /:id/messages/batch — Bulk append messages (atomic)
// ---------------------------------------------------------------------------
router.post("/:id/messages/batch", async (req: Request, res: Response) => {
	try {
		const session = await getOwnedSession(req, res);
		if (!session) return;

		const db = getDatabase();
		const { messages } = req.body as {
			messages: Array<{ role: string; content: any; stopReason?: string; usage?: any }>;
		};

		if (!Array.isArray(messages) || messages.length === 0) {
			res.status(400).json({ success: false, error: "messages must be a non-empty array" });
			return;
		}

		const client = await db.getClient();
		try {
			await client.query("BEGIN");

			const ordinalResult = await client.query<{ next_ordinal: number }>(
				"SELECT COALESCE(MAX(ordinal), -1) + 1 AS next_ordinal FROM messages WHERE session_id = $1",
				[session.id],
			);
			let ordinal = ordinalResult.rows[0].next_ordinal;

			const inserted: MessageRow[] = [];

			for (const msg of messages) {
				const id = randomUUID();
				// Ensure content is a proper JavaScript object/array for JSONB
				// If it's a string, parse it; otherwise use as-is
				let content = msg.content;
				if (typeof content === "string") {
					try {
						content = JSON.parse(content);
					} catch {
						// If parsing fails, treat as plain text message
						content = [{ type: "text", text: content }];
					}
				}

				// Convert to JSON string for JSONB parameters
				const contentJson = JSON.stringify(content);
				const usageJson = msg.usage ? JSON.stringify(msg.usage) : null;

				const result = await client.query<MessageRow>(
					`INSERT INTO messages (id, session_id, ordinal, role, content, stop_reason, usage, created_at)
					 VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, NOW())
					 RETURNING *`,
					[
						id,
						session.id,
						ordinal,
						msg.role,
						contentJson,
						msg.stopReason ?? null,
						usageJson,
					],
				);
				inserted.push(result.rows[0]);
				ordinal++;
			}

			await client.query(
				`UPDATE sessions
				 SET message_count = message_count + $1, last_modified = NOW()
				 WHERE id = $2`,
				[messages.length, session.id],
			);

			await client.query("COMMIT");

			res.status(201).json({ success: true, data: { messages: inserted } });
		} catch (txErr) {
			await client.query("ROLLBACK");
			throw txErr;
		} finally {
			client.release();
		}
	} catch (err) {
		console.error("[sessions] POST /:id/messages/batch error:", err);
		res.status(500).json({ success: false, error: "Internal server error" });
	}
});

export default router;
