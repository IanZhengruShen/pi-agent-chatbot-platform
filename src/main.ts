/**
 * Browser entry point for the Chatbot Platform.
 *
 * Auth-gated: shows login page until authenticated, then connects
 * to the bridge server via WebSocket and uses RemoteAgent to drive
 * the ChatPanel with the full coding agent backend.
 */

import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import type { Agent, AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import {
	AppStorage,
	ChatPanel,
	CustomProvidersStore,
	ProviderKeysStore,
	ProvidersModelsTab,
	ProxyTab,
	SessionListDialog,
	SessionsStore,
	SettingsDialog,
	SettingsStore,
	setAppStorage,
} from "./web-ui/index.js";
import "./components/ProviderKeysPanel.js";
import "./components/SkillsPanel.js";
import "./components/FilesPanel.js";
import "./components/OAuthConnectionsPanel.js";
import "./components/SchedulerPanel.js";
import { html, render } from "lit";
import { Calendar, FileUp, History, KeyRound, Link, LogOut, Puzzle, RotateCcw, Settings, Wifi, WifiOff } from "lucide";
import { AuthClient } from "./auth/auth-client.js";
import "./auth/login-page.js";
import { RemoteAgent } from "./remote-agent.js";
import { ApiStorageBackend } from "./storage/api-storage-backend.js";
import "./app.css";

// ============================================================================
// Auth
// ============================================================================
const authClient = new AuthClient();

// ============================================================================
// State
// ============================================================================
let storage: AppStorage | null = null;
let remoteAgent: RemoteAgent | null = null;
let chatPanel: ChatPanel;
let agentUnsubscribe: (() => void) | undefined;
let wsConnected = false;
let currentSessionId: string | undefined;
let currentTitle = "";
let ws: WebSocket | null = null;
let skillsList: Array<{ name: string; description: string }> = [];
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectDelay = 1000; // Exponential backoff: 1s → 2s → 4s → ... → 30s max
const MAX_RECONNECT_DELAY = 30_000;
let saveSessionTimer: ReturnType<typeof setTimeout> | undefined;

// ============================================================================
// Storage setup (ApiStorageBackend replaces IndexedDB)
// ============================================================================

function initStorage(): AppStorage {
	const backend = new ApiStorageBackend({
		baseUrl: "",
		getToken: () => authClient.token,
	});

	const settings = new SettingsStore();
	const providerKeys = new ProviderKeysStore();
	const sessions = new SessionsStore();
	const customProviders = new CustomProvidersStore();

	settings.setBackend(backend);
	providerKeys.setBackend(backend);
	customProviders.setBackend(backend);
	sessions.setBackend(backend);

	const appStorage = new AppStorage(settings, providerKeys, sessions, customProviders, backend);
	setAppStorage(appStorage);
	return appStorage;
}

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
	if (!currentSessionId || !remoteAgent || !currentTitle || !storage) return;

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
	if (!storage) return false;

	const sessionData = await storage.sessions.get(sessionId);
	if (!sessionData) {
		console.error("Session not found:", sessionId);
		return false;
	}

	const metadata = await storage.sessions.getMetadata(sessionId);
	currentSessionId = sessionId;
	currentTitle = metadata?.title || "";

	// Load saved messages without resetting the server
	// (Server can't restore old context, but we can show read-only history)
	if (remoteAgent) {
		// Use the public method to load messages and notify UI
		remoteAgent.loadMessagesFromStorage(sessionData.messages);

		// Force UI components to re-render with loaded messages
		if (chatPanel?.agentInterface) {
			chatPanel.agentInterface.requestUpdate();
		}
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
	const token = authClient.token;
	let url = `${protocol}//${host}/ws?token=${encodeURIComponent(token || "")}`;
	if (currentSessionId) {
		url += `&sessionId=${encodeURIComponent(currentSessionId)}`;
	}
	return url;
}

function connectWebSocket(): void {
	if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
		return;
	}

	ws = new WebSocket(getWsUrl());

	ws.addEventListener("open", async () => {
		console.log("[ws] Connected to bridge server");
		wsConnected = true;
		reconnectDelay = 1000; // Reset backoff on successful connection

		// Create RemoteAgent with the WebSocket
		remoteAgent = new RemoteAgent(ws!);

		// Set up ChatPanel with the remote agent
		await chatPanel.setAgent(remoteAgent as unknown as Agent, {
			onApiKeyRequired: async (_provider: string) => {
				// API keys are managed server-side — always proceed with the send
				return true;
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

			// Debounced auto-save: wait 500ms after last event to ensure
			// fetchMessages() completes and messages are fully synced
			if (currentSessionId) {
				clearTimeout(saveSessionTimer);
				saveSessionTimer = setTimeout(() => {
					saveSession();
				}, 500);
			}

			renderApp();
		});

		renderApp();
	});

	ws.addEventListener("close", (event) => {
		console.log(`[ws] Disconnected (code=${event.code}, reason=${event.reason})`);

		// Save session immediately before disconnecting
		clearTimeout(saveSessionTimer);
		if (currentSessionId && remoteAgent) {
			saveSession();
		}

		wsConnected = false;
		remoteAgent = null;
		if (agentUnsubscribe) {
			agentUnsubscribe();
			agentUnsubscribe = undefined;
		}
		renderApp();

		// Auto-reconnect with exponential backoff (only if still authenticated)
		if (authClient.isAuthenticated) {
			clearTimeout(reconnectTimer);
			console.log(`[ws] Reconnecting in ${reconnectDelay / 1000}s...`);
			reconnectTimer = setTimeout(() => {
				console.log("[ws] Attempting reconnect...");
				connectWebSocket();
			}, reconnectDelay);
			reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
		}
	});

	ws.addEventListener("error", (event) => {
		console.error("[ws] Error:", event);
	});
}

function disconnectWebSocket(): void {
	clearTimeout(reconnectTimer);
	clearTimeout(saveSessionTimer);
	if (ws) {
		ws.close();
		ws = null;
	}
	wsConnected = false;
	remoteAgent = null;
	if (agentUnsubscribe) {
		agentUnsubscribe();
		agentUnsubscribe = undefined;
	}
}

// ============================================================================
// Skills fetching
// ============================================================================

async function fetchSkills(): Promise<void> {
	try {
		const res = await fetch("/api/skills", {
			headers: { Authorization: `Bearer ${authClient.token}` },
		});
		if (!res.ok) return;
		const data = await res.json();
		const skills = data?.data?.skills;
		if (data.success && Array.isArray(skills)) {
			skillsList = skills.map((s: any) => ({ name: s.name, description: s.description || "" }));
			if (chatPanel) {
				chatPanel.skills = skillsList;
			}
		}
	} catch (err) {
		console.error("Failed to fetch skills:", err);
	}
}

// ============================================================================
// Render
// ============================================================================

const renderApp = () => {
	const app = document.getElementById("app");
	if (!app) return;

	// Not authenticated — show login page
	if (!authClient.isAuthenticated) {
		const loginHtml = html`
			<login-page .authClient=${authClient} @auth-success=${onAuthSuccess}></login-page>
		`;
		render(loginHtml, app);
		return;
	}

	// Authenticated — show main app
	const user = authClient.user;
	const appHtml = html`
		<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
			<!-- Header -->
			<div class="flex items-center justify-between border-b border-border shrink-0">
				<div class="flex items-center gap-2 px-4 py-2">
					<span class="text-base font-semibold text-foreground">Chatbot Platform</span>
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

					<!-- User info -->
					<span class="text-xs text-muted-foreground px-2">${user?.email || ""}</span>

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

					<!-- Provider Keys (admin only) -->
					${user?.role === "admin"
						? Button({
								variant: "ghost",
								size: "sm",
								children: icon(KeyRound, "sm"),
								onClick: () => {
									const dialog = document.createElement("dialog");
									dialog.innerHTML = `
										<div style="min-width: 500px; max-width: 600px; padding: 1rem;">
											<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
												<h2 style="margin: 0; font-size: 1.125rem;">Provider Keys</h2>
												<button onclick="this.closest('dialog').close()" style="background: none; border: none; cursor: pointer; font-size: 1.25rem;">&times;</button>
											</div>
											<provider-keys-panel></provider-keys-panel>
										</div>
									`;
									const panel = dialog.querySelector("provider-keys-panel") as any;
									if (panel) panel.getToken = () => authClient.token;
									document.body.appendChild(dialog);
									dialog.showModal();
									dialog.addEventListener("close", () => dialog.remove());
									dialog.addEventListener("click", (e) => {
										if (e.target === dialog) dialog.close();
									});
								},
								title: "Provider Keys",
							})
						: null}

					<!-- OAuth Subscriptions -->
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Link, "sm"),
						onClick: () => {
							const dialog = document.createElement("dialog");
							dialog.innerHTML = `
								<div style="min-width: 500px; max-width: 600px; padding: 1rem;">
									<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
										<h2 style="margin: 0; font-size: 1.125rem;">OAuth Subscriptions</h2>
										<button onclick="this.closest('dialog').close()" style="background: none; border: none; cursor: pointer; font-size: 1.25rem;">&times;</button>
									</div>
									<oauth-connections-panel></oauth-connections-panel>
								</div>
							`;
							const panel = dialog.querySelector("oauth-connections-panel") as any;
							if (panel) panel.getToken = () => authClient.token;
							document.body.appendChild(dialog);
							dialog.showModal();
							dialog.addEventListener("close", () => dialog.remove());
							dialog.addEventListener("click", (e) => {
								if (e.target === dialog) dialog.close();
							});
						},
						title: "OAuth Subscriptions",
					})}

					<!-- Skills -->
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Puzzle, "sm"),
						onClick: () => {
							const dialog = document.createElement("dialog");
							dialog.innerHTML = `
								<div style="min-width: 500px; max-width: 600px; padding: 1rem;">
									<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
										<h2 style="margin: 0; font-size: 1.125rem;">Skills</h2>
										<button onclick="this.closest('dialog').close()" style="background: none; border: none; cursor: pointer; font-size: 1.25rem;">&times;</button>
									</div>
									<skills-panel></skills-panel>
								</div>
							`;
							const panel = dialog.querySelector("skills-panel") as any;
							if (panel) {
								panel.getToken = () => authClient.token;
								panel.userRole = user?.role || "member";
							}
							document.body.appendChild(dialog);
							dialog.showModal();
							dialog.addEventListener("close", () => dialog.remove());
							dialog.addEventListener("click", (e) => {
								if (e.target === dialog) dialog.close();
							});
						},
						title: "Skills",
					})}

					<!-- Files -->
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(FileUp, "sm"),
						onClick: () => {
							const dialog = document.createElement("dialog");
							dialog.innerHTML = `
								<div style="min-width: 500px; max-width: 600px; padding: 1rem;">
									<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
										<h2 style="margin: 0; font-size: 1.125rem;">Files</h2>
										<button onclick="this.closest('dialog').close()" style="background: none; border: none; cursor: pointer; font-size: 1.25rem;">&times;</button>
									</div>
									<files-panel></files-panel>
								</div>
							`;
							const panel = dialog.querySelector("files-panel") as any;
							if (panel) panel.getToken = () => authClient.token;
							document.body.appendChild(dialog);
							dialog.showModal();
							dialog.addEventListener("close", () => dialog.remove());
							dialog.addEventListener("click", (e) => {
								if (e.target === dialog) dialog.close();
							});
						},
						title: "Files",
					})}

					<!-- Scheduled Jobs -->
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Calendar, "sm"),
						onClick: () => {
							const dialog = document.createElement("dialog");
							dialog.style.cssText = "max-width: 900px; width: 90vw; padding: 1.5rem; border: 1px solid var(--border); border-radius: 0.5rem; background: var(--background);";
							dialog.innerHTML = `
								<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
									<h2 style="margin: 0; font-size: 1.25rem; font-weight: 600;">Scheduled Jobs</h2>
									<button style="border: none; background: transparent; font-size: 1.5rem; cursor: pointer; padding: 0.25rem;" onclick="this.closest('dialog').close()">&times;</button>
								</div>
								<scheduler-panel></scheduler-panel>
							`;
							const panel = dialog.querySelector("scheduler-panel") as any;
							if (panel) {
								panel.getToken = () => authClient.token;
								panel.userRole = user?.role || "member";
							}
							document.body.appendChild(dialog);
							dialog.showModal();
							dialog.addEventListener("close", () => dialog.remove());
							dialog.addEventListener("click", (e) => {
								if (e.target === dialog) dialog.close();
							});
						},
						title: "Scheduled Jobs",
					})}

					<theme-toggle></theme-toggle>

					<!-- Settings (providers, proxy) -->
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Settings, "sm"),
						onClick: () => SettingsDialog.open([new ProvidersModelsTab(), new ProxyTab()]),
						title: "Settings",
					})}

					<!-- Logout -->
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(LogOut, "sm"),
						onClick: handleLogout,
						title: "Logout",
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
// Auth handlers
// ============================================================================

function onAuthSuccess() {
	// Initialize storage and connect after successful login
	storage = initStorage();
	chatPanel = new ChatPanel();
	connectWebSocket();
	fetchSkills();
	renderApp();
}

function handleLogout() {
	disconnectWebSocket();
	storage = null;
	currentSessionId = undefined;
	currentTitle = "";
	authClient.logout();
	renderApp();
}

// ============================================================================
// Init
// ============================================================================

async function initApp() {
	const app = document.getElementById("app");
	if (!app) throw new Error("App container not found");

	if (authClient.isAuthenticated) {
		// Validate stored token
		const valid = await authClient.validate();
		if (valid) {
			storage = initStorage();
			chatPanel = new ChatPanel();
			connectWebSocket();
			fetchSkills();
		} else {
			// Token expired/invalid — show login
			authClient.logout();
		}
	}

	renderApp();
}

initApp();
