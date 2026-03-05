/**
 * Process pool manager for RPC child processes.
 *
 * Manages lifecycle of pi --mode rpc processes with:
 * - Idle timeout and reaping
 * - Capacity limits
 * - Crash detection
 * - Graceful shutdown
 */

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

export interface ProcessInfo {
	id: string;
	process: ChildProcess;
	userId: string;
	teamId: string;
	sessionId: string;
	lastActivity: number;
	state: "starting" | "running" | "stopping" | "crashed";
	generating: boolean;
}

export type StopReason = "idle" | "crash" | "manual" | "shutdown";

export interface ProcessPoolEvents {
	"process-started": (info: ProcessInfo) => void;
	"process-stopped": (sessionId: string, reason: StopReason) => void;
}

export interface ProcessPoolOptions {
	maxProcesses?: number;
	idleTimeoutMs?: number;
	sweepIntervalMs?: number;
	gracePeriodMs?: number;
}

export class ProcessPool extends EventEmitter {
	private processes = new Map<string, ProcessInfo>();
	private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private sweepTimer: ReturnType<typeof setInterval> | null = null;
	private readonly maxProcesses: number;
	private readonly idleTimeoutMs: number;
	private readonly gracePeriodMs: number;

	private readonly aggressiveIdleTimeoutMs: number;

	constructor(options: ProcessPoolOptions = {}) {
		super();
		this.maxProcesses = options.maxProcesses ?? parseInt(process.env.PROCESS_POOL_MAX || "30", 10);
		this.idleTimeoutMs = options.idleTimeoutMs ?? parseInt(process.env.PROCESS_IDLE_TIMEOUT_MS || "1800000", 10);
		this.aggressiveIdleTimeoutMs = 5 * 60 * 1000; // 5 minutes when pool is near capacity
		this.gracePeriodMs = options.gracePeriodMs ?? 5000;

		const sweepInterval = options.sweepIntervalMs ?? 30_000;
		this.sweepTimer = setInterval(() => this.sweep(), sweepInterval);
		// Don't keep the process alive just for the sweep timer
		this.sweepTimer.unref();
	}

