import { Router } from "express";
import { randomUUID } from "crypto";
import type { Request, Response } from "express";
import type { SessionRow, MessageRow } from "../db/types.js";
import { getDatabase } from "../db/index.js";
import { requireAuth } from "../auth/middleware.js";
import { requireAuthOrToken } from "../auth/middleware.js";
import { isOwner } from "../auth/permissions.js";
import { asyncRoute } from "../utils/async-handler.js";
import type { SessionStatusService } from "../services/session-status-service.js";
import type { ProcessPool } from "../services/process-pool.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

export function createSessionsRouter(
	sessionStatusService: SessionStatusService,
	processPool: ProcessPool,
): Router {
	const router = Router();

	// ---------------------------------------------------------------------------
	// SSE endpoint — uses ticket auth (before requireAuth middleware)
	// ---------------------------------------------------------------------------

	router.get("/events", requireAuthOrToken, (req, res) => {
		const userId = req.user!.userId;

		// Set SSE headers
		res.setHeader("Content-Type", "text/event-stream");
		res.setHeader("Cache-Control", "no-cache");
		res.setHeader("Connection", "keep-alive");
		res.setHeader("X-Accel-Buffering", "no"); // nginx
		res.flushHeaders();

		// Send initial snapshot of all session statuses for this user
		const statuses = sessionStatusService.getStatusesForUser(userId);
		const snapshot: Record<string, string> = {};
		for (const [sessionId, status] of statuses) {
			snapshot[sessionId] = status;
		}
		res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);

		// Subscribe to status changes
		const unsubscribe = sessionStatusService.subscribe(userId, (event) => {
			res.write(`event: session_status\ndata: ${JSON.stringify(event)}\n\n`);
		});

		// Keep-alive ping every 15s
		const pingInterval = setInterval(() => {
			res.write(`:ping\n\n`);
		}, 15_000);

		// Cleanup on disconnect
		req.on("close", () => {
			clearInterval(pingInterval);
			unsubscribe();
		});
	});

	// All remaining routes require standard auth
	router.use(requireAuth);

	// ---------------------------------------------------------------------------
	// POST /:id/abort — Abort a generating session
	// ---------------------------------------------------------------------------
	router.post("/:id/abort", asyncRoute(async (req, res) => {
		const session = await getOwnedSession(req, res);
		if (!session) return;

		const processInfo = processPool.get(session.id);
		if (!processInfo || !processInfo.process.stdin) {
			res.status(404).json({ success: false, error: "No active process for this session" });
			return;
		}

		try {
			processInfo.process.stdin.write(JSON.stringify({ type: "abort" }) + "\n");
			res.json({ success: true });
		} catch (err: any) {
			res.status(500).json({ success: false, error: "Failed to send abort signal" });
		}
	}));

	// ---------------------------------------------------------------------------
	// 1. GET / — List active sessions for the authenticated user
	// ---------------------------------------------------------------------------
	router.get("/", asyncRoute(async (req, res) => {
		const db = getDatabase();
		const result = await db.query<SessionRow>(
			`SELECT * FROM sessions
			 WHERE user_id = $1 AND deleted_at IS NULL
			 ORDER BY last_modified DESC`,
			[req.user!.userId],
		);

		res.json({ success: true, data: { sessions: result.rows } });
	}));

	// ---------------------------------------------------------------------------
	// 2. POST / — Create a new session
	// ---------------------------------------------------------------------------
	router.post("/", asyncRoute(async (req, res) => {
		const db = getDatabase();
		const { id, title, modelId, provider, thinkingLevel, agentProfileId } = req.body;

		// 1.14 Validate client-provided session ID format
		if (id && !UUID_REGEX.test(id)) {
			res.status(400).json({ success: false, error: "Session ID must be a valid UUID" });
			return;
		}

		// Use client-provided ID if present, otherwise generate one
		const sessionId = id || randomUUID();
		const now = new Date();

		const result = await db.query<SessionRow>(
			`INSERT INTO sessions (id, user_id, title, model_id, provider, thinking_level, message_count, preview, agent_profile_id, created_at, last_modified)
			 VALUES ($1, $2, $3, $4, $5, $6, 0, '', $7, $8, $8)
			 RETURNING *`,
			[
				sessionId,
				req.user!.userId,
				title ?? "New Session",
				modelId ?? null,
				provider ?? null,
				thinkingLevel ?? "default",
				agentProfileId ?? null,
				now,
			],
		);

		res.status(201).json({ success: true, data: { session: result.rows[0] } });
	}));

	// ---------------------------------------------------------------------------
	// 3. GET /:id — Get session detail (with ownership check)
	// ---------------------------------------------------------------------------
	router.get("/:id", asyncRoute(async (req, res) => {
		const session = await getOwnedSession(req, res);
		if (!session) return;

		res.json({ success: true, data: { session } });
	}));

	// ---------------------------------------------------------------------------
	// 4. PATCH /:id — Update session (with ownership check)
	// ---------------------------------------------------------------------------
	router.patch("/:id", asyncRoute(async (req, res) => {
		const session = await getOwnedSession(req, res);
		if (!session) return;

		const db = getDatabase();
		const { title, modelId, provider, thinkingLevel, artifactsCache, projectId } = req.body;

		// Build dynamic SET clause — projectId needs special handling (explicit null clears it)
		const setClauses = [
			"title = COALESCE($1, title)",
			"model_id = COALESCE($2, model_id)",
			"provider = COALESCE($3, provider)",
			"thinking_level = COALESCE($4, thinking_level)",
			"artifacts_cache = COALESCE($6, artifacts_cache)",
			"last_modified = NOW()",
		];
		const params: any[] = [
			title ?? null,
			modelId ?? null,
			provider ?? null,
			thinkingLevel ?? null,
			session.id,
			artifactsCache ? JSON.stringify(artifactsCache) : null,
		];

		// projectId: undefined = not sent (don't touch), null = clear, string = set
		if (projectId !== undefined) {
			params.push(projectId);
			setClauses.push(`project_id = $${params.length}`);
		}

		const result = await db.query<SessionRow>(
			`UPDATE sessions
			 SET ${setClauses.join(",\n			     ")}
			 WHERE id = $5
			 RETURNING *`,
			params,
		);

		res.json({ success: true, data: { session: result.rows[0] } });
	}));

	// ---------------------------------------------------------------------------
	// 5. DELETE /:id — Soft delete (with ownership check)
	// ---------------------------------------------------------------------------
	router.delete("/:id", asyncRoute(async (req, res) => {
		const session = await getOwnedSession(req, res);
		if (!session) return;

		const db = getDatabase();
		await db.query("UPDATE sessions SET deleted_at = NOW() WHERE id = $1", [
			session.id,
		]);

		res.json({ success: true });
	}));

	// ---------------------------------------------------------------------------
	// 6. GET /:id/messages — Paginated messages (ordered by ordinal DESC)
	// ---------------------------------------------------------------------------
	router.get("/:id/messages", asyncRoute(async (req, res) => {
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
	}));

	// ---------------------------------------------------------------------------
	// 7. POST /:id/messages — Append a single message
	// ---------------------------------------------------------------------------
	router.post("/:id/messages", asyncRoute(async (req, res) => {
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
	}));

	// ---------------------------------------------------------------------------
	// 8. POST /:id/messages/batch — Bulk append messages (atomic)
	// ---------------------------------------------------------------------------
	router.post("/:id/messages/batch", asyncRoute(async (req, res) => {
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
	}));

	return router;
}

export default createSessionsRouter;
