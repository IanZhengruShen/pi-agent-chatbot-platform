/**
 * Browser entry point for the Pi Coding Agent Web UI.
 *
 * Connects to the bridge server via WebSocket and uses RemoteAgent
 * to drive the ChatPanel with the full coding agent backend.
 */

import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import type { Agent, AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import {
	ApiKeyPromptDialog,
	AppStorage,
	ChatPanel,
	CustomProvidersStore,
	IndexedDBStorageBackend,
	ProviderKeysStore,
	ProvidersModelsTab,
	ProxyTab,
	SessionListDialog,
	SessionsStore,
	SettingsDialog,
	SettingsStore,
	setAppStorage,
} from "@mariozechner/pi-web-ui";
import { html, render } from "lit";
import { History, RotateCcw, Settings, Wifi, WifiOff } from "lucide";
import { RemoteAgent } from "./remote-agent.js";
import "./app.css";

// ============================================================================
// Storage setup (reused from web-ui example for settings/API keys)
// ============================================================================
const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();
const customProviders = new CustomProvidersStore();

const configs = [
	settings.getConfig(),
	SessionsStore.getMetadataConfig(),
	providerKeys.getConfig(),
	customProviders.getConfig(),
	sessions.getConfig(),
];

const backend = new IndexedDBStorageBackend({
	dbName: "pi-web-ui-agent",
	version: 1,
	stores: configs,
});

settings.setBackend(backend);
providerKeys.setBackend(backend);
customProviders.setBackend(backend);
sessions.setBackend(backend);

const storage = new AppStorage(settings, providerKeys, sessions, customProviders, backend);
setAppStorage(storage);

// ============================================================================
// State
// ============================================================================
let remoteAgent: RemoteAgent | null = null;
let chatPanel: ChatPanel;
let agentUnsubscribe: (() => void) | undefined;
let wsConnected = false;
let currentSessionId: string | undefined;
let currentTitle = "";
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

// ============================================================================
// Session helpers
// ============================================================================

const generateTitle = (messages: AgentMessage[]): string => {
	const firstUserMsg = messages.find((m) => m.role === "user" || m.role === "user-with-attachments");
	if (!firstUserMsg || (firstUserMsg.role !== "user" && firstUserMsg.role !== "user-with-attachments")) return "";

	let text = "";
	const content = firstUserMsg.content;

	if (typeof content === "string") {
		text = content;
	} else {
		const textBlocks = content.filter((c: any) => c.type === "text");
		text = textBlocks.map((c: any) => c.text || "").join(" ");
	}

	text = text.trim();
	if (!text) return "";

	const sentenceEnd = text.search(/[.!?]/);
	if (sentenceEnd > 0 && sentenceEnd <= 50) {
		return text.substring(0, sentenceEnd + 1);
	}
	return text.length <= 50 ? text : `${text.substring(0, 47)}...`;
};

const shouldSaveSession = (messages: AgentMessage[]): boolean => {
	const hasUserMsg = messages.some((m: any) => m.role === "user" || m.role === "user-with-attachments");
	const hasAssistantMsg = messages.some((m: any) => m.role === "assistant");
	return hasUserMsg && hasAssistantMsg;
};

const saveSession = async () => {
	if (!currentSessionId || !remoteAgent || !currentTitle) return;

	const state = remoteAgent.state;
	if (!shouldSaveSession(state.messages)) return;

	try {
		const sessionData = {
			id: currentSessionId,
			title: currentTitle,
			model: state.model!,
			thinkingLevel: state.thinkingLevel,
			messages: state.messages,
			createdAt: new Date().toISOString(),
			lastModified: new Date().toISOString(),
		};

		const metadata = {
			id: currentSessionId,
			title: currentTitle,
			createdAt: sessionData.createdAt,
			lastModified: sessionData.lastModified,
			messageCount: state.messages.length,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			modelId: state.model?.id || null,
			thinkingLevel: state.thinkingLevel,
			preview: generateTitle(state.messages),
		};

		await storage.sessions.save(sessionData, metadata);
	} catch (err) {
		console.error("Failed to save session:", err);
	}
};

const loadSession = async (sessionId: string): Promise<boolean> => {
	const sessionData = await storage.sessions.get(sessionId);
	if (!sessionData) {
		console.error("Session not found:", sessionId);
		return false;
	}

	const metadata = await storage.sessions.getMetadata(sessionId);
	currentSessionId = sessionId;
	currentTitle = metadata?.title || "";

	// Reset server state (can't restore old context)
	if (remoteAgent) {
		await remoteAgent.newSession();
		// Display saved messages in the chat (read-only history)
		remoteAgent.state.messages = sessionData.messages;
	}

	renderApp();
	return true;
};

// ============================================================================
// WebSocket connection
// ============================================================================

function getWsUrl(): string {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const host = window.location.host;
	return `${protocol}//${host}/ws`;
}

/**
 * Prompt the user for an API key using the standard ApiKeyPromptDialog,
 * then read it from storage and forward it to the bridge server.
 */
async function promptAndForwardApiKey(provider: string): Promise<string | undefined> {
	// Clear any dummy/stale key so the dialog doesn't auto-close
	await storage.providerKeys.delete(provider);

	// Show the standard API key dialog (ProviderKeyInput validates the key
	// by making a test API call, then saves to IndexedDB on success)
	const success = await ApiKeyPromptDialog.prompt(provider);
	if (!success) return undefined;

	// Read the validated key back from storage
	const apiKey = await storage.providerKeys.get(provider);
	return apiKey ?? undefined;
}

function connectWebSocket(): void {
	if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
		return;
	}

	ws = new WebSocket(getWsUrl());

	ws.addEventListener("open", async () => {
		console.log("[ws] Connected to bridge server");
		wsConnected = true;

		// Create RemoteAgent with the WebSocket
		remoteAgent = new RemoteAgent(ws!);

		// When the server reports a missing API key, show the standard dialog
		// and forward the key to the bridge server
		remoteAgent.onApiKeyRequired = async (provider: string): Promise<string | undefined> => {
			return promptAndForwardApiKey(provider);
		};

		// Set up ChatPanel with the remote agent immediately so the UI
		// shows the chat input right away instead of "No agent set".
		await chatPanel.setAgent(remoteAgent as unknown as Agent, {
			onApiKeyRequired: async (provider: string) => {
				// When AgentInterface detects no key for a provider (e.g. after
				// switching models), prompt the user and forward to bridge
				const apiKey = await promptAndForwardApiKey(provider);
				if (apiKey && remoteAgent) {
					await remoteAgent.setApiKey(provider, apiKey);
				}
				return !!apiKey;
			},
			toolsFactory: () => {
				// No browser-side tools — all tools run on the server
				return [];
			},
		});

		renderApp();

		// Sync state first so the UI shows the real model name quickly
		try {
			await remoteAgent.syncState();
			chatPanel.agentInterface?.requestUpdate();
			// Fetch messages in background — doesn't block model display
			remoteAgent.fetchMessages().catch((err) => {
				console.error("Failed to fetch messages:", err);
			});
		} catch (err) {
			console.error("Failed to sync initial state:", err);
		}

		// Restore API keys in background (slow — restarts the pi process)
		(async () => {
			try {
				const providers = await storage.providerKeys.list();
				for (const provider of providers) {
					const key = await storage.providerKeys.get(provider);
					if (key && remoteAgent) {
						await remoteAgent.setApiKey(provider, key);
					}
				}
			} catch (err) {
				console.warn("Failed to restore API keys from storage:", err);
			}
		})();

		// Subscribe to events for UI updates + auto-save
		agentUnsubscribe = remoteAgent.subscribe((_event: AgentEvent) => {
			const messages = remoteAgent!.state.messages;

			// Generate title after first successful response
			if (!currentTitle && shouldSaveSession(messages)) {
				currentTitle = generateTitle(messages);
			}

			// Create session ID on first saveable state
			if (!currentSessionId && shouldSaveSession(messages)) {
				currentSessionId = crypto.randomUUID();
			}

			// Auto-save
			if (currentSessionId) {
				saveSession();
			}

			renderApp();
		});

		renderApp();
	});

	ws.addEventListener("close", (event) => {
		console.log(`[ws] Disconnected (code=${event.code}, reason=${event.reason})`);
		wsConnected = false;
		remoteAgent = null;
		if (agentUnsubscribe) {
			agentUnsubscribe();
			agentUnsubscribe = undefined;
		}
		renderApp();

		// Auto-reconnect after 3 seconds
		clearTimeout(reconnectTimer);
		reconnectTimer = setTimeout(() => {
			console.log("[ws] Attempting reconnect...");
			connectWebSocket();
		}, 3000);
	});

	ws.addEventListener("error", (event) => {
		console.error("[ws] Error:", event);
	});
}

