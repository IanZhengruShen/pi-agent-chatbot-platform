/**
 * Jobs API Routes: CRUD endpoints for scheduled jobs.
 *
 * Authorization:
 * - User-scoped jobs: User owns, full CRUD access
 * - Team-scoped jobs: Admin creates/updates/deletes, all members view
 *
 * Endpoints:
 * - GET /api/jobs - List jobs (user's own + team if member)
 * - POST /api/jobs - Create job
 * - GET /api/jobs/:id - Get job details
 * - PATCH /api/jobs/:id - Update job
 * - DELETE /api/jobs/:id - Delete job
 * - POST /api/jobs/:id/trigger - Manually trigger job now
 * - GET /api/jobs/:id/runs - Paginated job run history
 */

import { Router } from "express";
import { randomUUID } from "crypto";
import type { Request, Response } from "express";
import { Cron } from "croner";
import type { ScheduledJobRow, JobRunRow, SkillRow, UserFileRow } from "../db/types.js";
import { getDatabase } from "../db/index.js";
import { requireAuth } from "../auth/middleware.js";
import { isOwner } from "../auth/permissions.js";
import type { CryptoService } from "../services/crypto.js";
import type { StorageService } from "../services/storage.js";
import { executeJob } from "../scheduler/job-executor.js";
import { deliverResult } from "../scheduler/delivery.js";

