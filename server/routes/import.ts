import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { getDatabase } from "../db/index.js";

const router = Router();
router.use(requireAuth);

/**
 * POST /api/import/sessions
 *
 * Imports sessions and messages from an IndexedDB export.
 * Skips sessions that already exist (by ID). Creates sessions
 * under the authenticated user.
 *
 * Body: { sessions: SessionData[], metadata: SessionMetadata[] }
 * Response: { success: true, data: { imported: number, skipped: number } }
 */
router.post("/sessions", async (req, res) => {
	const db = getDatabase();
	const userId = req.user!.userId;
	const { sessions, metadata } = req.body;

	if (!Array.isArray(sessions)) {
		res.status(400).json({ success: false, error: "sessions must be an array" });
		return;
	}

	// Build a metadata lookup by ID for enrichment
	const metaMap = new Map<string, any>();
	if (Array.isArray(metadata)) {
		for (const m of metadata) {
			if (m?.id) metaMap.set(m.id, m);
		}
	}

	// Check which sessions already exist for this user
	const { rows: existing } = await db.query(
		"SELECT id FROM sessions WHERE user_id = $1 AND deleted_at IS NULL",
		[userId],
	);
	const existingIds = new Set(existing.map((r: any) => r.id));

	let imported = 0;
	let skipped = 0;

	for (const session of sessions) {
		if (!session?.id) {
			skipped++;
			continue;
		}

		if (existingIds.has(session.id)) {
			skipped++;
			continue;
		}

		const meta = metaMap.get(session.id);
		const client = await db.getClient();

		try {
			await client.query("BEGIN");

			// Create session
			await client.query(
				`INSERT INTO sessions (id, user_id, title, model_id, provider, thinking_level, message_count, preview, created_at, last_modified)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
				[
					session.id,
					userId,
					session.title || meta?.title || "",
					session.model?.id || meta?.modelId || null,
					session.model?.provider || meta?.provider || null,
					session.thinkingLevel || meta?.thinkingLevel || "off",
					session.messages?.length || meta?.messageCount || 0,
					meta?.preview || "",
					session.createdAt || new Date().toISOString(),
					session.lastModified || new Date().toISOString(),
				],
			);

			// Insert messages
			const messages = session.messages || [];
			for (let i = 0; i < messages.length; i++) {
				const msg = messages[i];
				await client.query(
					`INSERT INTO messages (session_id, ordinal, role, content, stop_reason, usage)
					 VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb)`,
					[
						session.id,
						i,
						msg.role || "user",
						JSON.stringify(msg.content),
						msg.stopReason || msg.stop_reason || null,
						msg.usage ? JSON.stringify(msg.usage) : null,
					],
				);
			}

			await client.query("COMMIT");
			imported++;
		} catch (err) {
			await client.query("ROLLBACK");
			console.error(`[import] Failed to import session ${session.id}:`, err);
			skipped++;
		} finally {
			client.release();
		}
	}

	res.json({ success: true, data: { imported, skipped } });
});

export default router;
