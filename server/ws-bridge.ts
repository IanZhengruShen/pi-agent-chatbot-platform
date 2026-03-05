/**
 * WebSocket ↔ RPC process bridge.
 *
 * Spawns `pi --mode rpc` as a child process and bridges communication
 * between a WebSocket connection and the process's stdin/stdout.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import type { WebSocket } from "ws";
import { resolvePiCommand } from "./utils/resolve-command.js";
import { PROVIDER_ENV_MAP } from "./utils/provider-env-map.js";
export { PROVIDER_ENV_MAP } from "./utils/provider-env-map.js";

export interface BridgeOptions {
	/** Working directory for the agent */
	cwd?: string;
	/** Provider to use */
	provider?: string;
	/** Model ID to use */
	model?: string;
	/** Additional CLI arguments */
	args?: string[];
	/** System prompt text — replaces the default pi coding-assistant prompt */
	systemPrompt?: string;
	/** System prompt text — appended to the default prompt instead of replacing */
	appendSystemPrompt?: string;
}

export class WsBridge {
	protected process: ChildProcess | null = null;
	protected rl: readline.Interface | null = null;
	protected closed = false;
	/** Extra env vars injected via set_api_key (persisted across restarts) */
	protected extraEnv: Record<string, string> = {};
	protected ws: WebSocket;
	protected options: BridgeOptions;

	constructor(ws: WebSocket, options: BridgeOptions = {}) {
		this.ws = ws;
		this.options = options;
	}

	/**
	 * Start the bridge: spawn the RPC process and wire up communication.
	 */
	start(): void {
		this.spawnProcess();

		// WebSocket message handler — intercepts bridge commands, forwards the rest
		this.ws.on("message", (data) => {
			if (this.closed) return;
			const message = data.toString();
			try {
				const parsed = JSON.parse(message);

				// Handle bridge-level commands (not forwarded to pi process)
				if (parsed.type === "bridge_set_api_key") {
					this.handleSetApiKey(parsed);
					return;
				}

				// Forward to pi process stdin
				if (!this.process?.stdin) return;
				console.log(`[ws→rpc] ${parsed.type || "unknown"}${parsed.id ? ` (${parsed.id})` : ""}`);
				this.process.stdin.write(message + "\n");
			} catch {
				console.error("[bridge] Invalid JSON from WebSocket:", message);
			}
		});

		// WebSocket close → kill process
		this.ws.on("close", () => {
			this.stop();
		});

		this.ws.on("error", (err) => {
			console.error("[bridge] WebSocket error:", err.message);
			this.stop();
		});
	}

	/**
	 * Stop the bridge: kill the process and clean up.
	 */
	stop(): void {
		if (this.closed) return;
		this.closed = true;
		this.killProcess();
		console.log("[bridge] Stopped RPC bridge");
	}

	/**
	 * Handle set_api_key bridge command: store the key and restart the process.
	 */
	protected handleSetApiKey(parsed: any): void {
		const { provider, apiKey, id } = parsed;
		const envVar = PROVIDER_ENV_MAP[provider] || `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;

		console.log(`[bridge] Setting API key for provider "${provider}" (env: ${envVar})`);
		this.extraEnv[envVar] = apiKey;

		// Kill current process and respawn with new env
		this.killProcess();
		this.spawnProcess();

		// Acknowledge to browser
		this.ws.send(JSON.stringify({
			id,
			type: "bridge_response",
			command: "bridge_set_api_key",
			success: true,
		}));
	}

	/**
	 * Spawn the pi --mode rpc child process.
	 */
	protected spawnProcess(): void {
		const { command, commandArgs } = resolvePiCommand();
		const args = [...commandArgs, "--mode", "rpc"];

		if (this.options.provider) {
			args.push("--provider", this.options.provider);
		}
		if (this.options.model) {
			args.push("--model", this.options.model);
		}
		if (this.options.args) {
			args.push(...this.options.args);
		}

		// Inject platform-wide extensions
		if (process.env.BRAVE_SEARCH_API_KEY) {
			const braveSearchExt = fileURLToPath(new URL("./extensions/brave-search.ts", import.meta.url));
			args.push("--extension", braveSearchExt);
		}

		console.log(`[bridge] Spawning: ${command} ${args.join(" ")}`);

		this.process = spawn(command, args, {
			cwd: this.options.cwd || process.cwd(),
			env: { ...process.env, ...this.extraEnv },
			stdio: ["pipe", "pipe", "pipe"],
		});

		// Forward stderr to server console for debugging
		this.process.stderr?.on("data", (data) => {
			console.error(`[rpc stderr] ${data.toString().trimEnd()}`);
		});

		// Set up line reader for stdout → WebSocket
		this.rl = readline.createInterface({
			input: this.process.stdout!,
			terminal: false,
		});

		this.rl.on("line", (line) => {
			if (this.closed) return;
			try {
				// Forward the raw line without re-parsing for every token.
				// Only parse for debug-level logging of non-streaming events.
				if (process.env.LOG_LEVEL === "debug") {
					const parsed = JSON.parse(line);
					console.log(`[rpc→ws] ${parsed.type || "unknown"}${parsed.command ? ` (${parsed.command})` : ""}`);
				}
				this.ws.send(line);
			} catch {
				// Non-JSON output, ignore
			}
		});

		// Handle process exit
		this.process.on("exit", (code, signal) => {
			console.log(`[rpc] Process exited (code=${code}, signal=${signal})`);
			if (!this.closed) {
				// Don't close the WebSocket — the process may be restarting
				// (e.g. after set_api_key). Only close if truly unexpected.
			}
		});

		this.process.on("error", (err) => {
			console.error(`[rpc] Process error: ${err.message}`);
			if (!this.closed) {
				this.ws.close(1011, "RPC process error");
			}
		});

		console.log("[bridge] Started RPC process");
	}

	/**
	 * Kill the current child process.
	 */
	protected killProcess(): void {
		this.rl?.close();
		this.rl = null;

		if (this.process) {
			const proc = this.process;
			this.process = null;
			proc.kill("SIGTERM");
			const forceKillTimer = setTimeout(() => {
				try { proc.kill("SIGKILL"); } catch {}
			}, 2000);
			proc.on("exit", () => clearTimeout(forceKillTimer));
		}
	}

}
