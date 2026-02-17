/**
 * Scheduler Worker: polls for due jobs and executes them.
 *
 * Architecture:
 * - Polls PostgreSQL every 30s for jobs where next_run_at <= now()
 * - Atomic job claiming via FOR UPDATE SKIP LOCKED
 * - Concurrency limit: 5 jobs executing simultaneously
 * - Calculates next_run_at using croner library
 * - Tracks failures and auto-disables after 3 consecutive failures
 * - Graceful shutdown waits for in-flight jobs
 */

import { Cron } from "croner";
import type { Database, JobRunRow, ScheduledJobRow } from "../db/types.js";
import type { CryptoService } from "../services/crypto.js";
import type { StorageService } from "../services/storage.js";
import { executeJob } from "./job-executor.js";
import { deliverResult } from "./delivery.js";

const POLL_INTERVAL_MS = parseInt(process.env.SCHEDULER_POLL_INTERVAL_MS || "30000", 10);
const MAX_CONCURRENT_JOBS = parseInt(process.env.SCHEDULER_MAX_CONCURRENT || "5", 10);

export class SchedulerWorker {
	private db: Database;
	private crypto: CryptoService;
	private storage: StorageService;
	private pollingTimer?: ReturnType<typeof setInterval>;
	private activeJobs = new Map<string, Promise<void>>();
	private stopping = false;

	constructor(db: Database, crypto: CryptoService, storage: StorageService) {
		this.db = db;
		this.crypto = crypto;
		this.storage = storage;
	}

	/**
	 * Start the scheduler worker.
	 */
	async start(): Promise<void> {
		console.log(`[scheduler] Starting worker (poll interval: ${POLL_INTERVAL_MS}ms, max concurrent: ${MAX_CONCURRENT_JOBS})`);

		// Immediate first poll
		await this.pollAndExecute();

		// Schedule recurring polls
		this.pollingTimer = setInterval(() => {
			this.pollAndExecute().catch((err) => {
				console.error("[scheduler] Poll cycle failed:", err);
			});
		}, POLL_INTERVAL_MS);

		// Don't block process exit
		this.pollingTimer.unref();
	}

	/**
	 * Gracefully shut down the worker.
	 */
	async shutdown(): Promise<void> {
		console.log("[scheduler] Shutting down...");
		this.stopping = true;

		// Stop polling
		if (this.pollingTimer) {
			clearInterval(this.pollingTimer);
			this.pollingTimer = undefined;
		}

		// Wait for in-flight jobs
		if (this.activeJobs.size > 0) {
			console.log(`[scheduler] Waiting for ${this.activeJobs.size} in-flight job(s)...`);
			await Promise.all(this.activeJobs.values());
		}

		console.log("[scheduler] Shutdown complete");
	}

	/**
	 * Poll for due jobs and execute them (respecting concurrency limit).
	 */
	private async pollAndExecute(): Promise<void> {
		if (this.stopping) return;

		// Check capacity
		const available = MAX_CONCURRENT_JOBS - this.activeJobs.size;
		if (available <= 0) {
			return; // At capacity
		}

		// Claim up to 'available' jobs atomically
		for (let i = 0; i < available; i++) {
			const job = await this.claimNextJob();
			if (!job) break; // No more jobs

			// Execute in background
			const execution = this.executeAndDeliver(job);
			this.activeJobs.set(job.id, execution);
			execution.finally(() => this.activeJobs.delete(job.id));
		}
	}

	/**
	 * Atomically claim the next due job using FOR UPDATE SKIP LOCKED.
	 */
	private async claimNextJob(): Promise<ScheduledJobRow | null> {
		try {
			const result = await this.db.query<ScheduledJobRow>(
				`UPDATE scheduled_jobs
				 SET last_run_at = now(),
				     next_run_at = $1
				 WHERE id = (
				   SELECT id FROM scheduled_jobs
				   WHERE enabled = true AND next_run_at <= now()
				   ORDER BY next_run_at
				   LIMIT 1
				   FOR UPDATE SKIP LOCKED
				 )
				 RETURNING *`,
				[new Date(Date.now() + 60_000)], // Temporary next_run_at (1 minute from now, will be recalculated after execution)
			);

			if (result.rows.length === 0) {
				return null;
			}

			const job = result.rows[0];
			console.log(`[scheduler] Claimed job ${job.id} ("${job.name}")`);
			return job;
		} catch (err) {
			console.error("[scheduler] Failed to claim job:", err);
			return null;
		}
	}

