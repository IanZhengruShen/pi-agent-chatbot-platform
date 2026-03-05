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
	SessionsStore,
	SettingsDialog,
	SettingsStore,
	SettingsTab,
	setAppStorage,
} from "./web-ui/index.js";
import type { SessionMetadata } from "./web-ui/index.js";
import "./components/ProviderKeysPanel.js";
import "./components/SkillsPanel.js";
import "./components/FilesPanel.js";
import "./components/OAuthConnectionsPanel.js";
import "./components/SchedulerPanel.js";
import "./components/TasksDashboard.js";
import "./components/AgentProfilesPanel.js";
import "./components/MemoryPanel.js";
import { TeamMembersTab } from "./components/TeamMembersPanel.js";
import { html, render, nothing } from "lit";
import {
	Bot,
	Brain,
	Calendar,
	ChevronDown,
	FileUp,
	KeyRound,
	Link,
	ListTodo,
	LogOut,
	MessageSquare,
	PanelLeft,
	PanelLeftClose,
	Plus,
	Puzzle,
	Settings,
	Square,
	Trash2,
	Wrench,
} from "lucide";
import { AuthClient } from "./auth/auth-client.js";
import "./auth/login-page.js";
import { RemoteAgent } from "./remote-agent.js";
import { ApiStorageBackend } from "./storage/api-storage-backend.js";
import { resolveRoute, navigateTo } from "./router.js";
import type { RouteName } from "./router.js";
import "./studio/StudioPage.js";
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
let intentionalDisconnect = false; // Suppress reconnect on intentional disconnect
let pendingSessionMessages: AgentMessage[] | null = null; // Messages to restore after WS reconnect
let pendingArtifactsCache: Record<string, string> | null = null; // Cached binary artifact content to restore

// Cache tool call arguments for detecting renderable file writes
const pendingToolArgs = new Map<string, { toolName: string; args: any }>();
// Track the last known working directory from tool arg file paths
let lastKnownDir = "";
// Track files we've already attempted to fetch (avoid duplicate fetches)
const fetchedFileRefs = new Set<string>();

import { RENDERABLE_EXTENSIONS, BINARY_EXTENSIONS, ARTIFACT_AUTO_DETECT_EXTENSIONS } from "./shared/file-extensions.js";

// Session status tracking (from SSE)
type SessionStatus = "generating" | "idle" | "suspended" | "dead";
let sessionStatusMap = new Map<string, SessionStatus>();
let sessionStatusEventSource: EventSource | null = null;

// Sidebar & dropdown state
let sidebarOpen = true;
let sidebarSessions: SessionMetadata[] = [];
let toolsMenuOpen = false;
let userMenuOpen = false;
let profileMenuOpen = false;

// Router state
let currentRoute: RouteName = "chat";
let routeParams: Record<string, string> = {};

// Agent profiles state
interface AgentProfileInfo {
	id: string;
	scope: string;
	owner_id: string;
	name: string;
	description: string | null;
	icon: string | null;
	starter_message: string | null;
	suggested_prompts: string[] | null;
}
let agentProfiles: AgentProfileInfo[] = [];
let currentAgentProfileId: string | undefined;
let currentModelId: string | undefined;
let currentProvider: string | undefined;

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
		// Capture binary artifact content (PPTX slides, etc.) for persistence
		const artifactsCache: Record<string, string> = {};
		const panel = chatPanel?.artifactsPanel;
		if (panel) {
			for (const [filename, artifact] of panel.artifacts) {
				const ext = filename.split(".").pop()?.toLowerCase();
				if (ext && BINARY_EXTENSIONS.has(ext) && artifact.content) {
					artifactsCache[filename] = artifact.content;
				}
			}
		}

		const sessionData = {
			id: currentSessionId,
			title: currentTitle,
			model: state.model!,
			thinkingLevel: state.thinkingLevel,
			messages: state.messages,
			agentProfileId: currentAgentProfileId || null,
			createdAt: new Date().toISOString(),
			lastModified: new Date().toISOString(),
			...(Object.keys(artifactsCache).length > 0 ? { artifactsCache } : {}),
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
			agentProfileId: currentAgentProfileId || null,
		};

		await storage.sessions.save(sessionData, metadata);
		// Refresh sidebar after saving
		loadSidebarSessions();
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

	// Save current session before switching (if there's anything to save)
	clearTimeout(saveSessionTimer);
	if (currentSessionId && remoteAgent) {
		saveSession();
	}

	// Store messages and artifact cache to restore after WebSocket reconnects
	pendingSessionMessages = sessionData.messages;
	pendingArtifactsCache = (sessionData as any).artifactsCache ?? null;

	// Disconnect old WebSocket cleanly (listeners removed, no stale reconnects)
	disconnectWebSocket();

	// Update state for the new session
	currentSessionId = sessionId;
	currentTitle = metadata?.title || "";
	currentAgentProfileId = (metadata as any)?.agentProfileId || undefined;
	currentModelId = undefined;
	currentProvider = undefined;
	chatPanel?.artifactsPanel?.clear();
	fetchedFileRefs.clear();

	// Reconnect — the URL will include the sessionId + agentProfileId
	connectWebSocket();
	renderApp();
	return true;
};

const abortSession = async (sessionId: string) => {
	try {
		await fetch("/api/sessions/" + sessionId + "/abort", {
			method: "POST",
			headers: { Authorization: "Bearer " + authClient.token },
		});
	} catch (err) {
		console.error("Failed to abort session:", err);
	}
};

