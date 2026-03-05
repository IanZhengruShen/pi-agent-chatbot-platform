/**
 * Session status tracking + SSE fan-out for background sessions.
 *
 * Maintains an in-memory cache of session statuses and notifies
 * subscribed SSE listeners when statuses change.
 */

import type { Database } from "../db/types.js";

export type SessionStatus = "generating" | "idle" | "suspended" | "dead";

export interface SessionStatusEvent {
	sessionId: string;
	status: SessionStatus;
}

type StatusListener = (event: SessionStatusEvent) => void;

export class SessionStatusService {
	private statusCache = new Map<string, SessionStatus>();
	private ownerMap = new Map<string, string>(); // sessionId → userId
	private listeners = new Map<string, Set<StatusListener>>(); // userId → listeners

	/** Update status in DB, cache, and notify listeners. */
	async setStatus(sessionId: string, status: SessionStatus, db: Database): Promise<void> {
		this.statusCache.set(sessionId, status);

		// Persist to DB (fire-and-forget style but we await for correctness)
		db.query(
			`UPDATE sessions SET session_status = $1, last_status_at = now() WHERE id = $2`,
			[status, sessionId],
		).catch((err) => {
			console.error(`[session-status] Failed to persist status for ${sessionId}:`, err);
		});

		// Notify listeners for the owning user
		const userId = this.ownerMap.get(sessionId);
		if (userId) {
			const userListeners = this.listeners.get(userId);
			if (userListeners) {
				const event: SessionStatusEvent = { sessionId, status };
				for (const listener of userListeners) {
					try { listener(event); } catch {}
				}
			}
		}
	}

	/** Get cached status. */
	getStatus(sessionId: string): SessionStatus | undefined {
		return this.statusCache.get(sessionId);
	}

	/** Get all cached statuses for a user. */
	getStatusesForUser(userId: string): Map<string, SessionStatus> {
		const result = new Map<string, SessionStatus>();
		for (const [sessionId, ownerUserId] of this.ownerMap) {
			if (ownerUserId === userId) {
				const status = this.statusCache.get(sessionId);
				if (status) {
					result.set(sessionId, status);
				}
			}
		}
		return result;
	}

	/** Subscribe to status changes for a user. Returns unsubscribe function. */
	subscribe(userId: string, listener: StatusListener): () => void {
		let userListeners = this.listeners.get(userId);
		if (!userListeners) {
			userListeners = new Set();
			this.listeners.set(userId, userListeners);
		}
		userListeners.add(listener);

		return () => {
			userListeners!.delete(listener);
			if (userListeners!.size === 0) {
				this.listeners.delete(userId);
			}
		};
	}

	/** Count generating sessions for a user. */
	async getGeneratingCount(userId: string, db: Database): Promise<number> {
		const result = await db.query<{ count: string }>(
			`SELECT COUNT(*)::text AS count FROM sessions
			 WHERE user_id = $1 AND session_status = 'generating' AND deleted_at IS NULL`,
			[userId],
		);
		return parseInt(result.rows[0].count, 10);
	}

	/** Register a session's owner for SSE routing. */
	registerOwner(sessionId: string, userId: string): void {
		this.ownerMap.set(sessionId, userId);
	}

	/** Unregister a session's owner. */
	unregisterOwner(sessionId: string): void {
		this.ownerMap.delete(sessionId);
	}
}
