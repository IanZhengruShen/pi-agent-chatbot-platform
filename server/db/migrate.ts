import * as fs from "node:fs";
import * as path from "node:path";
import type { Database } from "./types.js";

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "migrations");

/**
 * Run all pending SQL migrations.
 *
 * Migrations are `.sql` files in server/db/migrations/, sorted by filename.
 * A `_migrations` table tracks which have already been applied.
 * Each migration runs inside a transaction.
 */
export async function runMigrations(db: Database): Promise<void> {
	// Ensure the tracking table exists
	await db.query(`
		CREATE TABLE IF NOT EXISTS _migrations (
			name TEXT PRIMARY KEY,
			applied_at TIMESTAMPTZ DEFAULT now()
		)
	`);

	// Find already-applied migrations
	const { rows: applied } = await db.query<{ name: string }>(
		"SELECT name FROM _migrations ORDER BY name",
	);
	const appliedSet = new Set(applied.map((r) => r.name));

	// Read migration files, sorted by name
	const files = fs
		.readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort();

	let count = 0;
	for (const file of files) {
		if (appliedSet.has(file)) continue;

		const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
		const client = await db.getClient();

		try {
			await client.query("BEGIN");
			await client.query(sql);
			await client.query("INSERT INTO _migrations (name) VALUES ($1)", [file]);
			await client.query("COMMIT");
			console.log(`[migrate] Applied: ${file}`);
			count++;
		} catch (err) {
			await client.query("ROLLBACK");
			console.error(`[migrate] Failed on ${file}:`, err);
			throw err;
		} finally {
			client.release();
		}
	}

	if (count === 0) {
		console.log("[migrate] No pending migrations.");
	} else {
		console.log(`[migrate] Applied ${count} migration(s).`);
	}
}

// Allow running directly: npx tsx server/db/migrate.ts
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
	const dotenv = await import("dotenv");
	dotenv.config({ path: path.resolve(import.meta.dirname, "../../.env.development") });

	if (!process.env.DATABASE_URL) {
		console.error("[migrate] DATABASE_URL is not set. Copy .env.development.example to .env.development");
		process.exit(1);
	}

	const { createDatabase } = await import("./index.js");
	const db = createDatabase();

	runMigrations(db)
		.then(() => {
			console.log("[migrate] Done.");
			process.exit(0);
		})
		.catch((err) => {
			console.error("[migrate] Fatal:", err);
			process.exit(1);
		});
}
