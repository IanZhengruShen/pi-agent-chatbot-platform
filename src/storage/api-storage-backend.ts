import type { StorageBackend, StorageTransaction } from "../web-ui/index.js";

export interface ApiStorageBackendOptions {
	baseUrl: string;
	getToken: () => string | null;
}

/**
 * StorageBackend implementation backed by REST API calls with an optimistic
 * in-memory cache. All reads return cached data immediately; writes update
 * the cache first, then fire-and-forget the server sync.
 */
export class ApiStorageBackend implements StorageBackend {
	private baseUrl: string;
	private getToken: () => string | null;
	private cache = new Map<string, Map<string, any>>();
	private initPromise: Promise<void> | null = null;
	private initialized = false;

	/** Tracks which session IDs are known to exist on the server. */
	private knownServerSessions = new Set<string>();

	/** Tracks sessions currently being created (POST in-flight). */
	private pendingCreations = new Map<string, Promise<void>>();

	/** LRU tracking for session data cache. Most recent ID is last. */
	private sessionAccessOrder: string[] = [];
	private static readonly MAX_CACHED_SESSIONS = 50;

	/**
	 * Tracks the number of messages the server knows about per session,
	 * so we can compute which messages are "new" during a set() call.
	 */
	private serverMessageCounts = new Map<string, number>();

	constructor(options: ApiStorageBackendOptions) {
		this.baseUrl = options.baseUrl.replace(/\/$/, "");
		this.getToken = options.getToken;
	}

	/** Serialize messages for batch API calls. */
	private serializeMessages(messages: any[]): any[] {
		return messages.map((m: any) => ({
			role: m.role,
			content: m.content,
			stopReason: m.stopReason ?? m.stop_reason,
			usage: m.usage,
		}));
	}

	// -----------------------------------------------------------------------
	// Initialization
	// -----------------------------------------------------------------------

	private async init(): Promise<void> {
		if (this.initialized) return;
		if (this.initPromise) return this.initPromise;

		this.initPromise = this._doInit();
		return this.initPromise;
	}

