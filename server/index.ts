/**
 * Bridge server entry point.
 *
 * In dev mode: runs Vite dev server + WebSocket bridge
 * In production: serves static files from dist/ + WebSocket bridge
 */

import express from "express";
import { createServer } from "node:http";
import * as path from "node:path";
import { WebSocketServer } from "ws";
import { WsBridge, type BridgeOptions } from "./ws-bridge.js";

const PORT = parseInt(process.env.PORT || "3001", 10);
const isDev = process.env.NODE_ENV !== "production";

async function main() {
	const app = express();
	const server = createServer(app);

	// WebSocket server — noServer mode so we can route upgrades manually
	const wss = new WebSocketServer({ noServer: true });

	wss.on("connection", (ws, req) => {
		console.log("[server] New WebSocket connection");

		// Parse bridge options from query params
		const url = new URL(req.url || "/", `http://localhost:${PORT}`);
		const options: BridgeOptions = {};
		if (url.searchParams.has("cwd")) options.cwd = url.searchParams.get("cwd")!;
		if (url.searchParams.has("provider")) options.provider = url.searchParams.get("provider")!;
		if (url.searchParams.has("model")) options.model = url.searchParams.get("model")!;

		const bridge = new WsBridge(ws, options);
		bridge.start();
	});

	if (isDev) {
		// In dev mode, use Vite's dev server as middleware
		const { createServer: createViteServer } = await import("vite");
		const vite = await createViteServer({
			configFile: path.resolve(import.meta.dirname, "../vite.config.ts"),
			root: path.resolve(import.meta.dirname, ".."),
			server: {
				middlewareMode: true,
				hmr: {
					server,
				},
			},
		});
		app.use(vite.middlewares);

		// Route WebSocket upgrades: /ws → our bridge, everything else → Vite HMR
		server.on("upgrade", (req, socket, head) => {
			const pathname = new URL(req.url || "/", `http://localhost:${PORT}`).pathname;
			if (pathname === "/ws") {
				wss.handleUpgrade(req, socket, head, (ws) => {
					wss.emit("connection", ws, req);
				});
			}
			// Otherwise let Vite handle it (HMR websocket)
		});
	} else {
		// In production, serve the built files
		const distPath = path.resolve(import.meta.dirname, "../dist");
		app.use(express.static(distPath));
		app.get("*", (_req, res) => {
			res.sendFile(path.join(distPath, "index.html"));
		});

		// In production, handle all upgrades ourselves
		server.on("upgrade", (req, socket, head) => {
			const pathname = new URL(req.url || "/", `http://localhost:${PORT}`).pathname;
			if (pathname === "/ws") {
				wss.handleUpgrade(req, socket, head, (ws) => {
					wss.emit("connection", ws, req);
				});
			} else {
				socket.destroy();
			}
		});
	}

	server.listen(PORT, () => {
		console.log(`[server] Pi Coding Agent Web UI running at http://localhost:${PORT}`);
		if (isDev) {
			console.log("[server] Running in development mode with Vite HMR");
		}
	});
}

main().catch((err) => {
	console.error("Failed to start server:", err);
	process.exit(1);
});
