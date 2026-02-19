/**
 * Bridge server entry point.
 *
 * In dev mode: runs Vite dev server + WebSocket bridge + API routes
 * In production: serves static files from dist/ + WebSocket bridge + API routes
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.development" });
dotenv.config(); // also load .env if it exists (overrides nothing by default)
import express from "express";
import { createServer } from "node:http";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { authenticateWsUpgrade } from "./auth/ws-auth.js";
import { createDatabase } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { apiRateLimit, authRateLimit } from "./middleware/rate-limit.js";
import authRouter from "./routes/auth.js";
import sessionsRouter from "./routes/sessions.js";
import settingsRouter from "./routes/settings.js";
import importRouter from "./routes/import.js";
import { createProviderKeysRouter } from "./routes/provider-keys.js";
import { createSkillsRouter } from "./routes/skills.js";
import { createFilesRouter } from "./routes/files.js";
import { createOAuthRouter } from "./routes/oauth.js";
import { createJobsRouter } from "./routes/jobs.js";
import { createTasksRouter } from "./routes/tasks.js";
import { requireAuth } from "./auth/middleware.js";
import { createCryptoService } from "./services/crypto.js";
import { ProcessPool } from "./services/process-pool.js";
import { createStorageService } from "./services/storage.js";
import { AgentExecutor } from "./services/agent-executor.js";
import { ArtifactCollector } from "./services/artifact-collector.js";
import { TaskQueueService } from "./services/task-queue.js";
import { TenantBridge, type TenantBridgeOptions } from "./agent-service.js";
import type { BridgeOptions } from "./ws-bridge.js";
import { RENDERABLE_EXTENSIONS, BINARY_EXTENSIONS } from "../src/shared/file-extensions.js";

const PORT = parseInt(process.env.PORT || "3001", 10);
const isDev = process.env.NODE_ENV !== "production";

async function main() {
	// Initialize database and run migrations
	const db = createDatabase();
	await runMigrations(db);

	// Initialize services
	const crypto = createCryptoService();
	const processPool = new ProcessPool();
	const storageService = createStorageService();
	const agentExecutor = new AgentExecutor({ db, crypto, storage: storageService });
	const artifactCollector = new ArtifactCollector(db, storageService);
	const taskQueueService = new TaskQueueService(db, storageService, agentExecutor, artifactCollector);
	await taskQueueService.start();

	const app = express();

	// Body parsing
	app.use(express.json());

	// Health check (no auth required) — includes process pool and task queue stats
	app.get("/healthz", (_req, res) => {
		res.json({ status: "ok", processPool: processPool.stats(), taskQueue: taskQueueService.stats() });
	});

	// Track active CWDs per user (for agent-files endpoint)
	const activeUserCwds = new Map<string, string>();

	// --- API Routes ---
	app.use("/api/auth", authRateLimit, authRouter);
	app.use("/api/sessions", requireAuth, apiRateLimit, sessionsRouter);
	app.use("/api/settings", requireAuth, apiRateLimit, settingsRouter);
	app.use("/api/import", requireAuth, apiRateLimit, importRouter);
	app.use("/api/provider-keys", apiRateLimit, createProviderKeysRouter(crypto));
	app.use("/api/skills", apiRateLimit, createSkillsRouter(storageService));
	app.use("/api/files", apiRateLimit, createFilesRouter(storageService));
	app.use("/api/oauth", apiRateLimit, createOAuthRouter(crypto));
	app.use("/api/jobs", apiRateLimit, createJobsRouter(storageService, crypto));
	app.use("/api/tasks", apiRateLimit, createTasksRouter(storageService, crypto, taskQueueService));

	// Read files from the agent's working directory (for rendering artifacts)
	app.get("/api/agent-files", requireAuth, apiRateLimit, async (req, res) => {
		const rawPath = req.query.path as string;
		if (!rawPath) {
			return res.status(400).json({ error: "Path required" });
		}
		// Resolve relative paths against the user's active CWD
		const userId = (req as any).user?.userId;
		const cwd = activeUserCwds.get(userId);
		let filePath: string;
		if (path.isAbsolute(rawPath)) {
			filePath = rawPath;
		} else if (cwd) {
			filePath = path.resolve(cwd, rawPath);
		} else {
			return res.status(400).json({ error: "Absolute path required (no active CWD)" });
		}
		// Only allow renderable file types
		const ext = path.extname(filePath).slice(1).toLowerCase();
		if (!RENDERABLE_EXTENSIONS.has(ext)) {
			return res.status(400).json({ error: "Unsupported file type" });
		}
		// Validate path is under user's active CWD
		if (cwd) {
			const resolved = path.resolve(filePath);
			if (!resolved.startsWith(cwd)) {
				return res.status(403).json({ error: "Path is outside working directory" });
			}
		}
		try {
			const isBinary = BINARY_EXTENSIONS.has(ext);
			if (isBinary) {
				const buffer = await fs.readFile(filePath);
				const base64Content = buffer.toString("base64");
				res.json({ content: base64Content, encoding: "base64" });
			} else {
				const content = await fs.readFile(filePath, "utf-8");
				res.json({ content, encoding: "text" });
			}
		} catch {
			res.status(404).json({ error: "File not found" });
		}
	});

	// --- WebSocket ---
	const server = createServer(app);
	const wss = new WebSocketServer({ noServer: true });

	wss.on("connection", (ws, req) => {
		// Auth user is attached by the upgrade handler
		const user = (req as any).__authUser;
		console.log(`[server] New WebSocket connection from ${user?.email || "unknown"}`);

		// Parse bridge options from query params
		const url = new URL(req.url || "/", `http://localhost:${PORT}`);
		const options: BridgeOptions = {};
		if (url.searchParams.has("cwd")) options.cwd = url.searchParams.get("cwd")!;
		if (url.searchParams.has("provider")) options.provider = url.searchParams.get("provider")!;
		if (url.searchParams.has("model")) options.model = url.searchParams.get("model")!;

		const sessionId = url.searchParams.get("sessionId") || undefined;

		// Track CWD for agent-files endpoint
		if (options.cwd) {
			activeUserCwds.set(user.userId, options.cwd);
		}

		// Use TenantBridge with server-side key management
		const tenantOptions: TenantBridgeOptions = {
			...options,
			user: {
				userId: user.userId,
				teamId: user.teamId,
				email: user.email,
				role: user.role,
			},
			sessionId,
			processPool,
			crypto,
			db,
			storage: storageService,
		};

		const bridge = new TenantBridge(ws, tenantOptions);
		bridge.start();
	});

	// WebSocket upgrade handler with JWT authentication
	const handleUpgrade = (req: any, socket: any, head: any) => {
		const pathname = new URL(req.url || "/", `http://localhost:${PORT}`).pathname;
		if (pathname === "/ws") {
			// Authenticate WebSocket upgrade
			const user = authenticateWsUpgrade(req);
			if (!user) {
				socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
				socket.destroy();
				return;
			}

			// Attach user to request for the connection handler
			req.__authUser = user;

			wss.handleUpgrade(req, socket, head, (ws) => {
				wss.emit("connection", ws, req);
			});
		} else if (isDev) {
			// In dev mode, let Vite handle non-/ws upgrades (HMR)
		} else {
			socket.destroy();
		}
	};

	if (isDev) {
		// In dev mode, use Vite's dev server as middleware.
		const { createServer: createViteServer } = await import("vite");
		const vite = await createViteServer({
			configFile: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../vite.config.ts"),
			root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
			server: {
				middlewareMode: true,
				hmr: {
					server,
				},
			},
		});

		// Vite middleware AFTER API routes so /api/* is handled first
		app.use(vite.middlewares);

		// Vite registers its own upgrade handler for HMR. We need a single
		// dispatcher that routes /ws to us and everything else to Vite.
		const viteUpgradeListeners = server.listeners("upgrade").slice();
		server.removeAllListeners("upgrade");

		server.on("upgrade", (req: any, socket: any, head: any) => {
			const pathname = new URL(req.url || "/", `http://localhost:${PORT}`).pathname;
			if (pathname === "/ws") {
				handleUpgrade(req, socket, head);
			} else {
				// Forward to Vite's HMR upgrade handler(s)
				for (const listener of viteUpgradeListeners) {
					(listener as Function).call(server, req, socket, head);
				}
			}
		});
	} else {
		// In production, serve the built files
		const distPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
		app.use(express.static(distPath));

		// SPA fallback — but not for /api/* routes
		app.get("*", (_req, res) => {
			res.sendFile(path.join(distPath, "index.html"));
		});

		server.on("upgrade", handleUpgrade);
	}

	// Graceful shutdown
	const gracefulShutdown = async (signal: string) => {
		console.log(`[server] Received ${signal}, shutting down gracefully...`);
		await taskQueueService.shutdown();
		await processPool.shutdown();
		server.close(() => {
			console.log("[server] HTTP server closed");
			process.exit(0);
		});
		// Force exit after 10s if shutdown hangs
		setTimeout(() => process.exit(1), 10_000).unref();
	};

	process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
	process.on("SIGINT", () => gracefulShutdown("SIGINT"));

	server.listen(PORT, () => {
		console.log(`[server] Chatbot Platform running at http://localhost:${PORT}`);
		if (isDev) {
			console.log("[server] Running in development mode with Vite HMR");
		}
	});
}

main().catch((err) => {
	console.error("Failed to start server:", err);
	process.exit(1);
});
