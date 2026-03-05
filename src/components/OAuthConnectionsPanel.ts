/**
 * OAuth Connections Panel.
 *
 * User-level component for connecting subscription-based LLM providers
 * (Anthropic Claude Pro, OpenAI Codex, GitHub Copilot, etc.)
 */

import { apiFetch } from "../shared/api.js";
import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";

interface OAuthConnectionInfo {
	provider: string;
	expiresAt: string;
	expired: boolean;
	createdAt: string;
	updatedAt: string;
}

const PROVIDER_LABELS: Record<string, string> = {
	anthropic: "Anthropic (Claude Pro/Max)",
	"openai-codex": "OpenAI Codex (ChatGPT Plus/Pro)",
	"github-copilot": "GitHub Copilot",
	"google-gemini-cli": "Google Gemini CLI",
	"google-antigravity": "Google Antigravity",
};

const PROVIDER_DESCRIPTIONS: Record<string, string> = {
	anthropic: "Connect your Claude Pro or Claude Max subscription",
	"openai-codex": "Connect your ChatGPT Plus or Pro subscription",
	"github-copilot": "Connect your GitHub Copilot subscription (device code flow)",
	"google-gemini-cli": "Connect your Google Gemini CLI account (Google OAuth)",
	"google-antigravity": "Connect your Google Antigravity account (Google OAuth)",
};

// Providers that are fully supported
const SUPPORTED_PROVIDERS = new Set(["anthropic", "openai-codex"]);

// Providers that need additional implementation (device code flow, etc.)
const COMING_SOON_PROVIDERS = new Set(["github-copilot", "google-gemini-cli", "google-antigravity"]);

@customElement("oauth-connections-panel")
export class OAuthConnectionsPanel extends LitElement {
	static override styles = css`
		:host {
			display: block;
			padding: 1rem;
		}
		.connection-list {
			display: flex;
			flex-direction: column;
			gap: 0.5rem;
			margin-bottom: 1rem;
		}
		.connection-item {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 0.75rem 1rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.5rem;
			background: var(--card, #fff);
		}
		.connection-item.expired {
			border-color: var(--destructive, #dc2626);
			opacity: 0.7;
		}
		.connection-info {
			display: flex;
			flex-direction: column;
			gap: 0.25rem;
		}
		.connection-provider {
			font-weight: 600;
			font-size: 0.875rem;
		}
		.connection-date {
			font-size: 0.75rem;
			color: var(--muted-foreground, #6b7280);
		}
		.connection-expired {
			font-size: 0.75rem;
			color: var(--destructive, #dc2626);
			font-weight: 500;
		}
		.available-providers {
			display: flex;
			flex-direction: column;
			gap: 0.75rem;
		}
		.provider-card {
			display: flex;
			flex-direction: column;
			gap: 0.5rem;
			padding: 1rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.5rem;
			background: var(--card, #fff);
		}
		.provider-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
		}
		.provider-title {
			font-weight: 600;
			font-size: 0.875rem;
		}
		.provider-description {
			font-size: 0.75rem;
			color: var(--muted-foreground, #6b7280);
		}
		button {
			padding: 0.5rem 1rem;
			border: none;
			border-radius: 0.375rem;
			font-size: 0.875rem;
			cursor: pointer;
			font-weight: 500;
		}
		.btn-primary {
			background: var(--primary, #2563eb);
			color: white;
		}
		.btn-primary:disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}
		.btn-danger {
			background: transparent;
			color: var(--destructive, #dc2626);
			border: 1px solid var(--destructive, #dc2626);
			padding: 0.25rem 0.75rem;
			font-size: 0.75rem;
		}
		.status {
			font-size: 0.875rem;
			padding: 0.5rem;
			border-radius: 0.375rem;
			margin-bottom: 1rem;
		}
		.status-success {
			background: #dcfce7;
			color: #166534;
		}
		.status-error {
			background: #fef2f2;
			color: #991b1b;
		}
		.empty {
			text-align: center;
			padding: 2rem;
			color: var(--muted-foreground, #6b7280);
			font-size: 0.875rem;
		}
		.code-input-card {
			padding: 1rem;
			border: 2px solid var(--primary, #2563eb);
			border-radius: 0.5rem;
			background: var(--card, #fff);
			margin-bottom: 1rem;
			display: flex;
			flex-direction: column;
			gap: 0.75rem;
		}
		.code-input-card label {
			font-size: 0.875rem;
			font-weight: 500;
		}
		.code-input-card .hint {
			font-size: 0.75rem;
			color: var(--muted-foreground, #6b7280);
		}
		.code-input-row {
			display: flex;
			gap: 0.5rem;
		}
		.code-input-row input {
			flex: 1;
			padding: 0.5rem 0.75rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.375rem;
			font-size: 0.875rem;
			font-family: monospace;
		}
		.code-input-row input:focus {
			outline: none;
			border-color: var(--primary, #2563eb);
			box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.2);
		}
		.btn-cancel {
			background: transparent;
			color: var(--muted-foreground, #6b7280);
			border: 1px solid var(--border, #e5e7eb);
		}
		h3 {
			margin: 0 0 1rem 0;
			font-size: 1rem;
			font-weight: 600;
		}
		.section-title {
			margin: 1.5rem 0 0.75rem 0;
			font-size: 0.875rem;
			font-weight: 600;
			color: var(--muted-foreground, #6b7280);
			text-transform: uppercase;
			letter-spacing: 0.05em;
		}
	`;

