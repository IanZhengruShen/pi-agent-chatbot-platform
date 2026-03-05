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
import helmet from "helmet";
import cors from "cors";
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
import { createSessionsRouter } from "./routes/sessions.js";
import settingsRouter from "./routes/settings.js";
import importRouter from "./routes/import.js";
import { createProviderKeysRouter } from "./routes/provider-keys.js";
import { createSkillsRouter } from "./routes/skills.js";
import { createFilesRouter } from "./routes/files.js";
import { createOAuthRouter } from "./routes/oauth.js";
import { createJobsRouter } from "./routes/jobs.js";
import { createTasksRouter } from "./routes/tasks.js";
import { createAgentProfilesRouter } from "./routes/agent-profiles.js";
import { createMemoryRouter } from "./routes/memory.js";
import { createTeamMembersRouter } from "./routes/team-members.js";
import { createProjectsRouter } from "./routes/projects.js";
import { requireAuth } from "./auth/middleware.js";
import { createCryptoService } from "./services/crypto.js";
import { ProcessPool } from "./services/process-pool.js";
import { createStorageService } from "./services/storage.js";
import { AgentExecutor } from "./services/agent-executor.js";
import { ArtifactCollector } from "./services/artifact-collector.js";
import { TaskQueueService } from "./services/task-queue.js";
import { SessionStatusService } from "./services/session-status-service.js";
import { OutputBufferService } from "./services/output-buffer.js";
import { TenantBridge, type TenantBridgeOptions } from "./agent-service.js";
import type { BridgeOptions } from "./ws-bridge.js";
import type { AgentProfileRow } from "./db/types.js";
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
	const sessionStatusService = new SessionStatusService();
	const outputBufferService = new OutputBufferService(db);

	// Wire process-stopped events to session status service
	processPool.on("process-stopped", (sessionId: string, reason: string) => {
		if (reason === "crash" || reason === "shutdown") {
			sessionStatusService.setStatus(sessionId, "dead", db);
		} else if (reason === "idle") {
			sessionStatusService.setStatus(sessionId, "suspended", db);
		}
	});

	const app = express();

	// --- Security middleware ---

	// 1.3 HTTPS redirect (production only, behind reverse proxy)
	if (!isDev) {
		app.set("trust proxy", 1);
		app.use((req, res, next) => {
			if (req.headers["x-forwarded-proto"] !== "https") {
				return res.redirect(301, `https://${req.headers.host}${req.url}`);
			}
			next();
		});
	}

	// 1.1 Security headers (helmet)
	// CDN domains allowed for HTML artifact rendering (interactive plots, etc.)
	// Security note: artifacts run inside sandboxed iframes (allow-scripts only,
	// NO allow-same-origin) so scripts cannot access the parent page context.
	const trustedCDNs = [
		"https://cdn.plot.ly",
		"https://cdn.jsdelivr.net",
		"https://cdnjs.cloudflare.com",
		"https://unpkg.com",
		"https://d3js.org",
	];
	app.use(
		helmet({
			contentSecurityPolicy: {
				directives: {
					defaultSrc: ["'self'"],
					scriptSrc: ["'self'", "'unsafe-inline'", ...trustedCDNs, ...(isDev ? ["'unsafe-eval'"] : [])],
					styleSrc: ["'self'", "'unsafe-inline'", ...trustedCDNs],
					imgSrc: ["'self'", "data:", "blob:", "https:"],
					connectSrc: ["'self'", "ws:", "wss:", ...trustedCDNs],
					workerSrc: ["'self'", "blob:"],
					fontSrc: ["'self'", ...trustedCDNs],
					objectSrc: ["'none'"],
					frameAncestors: ["'none'"],
					...(isDev ? { scriptSrcAttr: ["'unsafe-inline'"] } : {}),
				},
			},
			hsts: { maxAge: 31536000, includeSubDomains: true },
			crossOriginEmbedderPolicy: false, // Allow loading external resources
		}),
	);

	// 1.2 CORS
	const allowedOrigins = process.env.ALLOWED_ORIGINS
		? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
		: [];
	if (isDev) {
		allowedOrigins.push("http://localhost:3001", "http://localhost:5173");
	}
	app.use(
		cors({
			origin: allowedOrigins.length > 0 ? allowedOrigins : false,
			credentials: true,
			methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
			allowedHeaders: ["Content-Type", "Authorization"],
		}),
	);

	// 1.4 Body parsing with size limit
	app.use(express.json({ limit: "1mb" }));

	// 1.5 Cache-Control on API responses
	app.use("/api", (_req, res, next) => {
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("Pragma", "no-cache");
		next();
	});

	// 1.6 Health check — public endpoint returns minimal info
	app.get("/healthz", (_req, res) => {
		res.json({ status: "ok" });
	});
	// Detailed health (behind auth) with pool/queue stats
	app.get("/healthz/details", requireAuth, (_req, res) => {
		res.json({ status: "ok", processPool: processPool.stats(), taskQueue: taskQueueService.stats() });
	});

	// 1.7 WebSocket per-user connection tracking
	const wsConnectionCounts = new Map<string, number>();
	const WS_MAX_PER_USER = 5;

	// Track active CWDs per user (for agent-files endpoint)
	const activeUserCwds = new Map<string, string>();

	// --- API Routes ---
	app.use("/api/auth", authRateLimit, authRouter);
	app.use("/api/sessions", apiRateLimit, createSessionsRouter(sessionStatusService, processPool));
	app.use("/api/settings", requireAuth, apiRateLimit, settingsRouter);
	app.use("/api/import", requireAuth, apiRateLimit, importRouter);
	app.use("/api/provider-keys", apiRateLimit, createProviderKeysRouter(crypto));
	app.use("/api/skills", apiRateLimit, createSkillsRouter(storageService));
	app.use("/api/files", apiRateLimit, createFilesRouter(storageService));
	app.use("/api/oauth", apiRateLimit, createOAuthRouter(crypto));
	app.use("/api/jobs", apiRateLimit, createJobsRouter(storageService, crypto));
	app.use("/api/tasks", apiRateLimit, createTasksRouter(storageService, crypto, taskQueueService));
	app.use("/api/agent-profiles", apiRateLimit, createAgentProfilesRouter(agentExecutor));
	app.use("/api/memory", apiRateLimit, createMemoryRouter());
	app.use("/api/team-members", apiRateLimit, createTeamMembersRouter());
	app.use("/api/projects", apiRateLimit, createProjectsRouter(agentExecutor));

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
		// 1.8 Path traversal fix: resolve symlinks and use path.sep to prevent prefix attacks
		if (cwd) {
			try {
				const realFile = await fs.realpath(filePath);
				const realCwd = await fs.realpath(cwd);
				if (!realFile.startsWith(realCwd + path.sep) && realFile !== realCwd) {
					return res.status(403).json({ error: "Path is outside working directory" });
				}
				filePath = realFile;
			} catch {
				return res.status(404).json({ error: "File not found" });
			}
		}
		try {
			// PPTX: convert to slide images server-side via LibreOffice
			if (ext === "pptx" || ext === "ppt") {
				try {
					const { convertPptxToSlideImages } = await import("./services/pptx-converter.js");
					const [slides, rawBuffer] = await Promise.all([
						convertPptxToSlideImages(filePath),
						fs.readFile(filePath),
					]);
					res.json({ slides, raw: rawBuffer.toString("base64"), encoding: "slides" });
					return;
				} catch (convErr: any) {
					// LibreOffice/pdftoppm not installed — fall back to raw base64
					console.warn("[agent-files] PPTX conversion failed, serving raw binary:", convErr.message);
					const buffer = await fs.readFile(filePath);
					res.json({ content: buffer.toString("base64"), encoding: "base64" });
					return;
				}
			}

			const isBinary = BINARY_EXTENSIONS.has(ext);
			if (isBinary) {
				const buffer = await fs.readFile(filePath);
				const base64Content = buffer.toString("base64");
				res.json({ content: base64Content, encoding: "base64" });
			} else {
				const content = await fs.readFile(filePath, "utf-8");
				res.json({ content, encoding: "text" });
			}
		} catch (err: any) {
			console.error("[agent-files] Error serving file:", err.message);
			res.status(404).json({ error: "File not found" });
		}
	});

	// --- WebSocket ---
	const server = createServer(app);
	const wss = new WebSocketServer({ noServer: true });

	wss.on("connection", async (ws, req) => {
		// Auth user is attached by the upgrade handler
		const user = (req as any).__authUser;
		console.log(`[server] New WebSocket connection from ${user?.email || "unknown"}`);

		// 1.7 Enforce per-user WebSocket connection limit
		if (user?.userId) {
			const count = wsConnectionCounts.get(user.userId) || 0;
			if (count >= WS_MAX_PER_USER) {
				console.warn(`[server] WebSocket limit exceeded for ${user.email} (${count}/${WS_MAX_PER_USER})`);
				ws.close(4029, "Too many connections");
				return;
			}
			wsConnectionCounts.set(user.userId, count + 1);
			ws.on("close", () => {
				const current = wsConnectionCounts.get(user.userId) || 1;
				if (current <= 1) {
					wsConnectionCounts.delete(user.userId);
				} else {
					wsConnectionCounts.set(user.userId, current - 1);
				}
			});
		}

		// Parse bridge options from query params
		const url = new URL(req.url || "/", `http://localhost:${PORT}`);
		const options: BridgeOptions = {};
		if (url.searchParams.has("cwd")) options.cwd = url.searchParams.get("cwd")!;
		if (url.searchParams.has("provider")) options.provider = url.searchParams.get("provider")!;
		if (url.searchParams.has("model")) options.model = url.searchParams.get("model")!;

		let sessionId = url.searchParams.get("sessionId") || undefined;

		// Validate session ownership before allowing reconnection
		if (sessionId) {
			const sessionResult = await db.query<{ user_id: string }>(
				"SELECT user_id FROM sessions WHERE id = $1 AND deleted_at IS NULL",
				[sessionId],
			);
			if (sessionResult.rows.length === 0) {
				// Session doesn't exist — let it proceed as a new session
				sessionId = undefined;
			} else if (sessionResult.rows[0].user_id !== user.userId) {
				console.warn(`[server] User ${user.userId} attempted to access session ${sessionId} owned by ${sessionResult.rows[0].user_id}`);
				ws.close(4003, "Session not owned by authenticated user");
				return;
			}
		}

		// Track CWD for agent-files endpoint
		if (options.cwd) {
			activeUserCwds.set(user.userId, options.cwd);
		}

		// Resolve agent profile if specified
		const agentProfileId = url.searchParams.get("agentProfileId") || undefined;
		let profileSkillIds: string[] | undefined;
		let profileFileIds: string[] | undefined;

		if (agentProfileId) {
			try {
				const profileResult = await db.query<AgentProfileRow>(
					`SELECT * FROM agent_profiles WHERE id = $1
					 AND ((scope = 'platform')
					   OR (scope = 'team' AND owner_id = $2)
					   OR (scope = 'user' AND owner_id = $3))`,
					[agentProfileId, user.teamId, user.userId],
				);
				const profile = profileResult.rows[0];
				if (profile) {
					// Profile fields applied as defaults (explicit query params override)
					if (!options.provider && profile.provider) options.provider = profile.provider;
					if (!options.model && profile.model_id) options.model = profile.model_id;
					// System prompt from profile
					if (profile.prompt_mode === "append") {
						options.appendSystemPrompt = profile.system_prompt;
					} else {
						options.systemPrompt = profile.system_prompt;
					}
					profileSkillIds = profile.skill_ids ?? undefined;
					profileFileIds = profile.file_ids ?? undefined;
					// Increment use count (fire-and-forget)
					db.query(
						`UPDATE agent_profiles SET use_count = use_count + 1 WHERE id = $1`,
						[agentProfileId],
					).catch(() => {});
					console.log(`[server] Using agent profile "${profile.name}" (${agentProfileId})`);
				} else {
					console.warn(`[server] Agent profile ${agentProfileId} not found or not accessible`);
				}
			} catch (err) {
				console.error("[server] Failed to resolve agent profile:", err);
			}
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
			sessionStatusService,
			outputBufferService,
			profileSkillIds,
			profileFileIds,
			agentProfileId,
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
		app.get("/{*path}", (_req, res) => {
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
