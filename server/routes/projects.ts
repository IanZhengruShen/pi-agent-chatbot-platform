/**
 * Projects (session folders) management routes.
 *
 * CRUD for user-scoped projects + AI auto-grouping of ungrouped sessions.
 */

import { Router } from "express";
import { type Context, complete, getModel } from "@mariozechner/pi-ai";
import { getDatabase } from "../db/index.js";
import type { ProjectRow, SessionRow } from "../db/types.js";
import { requireAuth } from "../auth/middleware.js";
import { asyncRoute } from "../utils/async-handler.js";
import type { AgentExecutor } from "../services/agent-executor.js";

/** Models to try for auto-grouping, in preference order. */
const ORGANIZE_MODEL_CANDIDATES: { provider: string; envVar: string; modelId: string }[] = [
	{ provider: "anthropic", envVar: "ANTHROPIC_API_KEY", modelId: "claude-3-5-haiku-20241022" },
	{ provider: "openai", envVar: "OPENAI_API_KEY", modelId: "gpt-4o-mini" },
	{ provider: "google", envVar: "GEMINI_API_KEY", modelId: "gemini-2.5-flash" },
	{ provider: "groq", envVar: "GROQ_API_KEY", modelId: "openai/gpt-oss-20b" },
	{ provider: "xai", envVar: "XAI_API_KEY", modelId: "grok-4-fast-non-reasoning" },
];