	@property({ type: Function })
	getToken: (() => string | null) | undefined;

	@state()
	private connections: OAuthConnectionInfo[] = [];

	@state()
	private loading = false;

	@state()
	private connecting: Record<string, boolean> = {};

	@state()
	private statusMessage = "";

	@state()
	private statusType: "success" | "error" = "success";

	/** Provider currently awaiting a pasted auth code */
	@state()
	private pendingCodeProvider: string | null = null;

	/** The OAuth state token for the pending code exchange */
	private pendingState: string | null = null;

	/** Reference to the open OAuth popup */
	private oauthPopup: Window | null = null;

	override connectedCallback() {
		super.connectedCallback();
		this.loadConnections();
	}

	private fetchApi = (url: string, options?: RequestInit) => apiFetch(url, options, this.getToken);

	private async loadConnections() {
		this.loading = true;
		try {
			const result = await this.fetchApi("/api/oauth");
			if (result.success) {
				this.connections = result.data.credentials;
			}
		} catch (err) {
			console.error("Failed to load OAuth connections:", err);
		} finally {
			this.loading = false;
		}
	}

	private async handleConnect(provider: string) {
		this.connecting = { ...this.connecting, [provider]: true };
		this.statusMessage = "";

		try {
			// Start OAuth flow
			const startResult = await this.fetchApi(`/api/oauth/${provider}/start`, {
				method: "POST",
			});

			if (!startResult.success) {
				this.statusMessage = startResult.error || "Failed to start OAuth flow";
				this.statusType = "error";
				this.connecting = { ...this.connecting, [provider]: false };
				return;
			}

			const { authUrl, state } = startResult.data;

			// Open OAuth URL in popup
			const popup = window.open(
				authUrl,
				"oauth_popup",
				"width=600,height=700,left=100,top=100"
			);

			if (!popup) {
				this.statusMessage = "Please allow popups to connect";
				this.statusType = "error";
				this.connecting = { ...this.connecting, [provider]: false };
				return;
			}

			// Store state and show inline code input
			this.oauthPopup = popup;
			this.pendingState = state;
			this.pendingCodeProvider = provider;
			// connecting state stays true — cleared when code is submitted or cancelled
		} catch (err) {
			console.error("OAuth connection error:", err);
			this.statusMessage = "Network error";
			this.statusType = "error";
			this.connecting = { ...this.connecting, [provider]: false };
		}
	}

	private async handleCodeSubmit() {
		const provider = this.pendingCodeProvider;
		const state = this.pendingState;
		if (!provider || !state) return;

		const input = this.shadowRoot?.querySelector<HTMLInputElement>("#oauth-code-input");
		const rawCode = input?.value?.trim();
		if (!rawCode) return;

		// Extract code from "code#state" format that some providers use
		const code = rawCode.split("#")[0];

		// Close popup if still open
		if (this.oauthPopup && !this.oauthPopup.closed) {
			this.oauthPopup.close();
		}

		// Clear the pending state
		this.pendingCodeProvider = null;
		this.pendingState = null;
		this.oauthPopup = null;

		try {
			const callbackResult = await this.fetchApi(`/api/oauth/${provider}/callback`, {
				method: "POST",
				body: JSON.stringify({ code, state }),
			});

			if (callbackResult.success) {
				this.statusMessage = `Successfully connected ${PROVIDER_LABELS[provider]}`;
				this.statusType = "success";
				await this.loadConnections();
			} else {
				this.statusMessage = callbackResult.error || "Failed to complete OAuth flow";
				this.statusType = "error";
			}
		} catch (err) {
			console.error("OAuth connection error:", err);
			this.statusMessage = "Network error";
			this.statusType = "error";
		} finally {
			this.connecting = { ...this.connecting, [provider]: false };
		}
	}

