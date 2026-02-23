/**
 * Agent profiles management routes.
 *
 * CRUD for agent profiles with scope-based authorization (platform/team/user).
 * Agent profiles define specialist agents with custom system prompts and curated skills.
 */

import { Router } from "express";
import { type Context, complete, getModel } from "@mariozechner/pi-ai";
import { getDatabase } from "../db/index.js";
import type { AgentProfileRow } from "../db/types.js";
import { requireAuth } from "../auth/middleware.js";
import { asyncRoute } from "../utils/async-handler.js";
import type { AgentExecutor } from "../services/agent-executor.js";

const DEFAULT_ICON = "\u{1F916}"; // 🤖

/** Cheap/fast models to try for icon generation, in preference order. */
const ICON_GEN_CANDIDATES: { provider: string; envVar: string; modelId: string }[] = [
	{ provider: "anthropic", envVar: "ANTHROPIC_API_KEY", modelId: "claude-3-5-haiku-20241022" },
	{ provider: "openai", envVar: "OPENAI_API_KEY", modelId: "gpt-4o-mini" },
	{ provider: "google", envVar: "GEMINI_API_KEY", modelId: "gemini-2.5-flash" },
	{ provider: "groq", envVar: "GROQ_API_KEY", modelId: "openai/gpt-oss-20b" },
	{ provider: "xai", envVar: "XAI_API_KEY", modelId: "grok-4-fast-non-reasoning" },
];

