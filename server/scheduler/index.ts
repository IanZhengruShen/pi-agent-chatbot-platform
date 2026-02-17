/**
 * Scheduler Entry Point: standalone worker process.
 *
 * Usage:
 *   npm run scheduler
 *   node dist/server/scheduler/index.js
 *
 * Environment variables:
 *   DATABASE_URL - PostgreSQL connection string (required)
 *   SCHEDULER_POLL_INTERVAL_MS - Polling interval in ms (default: 30000)
 *   SCHEDULER_MAX_CONCURRENT - Max concurrent jobs (default: 5)
 *   JOB_EXECUTION_TIMEOUT_MS - Job timeout in ms (default: 300000 = 5 minutes)
 *   SMTP_HOST - SMTP server host (required for email delivery)
 *   SMTP_PORT - SMTP server port (default: 587)
 *   SMTP_SECURE - Use TLS (default: false)
 *   SMTP_USER - SMTP username (optional)
 *   SMTP_PASSWORD - SMTP password (optional)
 *   EMAIL_FROM_ADDRESS - From address for emails (default: noreply@chatbot-platform.local)
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.development" });
dotenv.config(); // also load .env if it exists (overrides nothing by default)

import { createDatabase } from "../db/index.js";
import { createCryptoService } from "../services/crypto.js";
import { createStorageService } from "../services/storage.js";
import { SchedulerWorker } from "./worker.js";

async function main() {
	console.log("[scheduler] Initializing...");

	// Initialize services
	const db = createDatabase();
	const crypto = createCryptoService();
	const storage = createStorageService();

	// Create worker
	const worker = new SchedulerWorker(db, crypto, storage);

	// Graceful shutdown handlers
	const shutdown = async () => {
		console.log("\n[scheduler] Received shutdown signal");
		await worker.shutdown();
		await db.pool.end();
		process.exit(0);
	};

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);

	// Start the worker
	await worker.start();
	console.log("[scheduler] Worker started successfully");
}

main().catch((err) => {
	console.error("[scheduler] Fatal error:", err);
	process.exit(1);
});