const deleteSession = async (sessionId: string) => {
	if (!storage) return;
	try {
		await storage.sessions.delete(sessionId);
		if (sessionId === currentSessionId) {
			currentSessionId = undefined;
			currentTitle = "";
			chatPanel?.artifactsPanel?.clear();
			fetchedFileRefs.clear();
			if (remoteAgent) {
				remoteAgent.newSession();
			}
		}
		await loadSidebarSessions();
		renderApp();
	} catch (err) {
		console.error("Failed to delete session:", err);
	}
};

// ============================================================================
// Sidebar helpers
// ============================================================================

async function loadSidebarSessions() {
	if (!storage) return;
	try {
		sidebarSessions = await storage.sessions.getAllMetadata();
		renderApp();
	} catch (err) {
		console.error("Failed to load sidebar sessions:", err);
	}
}

interface SessionGroup {
	label: string;
	sessions: SessionMetadata[];
}

function groupSessionsByDate(sessions: SessionMetadata[]): SessionGroup[] {
	const now = new Date();
	const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const yesterdayStart = new Date(todayStart.getTime() - 86400000);
	const last7Start = new Date(todayStart.getTime() - 7 * 86400000);

	const today: SessionMetadata[] = [];
	const yesterday: SessionMetadata[] = [];
	const last7Days: SessionMetadata[] = [];
	const older: SessionMetadata[] = [];

	for (const s of sessions) {
		const d = new Date(s.lastModified || s.createdAt);
		if (d >= todayStart) today.push(s);
		else if (d >= yesterdayStart) yesterday.push(s);
		else if (d >= last7Start) last7Days.push(s);
		else older.push(s);
	}

	const groups: SessionGroup[] = [];
	if (today.length) groups.push({ label: "Today", sessions: today });
	if (yesterday.length) groups.push({ label: "Yesterday", sessions: yesterday });
	if (last7Days.length) groups.push({ label: "Last 7 days", sessions: last7Days });
	if (older.length) groups.push({ label: "Older", sessions: older });
	return groups;
}

// ============================================================================
// Dialog opener helper
// ============================================================================

function openDialog(opts: { title: string; tag: string; style?: string; setup?: (panel: any) => void }) {
	const dialog = document.createElement("dialog");
	dialog.style.cssText = opts.style || "";
	dialog.innerHTML = `
		<div style="min-width: 500px; padding: 1rem;">
			<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
				<h2 style="margin: 0; font-size: 1.125rem;">${opts.title}</h2>
				<button onclick="this.closest('dialog').close()" style="background: none; border: none; cursor: pointer; font-size: 1.25rem;">&times;</button>
			</div>
			<${opts.tag}></${opts.tag}>
		</div>
	`;
	const panel = dialog.querySelector(opts.tag) as any;
	if (panel && opts.setup) opts.setup(panel);
	document.body.appendChild(dialog);
	dialog.showModal();
	dialog.addEventListener("close", () => dialog.remove());
	dialog.addEventListener("click", (e) => {
		if (e.target === dialog) dialog.close();
	});
}

// ============================================================================
// Click-outside handler for dropdowns
// ============================================================================

function setupClickOutside() {
	document.addEventListener("click", (e) => {
		const target = e.target as HTMLElement;
		if (toolsMenuOpen && !target.closest("[data-tools-menu]")) {
			toolsMenuOpen = false;
			renderApp();
		}
		if (profileMenuOpen && !target.closest("[data-profile-menu]")) {
			profileMenuOpen = false;
			renderApp();
		}
		if (userMenuOpen && !target.closest("[data-user-menu]")) {
			userMenuOpen = false;
			renderApp();
		}
	});
}

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
	if (currentAgentProfileId) {
		url += `&agentProfileId=${encodeURIComponent(currentAgentProfileId)}`;
	}
	if (currentProvider) {
		url += `&provider=${encodeURIComponent(currentProvider)}`;
	}
	if (currentModelId) {
		url += `&model=${encodeURIComponent(currentModelId)}`;
	}
	return url;
}

function trackCurrentModel(): void {
	const model = remoteAgent?.state.model;
	if (model?.id) {
		currentModelId = model.id;
		currentProvider = model.provider;
	}
}

