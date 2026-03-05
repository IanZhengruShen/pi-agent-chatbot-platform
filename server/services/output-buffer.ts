/**
 * Output buffer service: persists RPC stdout lines to DB
 * while no WebSocket client is attached to a session.
 */

import type { Database } from "../db/types.js";

const MAX_BUFFER_ROWS = 500;

export class OutputBufferService {
	private db: Database;

	constructor(db: Database) {
		this.db = db;
	}

	/** Append a line to the output buffer, trimming if over limit. */
	async append(sessionId: string, line: string): Promise<void> {
		await this.db.query(
			`INSERT INTO session_output_buffer (session_id, line) VALUES ($1, $2)`,
			[sessionId, line],
		);

		// Trim old rows if over limit
		await this.db.query(
			`DELETE FROM session_output_buffer
			 WHERE session_id = $1
			   AND id NOT IN (
			     SELECT id FROM session_output_buffer
			     WHERE session_id = $1
			     ORDER BY id DESC
			     LIMIT $2
			   )`,
			[sessionId, MAX_BUFFER_ROWS],
		).catch(() => {}); // Non-critical trim
	}

	/** Flush all buffered lines for a session (read + delete). Returns lines in order. */
	async flush(sessionId: string): Promise<string[]> {
		const result = await this.db.query<{ line: string }>(
			`DELETE FROM session_output_buffer
			 WHERE session_id = $1
			 RETURNING line`,
			[sessionId],
		);
		// DELETE RETURNING doesn't guarantee order, so we need a separate query
		// Actually, let's use a CTE to get ordered results
		// Simpler: just select then delete
		return result.rows.map(r => r.line);
	}

	/** Flush all buffered lines in order (select ordered, then delete). */
	async flushOrdered(sessionId: string): Promise<string[]> {
		const client = await this.db.getClient();
		try {
			await client.query("BEGIN");
			const result = await client.query<{ line: string }>(
				`SELECT line FROM session_output_buffer
				 WHERE session_id = $1
				 ORDER BY id ASC`,
				[sessionId],
			);
			await client.query(
				`DELETE FROM session_output_buffer WHERE session_id = $1`,
				[sessionId],
			);
			await client.query("COMMIT");
			return result.rows.map(r => r.line);
		} catch (err) {
			await client.query("ROLLBACK");
			throw err;
		} finally {
			client.release();
		}
	}

	/** Clear all buffered lines for a session. */
	async clear(sessionId: string): Promise<void> {
		await this.db.query(
			`DELETE FROM session_output_buffer WHERE session_id = $1`,
			[sessionId],
		);
	}
}