	private async _doInit(): Promise<void> {
		try {
			const [sessionsRes, settingsRes] = await Promise.all([
				this.apiFetch("/api/sessions"),
				this.apiFetch("/api/settings"),
			]);

			// Populate sessions-metadata cache
			const metadataCache = this.getStore("sessions-metadata");
			const sessionsCache = this.getStore("sessions");

			if (sessionsRes?.data?.sessions) {
				for (const s of sessionsRes.data.sessions) {
					this.knownServerSessions.add(s.id);
					this.serverMessageCounts.set(s.id, s.message_count ?? 0);

					metadataCache.set(s.id, {
						id: s.id,
						title: s.title,
						lastModified: s.last_modified,
						messageCount: s.message_count,
						preview: s.preview,
						modelId: s.model_id,
						provider: s.provider,
						thinkingLevel: s.thinking_level,
						agentProfileId: s.agent_profile_id ?? null,
					});
				}
			}

			// Populate settings cache
			const settingsCache = this.getStore("settings");
			if (settingsRes?.data?.userSettings) {
				for (const [key, value] of Object.entries(settingsRes.data.userSettings)) {
					settingsCache.set(key, value);
				}
			}

			this.initialized = true;
		} catch (err) {
			console.error("[ApiStorageBackend] init error:", err);
			// Allow retry on next access
			this.initPromise = null;
			throw err;
		}
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	private getStore(storeName: string): Map<string, any> {
		let store = this.cache.get(storeName);
		if (!store) {
			store = new Map();
			this.cache.set(storeName, store);
		}
		return store;
	}

	/** Move session to most-recently-used position and evict oldest if over limit. */
	private touchSession(key: string): void {
		const idx = this.sessionAccessOrder.indexOf(key);
		if (idx !== -1) this.sessionAccessOrder.splice(idx, 1);
		this.sessionAccessOrder.push(key);

		// Evict LRU sessions beyond the cap
		const sessionsStore = this.cache.get("sessions");
		while (
			this.sessionAccessOrder.length > ApiStorageBackend.MAX_CACHED_SESSIONS &&
			sessionsStore
		) {
			const evictId = this.sessionAccessOrder.shift()!;
			sessionsStore.delete(evictId);
		}
	}

	private async apiFetch(path: string, options?: RequestInit): Promise<any> {
		const token = this.getToken();
		const headers: Record<string, string> = {
			...(options?.headers as any),
		};
		if (token) headers["Authorization"] = `Bearer ${token}`;
		if (options?.body) headers["Content-Type"] = "application/json";

		const res = await fetch(`${this.baseUrl}${path}`, { ...options, headers });
		if (!res.ok) throw new Error(`API error: ${res.status}`);
		return res.json();
	}

	/**
	 * Fire-and-forget server sync — errors are logged but never propagated.
	 */
	private syncToServer(path: string, options?: RequestInit): void {
		this.apiFetch(path, options).catch((err) => {
			console.error("[ApiStorageBackend] background sync error:", err);
		});
	}

	/**
	 * Add toolCallId field to toolResult messages by matching with preceding assistant's toolCalls.
	 *
	 * The database stores toolResult messages separately without toolCallId, but the UI needs
	 * this field to match results with their corresponding tool calls. This method enriches
	 * the messages by adding toolCallIds based on the order of tool calls and results.
	 *
	 * Modifies messages in-place.
	 */
	private addToolCallIds(messages: any[]): void {
		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];

			// Look for assistant messages with tool calls
			if (msg.role === "assistant") {
				const toolCalls = (msg.content || []).filter((block: any) => block.type === "toolCall");

				if (toolCalls.length > 0) {
					// Match following toolResult messages with these toolCalls
					let toolCallIndex = 0;
					for (let j = i + 1; j < messages.length && toolCallIndex < toolCalls.length; j++) {
						if (messages[j].role === "toolResult") {
							// Add toolCallId field to match this with the tool call
							messages[j].toolCallId = toolCalls[toolCallIndex].id;
							toolCallIndex++;
						} else if (messages[j].role !== "toolResult") {
							// Stop when we hit a non-toolResult message
							break;
						}
					}
				}
			}
		}
	}

	// -----------------------------------------------------------------------
	// StorageBackend — get
	// -----------------------------------------------------------------------

	async get<T = unknown>(storeName: string, key: string): Promise<T | null> {
		await this.init();

		if (storeName === "provider-keys") return null;

		// For full session data, fetch from server if not already cached
		if (storeName === "sessions") {
			const store = this.getStore("sessions");
			if (store.has(key)) {
				this.touchSession(key);
				return store.get(key) as T;
			}

			try {
				const [sessionRes, messagesRes] = await Promise.all([
					this.apiFetch(`/api/sessions/${key}`),
					this.apiFetch(`/api/sessions/${key}/messages?limit=200`),
				]);

				const session = sessionRes?.data?.session;
				if (!session) return null;

				const messages = messagesRes?.data?.messages ?? [];
				// Messages come back DESC from server; reverse to ASC
				messages.reverse();

				// Add toolCallId to toolResult messages by matching with preceding assistant toolCalls
				this.addToolCallIds(messages);

				const sessionData = {
					id: session.id,
					title: session.title,
					modelId: session.model_id,
					provider: session.provider,
					thinkingLevel: session.thinking_level,
					messages,
					lastModified: session.last_modified,
					messageCount: session.message_count,
					artifactsCache: session.artifacts_cache ?? {},
				};

				store.set(key, sessionData);
				this.knownServerSessions.add(key);
				this.serverMessageCounts.set(key, messages.length);
				this.touchSession(key);

				return sessionData as T;
			} catch {
				return null;
			}
		}

		const store = this.getStore(storeName);
		return (store.get(key) as T) ?? null;
	}

	// -----------------------------------------------------------------------
	// StorageBackend — set
	// -----------------------------------------------------------------------

	async set<T = unknown>(storeName: string, key: string, value: T): Promise<void> {
		await this.init();

		if (storeName === "provider-keys") return;

		const store = this.getStore(storeName);

		if (storeName === "sessions") {
			const data = value as any;
			store.set(key, data);
			this.touchSession(key);

			// Also update metadata cache
			const metadataCache = this.getStore("sessions-metadata");
			metadataCache.set(key, {
				id: key,
				title: data.title,
				lastModified: data.lastModified ?? new Date().toISOString(),
				messageCount: data.messages?.length ?? data.messageCount ?? 0,
				preview: data.preview,
				modelId: data.modelId,
				provider: data.provider,
				thinkingLevel: data.thinkingLevel,
			});

			if (this.knownServerSessions.has(key) || this.pendingCreations.has(key)) {
				// Session exists (or is being created) on server — patch metadata + batch new messages
				const handleSessionNotFound = () => {
					console.log(`[ApiStorageBackend] Session ${key} not found on server, recreating...`);
					this.knownServerSessions.delete(key);
					this.pendingCreations.delete(key);
					this.serverMessageCounts.delete(key);
					// Create the session on the server
					const allMessages = data.messages ?? [];
					const recreatePromise = this.apiFetch("/api/sessions", {
						method: "POST",
						body: JSON.stringify({
							id: key,
							title: data.title ?? "New Session",
							modelId: data.modelId,
							provider: data.provider,
							thinkingLevel: data.thinkingLevel,
						}),
					})
						.then(() => {
							this.knownServerSessions.add(key);
							this.pendingCreations.delete(key);
							// Now sync messages if there are any
							if (allMessages.length > 0) {
								this.serverMessageCounts.set(key, allMessages.length);
								return this.apiFetch(`/api/sessions/${key}/messages/batch`, {
									method: "POST",
									body: JSON.stringify({
										messages: allMessages.map((m: any) => ({
											role: m.role,
											content: m.content,
											stopReason: m.stopReason ?? m.stop_reason,
											usage: m.usage,
										})),
									}),
								});
							}
						})
						.catch((err) => {
							this.pendingCreations.delete(key);
							console.error("[ApiStorageBackend] Failed to recreate session:", err);
						}) as Promise<void>;
					this.pendingCreations.set(key, recreatePromise);
				};

				// Wait for any in-flight creation before syncing
				const doSync = async () => {
					const pending = this.pendingCreations.get(key);
					if (pending) {
						try { await pending; } catch { return; }
					}

					this.apiFetch(`/api/sessions/${key}`, {
						method: "PATCH",
						body: JSON.stringify({
							title: data.title,
							thinkingLevel: data.thinkingLevel,
							modelId: data.modelId,
							provider: data.provider,
							...(data.artifactsCache && Object.keys(data.artifactsCache).length > 0
								? { artifactsCache: data.artifactsCache }
								: {}),
						}),
					}).catch((err) => {
						if (err.message?.includes("404")) {
							handleSessionNotFound();
						} else {
							console.error("[ApiStorageBackend] PATCH session error:", err);
						}
					});

					const knownCount = this.serverMessageCounts.get(key) ?? 0;
					const allMessages = data.messages ?? [];
					if (allMessages.length > knownCount) {
						const newMessages = allMessages.slice(knownCount);
						const expectedCount = allMessages.length;
						this.serverMessageCounts.set(key, expectedCount);
						this.apiFetch(`/api/sessions/${key}/messages/batch`, {
							method: "POST",
							body: JSON.stringify({
								messages: this.serializeMessages(newMessages),
							}),
						})
							.then((res) => {
								if (res?.data?.messages) {
									this.serverMessageCounts.set(key, knownCount + res.data.messages.length);
								}
							})
							.catch((err) => {
								if (err.message?.includes("404")) {
									handleSessionNotFound();
								} else {
									console.error("[ApiStorageBackend] batch sync failed:", err);
									this.serverMessageCounts.set(key, knownCount);
								}
							});
					}
				};
				doSync();
			} else {
				// New session — create on server
				const allMessages = data.messages ?? [];
				this.serverMessageCounts.set(key, allMessages.length);

				const createPromise = this.apiFetch("/api/sessions", {
					method: "POST",
					body: JSON.stringify({
						id: key, // Send client-generated ID so server uses it
						title: data.title ?? "New Session",
						modelId: data.modelId,
						provider: data.provider,
						thinkingLevel: data.thinkingLevel,
						agentProfileId: data.agentProfileId ?? null,
					}),
				})
					.then(() => {
						this.knownServerSessions.add(key);
						this.pendingCreations.delete(key);
						// Session created successfully, now sync messages if any
						if (allMessages.length > 0) {
							return this.apiFetch(`/api/sessions/${key}/messages/batch`, {
								method: "POST",
								body: JSON.stringify({
									messages: this.serializeMessages(allMessages),
								}),
							});
						}
					})
					.catch((err) => {
						this.pendingCreations.delete(key);
						console.error("[ApiStorageBackend] create session sync error:", err);
					}) as Promise<void>;
				this.pendingCreations.set(key, createPromise);
			}
			return;
		}

		if (storeName === "sessions-metadata") {
			const metadata = value as any;
			store.set(key, metadata);

			// Sync title change to server
			if (metadata.title !== undefined) {
				this.syncToServer(`/api/sessions/${key}`, {
					method: "PATCH",
					body: JSON.stringify({ title: metadata.title }),
				});
			}
			return;
		}

		if (storeName === "settings") {
			store.set(key, value);
			this.syncToServer("/api/settings", {
				method: "PATCH",
				body: JSON.stringify({ settings: { [key]: value } }),
			});
			return;
		}

		if (storeName === "custom-providers") {
			store.set(key, value);
			// Sync custom providers into settings as a nested object
			const allProviders: Record<string, any> = {};
			for (const [k, v] of store.entries()) {
				allProviders[k] = v;
			}
			this.syncToServer("/api/settings", {
				method: "PATCH",
				body: JSON.stringify({ settings: { customProviders: allProviders } }),
			});
			return;
		}

		// Fallback: just cache
		store.set(key, value);
	}

	// -----------------------------------------------------------------------
	// StorageBackend — delete
	// -----------------------------------------------------------------------

	async delete(storeName: string, key: string): Promise<void> {
		await this.init();

		if (storeName === "provider-keys") return;

		const store = this.getStore(storeName);
		store.delete(key);

		if (storeName === "sessions") {
			// Also remove metadata
			this.getStore("sessions-metadata").delete(key);
			this.knownServerSessions.delete(key);
			this.serverMessageCounts.delete(key);

			this.syncToServer(`/api/sessions/${key}`, { method: "DELETE" });
			return;
		}

		if (storeName === "sessions-metadata") {
			// Already handled by "sessions" delete; no separate server call
			return;
		}

		if (storeName === "settings") {
			this.syncToServer("/api/settings", {
				method: "PATCH",
				body: JSON.stringify({ settings: { [key]: null } }),
			});
			return;
		}

		if (storeName === "custom-providers") {
			const allProviders: Record<string, any> = {};
			for (const [k, v] of store.entries()) {
				allProviders[k] = v;
			}
			this.syncToServer("/api/settings", {
				method: "PATCH",
				body: JSON.stringify({ settings: { customProviders: allProviders } }),
			});
			return;
		}
	}

	// -----------------------------------------------------------------------
	// StorageBackend — keys
	// -----------------------------------------------------------------------

	async keys(storeName: string, prefix?: string): Promise<string[]> {
		await this.init();

		if (storeName === "provider-keys") return [];

		const store = this.getStore(storeName);
		let result = Array.from(store.keys());

		if (prefix) {
			result = result.filter((k) => k.startsWith(prefix));
		}

		return result;
	}

	// -----------------------------------------------------------------------
	// StorageBackend — getAllFromIndex
	// -----------------------------------------------------------------------

	async getAllFromIndex<T = unknown>(
		storeName: string,
		indexName: string,
		direction: "asc" | "desc" = "asc",
	): Promise<T[]> {
		await this.init();

		if (storeName === "provider-keys") return [];

		const store = this.getStore(storeName);
		const values = Array.from(store.values());

		if (storeName === "sessions-metadata" && indexName === "lastModified") {
			values.sort((a, b) => {
				const aTime = new Date(a.lastModified ?? 0).getTime();
				const bTime = new Date(b.lastModified ?? 0).getTime();
				return direction === "desc" ? bTime - aTime : aTime - bTime;
			});
		}

		return values as T[];
	}

	// -----------------------------------------------------------------------
	// StorageBackend — clear
	// -----------------------------------------------------------------------

	async clear(storeName: string): Promise<void> {
		await this.init();

		const store = this.getStore(storeName);
		store.clear();
	}

	// -----------------------------------------------------------------------
	// StorageBackend — has
	// -----------------------------------------------------------------------

	async has(storeName: string, key: string): Promise<boolean> {
		await this.init();

		if (storeName === "provider-keys") return false;

		const store = this.getStore(storeName);
		return store.has(key);
	}

	// -----------------------------------------------------------------------
	// StorageBackend — transaction
	// -----------------------------------------------------------------------

	async transaction<T>(
		_storeNames: string[],
		_mode: "readonly" | "readwrite",
		operation: (tx: StorageTransaction) => Promise<T>,
	): Promise<T> {
		await this.init();

		// Accumulate writes in a buffer, then apply to cache and sync
		const pendingOps: Array<{
			type: "set" | "delete";
			storeName: string;
			key: string;
			value?: any;
		}> = [];

		const tx: StorageTransaction = {
			get: async <V = unknown>(storeName: string, key: string): Promise<V | null> => {
				// Check pending writes first (most recent wins)
				for (let i = pendingOps.length - 1; i >= 0; i--) {
					const op = pendingOps[i];
					if (op.storeName === storeName && op.key === key) {
						if (op.type === "delete") return null;
						return op.value as V;
					}
				}
				const store = this.getStore(storeName);
				return (store.get(key) as V) ?? null;
			},
			set: async <V = unknown>(storeName: string, key: string, value: V): Promise<void> => {
				pendingOps.push({ type: "set", storeName, key, value });
			},
			delete: async (storeName: string, key: string): Promise<void> => {
				pendingOps.push({ type: "delete", storeName, key });
			},
		};

		const result = await operation(tx);

		// Apply all pending operations
		for (const op of pendingOps) {
			if (op.type === "set") {
				await this.set(op.storeName, op.key, op.value);
			} else {
				await this.delete(op.storeName, op.key);
			}
		}

		return result;
	}

	// -----------------------------------------------------------------------
	// StorageBackend — quota / persistence
	// -----------------------------------------------------------------------

	async getQuotaInfo(): Promise<{ usage: number; quota: number; percent: number }> {
		return { usage: 0, quota: Infinity, percent: 0 };
	}

	async requestPersistence(): Promise<boolean> {
		return true;
	}
}