function onAgentEvent(event: AgentEvent): void {
	const messages = remoteAgent!.state.messages;

	// Track model changes (e.g. user switches model mid-session)
	trackCurrentModel();

	// Generate title after first successful response
	if (!currentTitle && shouldSaveSession(messages)) {
		currentTitle = generateTitle(messages);
	}

	// Create session ID on first saveable state
	if (!currentSessionId && shouldSaveSession(messages)) {
		currentSessionId = crypto.randomUUID();
	}

	// Debounced auto-save
	if (currentSessionId) {
		clearTimeout(saveSessionTimer);
		saveSessionTimer = setTimeout(() => saveSession(), 500);
	}

	// --- File artifact auto-detection ---
	if (event.type === "tool_execution_start") {
		pendingToolArgs.set(event.toolCallId, { toolName: event.toolName, args: event.args });
		const fp = event.args?.path || event.args?.filePath || event.args?.file_path || "";
		if (typeof fp === "string") trackDirFromPath(fp);
	}
	if (event.type === "tool_execution_end" && !event.isError) {
		const cached = pendingToolArgs.get(event.toolCallId);
		pendingToolArgs.delete(event.toolCallId);
		if (cached?.args) {
			const filePath = getRenderablePathFromArgs(cached.args);
			const content = getContentFromArgs(cached.args);
			const ext = filePath?.split(".").pop()?.toLowerCase();
			// PPTX files need server-side conversion (LibreOffice → PNG slides),
			// so always fetch even when inline content is available.
			if (filePath && (ext === "pptx" || ext === "ppt")) {
				fetchAndCreateFileArtifact(filePath);
			} else if (filePath && content) {
				createFileArtifact(filePath, content);
			} else if (filePath && !content) {
				fetchAndCreateFileArtifact(filePath);
			}
		}
	}
	if (event.type === "tool_execution_end" && event.isError) {
		pendingToolArgs.delete(event.toolCallId);
	}
	if (event.type === "message_end") {
		const msg = (event as any).message;
		if (msg?.role === "assistant") {
			scanMessageForFileReferences(msg);
		}
	}

	renderApp();
}

async function onWebSocketOpen(): Promise<void> {
	console.log("[ws] Connected to bridge server");
	wsConnected = true;
	reconnectDelay = 1000;

	remoteAgent = new RemoteAgent(ws!);

	await chatPanel.setAgent(remoteAgent as unknown as Agent, {
		onApiKeyRequired: async () => true, // Keys managed server-side
		toolsFactory: () => [],              // Tools run on the server
	});

	renderApp();

	// Restore messages from a previous session if switching via sidebar
	const restoredFromStorage = pendingSessionMessages != null;
	if (pendingSessionMessages) {
		const messages = pendingSessionMessages;
		const cachedArtifacts = pendingArtifactsCache;
		pendingSessionMessages = null;
		pendingArtifactsCache = null;

		remoteAgent.loadMessagesFromStorage(messages);
		if (chatPanel?.agentInterface) {
			chatPanel.agentInterface.requestUpdate();
		}
		reconstructFileArtifactsFromMessages(messages, cachedArtifacts ?? undefined);
	}

	try {
		await remoteAgent.syncState();
		trackCurrentModel();
		chatPanel.agentInterface?.requestUpdate();
		if (!restoredFromStorage) {
			remoteAgent.fetchMessages().catch((err) => {
				console.error("Failed to fetch messages:", err);
			});
		}
	} catch (err) {
		console.error("Failed to sync initial state:", err);
	}

	agentUnsubscribe = remoteAgent.subscribe(onAgentEvent);
	renderApp();
}

function onWebSocketClose(event: CloseEvent): void {
	console.log(`[ws] Disconnected (code=${event.code}, reason=${event.reason})`);

	// If this close was triggered by intentional disconnect (profile switch, etc.),
	// skip session save and reconnect — the caller handles the next connection.
	if (intentionalDisconnect) {
		return;
	}

	// Handle generating limit exceeded — no auto-reconnect
	if (event.code === 4031) {
		wsConnected = false;
		remoteAgent = null;
		if (agentUnsubscribe) {
			agentUnsubscribe();
			agentUnsubscribe = undefined;
		}
		alert("You have 3 sessions actively running. Stop one before starting another.");
		renderApp();
		return;
	}

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

	if (authClient.isAuthenticated) {
		clearTimeout(reconnectTimer);
		console.log(`[ws] Reconnecting in ${reconnectDelay / 1000}s...`);
		reconnectTimer = setTimeout(() => {
			console.log("[ws] Attempting reconnect...");
			connectWebSocket();
		}, reconnectDelay);
		reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
	}
}

function connectWebSocket(): void {
	if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
		return;
	}

	ws = new WebSocket(getWsUrl());
	ws.addEventListener("open", onWebSocketOpen);
	ws.addEventListener("close", onWebSocketClose);
	ws.addEventListener("error", (event) => console.error("[ws] Error:", event));
}

