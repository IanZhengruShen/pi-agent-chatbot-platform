import { Pool } from "pg";
import type { Database } from "./types.js";

let _db: Database | null = null;

/** Create and return a Database singleton. Call once at startup. */
export function createDatabase(connectionString?: string): Database {
	if (_db) return _db;

	const pool = new Pool({
		connectionString: connectionString || process.env.DATABASE_URL,
		max: 20,
		idleTimeoutMillis: 30_000,
		connectionTimeoutMillis: 5_000,
	});

	pool.on("error", (err) => {
		console.error("[db] Unexpected pool error:", err.message);
	});

	const db: Database = {
		pool,
		query: (text, params) => pool.query(text, params),
		getClient: () => pool.connect(),
	};

	_db = db;
	return db;
}

/** Get the existing Database singleton. Throws if not yet created. */
export function getDatabase(): Database {
	if (!_db) {
		throw new Error("Database not initialized. Call createDatabase() first.");
	}
	return _db;
}
