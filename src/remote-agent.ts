/**
 * RemoteAgent: An Agent-compatible class that communicates with the
 * pi-coding-agent's RPC mode via WebSocket.
 *
 * Implements the same interface that AgentInterface/ChatPanel expects
 * from Agent, but delegates all work to the remote RPC process.
 */

import type {
	AgentEvent,
	AgentMessage,
	AgentState,
	AgentTool,
	StreamFn,
	ThinkingLevel,
} from "@mariozechner/pi-agent-core";
import type { ImageContent, Model } from "@mariozechner/pi-ai";
import { convertAttachments, isUserMessageWithAttachments } from "./web-ui/index.js";

// Minimal Model placeholder for initial state
const PLACEHOLDER_MODEL: Model<any> = {
	api: "anthropic" as any,
	provider: "anthropic",
	id: "loading...",
	name: "Loading...",
	contextWindow: 200000,
	maxTokens: 64000,
	reasoning: false,
	input: ["text"],
	baseUrl: "",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/**
 * RemoteAgent provides an Agent-compatible interface backed by WebSocket
 * communication to a pi-coding-agent RPC process.
 */
export class RemoteAgent {
	private _state: AgentState = {
		systemPrompt: "",
		model: PLACEHOLDER_MODEL,
		thinkingLevel: "off",
		tools: [],
		messages: [],
		isStreaming: false,
		streamMessage: null,
		pendingToolCalls: new Set<string>(),
		error: undefined,
	};

	private listeners = new Set<(e: AgentEvent) => void>();
	private ws: WebSocket;
	private requestId = 0;
	private pendingRequests = new Map<string, { resolve: (data: any) => void; reject: (err: Error) => void }>();

	// These are expected by AgentInterface but are no-ops for remote agent
	public streamFn: StreamFn = (() => {}) as any;
	// Always return a dummy key so AgentInterface doesn't prompt for API keys
	// (the real API key is managed server-side by the TenantBridge)
	public getApiKey: (provider: string) => Promise<string | undefined> | string | undefined = () =>
		"remote-agent-server-side";

	constructor(ws: WebSocket) {
		this.ws = ws;
		this.ws.addEventListener("message", (event) => {
			this.handleMessage(event.data as string);
		});
	}

	// =========================================================================
	// Agent-compatible interface
	// =========================================================================

	get state(): AgentState {
		return this._state;
	}

	subscribe(fn: (e: AgentEvent) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	setModel(m: Model<any>): void {
		// Update local state optimistically
		this._state.model = m;
		// Send as a tracked command so the response doesn't trigger showError
		this.sendCommand({ type: "set_model", provider: m.provider, modelId: m.id }).catch((err) => {
			console.warn(`[RemoteAgent] set_model rejected: ${err.message}`);
		});
	}

	setThinkingLevel(l: ThinkingLevel): void {
		this._state.thinkingLevel = l;
		this.send({ type: "set_thinking_level", level: l });
	}

	setTools(_t: AgentTool<any>[]): void {
		// No-op: tools are managed server-side
	}

	setSystemPrompt(_v: string): void {
		// No-op: system prompt is managed server-side
	}

	abort(): void {
		this.send({ type: "abort" });
	}

	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
		let message: string;
		let resolvedImages = images;

		if (typeof input === "string") {
			message = input;
		} else if (Array.isArray(input)) {
			const first = input[0];
			message = this.extractText(first);
		} else {
			// Handle UserMessageWithAttachments: extract images and document
			// text so the RPC server receives them properly.
			if (isUserMessageWithAttachments(input) && input.attachments?.length) {
				const converted = convertAttachments(input.attachments);
				const imageBlocks = converted.filter((c): c is ImageContent => c.type === "image");
				const textBlocks = converted.filter((c) => c.type === "text").map((c) => (c as any).text as string);

				message = this.extractText(input);
				if (textBlocks.length > 0) {
					message = message + "\n" + textBlocks.join("\n");
				}
				if (imageBlocks.length > 0) {
					resolvedImages = [...(resolvedImages || []), ...imageBlocks];
				}

				// Store the rich message locally so the UI shows attachment
				// tiles instead of raw document text.
				this._state.messages = [...this._state.messages, input];
				this.emit({ type: "state-update", state: this._state } as any);
			} else {
				message = this.extractText(input);
			}
		}

		console.log("[RemoteAgent] prompt:", message);
		await this.sendCommand({ type: "prompt", message, images: resolvedImages });
		console.log("[RemoteAgent] prompt command acknowledged");
	}

	steer(m: AgentMessage): void {
		const message = this.extractText(m);
		this.send({ type: "steer", message });
	}

	followUp(m: AgentMessage): void {
		const message = this.extractText(m);
		this.send({ type: "follow_up", message });
	}

	// Required by Agent interface but no-ops — state is managed server-side
	replaceMessages(_ms: AgentMessage[]): void {}
	appendMessage(_m: AgentMessage): void {}
	clearMessages(): void {}
	clearSteeringQueue(): void {}
	clearFollowUpQueue(): void {}
	clearAllQueues(): void {}
	hasQueuedMessages(): boolean { return false; }

	waitForIdle(): Promise<void> {
		if (!this._state.isStreaming) return Promise.resolve();
		return new Promise((resolve) => {
			const unsub = this.subscribe((e) => {
				if (e.type === "agent_end") {
					unsub();
					resolve();
				}
			});
		});
	}

	reset(): void {
		this.send({ type: "new_session" });
		this._state.messages = [];
		this._state.isStreaming = false;
		this._state.streamMessage = null;
		this._state.pendingToolCalls = new Set();
		this._state.error = undefined;
	}

	// =========================================================================
	// RPC-specific methods
	// =========================================================================

	/**
	 * Fetch full state from server and sync local state.
	 */
	async syncState(): Promise<void> {
		const response = await this.sendCommand({ type: "get_state" });
		if (response?.data) {
			const data = response.data;
			if (data.model) this._state.model = data.model;
			this._state.thinkingLevel = data.thinkingLevel;
			this._state.isStreaming = data.isStreaming;
			// Notify UI so it picks up the updated model/state
			this.emit({ type: "state-update", state: this._state } as any);
		}
	}

	/**
	 * Fetch messages from server.
	 */
	async fetchMessages(): Promise<AgentMessage[]> {
		const response = await this.sendCommand({ type: "get_messages" });
		if (response?.data?.messages) {
			const serverMessages: AgentMessage[] = response.data.messages;

			// Preserve local user-with-attachments messages so the UI shows
			// nice attachment tiles instead of the server's plain-text version.
			// Match by position: for each user message from the server, check
			// if we have a richer local version at the same index.
			const localAttachmentMsgs = this._state.messages.filter(isUserMessageWithAttachments);
			if (localAttachmentMsgs.length > 0) {
				let localIdx = 0;
				for (let i = 0; i < serverMessages.length; i++) {
					if (serverMessages[i].role === "user" && localIdx < localAttachmentMsgs.length) {
						// Check if the text content matches (the server has our text)
						const serverText = this.extractText(serverMessages[i]);
						const localText = this.extractText(localAttachmentMsgs[localIdx]);
						if (serverText.startsWith(localText)) {
							serverMessages[i] = localAttachmentMsgs[localIdx];
						}
						localIdx++;
					}
				}
			}

			this._state.messages = serverMessages;
			// Notify UI so it re-renders with the reconciled messages
			this.emit({ type: "state-update", state: this._state } as any);
			return serverMessages;
		}
		return [];
	}

	/**
	 * Get available commands/skills.
	 */
	async getCommands(): Promise<any[]> {
		const response = await this.sendCommand({ type: "get_commands" });
		return response?.data?.commands || [];
	}

	/**
	 * Get available models.
	 */
	async getAvailableModels(): Promise<any[]> {
		const response = await this.sendCommand({ type: "get_available_models" });
		return response?.data?.models || [];
	}

	/**
	 * Load messages from storage (for resuming a session).
	 * This updates the local state and notifies all subscribers.
	 */
	loadMessagesFromStorage(messages: AgentMessage[]): void {
		this._state.messages = messages;
		this._state.isStreaming = false;
		this._state.streamMessage = null;
		this._state.error = undefined;
		// Clear pending tool calls since these are historical messages
		this._state.pendingToolCalls = new Set();
		// Emit state-update event to notify UI components
		this.emit({ type: "state-update", state: this._state } as any);
	}

	/**
	 * Start a new session.
	 */
	async newSession(): Promise<void> {
		await this.sendCommand({ type: "new_session" });
		this._state.messages = [];
		this._state.isStreaming = false;
		this._state.streamMessage = null;
		this._state.pendingToolCalls = new Set();
		this._state.error = undefined;
		this.emit({ type: "agent_end", messages: [] });
	}

	/**
	 * Send an extension UI response back to the server.
	 */
	sendExtensionUIResponse(response: any): void {
		this.ws.send(JSON.stringify(response));
	}

	// =========================================================================
	// Internal
	// =========================================================================

	private handleMessage(raw: string): void {
		let data: any;
		try {
			data = JSON.parse(raw);
		} catch {
			return;
		}

		// Handle bridge-level responses (e.g. bridge_set_api_key ack)
		if (data.type === "bridge_response" && data.id && this.pendingRequests.has(data.id)) {
			const pending = this.pendingRequests.get(data.id)!;
			this.pendingRequests.delete(data.id);
			pending.resolve(data);
			return;
		}

		// Handle RPC responses to pending requests
		if (data.type === "response" && data.id && this.pendingRequests.has(data.id)) {
			const pending = this.pendingRequests.get(data.id)!;
			this.pendingRequests.delete(data.id);
			if (data.success === false) {
				pending.reject(new Error(data.error || "Unknown error"));
			} else {
				pending.resolve(data);
			}
			return;
		}

		// Handle extension UI requests
		if (data.type === "extension_ui_request") {
			this.handleExtensionUIRequest(data);
			return;
		}

		// Handle late error responses (e.g. prompt fails after initial ack)
		if (data.type === "response" && data.success === false) {
			const errorText = data.error || "Unknown server error";
			console.error("[RemoteAgent] server error:", errorText);

			// Detect "No API key" errors — keys are managed server-side by admins
			const apiKeyMatch = errorText.match(/No API key found for (\S+)/);
			if (apiKeyMatch) {
				const provider = apiKeyMatch[1].replace(/\.$/, "");
				this.showError(
					`No API key configured for ${provider}. Contact your team admin to add the key in Provider Keys settings.`,
				);
				return;
			}

			this.showError(errorText);
			return;
		}

		// Handle agent events — update local state mirror
		console.log("[RemoteAgent] event:", data.type, data.message?.role || "", JSON.stringify(data).substring(0, 200));
		this.updateStateFromEvent(data);

		// Emit to subscribers
		this.emit(data as AgentEvent);
	}

	private updateStateFromEvent(event: any): void {
		switch (event.type) {
			case "agent_start":
				this._state.isStreaming = true;
				this._state.error = undefined;
				break;

			case "agent_end":
				this._state.isStreaming = false;
				this._state.streamMessage = null;
				this._state.pendingToolCalls = new Set();
				// Update messages from the event if provided
				if (event.messages && Array.isArray(event.messages)) {
					// agent_end messages are the messages produced in this run
					// Fetch the full list to stay in sync
					this.fetchMessages().catch(() => {});
				}
				break;

			case "message_start":
				if (event.message?.role === "assistant") {
					this._state.streamMessage = event.message;
				}
				break;

			case "message_update":
				if (event.message) {
					this._state.streamMessage = event.message;
				}
				break;

			case "message_end":
				if (event.message) {
					this._state.streamMessage = null;
					// Skip appending server user messages that duplicate a local
					// user-with-attachments message (the local version has richer data).
					if (event.message.role === "user") {
						const serverText = this.extractText(event.message);
						const isDuplicate = this._state.messages.some(
							(m) => isUserMessageWithAttachments(m) && serverText.startsWith(this.extractText(m)),
						);
						if (isDuplicate) break;
					}
					this._state.messages = [...this._state.messages, event.message];
				}
				break;

			case "tool_execution_start":
				if (event.toolCallId) {
					const s = new Set(this._state.pendingToolCalls);
					s.add(event.toolCallId);
					this._state.pendingToolCalls = s;
				}
				break;

			case "tool_execution_end":
				if (event.toolCallId) {
					const s = new Set(this._state.pendingToolCalls);
					s.delete(event.toolCallId);
					this._state.pendingToolCalls = s;
				}
				break;

			case "turn_end":
				if (event.message?.role === "assistant" && event.message?.errorMessage) {
					this._state.error = event.message.errorMessage;
				}
				break;
		}
	}

	private handleExtensionUIRequest(request: any): void {
		const { id, method } = request;

		switch (method) {
			case "notify": {
				// Show browser notification/toast
				console.log(`[extension] ${request.notifyType || "info"}: ${request.message}`);
				// Could use a toast library here. For now, console + optional alert
				break;
			}

			case "setStatus": {
				// Could show in a status bar
				console.log(`[extension] Status [${request.statusKey}]: ${request.statusText}`);
				break;
			}

			case "setTitle": {
				document.title = request.title;
				break;
			}

			case "select": {
				const selected = window.prompt(
					`${request.title}\n\nOptions:\n${request.options.map((o: string, i: number) => `${i + 1}. ${o}`).join("\n")}\n\nEnter number:`,
				);
				if (selected) {
					const idx = parseInt(selected, 10) - 1;
					if (idx >= 0 && idx < request.options.length) {
						this.sendExtensionUIResponse({
							type: "extension_ui_response",
							id,
							value: request.options[idx],
						});
					} else {
						this.sendExtensionUIResponse({ type: "extension_ui_response", id, cancelled: true });
					}
				} else {
					this.sendExtensionUIResponse({ type: "extension_ui_response", id, cancelled: true });
				}
				break;
			}

			case "confirm": {
				const confirmed = window.confirm(`${request.title}\n\n${request.message}`);
				this.sendExtensionUIResponse({
					type: "extension_ui_response",
					id,
					confirmed,
				});
				break;
			}

			case "input": {
				const value = window.prompt(request.title, request.placeholder || "");
				if (value !== null) {
					this.sendExtensionUIResponse({ type: "extension_ui_response", id, value });
				} else {
					this.sendExtensionUIResponse({ type: "extension_ui_response", id, cancelled: true });
				}
				break;
			}

			default:
				// For unhandled methods, cancel to avoid blocking the server
				this.sendExtensionUIResponse({ type: "extension_ui_response", id, cancelled: true });
				break;
		}
	}

	private showError(errorText: string): void {
		this._state.isStreaming = false;
		this._state.error = errorText;

		const errorMsg: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: `Error: ${errorText}` }],
			stopReason: "error",
			errorMessage: errorText,
			timestamp: Date.now(),
		} as AgentMessage;
		this._state.messages = [...this._state.messages, errorMsg];
		this._state.streamMessage = null;

		this.emit({ type: "agent_end", messages: [errorMsg] });
	}

	private emit(e: AgentEvent): void {
		for (const listener of this.listeners) {
			listener(e);
		}
	}

	/**
	 * Send a command without waiting for response.
	 */
	private send(command: any): void {
		this.ws.send(JSON.stringify(command));
	}

	/**
	 * Send a command and wait for the response.
	 */
	private sendCommand(command: any): Promise<any> {
		const id = `req_${++this.requestId}`;
		const fullCommand = { ...command, id };

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Timeout waiting for response to ${command.type}`));
			}, 30000);

			this.pendingRequests.set(id, {
				resolve: (data) => {
					clearTimeout(timeout);
					resolve(data);
				},
				reject: (err) => {
					clearTimeout(timeout);
					reject(err);
				},
			});

			this.ws.send(JSON.stringify(fullCommand));
		});
	}

	private extractText(m: AgentMessage): string {
		if (typeof m.content === "string") return m.content;
		if (Array.isArray(m.content)) {
			return m.content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n");
		}
		return "";
	}
}