function disconnectWebSocket(): void {
	clearTimeout(reconnectTimer);
	clearTimeout(saveSessionTimer);
	intentionalDisconnect = true;
	if (ws) {
		ws.removeEventListener("open", onWebSocketOpen);
		ws.removeEventListener("close", onWebSocketClose);
		ws.close();
		ws = null;
	}
	wsConnected = false;
	reconnectDelay = 1000;
	remoteAgent = null;
	if (agentUnsubscribe) {
		agentUnsubscribe();
		agentUnsubscribe = undefined;
	}
	intentionalDisconnect = false;
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
// Agent profiles fetching
// ============================================================================

async function fetchAgentProfiles(): Promise<void> {
	try {
		const res = await fetch("/api/agent-profiles", {
			headers: { Authorization: `Bearer ${authClient.token}` },
		});
		if (!res.ok) return;
		const data = await res.json();
		const profiles = data?.data?.profiles;
		if (data.success && Array.isArray(profiles)) {
			agentProfiles = profiles;
			renderApp();
		}
	} catch (err) {
		console.error("Failed to fetch agent profiles:", err);
	}
}

function selectAgentProfile(profileId: string | undefined): void {
	profileMenuOpen = false;

	// Save current session before switching (if there's anything to save)
	clearTimeout(saveSessionTimer);
	if (currentSessionId && remoteAgent) {
		saveSession();
	}

	// Disconnect old WebSocket cleanly (listeners removed, no stale reconnects)
	disconnectWebSocket();

	// Now clear state for the new profile session
	currentAgentProfileId = profileId;
	currentSessionId = undefined;
	currentTitle = "";
	currentModelId = undefined;
	currentProvider = undefined;
	chatPanel?.artifactsPanel?.clear();
	fetchedFileRefs.clear();

	connectWebSocket();
	renderApp();
}

// ============================================================================
// Session status SSE subscription
// ============================================================================

function initSessionStatusSSE(): void {
	if (sessionStatusEventSource) {
		sessionStatusEventSource.close();
		sessionStatusEventSource = null;
	}

	const connect = async () => {
		try {
			// Get SSE ticket
			const ticketRes = await fetch("/api/auth/sse-ticket", {
				method: "POST",
				headers: { Authorization: `Bearer ${authClient.token}` },
			});
			if (!ticketRes.ok) return;
			const ticketData = await ticketRes.json();
			const ticket = ticketData?.data?.ticket;
			if (!ticket) return;

			const es = new EventSource(`/api/sessions/events?ticket=${encodeURIComponent(ticket)}`);
			sessionStatusEventSource = es;

			es.addEventListener("snapshot", (e: MessageEvent) => {
				try {
					const snapshot = JSON.parse(e.data) as Record<string, SessionStatus>;
					sessionStatusMap = new Map(Object.entries(snapshot));
					renderApp();
				} catch {}
			});

			es.addEventListener("session_status", (e: MessageEvent) => {
				try {
					const event = JSON.parse(e.data) as { sessionId: string; status: SessionStatus };
					sessionStatusMap.set(event.sessionId, event.status);
					renderApp();
				} catch {}
			});

			es.onerror = () => {
				es.close();
				sessionStatusEventSource = null;
				// Retry after 5s with new ticket
				setTimeout(connect, 5000);
			};
		} catch {
			setTimeout(connect, 5000);
		}
	};

	connect();
}

function closeSessionStatusSSE(): void {
	if (sessionStatusEventSource) {
		sessionStatusEventSource.close();
		sessionStatusEventSource = null;
	}
	sessionStatusMap.clear();
}

// ============================================================================
// File artifact detection helpers
// ============================================================================

/** Extract renderable file path from tool args (supports various arg shapes).
 *  Only returns paths for "final output" file types (documents, images, rich visuals).
 *  Filters out temp/skill files to keep the artifacts panel clean. */
function getRenderablePathFromArgs(args: any): string | null {
	if (!args || typeof args !== "object") return null;
	const filePath = args.path || args.filePath || args.file_path || args.filename || "";
	if (typeof filePath !== "string" || filePath.length === 0) return null;
	// Skip files in temp directories (skill files, system prompt files, etc.)
	if (filePath.startsWith("/tmp/") || filePath.includes("/pi-skills-") || filePath.includes("/pi-sysprompt-")) {
		return null;
	}
	const ext = filePath.split(".").pop()?.toLowerCase();
	if (ext && ARTIFACT_AUTO_DETECT_EXTENSIONS.has(ext)) {
		return filePath;
	}
	return null;
}

/** Extract content from tool args */
function getContentFromArgs(args: any): string | null {
	if (!args || typeof args !== "object") return null;
	const content = args.content || args.data || args.text || "";
	return typeof content === "string" && content.length > 0 ? content : null;
}

/** Create or update an artifact in the panel from a file write */
async function createFileArtifact(filePath: string, content: string) {
	const panel = chatPanel?.artifactsPanel;
	if (!panel) return;
	const filename = filePath.split("/").pop() || filePath;
	const command = panel.artifacts.has(filename) ? "rewrite" : "create";
	await panel.executeCommand({ command, filename, content });
}

/** Fetch file from server (fallback when content not in args) */
async function fetchAndCreateFileArtifact(filePath: string) {
	try {
		const res = await fetch(`/api/agent-files?path=${encodeURIComponent(filePath)}`, {
			headers: { Authorization: `Bearer ${authClient.token}` },
		});
		if (!res.ok) return;
		const data = await res.json();
		// PPTX: server returns pre-rendered slide images + raw binary for download
		if (data.encoding === "slides" && data.slides) {
			await createFileArtifact(filePath, JSON.stringify({ slides: data.slides, raw: data.raw }));
		} else if (data.content) {
			await createFileArtifact(filePath, data.content);
		}
	} catch (err) {
		console.error("[artifacts] Failed to fetch file:", err);
	}
}

/** Scan messages for renderable file writes and reconstruct artifacts */
async function reconstructFileArtifactsFromMessages(
	messages: AgentMessage[],
	artifactsCache?: Record<string, string>,
) {
	const panel = chatPanel?.artifactsPanel;
	if (!panel) return;

	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		// Check tool calls for file writes with content
		for (const block of msg.content) {
			if ((block as any).type !== "toolCall") continue;
			const args = (block as any).arguments;
			const filePath = getRenderablePathFromArgs(args);
			const content = getContentFromArgs(args);
			const ext = filePath?.split(".").pop()?.toLowerCase();
			if (filePath && (ext === "pptx" || ext === "ppt")) {
				const filename = filePath.split("/").pop() || filePath;
				if (artifactsCache && artifactsCache[filename]) {
					await createFileArtifact(filePath, artifactsCache[filename]);
				} else {
					await fetchAndCreateFileArtifact(filePath);
				}
				trackDirFromPath(filePath);
			} else if (filePath && content) {
				await createFileArtifact(filePath, content);
				trackDirFromPath(filePath);
			}
		}
		// Also scan text for binary file references (e.g. script-generated files)
		scanMessageForFileReferences(msg);
	}
}