	private handleCodeCancel() {
		const provider = this.pendingCodeProvider;
		if (this.oauthPopup && !this.oauthPopup.closed) {
			this.oauthPopup.close();
		}
		this.pendingCodeProvider = null;
		this.pendingState = null;
		this.oauthPopup = null;
		if (provider) {
			this.connecting = { ...this.connecting, [provider]: false };
		}
	}

	private async handleDisconnect(provider: string) {
		if (!confirm(`Disconnect ${PROVIDER_LABELS[provider] || provider}?`)) return;

		try {
			const result = await this.fetchApi(`/api/oauth/${provider}`, {
				method: "DELETE",
			});

			if (result.success) {
				this.statusMessage = `Disconnected ${PROVIDER_LABELS[provider]}`;
				this.statusType = "success";
				await this.loadConnections();
			} else {
				this.statusMessage = result.error || "Failed to disconnect";
				this.statusType = "error";
			}
		} catch {
			this.statusMessage = "Network error";
			this.statusType = "error";
		}
	}

	private get connectedProviders(): Set<string> {
		return new Set(this.connections.map((c) => c.provider));
	}

	private get availableProviders(): string[] {
		const connected = this.connectedProviders;
		return Object.keys(PROVIDER_LABELS).filter((p) => !connected.has(p));
	}

	override render() {
		return html`
			<h3>Your AI Subscriptions</h3>
			<p style="font-size: 0.875rem; color: var(--muted-foreground, #6b7280); margin-bottom: 1rem;">
				Connect your subscription-based LLM accounts. Your credentials are stored securely and never shared.
			</p>

			${this.statusMessage
				? html`<div class="status ${this.statusType === "success" ? "status-success" : "status-error"}">${this.statusMessage}</div>`
				: null}

			${this.pendingCodeProvider
				? html`
					<div class="code-input-card">
						<label>Paste the authorization code for ${PROVIDER_LABELS[this.pendingCodeProvider]}</label>
						<span class="hint">Authorize in the popup window, then copy the code shown on the page and paste it below.</span>
						<div class="code-input-row">
							<input
								id="oauth-code-input"
								type="text"
								placeholder="Paste authorization code here"
								@keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") this.handleCodeSubmit(); }}
							/>
							<button class="btn-primary" @click=${() => this.handleCodeSubmit()}>Submit</button>
							<button class="btn-cancel" @click=${() => this.handleCodeCancel()}>Cancel</button>
						</div>
					</div>
				`
				: null}

			${this.loading
				? html`<div class="empty">Loading...</div>`
				: html`
					${this.connections.length > 0
						? html`
							<div class="section-title">Connected Accounts</div>
							<div class="connection-list">
								${this.connections.map(
									(conn) => html`
										<div class="connection-item ${conn.expired ? "expired" : ""}">
											<div class="connection-info">
												<span class="connection-provider">${PROVIDER_LABELS[conn.provider] || conn.provider}</span>
												${conn.expired
													? html`<span class="connection-expired">⚠️ Expired - reconnect to renew</span>`
													: html`<span class="connection-date">Expires ${new Date(conn.expiresAt).toLocaleDateString()}</span>`
												}
											</div>
											<button class="btn-danger" @click=${() => this.handleDisconnect(conn.provider)}>
												Disconnect
											</button>
										</div>
									`,
								)}
							</div>
						`
						: null}

					${this.availableProviders.length > 0
						? html`
							<div class="section-title">Available Subscriptions</div>
							<div class="available-providers">
								${this.availableProviders.map(
									(provider) => {
										const isComingSoon = COMING_SOON_PROVIDERS.has(provider);
										return html`
											<div class="provider-card" style="${isComingSoon ? 'opacity: 0.6;' : ''}">
												<div class="provider-header">
													<div>
														<div class="provider-title">
															${PROVIDER_LABELS[provider]}
															${isComingSoon ? html`<span style="font-size: 0.75rem; color: var(--muted-foreground, #6b7280); font-weight: normal;"> (Coming Soon)</span>` : ''}
														</div>
														<div class="provider-description">${PROVIDER_DESCRIPTIONS[provider]}</div>
													</div>
													<button
														class="btn-primary"
														?disabled=${this.connecting[provider] || isComingSoon}
														@click=${() => this.handleConnect(provider)}
													>
														${isComingSoon ? "Coming Soon" : (this.connecting[provider] ? "Connecting..." : "Connect")}
													</button>
												</div>
											</div>
										`;
									},
								)}
							</div>
						`
						: html`<div class="empty">All available subscriptions are connected!</div>`}
				`}
		`;
	}
}