export function createJobsRouter(storage: StorageService, crypto: CryptoService): Router {
	const router = Router();

	// All routes require authentication
	router.use(requireAuth);

	// ---------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------

	/**
	 * Check if user can access a job (owner or team member).
	 */
	async function canAccessJob(req: Request, job: ScheduledJobRow): Promise<boolean> {
		if (job.owner_type === "user") {
			return isOwner(req, job.owner_id);
		} else if (job.owner_type === "team") {
			// Check if user is member of the team
			return req.user!.teamId === job.owner_id;
		}
		return false;
	}

	/**
	 * Check if user can modify a job (owner for user-scoped, admin for team-scoped).
	 */
	async function canModifyJob(req: Request, job: ScheduledJobRow): Promise<boolean> {
		if (job.owner_type === "user") {
			return isOwner(req, job.owner_id);
		} else if (job.owner_type === "team") {
			return req.user!.teamId === job.owner_id && req.user!.role === "admin";
		}
		return false;
	}

	/**
	 * Validate cron expression and return next run time.
	 */
	function validateCronExpression(cronExpr: string): Date | null {
		try {
			const cron = new Cron(cronExpr);
			const next = cron.nextRun();
			return next || null;
		} catch {
			return null;
		}
	}

	/**
	 * Validate email format.
	 */
	function isValidEmail(email: string): boolean {
		return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
	}

	/**
	 * Validate HTTPS URL.
	 */
	function isValidHttpsUrl(url: string): boolean {
		try {
			const parsed = new URL(url);
			return parsed.protocol === "https:";
		} catch {
			return false;
		}
	}

	// ---------------------------------------------------------------------------
	// 1. GET / — List jobs (user's own + team if member)
	// ---------------------------------------------------------------------------
	router.get("/", async (req: Request, res: Response) => {
		try {
			const db = getDatabase();
			const result = await db.query<ScheduledJobRow>(
				`SELECT * FROM scheduled_jobs
				 WHERE (owner_type = 'user' AND owner_id = $1)
				    OR (owner_type = 'team' AND owner_id = $2)
				 ORDER BY created_at DESC`,
				[req.user!.userId, req.user!.teamId],
			);

			res.json({ success: true, data: { jobs: result.rows } });
		} catch (err) {
			console.error("[jobs] GET / error:", err);
			res.status(500).json({ success: false, error: "Internal server error" });
		}
	});

	// ---------------------------------------------------------------------------
	// 2. POST / — Create a new job
	// ---------------------------------------------------------------------------
	router.post("/", async (req: Request, res: Response) => {
		try {
			const db = getDatabase();
			const {
				owner_type,
				name,
				description,
				cron_expr,
				prompt,
				skill_ids,
				file_ids,
				model_id,
				provider,
				delivery,
			} = req.body;

			// Validate required fields
			if (!name || !cron_expr || !prompt || !delivery) {
				return res.status(400).json({
					success: false,
					error: "Missing required fields: name, cron_expr, prompt, delivery",
				});
			}

			// Validate owner_type
			const ownerType = owner_type || "user";
			if (ownerType !== "user" && ownerType !== "team") {
				return res.status(400).json({ success: false, error: "owner_type must be 'user' or 'team'" });
			}

			// Check permissions for team-scoped jobs
			if (ownerType === "team" && req.user!.role !== "admin") {
				return res.status(403).json({ success: false, error: "Only admins can create team-scoped jobs" });
			}

			const ownerId = ownerType === "user" ? req.user!.userId : req.user!.teamId;

			// Validate cron expression
			const nextRunAt = validateCronExpression(cron_expr);
			if (!nextRunAt) {
				return res.status(400).json({ success: false, error: "Invalid cron expression" });
			}

			// Validate delivery config
			if (delivery.type === "email") {
				if (!delivery.to || !isValidEmail(delivery.to)) {
					return res.status(400).json({ success: false, error: "Invalid email address" });
				}
			} else if (delivery.type === "teams") {
				if (!delivery.webhook || !isValidHttpsUrl(delivery.webhook)) {
					return res.status(400).json({ success: false, error: "Invalid Teams webhook URL (must be HTTPS)" });
				}
			} else {
				return res.status(400).json({ success: false, error: "delivery.type must be 'email' or 'teams'" });
			}

			// Validate skill_ids (if provided)
			if (skill_ids && skill_ids.length > 0) {
				const skillResult = await db.query<SkillRow>(
					`SELECT id FROM skills
					 WHERE id = ANY($1)
					   AND ((scope = 'platform')
					     OR (scope = 'team' AND owner_id = $2)
					     OR (scope = 'user' AND owner_id = $3))`,
					[skill_ids, req.user!.teamId, req.user!.userId],
				);

				if (skillResult.rows.length !== skill_ids.length) {
					return res.status(400).json({
						success: false,
						error: "One or more skill_ids are invalid or inaccessible",
					});
				}
			}

			// Validate file_ids (if provided)
			if (file_ids && file_ids.length > 0) {
				const fileResult = await db.query<UserFileRow>(
					`SELECT id FROM user_files WHERE id = ANY($1) AND user_id = $2`,
					[file_ids, req.user!.userId],
				);

				if (fileResult.rows.length !== file_ids.length) {
					return res.status(400).json({
						success: false,
						error: "One or more file_ids are invalid or do not belong to you",
					});
				}
			}

			// Create the job
			const jobId = randomUUID();
			const result = await db.query<ScheduledJobRow>(
				`INSERT INTO scheduled_jobs (
					id, owner_type, owner_id, name, description, cron_expr, next_run_at,
					prompt, skill_ids, file_ids, model_id, provider, delivery, created_by
				 )
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
				 RETURNING *`,
				[
					jobId,
					ownerType,
					ownerId,
					name,
					description || null,
					cron_expr,
					nextRunAt,
					prompt,
					skill_ids || null,
					file_ids || null,
					model_id || null,
					provider || null,
					JSON.stringify(delivery),
					req.user!.userId,
				],
			);

			res.status(201).json({ success: true, data: { job: result.rows[0] } });
		} catch (err) {
			console.error("[jobs] POST / error:", err);
			res.status(500).json({ success: false, error: "Internal server error" });
		}
	});

	// ---------------------------------------------------------------------------
	// 3. GET /:id — Get job details
	// ---------------------------------------------------------------------------
	router.get("/:id", async (req: Request, res: Response) => {
		try {
			const db = getDatabase();
			const { id } = req.params;

			const result = await db.query<ScheduledJobRow>(
				`SELECT * FROM scheduled_jobs WHERE id = $1`,
				[id],
			);

			if (result.rows.length === 0) {
				return res.status(404).json({ success: false, error: "Job not found" });
			}

			const job = result.rows[0];

			if (!(await canAccessJob(req, job))) {
				return res.status(403).json({ success: false, error: "Forbidden" });
			}

			res.json({ success: true, data: { job } });
		} catch (err) {
			console.error("[jobs] GET /:id error:", err);
			res.status(500).json({ success: false, error: "Internal server error" });
		}
	});

	// ---------------------------------------------------------------------------
	// 4. PATCH /:id — Update job
	// ---------------------------------------------------------------------------
	router.patch("/:id", async (req: Request, res: Response) => {
		try {
			const db = getDatabase();
			const { id } = req.params;

			// Fetch existing job
			const existing = await db.query<ScheduledJobRow>(
				`SELECT * FROM scheduled_jobs WHERE id = $1`,
				[id],
			);

			if (existing.rows.length === 0) {
				return res.status(404).json({ success: false, error: "Job not found" });
			}

			const job = existing.rows[0];

			if (!(await canModifyJob(req, job))) {
				return res.status(403).json({ success: false, error: "Forbidden" });
			}

			// Build update query dynamically
			const updates: string[] = [];
			const values: any[] = [];
			let paramIndex = 1;

			const {
				name,
				description,
				cron_expr,
				prompt,
				skill_ids,
				file_ids,
				model_id,
				provider,
				delivery,
				enabled,
			} = req.body;

			if (name !== undefined) {
				updates.push(`name = $${paramIndex++}`);
				values.push(name);
			}

			if (description !== undefined) {
				updates.push(`description = $${paramIndex++}`);
				values.push(description);
			}

			if (cron_expr !== undefined) {
				const nextRunAt = validateCronExpression(cron_expr);
				if (!nextRunAt) {
					return res.status(400).json({ success: false, error: "Invalid cron expression" });
				}
				updates.push(`cron_expr = $${paramIndex++}`);
				values.push(cron_expr);
				updates.push(`next_run_at = $${paramIndex++}`);
				values.push(nextRunAt);
			}

			if (prompt !== undefined) {
				updates.push(`prompt = $${paramIndex++}`);
				values.push(prompt);
			}

			if (skill_ids !== undefined) {
				// Validate skill_ids
				if (skill_ids && skill_ids.length > 0) {
					const skillResult = await db.query<SkillRow>(
						`SELECT id FROM skills
						 WHERE id = ANY($1)
						   AND ((scope = 'platform')
						     OR (scope = 'team' AND owner_id = $2)
						     OR (scope = 'user' AND owner_id = $3))`,
						[skill_ids, req.user!.teamId, req.user!.userId],
					);

					if (skillResult.rows.length !== skill_ids.length) {
						return res.status(400).json({
							success: false,
							error: "One or more skill_ids are invalid or inaccessible",
						});
					}
				}

				updates.push(`skill_ids = $${paramIndex++}`);
				values.push(skill_ids);
			}

			if (file_ids !== undefined) {
				// Validate file_ids
				if (file_ids && file_ids.length > 0) {
					const fileResult = await db.query<UserFileRow>(
						`SELECT id FROM user_files WHERE id = ANY($1) AND user_id = $2`,
						[file_ids, req.user!.userId],
					);

					if (fileResult.rows.length !== file_ids.length) {
						return res.status(400).json({
							success: false,
							error: "One or more file_ids are invalid or do not belong to you",
						});
					}
				}

				updates.push(`file_ids = $${paramIndex++}`);
				values.push(file_ids);
			}

			if (model_id !== undefined) {
				updates.push(`model_id = $${paramIndex++}`);
				values.push(model_id);
			}

			if (provider !== undefined) {
				updates.push(`provider = $${paramIndex++}`);
				values.push(provider);
			}

			if (delivery !== undefined) {
				// Validate delivery config
				if (delivery.type === "email") {
					if (!delivery.to || !isValidEmail(delivery.to)) {
						return res.status(400).json({ success: false, error: "Invalid email address" });
					}
				} else if (delivery.type === "teams") {
					if (!delivery.webhook || !isValidHttpsUrl(delivery.webhook)) {
						return res.status(400).json({ success: false, error: "Invalid Teams webhook URL" });
					}
				} else {
					return res.status(400).json({ success: false, error: "delivery.type must be 'email' or 'teams'" });
				}

				updates.push(`delivery = $${paramIndex++}`);
				values.push(JSON.stringify(delivery));
			}

			if (enabled !== undefined) {
				updates.push(`enabled = $${paramIndex++}`);
				values.push(enabled);
				// Reset failure count when re-enabling
				if (enabled) {
					updates.push(`failure_count = 0`);
				}
			}

			if (updates.length === 0) {
				return res.status(400).json({ success: false, error: "No fields to update" });
			}

			updates.push(`updated_at = now()`);
			values.push(id);

			const result = await db.query<ScheduledJobRow>(
				`UPDATE scheduled_jobs SET ${updates.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
				values,
			);

			res.json({ success: true, data: { job: result.rows[0] } });
		} catch (err) {
			console.error("[jobs] PATCH /:id error:", err);
			res.status(500).json({ success: false, error: "Internal server error" });
		}
	});

	// ---------------------------------------------------------------------------
	// 5. DELETE /:id — Delete job
	// ---------------------------------------------------------------------------
	router.delete("/:id", async (req: Request, res: Response) => {
		try {
			const db = getDatabase();
			const { id } = req.params;

			// Fetch existing job
			const existing = await db.query<ScheduledJobRow>(
				`SELECT * FROM scheduled_jobs WHERE id = $1`,
				[id],
			);

			if (existing.rows.length === 0) {
				return res.status(404).json({ success: false, error: "Job not found" });
			}

			const job = existing.rows[0];

			if (!(await canModifyJob(req, job))) {
				return res.status(403).json({ success: false, error: "Forbidden" });
			}

			await db.query(`DELETE FROM scheduled_jobs WHERE id = $1`, [id]);

			res.json({ success: true, data: { message: "Job deleted" } });
		} catch (err) {
			console.error("[jobs] DELETE /:id error:", err);
			res.status(500).json({ success: false, error: "Internal server error" });
		}
	});

	// ---------------------------------------------------------------------------
	// 6. POST /:id/trigger — Manually trigger job now
	// ---------------------------------------------------------------------------
	router.post("/:id/trigger", async (req: Request, res: Response) => {
		try {
			const db = getDatabase();
			const { id } = req.params;

			// Fetch existing job
			const existing = await db.query<ScheduledJobRow>(
				`SELECT * FROM scheduled_jobs WHERE id = $1`,
				[id],
			);

			if (existing.rows.length === 0) {
				return res.status(404).json({ success: false, error: "Job not found" });
			}

			const job = existing.rows[0];

			if (!(await canAccessJob(req, job))) {
				return res.status(403).json({ success: false, error: "Forbidden" });
			}

			// Execute the job asynchronously (don't block the response)
			const runId = randomUUID();
			await db.query(
				`INSERT INTO job_runs (id, job_id, status) VALUES ($1, $2, 'running')`,
				[runId, job.id],
			);

			// Execute in background
			(async () => {
				try {
					const execResult = await executeJob(job, db, storage, crypto);
					const deliveryResult = await deliverResult(job.delivery, job.name, execResult);

					const finalStatus = deliveryResult.status === "failed" ? "failed" : execResult.status;
					const finalError = deliveryResult.status === "failed"
						? `Delivery failed: ${deliveryResult.error}`
						: execResult.error;

					let truncatedOutput = execResult.output;
					if (truncatedOutput && truncatedOutput.length > 50_000) {
						truncatedOutput = truncatedOutput.substring(0, 50_000) + "\n\n[Output truncated]";
					}

					await db.query(
						`UPDATE job_runs
						 SET finished_at = now(),
						     status = $1,
						     result = $2,
						     error = $3,
						     usage = $4,
						     delivery_status = $5,
						     delivery_error = $6
						 WHERE id = $7`,
						[
							finalStatus,
							JSON.stringify({ output: truncatedOutput }),
							finalError,
							JSON.stringify(execResult.usage),
							deliveryResult.status,
							deliveryResult.error,
							runId,
						],
					);
				} catch (err: any) {
					console.error(`[jobs] Manual trigger failed for job ${id}:`, err);
					await db.query(
						`UPDATE job_runs SET finished_at = now(), status = 'failed', error = $1 WHERE id = $2`,
						[err.message || String(err), runId],
					).catch(() => {});
				}
			})();

			res.json({ success: true, data: { message: "Job triggered", runId } });
		} catch (err) {
			console.error("[jobs] POST /:id/trigger error:", err);
			res.status(500).json({ success: false, error: "Internal server error" });
		}
	});

	// ---------------------------------------------------------------------------
	// 7. GET /:id/runs — Paginated job run history
	// ---------------------------------------------------------------------------
	router.get("/:id/runs", async (req: Request, res: Response) => {
		try {
			const db = getDatabase();
			const { id } = req.params;

			// Fetch existing job
			const existing = await db.query<ScheduledJobRow>(
				`SELECT * FROM scheduled_jobs WHERE id = $1`,
				[id],
			);

			if (existing.rows.length === 0) {
				return res.status(404).json({ success: false, error: "Job not found" });
			}

			const job = existing.rows[0];

			if (!(await canAccessJob(req, job))) {
				return res.status(403).json({ success: false, error: "Forbidden" });
			}

			// Pagination
			const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
			const offset = parseInt(req.query.offset as string) || 0;

			const result = await db.query<JobRunRow>(
				`SELECT * FROM job_runs
				 WHERE job_id = $1
				 ORDER BY started_at DESC
				 LIMIT $2 OFFSET $3`,
				[id, limit, offset],
			);

			res.json({ success: true, data: { runs: result.rows, limit, offset } });
		} catch (err) {
			console.error("[jobs] GET /:id/runs error:", err);
			res.status(500).json({ success: false, error: "Internal server error" });
		}
	});

	return router;
}