/**
 * Regex to find binary/generated filenames in assistant message text.
 * Only scans for binary types — text files are caught by tool-arg detection.
 * Handles markdown formatting: backticks (`file.pptx`), bold (**file.pdf**), etc.
 */
const FILE_REF_REGEX = new RegExp(
	`([\\w][\\w.\\-]*\\.(${[...BINARY_EXTENSIONS].join("|")}))` +
		`(?=[\\s\\),:;'"\\]!?\\x60*]|$)`,
	"gi",
);

/** Extract directory from an absolute file path and track it */
function trackDirFromPath(filePath: string) {
	if (filePath.startsWith("/")) {
		const dir = filePath.substring(0, filePath.lastIndexOf("/"));
		if (dir) lastKnownDir = dir;
	}
}

/**
 * Scan a single assistant message for binary file names not already
 * in the artifacts panel. This catches files generated by scripts
 * (e.g. a .js helper that writes a .pptx to disk).
 */
function scanMessageForFileReferences(msg: AgentMessage) {
	const panel = chatPanel?.artifactsPanel;
	if (!panel || !msg.content || typeof msg.content === "string") return;

	for (const block of msg.content) {
		if ((block as any).type !== "text") continue;
		const text = (block as any).text as string;
		FILE_REF_REGEX.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = FILE_REF_REGEX.exec(text)) !== null) {
			const filename = match[1];
			if (panel.artifacts.has(filename) || fetchedFileRefs.has(filename)) continue;
			fetchedFileRefs.add(filename);
			const fetchPath = lastKnownDir ? `${lastKnownDir}/${filename}` : filename;
			fetchAndCreateFileArtifact(fetchPath);
		}
	}
}

// ============================================================================
// Welcome screen
// ============================================================================

const DEFAULT_STARTER_PROMPTS = [
	"Draft a professional email",
	"Summarize a document",
	"Analyze data from a spreadsheet",
	"Create a report outline",
	"Help me brainstorm ideas",
	"Explain a complex topic simply",
];

function sendStarterPrompt(prompt: string) {
	if (!remoteAgent || !chatPanel) return;
	const agentIface = chatPanel.agentInterface;
	if (agentIface && typeof agentIface.sendMessage === "function") {
		agentIface.sendMessage(prompt);
	}
}

function buildWelcomeContent() {
	const currentProfile = agentProfiles.find(p => p.id === currentAgentProfileId);
	const profilePrompts = currentProfile?.suggested_prompts;
	const starterPrompts = profilePrompts && profilePrompts.length > 0 ? profilePrompts : DEFAULT_STARTER_PROMPTS;

	const profileName = currentProfile?.name || "AI Assistant";
	const profileIcon = currentProfile?.icon || "";
	const profileDescription = currentProfile?.description || "Ask me anything or try one of the suggestions below.";

	return html`
		<div class="flex-1 flex flex-col items-center px-4">
			<!-- Top spacer: pushes content to ~60% down the viewport -->
			<div style="flex: 3"></div>

			<div class="flex flex-col items-center gap-3 max-w-lg w-full text-center">
				${profileIcon ? html`<span class="text-4xl">${profileIcon}</span>` : html`
					<div class="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
						${icon(Bot, "md")}
					</div>
				`}
				<div>
					<h2 class="text-lg font-semibold text-foreground mb-1">${profileName}</h2>
					<p class="text-sm text-muted-foreground">${profileDescription}</p>
				</div>

				<div class="grid grid-cols-2 gap-2 w-full mt-1">
					${starterPrompts.slice(0, 6).map(prompt => html`
						<button
							class="text-left px-3 py-2.5 rounded-lg border border-border bg-background hover:bg-muted transition-colors cursor-pointer text-sm text-foreground"
							@click=${() => sendStarterPrompt(prompt)}
						>
							${prompt}
						</button>
					`)}
				</div>

				${!currentAgentProfileId && agentProfiles.length > 0 ? html`
					<p class="text-xs text-muted-foreground mt-1">
						Switch to a specialist AI using the profile selector above
					</p>
				` : nothing}
			</div>

			<!-- Bottom spacer: smaller than top to keep content above center -->
			<div style="flex: 2"></div>
		</div>
	`;
}

function updateWelcomeContent() {
	if (!chatPanel) return;
	const messages = remoteAgent?.state?.messages || [];
	if (messages.length > 0 || currentSessionId) {
		chatPanel.welcomeContent = undefined;
	} else {
		chatPanel.welcomeContent = buildWelcomeContent();
	}
}

// ============================================================================
// Render
// ============================================================================