export function createProjectsRouter(agentExecutor: AgentExecutor): Router {
	const router = Router();
	router.use(requireAuth);

	// -----------------------------------------------------------------------
	// GET / — List user's projects ordered by sort_order
	// -----------------------------------------------------------------------
	router.get("/", asyncRoute(async (req, res) => {
		const db = getDatabase();
		const result = await db.query<ProjectRow>(
			`SELECT * FROM projects WHERE user_id = $1 ORDER BY sort_order, created_at`,
			[req.user!.userId],
		);
		res.json({ success: true, data: { projects: result.rows } });
	}));

	// -----------------------------------------------------------------------
	// POST / — Create a new project
	// -----------------------------------------------------------------------
	router.post("/", asyncRoute(async (req, res) => {
		const db = getDatabase();
		const { name, icon } = req.body;

		if (!name || typeof name !== "string" || !name.trim()) {
			res.status(400).json({ success: false, error: "name is required" });
			return;
		}

		// Default sort_order: after existing projects
		const maxResult = await db.query<{ max_order: number | null }>(
			`SELECT MAX(sort_order) AS max_order FROM projects WHERE user_id = $1`,
			[req.user!.userId],
		);
		const sortOrder = (maxResult.rows[0].max_order ?? -1) + 1;

		const result = await db.query<ProjectRow>(
			`INSERT INTO projects (user_id, name, icon, sort_order)
			 VALUES ($1, $2, $3, $4)
			 RETURNING *`,
			[req.user!.userId, name.trim(), icon ?? null, sortOrder],
		);

		res.status(201).json({ success: true, data: { project: result.rows[0] } });
	}));

	// -----------------------------------------------------------------------
	// PATCH /:id — Update project name/icon/sort_order
	// -----------------------------------------------------------------------
	router.patch("/:id", asyncRoute(async (req, res) => {
		const db = getDatabase();
		const { id } = req.params;

		// Ownership check
		const existing = await db.query<ProjectRow>(
			`SELECT * FROM projects WHERE id = $1 AND user_id = $2`,
			[id, req.user!.userId],
		);
		if (existing.rows.length === 0) {
			res.status(404).json({ success: false, error: "Project not found" });
			return;
		}

		const { name, icon, sort_order } = req.body;
		const result = await db.query<ProjectRow>(
			`UPDATE projects
			 SET name = COALESCE($1, name),
			     icon = COALESCE($2, icon),
			     sort_order = COALESCE($3, sort_order)
			 WHERE id = $4 AND user_id = $5
			 RETURNING *`,
			[name ?? null, icon ?? null, sort_order ?? null, id, req.user!.userId],
		);

		res.json({ success: true, data: { project: result.rows[0] } });
	}));

	// -----------------------------------------------------------------------
	// DELETE /:id — Delete project (sessions get project_id = NULL via FK)
	// -----------------------------------------------------------------------
	router.delete("/:id", asyncRoute(async (req, res) => {
		const db = getDatabase();
		const { id } = req.params;

		const result = await db.query(
			`DELETE FROM projects WHERE id = $1 AND user_id = $2`,
			[id, req.user!.userId],
		);

		if (result.rowCount === 0) {
			res.status(404).json({ success: false, error: "Project not found" });
			return;
		}

		res.json({ success: true });
	}));

	// -----------------------------------------------------------------------
	// POST /organize — AI auto-grouping of ungrouped sessions
	// -----------------------------------------------------------------------
	router.post("/organize", asyncRoute(async (req, res) => {
		const db = getDatabase();
		const userId = req.user!.userId;

		// 1. Fetch ungrouped sessions
		const sessionsResult = await db.query<Pick<SessionRow, "id" | "title" | "preview">>(
			`SELECT id, title, preview FROM sessions
			 WHERE user_id = $1 AND project_id IS NULL AND deleted_at IS NULL
			 ORDER BY last_modified DESC`,
			[userId],
		);

		const ungrouped = sessionsResult.rows;
		if (ungrouped.length < 3) {
			res.status(400).json({ success: false, error: "Need at least 3 ungrouped sessions to organize" });
			return;
		}

		// 2. Find available LLM
		const env = await agentExecutor.buildEnv(userId, req.user!.teamId);
		let apiKey: string | undefined;
		let model: ReturnType<typeof getModel> | undefined;

		for (const candidate of ORGANIZE_MODEL_CANDIDATES) {
			const key = env[candidate.envVar];
			if (!key) continue;
			const m = getModel(candidate.provider as any, candidate.modelId);
			if (!m) continue;
			apiKey = key;
			model = m;
			break;
		}

		if (!apiKey || !model) {
			res.status(400).json({ success: false, error: "No LLM provider configured" });
			return;
		}

		// 3. Build prompt with session data
		const sessionSummaries = ungrouped.map(s =>
			`- ID: ${s.id} | Title: "${s.title}" | Preview: "${(s.preview || "").slice(0, 100)}"`
		).join("\n");

		const context: Context = {
			messages: [{
				role: "user",
				content: `You are organizing chat sessions into project folders. Group these sessions by topic/theme.

Sessions:
${sessionSummaries}

Reply with ONLY valid JSON (no markdown, no explanation). Format:
[{"projectName": "Short name", "icon": "single emoji", "sessionIds": ["id1", "id2"]}]

Rules:
- Group related sessions together (2+ sessions per group preferred)
- Use short, descriptive project names (2-4 words)
- Pick a single emoji icon that represents the group
- Every session must appear in exactly one group
- Aim for 2-5 groups total`,
				timestamp: Date.now(),
			}],
		};

		try {
			const result = await complete(model, context, {
				apiKey,
				maxTokens: 2000,
			} as any);

			const textPart = result.content?.find((c: any) => c.type === "text");
			const rawText = textPart && "text" in textPart ? textPart.text.trim() : "";

			// Parse JSON (strip markdown fences if present)
			const jsonStr = rawText.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
			const groups: Array<{ projectName: string; icon: string; sessionIds: string[] }> = JSON.parse(jsonStr);

			if (!Array.isArray(groups) || groups.length === 0) {
				res.status(500).json({ success: false, error: "Invalid grouping response from AI" });
				return;
			}

			// 4. Validate sessionIds — only allow IDs that are actually ungrouped
			const validIds = new Set(ungrouped.map(s => s.id));

			// 5. Create projects and assign sessions in a transaction
			const client = await db.getClient();
			const createdProjects: ProjectRow[] = [];

			try {
				await client.query("BEGIN");

				// Get current max sort_order
				const maxResult = await client.query<{ max_order: number | null }>(
					`SELECT MAX(sort_order) AS max_order FROM projects WHERE user_id = $1`,
					[userId],
				);
				let sortOrder = (maxResult.rows[0].max_order ?? -1) + 1;

				for (const group of groups) {
					if (!group.projectName || !Array.isArray(group.sessionIds)) continue;

					const validSessionIds = group.sessionIds.filter(id => validIds.has(id));
					if (validSessionIds.length === 0) continue;

					// Create project
					const projResult = await client.query<ProjectRow>(
						`INSERT INTO projects (user_id, name, icon, sort_order)
						 VALUES ($1, $2, $3, $4)
						 RETURNING *`,
						[userId, group.projectName, group.icon || null, sortOrder++],
					);
					const project = projResult.rows[0];
					createdProjects.push(project);

					// Assign sessions
					await client.query(
						`UPDATE sessions SET project_id = $1
						 WHERE id = ANY($2) AND user_id = $3 AND project_id IS NULL`,
						[project.id, validSessionIds, userId],
					);
				}

				await client.query("COMMIT");
			} catch (txErr) {
				await client.query("ROLLBACK");
				throw txErr;
			} finally {
				client.release();
			}

			res.json({ success: true, data: { projects: createdProjects } });
		} catch (err: any) {
			console.error("[projects] AI organize failed:", err);
			res.status(500).json({ success: false, error: "Failed to organize sessions" });
		}
	}));

	return router;
}