	/**
	 * Execute a job, deliver results, and update database.
	 */
	private async executeAndDeliver(job: ScheduledJobRow): Promise<void> {
		const runId = crypto.randomUUID();

		try {
			// Create job run record
			await this.db.query(
				`INSERT INTO job_runs (id, job_id, status) VALUES ($1, $2, 'running')`,
				[runId, job.id],
			);

			// Execute the job
			const execResult = await executeJob(job, this.db, this.storage, this.crypto);

			// Deliver the result
			const deliveryResult = await deliverResult(job.delivery, job.name, execResult);

			// Strict mode: failed delivery = failed job
			const finalStatus = deliveryResult.status === "failed" ? "failed" : execResult.status;
			const finalError = deliveryResult.status === "failed"
				? `Delivery failed: ${deliveryResult.error}`
				: execResult.error;

			// Truncate result if too large (>50KB)
			let truncatedOutput = execResult.output;
			if (truncatedOutput && truncatedOutput.length > 50_000) {
				truncatedOutput = truncatedOutput.substring(0, 50_000) + "\n\n[Output truncated]";
			}

			// Update job run record
			await this.db.query(
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

			// Update job with last status and failure tracking
			const newFailureCount = finalStatus === "success" ? 0 : job.failure_count + 1;
			const shouldDisable = newFailureCount >= 3;

			// Calculate next run time using croner
			const nextRunAt = shouldDisable ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) : calculateNextRun(job.cron_expr);

			await this.db.query(
				`UPDATE scheduled_jobs
				 SET last_status = $1,
				     last_error = $2,
				     failure_count = $3,
				     enabled = $4,
				     next_run_at = $5,
				     updated_at = now()
				 WHERE id = $6`,
				[finalStatus, finalError, newFailureCount, !shouldDisable, nextRunAt, job.id],
			);

			if (shouldDisable) {
				console.error(`[scheduler] Job ${job.id} ("${job.name}") auto-disabled after 3 consecutive failures`);
			}

			console.log(`[scheduler] Job ${job.id} ("${job.name}") completed: ${finalStatus}`);
		} catch (err: any) {
			console.error(`[scheduler] Failed to execute job ${job.id}:`, err);

			// Record failure in job_runs
			await this.db.query(
				`UPDATE job_runs
				 SET finished_at = now(),
				     status = 'failed',
				     error = $1
				 WHERE id = $2`,
				[err.message || String(err), runId],
			).catch(() => {}); // Best effort

			// Update job failure count
			const newFailureCount = job.failure_count + 1;
			const shouldDisable = newFailureCount >= 3;
			const nextRunAt = shouldDisable ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) : calculateNextRun(job.cron_expr);

			await this.db.query(
				`UPDATE scheduled_jobs
				 SET last_status = 'failed',
				     last_error = $1,
				     failure_count = $2,
				     enabled = $3,
				     next_run_at = $4,
				     updated_at = now()
				 WHERE id = $5`,
				[err.message || String(err), newFailureCount, !shouldDisable, nextRunAt, job.id],
			).catch(() => {}); // Best effort
		}
	}
}

/**
 * Calculate the next run time for a cron expression using croner.
 */
function calculateNextRun(cronExpr: string): Date {
	try {
		const cron = new Cron(cronExpr);
		const next = cron.nextRun();
		if (!next) {
			throw new Error("No next run calculated");
		}
		return next;
	} catch (err) {
		console.error(`[scheduler] Invalid cron expression "${cronExpr}":`, err);
		// Fallback: 24 hours from now
		return new Date(Date.now() + 24 * 60 * 60 * 1000);
	}
}