export function createAgentProfilesRouter(agentExecutor: AgentExecutor): Router {
	const router = Router();
	router.use(requireAuth);

	// -----------------------------------------------------------------------
	// POST /generate-icon — Auto-generate an emoji icon via LLM
	// -----------------------------------------------------------------------
	router.post("/generate-icon", asyncRoute(async (req, res) => {
		const { name, description, provider: reqProvider, model: reqModel } = req.body;
		if (!name || typeof name !== "string") {
			res.status(400).json({ success: false, error: "name is required" });
			return;
		}

		try {
			const env = await agentExecutor.buildEnv(req.user!.userId, req.user!.teamId);

			let apiKey: string | undefined;
			let model: ReturnType<typeof getModel> | undefined;

			// If caller specified a provider+model, try that first
			if (reqProvider && reqModel) {
				const envVar = ICON_GEN_CANDIDATES.find(c => c.provider === reqProvider)?.envVar
					?? `${(reqProvider as string).toUpperCase().replace(/-/g, "_")}_API_KEY`;
				const key = env[envVar];
				if (key) {
					const m = getModel(reqProvider as any, reqModel);
					if (m) {
						apiKey = key;
						model = m;
					}
				}
			}

			// Fall back to first available provider from candidate list
			if (!apiKey || !model) {
				for (const candidate of ICON_GEN_CANDIDATES) {
					const key = env[candidate.envVar];
					if (!key) continue;
					const m = getModel(candidate.provider as any, candidate.modelId);
					if (!m) continue;
					apiKey = key;
					model = m;
					break;
				}
			}

			if (!apiKey || !model) {
				res.json({ success: true, data: { icon: DEFAULT_ICON } });
				return;
			}

			const descPart = description ? ` described as '${description}'` : "";
			const context: Context = {
				messages: [{
					role: "user",
					content: `Pick one emoji that best represents an AI agent named '${name}'${descPart}. Reply with ONLY the single emoji character, nothing else.`,
					timestamp: Date.now(),
				}],
			};

			const result = await complete(model, context, {
				apiKey,
				maxTokens: 10,
			} as any);

			const textPart = result.content?.find((c: any) => c.type === "text");
			const icon = (textPart && "text" in textPart ? textPart.text.trim() : "") || DEFAULT_ICON;
			res.json({ success: true, data: { icon } });
		} catch (err) {
			console.error("[agent-profiles] Failed to generate icon:", err);
			res.json({ success: true, data: { icon: DEFAULT_ICON } });
		}
	}));

	// -----------------------------------------------------------------------
	// GET / — List visible profiles (platform + user's team + user's own)
	// -----------------------------------------------------------------------
	router.get("/", asyncRoute(async (req, res) => {
		const db = getDatabase();
		const result = await db.query<AgentProfileRow>(
			`SELECT * FROM agent_profiles
			 WHERE (scope = 'platform')
			    OR (scope = 'team' AND owner_id = $1)
			    OR (scope = 'user' AND owner_id = $2)
			 ORDER BY scope, name`,
			[req.user!.teamId, req.user!.userId],
		);

		res.json({ success: true, data: { profiles: result.rows } });
	}));

	// -----------------------------------------------------------------------
	// GET /:id — Get single profile (with access check)
	// -----------------------------------------------------------------------
	router.get("/:id", asyncRoute(async (req, res) => {
		const db = getDatabase();
		const result = await db.query<AgentProfileRow>(
			`SELECT * FROM agent_profiles
			 WHERE id = $1
			   AND ((scope = 'platform')
			     OR (scope = 'team' AND owner_id = $2)
			     OR (scope = 'user' AND owner_id = $3))`,
			[req.params.id, req.user!.teamId, req.user!.userId],
		);

		if (result.rows.length === 0) {
			res.status(404).json({ success: false, error: "Agent profile not found" });
			return;
		}

		res.json({ success: true, data: { profile: result.rows[0] } });
	}));

	// -----------------------------------------------------------------------
	// POST / — Create a new agent profile
	// -----------------------------------------------------------------------
	router.post("/", asyncRoute(async (req, res) => {
		const {
			scope, name, description, icon,
			system_prompt, prompt_mode,
			skill_ids, file_ids, model_id, provider,
			starter_message, suggested_prompts,
		} = req.body;

		// Validate scope
		if (!scope || !["platform", "team", "user"].includes(scope)) {
			res.status(400).json({ success: false, error: "scope must be 'platform', 'team', or 'user'" });
			return;
		}

		// Authorization: platform/team scope requires admin
		if ((scope === "platform" || scope === "team") && req.user!.role !== "admin") {
			res.status(403).json({ success: false, error: "Only admins can create platform/team agent profiles" });
			return;
		}

		// Validate required fields
		if (!name || typeof name !== "string" || name.length > 100) {
			res.status(400).json({ success: false, error: "name is required (max 100 chars)" });
			return;
		}
		if (!system_prompt || typeof system_prompt !== "string") {
			res.status(400).json({ success: false, error: "system_prompt is required" });
			return;
		}
		if (system_prompt.length > 50 * 1024) {
			res.status(400).json({ success: false, error: "system_prompt must be under 50KB" });
			return;
		}
		if (prompt_mode && !["replace", "append"].includes(prompt_mode)) {
			res.status(400).json({ success: false, error: "prompt_mode must be 'replace' or 'append'" });
			return;
		}

		const db = getDatabase();

		// Validate skill_ids if provided
		if (skill_ids && Array.isArray(skill_ids) && skill_ids.length > 0) {
			const skillCheck = await db.query(
				`SELECT id FROM skills
				 WHERE id = ANY($1)
				   AND ((scope = 'platform')
				     OR (scope = 'team' AND owner_id = $2)
				     OR (scope = 'user' AND owner_id = $3))`,
				[skill_ids, req.user!.teamId, req.user!.userId],
			);
			if (skillCheck.rows.length !== skill_ids.length) {
				res.status(400).json({ success: false, error: "Some skill_ids are invalid or not accessible" });
				return;
			}
		}

		// Validate file_ids if provided
		if (file_ids && Array.isArray(file_ids) && file_ids.length > 0) {
			const fileCheck = await db.query(
				`SELECT id FROM user_files WHERE id = ANY($1) AND user_id = $2`,
				[file_ids, req.user!.userId],
			);
			if (fileCheck.rows.length !== file_ids.length) {
				res.status(400).json({ success: false, error: "Some file_ids are invalid or not accessible" });
				return;
			}
		}

		const ownerId = scope === "user" ? req.user!.userId : req.user!.teamId;

		const result = await db.query<AgentProfileRow>(
			`INSERT INTO agent_profiles (
				scope, owner_id, name, description, icon,
				system_prompt, prompt_mode,
				skill_ids, file_ids, model_id, provider,
				starter_message, suggested_prompts
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
			RETURNING *`,
			[
				scope, ownerId, name, description || null, icon || null,
				system_prompt, prompt_mode || "replace",
				skill_ids || null, file_ids || null, model_id || null, provider || null,
				starter_message || null, suggested_prompts || null,
			],
		);

		res.status(201).json({ success: true, data: { profile: result.rows[0] } });
	}));

	// -----------------------------------------------------------------------
	// PUT /:id — Update an agent profile
	// -----------------------------------------------------------------------
	router.put("/:id", asyncRoute(async (req, res) => {
		const db = getDatabase();
		const existing = await db.query<AgentProfileRow>(
			`SELECT * FROM agent_profiles WHERE id = $1`,
			[req.params.id],
		);

		if (existing.rows.length === 0) {
			res.status(404).json({ success: false, error: "Agent profile not found" });
			return;
		}

		const profile = existing.rows[0];

		// Authorization
		const canEdit =
			((profile.scope === "platform" || profile.scope === "team") && req.user!.role === "admin") ||
			(profile.scope === "user" && profile.owner_id === req.user!.userId);

		if (!canEdit) {
			res.status(403).json({ success: false, error: "Insufficient permissions" });
			return;
		}

		const {
			name, description, icon,
			system_prompt, prompt_mode,
			skill_ids, file_ids, model_id, provider,
			starter_message, suggested_prompts,
		} = req.body;

		// Validate fields if provided
		if (name !== undefined && (typeof name !== "string" || name.length === 0 || name.length > 100)) {
			res.status(400).json({ success: false, error: "name must be 1-100 chars" });
			return;
		}
		if (system_prompt !== undefined && (typeof system_prompt !== "string" || system_prompt.length === 0)) {
			res.status(400).json({ success: false, error: "system_prompt is required" });
			return;
		}
		if (system_prompt && system_prompt.length > 50 * 1024) {
			res.status(400).json({ success: false, error: "system_prompt must be under 50KB" });
			return;
		}
		if (prompt_mode !== undefined && !["replace", "append"].includes(prompt_mode)) {
			res.status(400).json({ success: false, error: "prompt_mode must be 'replace' or 'append'" });
			return;
		}

		// Validate skill_ids if provided
		if (skill_ids && Array.isArray(skill_ids) && skill_ids.length > 0) {
			const skillCheck = await db.query(
				`SELECT id FROM skills
				 WHERE id = ANY($1)
				   AND ((scope = 'platform')
				     OR (scope = 'team' AND owner_id = $2)
				     OR (scope = 'user' AND owner_id = $3))`,
				[skill_ids, req.user!.teamId, req.user!.userId],
			);
			if (skillCheck.rows.length !== skill_ids.length) {
				res.status(400).json({ success: false, error: "Some skill_ids are invalid or not accessible" });
				return;
			}
		}

		// Validate file_ids if provided
		if (file_ids && Array.isArray(file_ids) && file_ids.length > 0) {
			const fileCheck = await db.query(
				`SELECT id FROM user_files WHERE id = ANY($1) AND user_id = $2`,
				[file_ids, req.user!.userId],
			);
			if (fileCheck.rows.length !== file_ids.length) {
				res.status(400).json({ success: false, error: "Some file_ids are invalid or not accessible" });
				return;
			}
		}

		const result = await db.query<AgentProfileRow>(
			`UPDATE agent_profiles SET
				name = COALESCE($1, name),
				description = $2,
				icon = $3,
				system_prompt = COALESCE($4, system_prompt),
				prompt_mode = COALESCE($5, prompt_mode),
				skill_ids = $6,
				file_ids = $7,
				model_id = $8,
				provider = $9,
				starter_message = $10,
				suggested_prompts = $11,
				updated_at = now()
			WHERE id = $12
			RETURNING *`,
			[
				name ?? null,
				description !== undefined ? description : profile.description,
				icon !== undefined ? icon : profile.icon,
				system_prompt ?? null,
				prompt_mode ?? null,
				skill_ids !== undefined ? skill_ids : profile.skill_ids,
				file_ids !== undefined ? file_ids : profile.file_ids,
				model_id !== undefined ? model_id : profile.model_id,
				provider !== undefined ? provider : profile.provider,
				starter_message !== undefined ? starter_message : profile.starter_message,
				suggested_prompts !== undefined ? suggested_prompts : profile.suggested_prompts,
				req.params.id,
			],
		);

		res.json({ success: true, data: { profile: result.rows[0] } });
	}));

	// -----------------------------------------------------------------------
	// DELETE /:id — Delete an agent profile
	// -----------------------------------------------------------------------
	router.delete("/:id", asyncRoute(async (req, res) => {
		const db = getDatabase();
		const result = await db.query<AgentProfileRow>(
			`SELECT * FROM agent_profiles WHERE id = $1`,
			[req.params.id],
		);

		if (result.rows.length === 0) {
			res.status(404).json({ success: false, error: "Agent profile not found" });
			return;
		}

		const profile = result.rows[0];

		// Authorization
		const canDelete =
			((profile.scope === "platform" || profile.scope === "team") && req.user!.role === "admin") ||
			(profile.scope === "user" && profile.owner_id === req.user!.userId);

		if (!canDelete) {
			res.status(403).json({ success: false, error: "Insufficient permissions" });
			return;
		}

		await db.query(`DELETE FROM agent_profiles WHERE id = $1`, [req.params.id]);

		res.json({ success: true });
	}));

	return router;
}