	/**
	 * Acquire a process for a session. If an alive process exists for this
	 * sessionId, returns it and resets the idle timer. Otherwise spawns a new one.
	 */
	acquire(opts: {
		sessionId: string;
		userId: string;
		teamId: string;
		spawnFn: () => ChildProcess;
	}): ProcessInfo {
		// Check for existing alive process
		const existing = this.processes.get(opts.sessionId);
		if (existing && (existing.state === "running" || existing.state === "starting")) {
			this.touch(opts.sessionId);
			return existing;
		}

		// Check capacity
		if (!this.hasCapacity()) {
			throw new PoolCapacityError(
				`Process pool at capacity (${this.maxProcesses}). Try again later.`,
			);
		}

		// Spawn new process
		const childProcess = opts.spawnFn();

		const info: ProcessInfo = {
			id: `proc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
			process: childProcess,
			userId: opts.userId,
			teamId: opts.teamId,
			sessionId: opts.sessionId,
			lastActivity: Date.now(),
			state: "starting",
			generating: false,
		};

		this.processes.set(opts.sessionId, info);

		// Mark as running once spawned successfully
		childProcess.on("spawn", () => {
			if (info.state === "starting") {
				info.state = "running";
			}
		});

		// Crash detection
		childProcess.on("exit", (code, signal) => {
			const current = this.processes.get(opts.sessionId);
			if (current !== info) return; // Already replaced

			if (info.state === "stopping") {
				// Expected stop — already handled
				return;
			}

			if (code !== 0 && code !== null) {
				info.state = "crashed";
				console.error(`[process-pool] Process crashed for session ${opts.sessionId} (code=${code}, signal=${signal})`);
				this.clearIdleTimer(opts.sessionId);
				this.processes.delete(opts.sessionId);
				this.emit("process-stopped", opts.sessionId, "crash" as StopReason);
			}
		});

		this.emit("process-started", info);
		return info;
	}

	/**
	 * Release a process back to the pool. Starts the idle timer but does NOT
	 * kill the process immediately — it can be reattached on reconnect.
	 */
	release(sessionId: string): void {
		const info = this.processes.get(sessionId);
		if (!info) return;

		info.lastActivity = Date.now();
		this.startIdleTimer(sessionId);
	}

	/** Reset the idle timer for a session (activity detected). */
	touch(sessionId: string): void {
		const info = this.processes.get(sessionId);
		if (!info) return;

		info.lastActivity = Date.now();
		this.clearIdleTimer(sessionId);
	}

	/** Mark a process as actively generating (clears idle timer). */
	markGenerating(sessionId: string): void {
		const info = this.processes.get(sessionId);
		if (!info) return;
		info.generating = true;
		info.lastActivity = Date.now();
		this.clearIdleTimer(sessionId);
	}

	/** Mark a process as idle (starts idle timer). */
	markIdle(sessionId: string): void {
		const info = this.processes.get(sessionId);
		if (!info) return;
		info.generating = false;
		info.lastActivity = Date.now();
		this.startIdleTimer(sessionId);
	}

	/** Get a process by session ID. */
	get(sessionId: string): ProcessInfo | null {
		const info = this.processes.get(sessionId);
		if (!info) return null;
		if (info.state === "crashed" || info.state === "stopping") return null;
		return info;
	}

	/** Check if there's room for another process. */
	hasCapacity(): boolean {
		return this.activeCount() < this.maxProcesses;
	}

	/** Get pool stats. */
	stats(): { active: number; max: number } {
		return { active: this.activeCount(), max: this.maxProcesses };
	}

	/**
	 * Gracefully shut down all processes: SIGTERM → grace period → SIGKILL.
	 */
	async shutdown(): Promise<void> {
		if (this.sweepTimer) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = null;
		}

		// Clear all idle timers
		for (const [sessionId] of this.idleTimers) {
			this.clearIdleTimer(sessionId);
		}

		const entries = Array.from(this.processes.entries());
		if (entries.length === 0) return;

		console.log(`[process-pool] Shutting down ${entries.length} process(es)...`);

		// Send SIGTERM to all
		for (const [, info] of entries) {
			info.state = "stopping";
			try { info.process.kill("SIGTERM"); } catch {}
		}

		// Wait for grace period, then SIGKILL any survivors
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				for (const [sessionId, info] of entries) {
					try { info.process.kill("SIGKILL"); } catch {}
					this.processes.delete(sessionId);
					this.emit("process-stopped", sessionId, "shutdown" as StopReason);
				}
				resolve();
			}, this.gracePeriodMs);

			// Check periodically if all have exited
			let remaining = entries.length;
			for (const [sessionId, info] of entries) {
				info.process.on("exit", () => {
					this.processes.delete(sessionId);
					this.emit("process-stopped", sessionId, "shutdown" as StopReason);
					remaining--;
					if (remaining === 0) {
						clearTimeout(timeout);
						resolve();
					}
				});
			}
		});
	}

	// =========================================================================
	// Internal
	// =========================================================================

	private activeCount(): number {
		let count = 0;
		for (const [, info] of this.processes) {
			if (info.state === "running" || info.state === "starting") count++;
		}
		return count;
	}

	private startIdleTimer(sessionId: string): void {
		this.clearIdleTimer(sessionId);
		this.idleTimers.set(
			sessionId,
			setTimeout(() => this.reapIdle(sessionId), this.idleTimeoutMs),
		);
	}

	private clearIdleTimer(sessionId: string): void {
		const timer = this.idleTimers.get(sessionId);
		if (timer) {
			clearTimeout(timer);
			this.idleTimers.delete(sessionId);
		}
	}

	/** Periodic sweep: reap processes that have been idle too long. */
	private sweep(): void {
		const now = Date.now();
		// Use aggressive timeout when pool is near capacity (>=80%)
		const highLoad = this.activeCount() / this.maxProcesses >= 0.8;
		const timeout = highLoad ? this.aggressiveIdleTimeoutMs : this.idleTimeoutMs;

		for (const [sessionId, info] of this.processes) {
			if (info.generating) continue; // Never reap generating processes
			if (
				(info.state === "running" || info.state === "starting") &&
				now - info.lastActivity > timeout &&
				!this.idleTimers.has(sessionId)
			) {
				this.reapIdle(sessionId);
			}
		}
	}

	/** Kill an idle process: SIGTERM → grace → SIGKILL. */
	private reapIdle(sessionId: string): void {
		const info = this.processes.get(sessionId);
		if (!info || info.state === "stopping") return;
		if (info.generating) return; // Never reap generating processes

		console.log(`[process-pool] Reaping idle process for session ${sessionId}`);
		info.state = "stopping";
		this.clearIdleTimer(sessionId);

		try { info.process.kill("SIGTERM"); } catch {}

		const forceKillTimer = setTimeout(() => {
			try { info.process.kill("SIGKILL"); } catch {}
		}, this.gracePeriodMs);

		info.process.on("exit", () => {
			clearTimeout(forceKillTimer);
			this.processes.delete(sessionId);
			this.emit("process-stopped", sessionId, "idle" as StopReason);
		});
	}
}

export class PoolCapacityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PoolCapacityError";
	}
}
