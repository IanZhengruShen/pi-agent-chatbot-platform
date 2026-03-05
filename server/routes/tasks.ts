/**
 * Tasks API Routes: CRUD + SSE endpoints for background tasks.
 *
 * Endpoints:
 * - POST   /api/tasks                      Submit new task
 * - GET    /api/tasks                      List user's tasks (paginated, filterable)
 * - GET    /api/tasks/:id                  Get task details + artifacts
 * - DELETE /api/tasks/:id                  Cancel running / delete completed
 * - POST   /api/tasks/:id/rerun            Clone as new pending task
 * - GET    /api/tasks/:id/artifacts/:aid   Download artifact file
 * - GET    /api/tasks/:id/events           SSE stream for real-time progress
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { requireAuth, requireAuthOrToken } from "../auth/middleware.js";
import { getDatabase } from "../db/index.js";
import type { TaskRow, TaskArtifactRow } from "../db/types.js";
import type { StorageService } from "../services/storage.js";
import type { CryptoService } from "../services/crypto.js";
import type { TaskQueueService } from "../services/task-queue.js";
import { asyncRoute } from "../utils/async-handler.js";
import { contentDisposition } from "../utils/sanitize-filename.js";

export function createTasksRouter(
	storage: StorageService,
	crypto: CryptoService,
	taskQueue: TaskQueueService,
): Router {
	const router = Router();
	const db = getDatabase();

	// SSE route registered FIRST (before router-level requireAuth) since it
	// needs requireAuthOrToken instead (EventSource can't set headers).
	// -----------------------------------------------------------------------
	// GET /api/tasks/:id/events — SSE stream (accepts ?token= for auth)
	// -----------------------------------------------------------------------
	router.get("/:id/events", requireAuthOrToken, (req: Request, res: Response) => {
		const taskId = req.params.id as string;
		const userId = req.user!.userId;

		// Set SSE headers
		res.setHeader("Content-Type", "text/event-stream");
		res.setHeader("Cache-Control", "no-cache");
		res.setHeader("Connection", "keep-alive");
		res.setHeader("X-Accel-Buffering", "no");
		res.flushHeaders();

		// Keep-alive ping
		const pingInterval = setInterval(() => {
			res.write(": ping\n\n");
		}, 15_000);

		// Helper to send SSE event
		const sendEvent = (event: string, data: any) => {
			res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		};

		let unsubscribeFn: (() => void) | null = null;

		function cleanup() {
			clearInterval(pingInterval);
			if (unsubscribeFn) unsubscribeFn();
			res.end();
		}

		// Check current task state
		db.query<TaskRow>(
			`SELECT * FROM tasks WHERE id = $1 AND user_id = $2`,
			[taskId, userId],
		).then(async (result) => {
			if (result.rows.length === 0) {
				sendEvent("task_error", { error: "Task not found" });
				cleanup();
				return;
			}

			const task = result.rows[0];

			// If already terminal, send final state and close
			if (["success", "failed", "cancelled", "timeout"].includes(task.status)) {
				const artifacts = await db.query<TaskArtifactRow>(
					`SELECT * FROM task_artifacts WHERE task_id = $1`,
					[taskId],
				);

				if (task.status === "success") {
					sendEvent("complete", {
						output: task.output,
						usage: task.usage,
						artifacts: artifacts.rows,
					});
				} else {
					sendEvent("task_error", {
						error: task.error,
						status: task.status,
					});
				}
				cleanup();
				return;
			}

			// Subscribe to live events
			unsubscribeFn = taskQueue.subscribe(taskId, (event) => {
				sendEvent(event.type, event.data);

				// Close on terminal events
				if (event.type === "complete" || event.type === "task_error" || event.type === "cancelled") {
					cleanup();
				}
			});

			// Send current progress if available
			if (task.progress && (task.progress.percent !== undefined || task.progress.message)) {
				sendEvent("progress", task.progress);
			}

			// Clean up on client disconnect
			req.on("close", cleanup);
		}).catch((err) => {
			console.error("[tasks-sse] Error:", err);
			sendEvent("task_error", { error: "Internal server error" });
			cleanup();
		});
	});

	// -----------------------------------------------------------------------
	// GET /api/tasks/:id/artifacts/:artifactId — Download artifact
	// Registered before requireAuth because browser downloads (target="_blank")
	// can't set Authorization header; accepts ?token= query param instead.
	// -----------------------------------------------------------------------
	router.get("/:id/artifacts/:artifactId", requireAuthOrToken, asyncRoute(async (req: Request, res: Response) => {
		// Verify task ownership
		const task = await db.query<TaskRow>(
			`SELECT id FROM tasks WHERE id = $1 AND user_id = $2`,
			[req.params.id, req.user!.userId],
		);
		if (task.rows.length === 0) {
			return res.status(404).json({ success: false, error: "Task not found" });
		}

		const artifact = await db.query<TaskArtifactRow>(
			`SELECT * FROM task_artifacts WHERE id = $1 AND task_id = $2`,
			[req.params.artifactId, req.params.id],
		);
		if (artifact.rows.length === 0) {
			return res.status(404).json({ success: false, error: "Artifact not found" });
		}

		const a = artifact.rows[0];
		const data = await storage.download(a.storage_key);

		res.setHeader("Content-Type", a.content_type || "application/octet-stream");
		res.setHeader("Content-Disposition", contentDisposition(a.filename));
		if (a.size_bytes) {
			res.setHeader("Content-Length", a.size_bytes.toString());
		}
		res.send(data);
	}));

	// All remaining routes require standard auth
	router.use(requireAuth);

	// -----------------------------------------------------------------------
	// POST /api/tasks — Submit new task
	// -----------------------------------------------------------------------
	router.post("/", asyncRoute(async (req: Request, res: Response) => {
		const { prompt, skill_ids, file_ids, model_id, provider, delivery } = req.body;

		if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
			return res.status(400).json({ success: false, error: "prompt is required" });
		}

		const result = await db.query<TaskRow>(
			`INSERT INTO tasks (user_id, team_id, prompt, skill_ids, file_ids, model_id, provider, delivery)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			 RETURNING *`,
			[
				req.user!.userId,
				req.user!.teamId,
				prompt.trim(),
				skill_ids || null,
				file_ids || null,
				model_id || null,
				provider || null,
				delivery ? JSON.stringify(delivery) : null,
			],
		);

		res.status(201).json({ success: true, data: { task: result.rows[0] } });
	}));

	// -----------------------------------------------------------------------
	// GET /api/tasks — List user's tasks
	// -----------------------------------------------------------------------
	router.get("/", asyncRoute(async (req: Request, res: Response) => {
		const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
		const offset = parseInt(req.query.offset as string) || 0;
		const statusFilter = req.query.status as string | undefined;

		// Select explicit columns excluding 'output' (can be MB-sized) for list view.
		// Use COUNT(*) OVER() window function to get total count in a single query.
		let query = `SELECT id, user_id, team_id, status, prompt, model_id, provider,
			skill_ids, file_ids, delivery, progress, error, usage,
			created_at, started_at, completed_at,
			COUNT(*) OVER() AS total_count
			FROM tasks WHERE user_id = $1`;
		const params: any[] = [req.user!.userId];

		if (statusFilter) {
			const statuses = statusFilter.split(",").map((s) => s.trim());
			params.push(statuses);
			query += ` AND status = ANY($${params.length})`;
		}

		query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
		params.push(limit, offset);

		const result = await db.query<TaskRow & { total_count: string }>(query, params);

		const total = result.rows.length > 0 ? parseInt(result.rows[0].total_count) : 0;

		res.json({
			success: true,
			data: {
				tasks: result.rows,
				total,
				limit,
				offset,
			},
		});
	}));

	// -----------------------------------------------------------------------
	// GET /api/tasks/:id — Get task details + artifacts
	// -----------------------------------------------------------------------
	router.get("/:id", asyncRoute(async (req: Request, res: Response) => {
		const task = await db.query<TaskRow>(
			`SELECT * FROM tasks WHERE id = $1 AND user_id = $2`,
			[req.params.id, req.user!.userId],
		);

		if (task.rows.length === 0) {
			return res.status(404).json({ success: false, error: "Task not found" });
		}

		const artifacts = await db.query<TaskArtifactRow>(
			`SELECT * FROM task_artifacts WHERE task_id = $1 ORDER BY created_at`,
			[req.params.id],
		);

		res.json({
			success: true,
			data: { task: task.rows[0], artifacts: artifacts.rows },
		});
	}));

	// -----------------------------------------------------------------------
	// DELETE /api/tasks/:id — Cancel running / delete completed
	// -----------------------------------------------------------------------
	router.delete("/:id", asyncRoute(async (req: Request, res: Response) => {
		const task = await db.query<TaskRow>(
			`SELECT * FROM tasks WHERE id = $1 AND user_id = $2`,
			[req.params.id, req.user!.userId],
		);

		if (task.rows.length === 0) {
			return res.status(404).json({ success: false, error: "Task not found" });
		}

		const t = task.rows[0];

		if (t.status === "pending" || t.status === "claimed" || t.status === "running") {
			// Cancel it
			const cancelled = await taskQueue.cancelTask(t.id, req.user!.userId);
			if (cancelled) {
				return res.json({ success: true, data: { action: "cancelled" } });
			}
			return res.status(409).json({ success: false, error: "Could not cancel task" });
		}

		// Terminal state — delete
		await db.query(`DELETE FROM tasks WHERE id = $1`, [t.id]);
		res.json({ success: true, data: { action: "deleted" } });
	}));

	// -----------------------------------------------------------------------
	// POST /api/tasks/:id/rerun — Clone as new pending task
	// -----------------------------------------------------------------------
	router.post("/:id/rerun", asyncRoute(async (req: Request, res: Response) => {
		const task = await db.query<TaskRow>(
			`SELECT * FROM tasks WHERE id = $1 AND user_id = $2`,
			[req.params.id, req.user!.userId],
		);

		if (task.rows.length === 0) {
			return res.status(404).json({ success: false, error: "Task not found" });
		}

		const t = task.rows[0];
		const newTask = await db.query<TaskRow>(
			`INSERT INTO tasks (user_id, team_id, prompt, skill_ids, file_ids, model_id, provider, delivery, parent_task_id)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			 RETURNING *`,
			[
				t.user_id, t.team_id, t.prompt, t.skill_ids, t.file_ids,
				t.model_id, t.provider,
				t.delivery ? JSON.stringify(t.delivery) : null,
				t.id,
			],
		);

		res.status(201).json({ success: true, data: { task: newTask.rows[0] } });
	}));

	return router;
}