// ============================================================================
// Render
// ============================================================================

const renderApp = () => {
	const app = document.getElementById("app");
	if (!app) return;

	const appHtml = html`
		<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
			<!-- Header -->
			<div class="flex items-center justify-between border-b border-border shrink-0">
				<div class="flex items-center gap-2 px-4 py-2">
					<span class="text-base font-semibold text-foreground">Pi Coding Agent</span>
				</div>
				<div class="flex items-center gap-1 px-2">
					<!-- Connection status -->
					<div class="flex items-center gap-1 text-xs px-2 ${wsConnected ? "text-green-500" : "text-red-500"}">
						${
							wsConnected
								? html`${icon(Wifi, "sm")} <span>Connected</span>`
								: html`${icon(WifiOff, "sm")} <span>Disconnected</span>`
						}
					</div>

					<!-- Session history -->
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(History, "sm"),
						onClick: () => {
							SessionListDialog.open(
								async (sessionId) => {
									await loadSession(sessionId);
								},
								(deletedSessionId) => {
									if (deletedSessionId === currentSessionId) {
										currentSessionId = undefined;
										currentTitle = "";
										if (remoteAgent) {
											remoteAgent.newSession();
											renderApp();
										}
									}
								},
							);
						},
						title: "Sessions",
					})}

					<!-- New session -->
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(RotateCcw, "sm"),
						onClick: async () => {
							if (remoteAgent) {
								currentSessionId = undefined;
								currentTitle = "";
								await remoteAgent.newSession();
								renderApp();
							}
						},
						title: "New Session",
					})}

					<theme-toggle></theme-toggle>

					<!-- Settings (providers, API keys, proxy) -->
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Settings, "sm"),
						onClick: () => SettingsDialog.open([new ProvidersModelsTab(), new ProxyTab()]),
						title: "Settings",
					})}
				</div>
			</div>

			<!-- Chat Panel -->
			${
				!wsConnected
					? html`<div class="flex-1 flex items-center justify-center">
						<div class="text-muted-foreground text-sm">Connecting...</div>
					</div>`
					: chatPanel
			}
		</div>
	`;

	render(appHtml, app);
};

// ============================================================================
// Init
// ============================================================================

async function initApp() {
	const app = document.getElementById("app");
	if (!app) throw new Error("App container not found");

	// Create ChatPanel first, then render the full app layout immediately.
	// The ChatPanel will show its own placeholder until setAgent() is called
	// once the WebSocket connects, but the overall app chrome (header, etc.)
	// is visible right away.
	chatPanel = new ChatPanel();

	// Connect to bridge server
	connectWebSocket();

	renderApp();
}

initApp();