const renderApp = () => {
	const app = document.getElementById("app");
	if (!app) return;

	// Update welcome content on the chat panel before rendering
	updateWelcomeContent();

	// Not authenticated — show login page
	if (!authClient.isAuthenticated) {
		const loginHtml = html`
			<login-page .authClient=${authClient} @auth-success=${onAuthSuccess}></login-page>
		`;
		render(loginHtml, app);
		return;
	}

	// Authenticated — resolve route
	const resolved = resolveRoute();
	currentRoute = resolved.route;
	routeParams = resolved.params;

	const user = authClient.user;

	// Studio routes — render full-page studio
	if (currentRoute === "studio" || currentRoute === "studio-edit") {
		const studioHtml = html`
			<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
				<studio-page
					.getToken=${() => authClient.token}
					.userRole=${user?.role || "member"}
					.userId=${user?.userId || ""}
					.editProfileId=${currentRoute === "studio-edit" ? routeParams.id : null}
					.activeTab=${routeParams.tab || "profiles"}
					@profiles-changed=${() => fetchAgentProfiles()}
				></studio-page>
			</div>
		`;
		render(studioHtml, app);
		return;
	}

	// Chat route
	const sessionGroups = groupSessionsByDate(sidebarSessions);

	const appHtml = html`
		<div class="w-full h-screen flex flex-row bg-background text-foreground overflow-hidden">
			<!-- Sidebar -->
			<aside class="shrink-0 flex flex-col border-r border-border bg-muted/30 overflow-hidden transition-all duration-200 ${sidebarOpen ? "w-64" : "w-0"}">
				${sidebarOpen ? html`
					<!-- Sidebar header -->
					<div class="flex items-center justify-between px-3 py-3 border-b border-border">
						<span class="text-sm font-semibold text-foreground truncate">Chatbot Platform</span>
						${Button({
							variant: "ghost",
							size: "sm",
							children: icon(PanelLeftClose, "sm"),
							onClick: () => { sidebarOpen = false; renderApp(); },
							title: "Collapse sidebar",
						})}
					</div>

					<!-- New session button -->
					<div class="px-3 py-2">
						<button
							class="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium border border-border hover:bg-muted transition-colors cursor-pointer"
							@click=${() => {
								clearTimeout(saveSessionTimer);
								if (currentSessionId && remoteAgent) saveSession();
								disconnectWebSocket();
								currentSessionId = undefined;
								currentTitle = "";
								chatPanel?.artifactsPanel?.clear();
								fetchedFileRefs.clear();
								connectWebSocket();
								renderApp();
							}}
						>
							${icon(Plus, "sm")}
							<span>New chat</span>
						</button>
					</div>

					<!-- Session list -->
					<div class="flex-1 overflow-y-auto px-2 py-1">
						${sessionGroups.length === 0 ? html`
							<div class="text-xs text-muted-foreground px-2 py-4 text-center">No sessions yet</div>
						` : sessionGroups.map((group) => html`
							<div class="mb-2">
								<div class="text-xs font-medium text-muted-foreground px-2 py-1">${group.label}</div>
								${group.sessions.map((session) => {
									const status = sessionStatusMap.get(session.id);
									const isGenerating = status === "generating";
									const isIdle = status === "idle";
									return html`
									<div
										class="group flex items-center gap-1 px-2 py-1.5 rounded-md text-sm cursor-pointer transition-colors ${session.id === currentSessionId ? "bg-muted font-medium" : "hover:bg-muted/60"}"
										@click=${() => loadSession(session.id)}
									>
										<span class="relative shrink-0">
											${icon(MessageSquare, "sm")}
											${isGenerating ? html`<span class="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-orange-500 animate-pulse"></span>` : nothing}
											${isIdle ? html`<span class="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-orange-400"></span>` : nothing}
										</span>
										<span class="flex-1 truncate">${session.title || "Untitled"}</span>
										${isGenerating && session.id !== currentSessionId ? html`
											<button
												class="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-orange-500/10 hover:text-orange-500 transition-opacity cursor-pointer"
												title="Stop generating"
												@click=${(e: Event) => {
													e.stopPropagation();
													abortSession(session.id);
												}}
											>
												${icon(Square, "sm")}
											</button>
										` : nothing}
										<button
											class="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-destructive/10 hover:text-destructive transition-opacity cursor-pointer"
											title="Delete session"
											@click=${(e: Event) => { e.stopPropagation(); deleteSession(session.id); }}
										>
											${icon(Trash2, "sm")}
										</button>
									</div>
								`})}
							</div>
						`)}
					</div>

					<!-- Sidebar footer -->
					<div class="border-t border-border px-3 py-2 flex items-center gap-2">
						<span class="w-2 h-2 rounded-full shrink-0 ${wsConnected ? "bg-green-500" : "bg-red-500"}"></span>
						<span class="text-xs text-muted-foreground truncate flex-1">${user?.email || ""}</span>
					</div>
				` : nothing}
			</aside>

			<!-- Main content -->
			<div class="flex-1 flex flex-col min-w-0">
				<!-- Header -->
				<div class="flex items-center justify-between border-b border-border shrink-0 px-3 py-1.5">
					<!-- Left: sidebar toggle + session title -->
					<div class="flex items-center gap-2 min-w-0">
						${!sidebarOpen ? Button({
							variant: "ghost",
							size: "sm",
							children: icon(PanelLeft, "sm"),
							onClick: () => { sidebarOpen = true; renderApp(); },
							title: "Open sidebar",
						}) : nothing}
						<span class="text-sm font-medium text-foreground truncate">${currentTitle || "New chat"}</span>
					</div>

					<!-- Right: studio link, agent profile selector, tools dropdown, theme toggle, user menu -->
					<div class="flex items-center gap-1">
						<!-- Agent Builder link -->
						<button
							class="flex items-center gap-1.5 px-2 py-1 text-sm rounded-md hover:bg-muted transition-colors cursor-pointer border border-transparent hover:border-border text-muted-foreground hover:text-foreground"
							@click=${() => navigateTo("/studio")}
						>
							${icon(Bot, "sm")}
							<span>Agent Builder</span>
						</button>
						<!-- Agent profile selector -->
						<div class="relative" data-profile-menu>
							<button
								class="flex items-center gap-1.5 px-2 py-1 text-sm rounded-md hover:bg-muted transition-colors cursor-pointer border border-transparent hover:border-border"
								@click=${(e: Event) => {
									e.stopPropagation();
									profileMenuOpen = !profileMenuOpen;
									toolsMenuOpen = false;
									userMenuOpen = false;
									renderApp();
								}}
							>
								${(() => {
									const current = agentProfiles.find(p => p.id === currentAgentProfileId);
									return current
										? html`<span>${current.icon || ""}${!current.icon ? icon(Bot, "sm") : nothing}</span><span class="max-w-[120px] truncate">${current.name}</span>`
										: html`${icon(Bot, "sm")}<span>Default</span>`;
								})()}
								${icon(ChevronDown, "sm")}
							</button>
							${profileMenuOpen ? html`
								<div class="absolute right-0 top-full mt-1 w-72 bg-background border border-border rounded-md shadow-lg py-1 z-50 max-h-80 overflow-y-auto">
									<!-- Default agent -->
									<button
										class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors text-left cursor-pointer ${!currentAgentProfileId ? "bg-muted/60 font-medium" : ""}"
										@click=${() => selectAgentProfile(undefined)}
									>
										${icon(Bot, "sm")}
										<div class="flex-1 min-w-0">
											<div class="truncate">Default Agent</div>
											<div class="text-xs text-muted-foreground truncate">All skills, default prompt</div>
										</div>
									</button>
									${agentProfiles.length > 0 ? html`
										<div class="border-t border-border my-1"></div>
										${agentProfiles.map(p => html`
											<div class="flex items-center hover:bg-muted transition-colors ${currentAgentProfileId === p.id ? "bg-muted/60 font-medium" : ""}">
												<button
													class="flex-1 flex items-center gap-2 px-3 py-2 text-sm text-left cursor-pointer bg-transparent border-none font-[inherit]"
													@click=${() => selectAgentProfile(p.id)}
												>
													<span class="shrink-0">${p.icon || ""}${!p.icon ? icon(Bot, "sm") : nothing}</span>
													<div class="flex-1 min-w-0">
														<div class="truncate">${p.name}</div>
														${p.description ? html`<div class="text-xs text-muted-foreground truncate">${p.description}</div>` : nothing}
													</div>
													<span class="text-xs text-muted-foreground shrink-0">${p.scope}</span>
												</button>
												<button
													class="shrink-0 p-1 mr-2 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary cursor-pointer bg-transparent border-none"
													title="Edit in Studio"
													@click=${(e: Event) => {
														e.stopPropagation();
														profileMenuOpen = false;
														navigateTo(`/studio/${p.id}/edit`);
														renderApp();
													}}
												>
													${icon(Settings, "sm")}
												</button>
											</div>
										`)}
									` : nothing}
									<div class="border-t border-border my-1"></div>
									<button
										class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors text-left cursor-pointer"
										@click=${() => {
											profileMenuOpen = false;
											navigateTo("/studio");
											renderApp();
										}}
									>
										${icon(Settings, "sm")}
										<span>Manage in Agent Builder...</span>
									</button>
								</div>
							` : nothing}
						</div>
						<!-- Tools dropdown -->
						<div class="relative" data-tools-menu>
							${Button({
								variant: "ghost",
								size: "sm",
								children: html`<span class="flex items-center gap-1">${icon(Wrench, "sm")}${icon(ChevronDown, "sm")}</span>`,
								onClick: (e: Event) => {
									e.stopPropagation();
									toolsMenuOpen = !toolsMenuOpen;
									userMenuOpen = false;
									renderApp();
								},
								title: "Tools",
							})}
							${toolsMenuOpen ? html`
								<div class="absolute right-0 top-full mt-1 w-52 bg-background border border-border rounded-md shadow-lg py-1 z-50">
									<button class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors text-left cursor-pointer" @click=${() => {
										toolsMenuOpen = false;
										openDialog({
											title: "Skills",
											tag: "skills-panel",
											setup: (panel) => { panel.getToken = () => authClient.token; panel.userRole = user?.role || "member"; },
										});
										renderApp();
									}}>
										${icon(Puzzle, "sm")}
										<span>Agent Tools</span>
									</button>
									<button class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors text-left cursor-pointer" @click=${() => {
										toolsMenuOpen = false;
										openDialog({
											title: "Files",
											tag: "files-panel",
											setup: (panel) => { panel.getToken = () => authClient.token; },
										});
										renderApp();
									}}>
										${icon(FileUp, "sm")}
										<span>Files</span>
									</button>
									<button class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors text-left cursor-pointer" @click=${() => {
										toolsMenuOpen = false;
										openDialog({
											title: "Memory",
											tag: "memory-panel",
											setup: (panel) => { panel.getToken = () => authClient.token; },
										});
										renderApp();
									}}>
										${icon(Brain, "sm")}
										<span>Memory</span>
									</button>
									<button class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors text-left cursor-pointer" @click=${() => {
										toolsMenuOpen = false;
										openDialog({
											title: "Your AI Subscriptions",
											tag: "oauth-connections-panel",
											setup: (panel) => { panel.getToken = () => authClient.token; },
										});
										renderApp();
									}}>
										${icon(Link, "sm")}
										<span>Your AI Subscriptions</span>
									</button>
									${user?.role === "admin" ? html`
										<button class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors text-left cursor-pointer" @click=${() => {
											toolsMenuOpen = false;
											openDialog({
												title: "Provider Keys",
												tag: "provider-keys-panel",
												setup: (panel) => { panel.getToken = () => authClient.token; },
											});
											renderApp();
										}}>
											${icon(KeyRound, "sm")}
											<span>Provider Keys</span>
										</button>
									` : nothing}
									<button class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors text-left cursor-pointer" @click=${() => {
										toolsMenuOpen = false;
										openDialog({
											title: "Background Tasks",
											tag: "tasks-dashboard",
											style: "max-width: 900px; width: 90vw; padding: 1.5rem; border: 1px solid var(--border); border-radius: 0.5rem; background: var(--background);",
											setup: (panel) => {
												panel.getToken = () => authClient.token;
												panel.userRole = user?.role || "member";
											},
										});
										renderApp();
									}}>
										${icon(ListTodo, "sm")}
										<span>Background Tasks</span>
									</button>
									<button class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors text-left cursor-pointer" @click=${() => {
										toolsMenuOpen = false;
										openDialog({
											title: "Scheduled Jobs",
											tag: "scheduler-panel",
											style: "max-width: 900px; width: 90vw; padding: 1.5rem; border: 1px solid var(--border); border-radius: 0.5rem; background: var(--background);",
											setup: (panel) => {
												panel.getToken = () => authClient.token;
												panel.userRole = user?.role || "member";
											},
										});
										renderApp();
									}}>
										${icon(Calendar, "sm")}
										<span>Scheduled Jobs</span>
									</button>
								</div>
							` : nothing}
						</div>

						<theme-toggle></theme-toggle>

						<!-- User menu dropdown -->
						<div class="relative" data-user-menu>
							${Button({
								variant: "ghost",
								size: "sm",
								children: html`<span class="flex items-center gap-1">${icon(Settings, "sm")}${icon(ChevronDown, "sm")}</span>`,
								onClick: (e: Event) => {
									e.stopPropagation();
									userMenuOpen = !userMenuOpen;
									toolsMenuOpen = false;
									renderApp();
								},
								title: "User menu",
							})}
							${userMenuOpen ? html`
								<div class="absolute right-0 top-full mt-1 w-48 bg-background border border-border rounded-md shadow-lg py-1 z-50">
									<div class="px-3 py-2 text-xs text-muted-foreground border-b border-border">${user?.email || ""}</div>
									<button class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors text-left cursor-pointer" @click=${() => {
										userMenuOpen = false;
										const tabs: SettingsTab[] = [new ProvidersModelsTab(), new ProxyTab()];
										if (user?.role === "admin") {
											const t = new TeamMembersTab();
											t.getToken = () => authClient.token;
											t.currentUserId = user?.userId || "";
											tabs.push(t);
										}
										SettingsDialog.open(tabs);
										renderApp();
									}}>
										${icon(Settings, "sm")}
										<span>Settings</span>
									</button>
									<button class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors text-left text-destructive cursor-pointer" @click=${() => {
										userMenuOpen = false;
										handleLogout();
									}}>
										${icon(LogOut, "sm")}
										<span>Logout</span>
									</button>
								</div>
							` : nothing}
						</div>
					</div>
				</div>

				<!-- Chat Panel -->
				${
					!wsConnected
						? html`<div class="flex-1 flex items-center justify-center">
							<div class="flex flex-col items-center gap-2">
								<div class="flex items-center gap-1 text-muted-foreground text-sm">
									<span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>
									<span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" style="animation-delay: 0.2s"></span>
									<span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" style="animation-delay: 0.4s"></span>
								</div>
								<span class="text-muted-foreground text-sm">Setting up your AI assistant...</span>
							</div>
						</div>`
						: chatPanel
				}
			</div>
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
	fetchAgentProfiles();
	loadSidebarSessions();
	initSessionStatusSSE();
	renderApp();
}

function handleLogout() {
	disconnectWebSocket();
	closeSessionStatusSSE();
	storage = null;
	sidebarSessions = [];
	currentSessionId = undefined;
	currentTitle = "";
	currentAgentProfileId = undefined;
	agentProfiles = [];
	authClient.logout();
	renderApp();
}

// ============================================================================
// Init
// ============================================================================

async function initApp() {
	const app = document.getElementById("app");
	if (!app) throw new Error("App container not found");

	setupClickOutside();

	// Client-side routing
	window.addEventListener("popstate", () => renderApp());
	window.addEventListener("route-change", () => renderApp());

	if (authClient.isAuthenticated) {
		// Validate stored token
		const valid = await authClient.validate();
		if (valid) {
			storage = initStorage();
			chatPanel = new ChatPanel();
			connectWebSocket();
			fetchSkills();
			fetchAgentProfiles();
			loadSidebarSessions();
			initSessionStatusSSE();
		} else {
			// Token expired/invalid — show login
			authClient.logout();
		}
	}

	renderApp();
}

initApp();
