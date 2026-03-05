/**
 * Provider Keys Settings Panel.
 *
 * Admin-only component for managing team API keys.
 * Keys are stored server-side with envelope encryption.
 */

import { apiFetch } from "../shared/api.js";
import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";

interface ProviderKeyInfo {
	provider: string;
	hasKey: boolean;
	config: Record<string, unknown>;
	updatedAt: string;
}

const PROVIDER_LABELS: Record<string, string> = {
	anthropic: "Anthropic",
	openai: "OpenAI",
	google: "Google (Gemini)",
	groq: "Groq",
	cerebras: "Cerebras",
	xai: "xAI",
	zai: "ZAI",
	openrouter: "OpenRouter",
	"vercel-ai-gateway": "Vercel AI Gateway",
	mistral: "Mistral",
	minimax: "MiniMax",
	"minimax-cn": "MiniMax (CN)",
	huggingface: "Hugging Face",
	opencode: "OpenCode",
	"kimi-coding": "Kimi Coding",
	"azure-openai": "Azure OpenAI",
};

@customElement("provider-keys-panel")
export class ProviderKeysPanel extends LitElement {
	static override styles = css`
		:host {
			display: block;
			padding: 1rem;
		}
		.key-list {
			display: flex;
			flex-direction: column;
			gap: 0.5rem;
			margin-bottom: 1rem;
		}
		.key-item {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 0.75rem 1rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.5rem;
			background: var(--card, #fff);
		}
		.key-info {
			display: flex;
			flex-direction: column;
			gap: 0.25rem;
		}
		.key-provider {
			font-weight: 600;
			font-size: 0.875rem;
		}
		.key-date {
			font-size: 0.75rem;
			color: var(--muted-foreground, #6b7280);
		}
		.add-form {
			display: flex;
			flex-direction: column;
			gap: 0.5rem;
			padding: 1rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.5rem;
			background: var(--card, #fff);
		}
		.form-row {
			display: flex;
			gap: 0.5rem;
			align-items: flex-end;
			flex-wrap: wrap;
		}
		.form-field {
			display: flex;
			flex-direction: column;
			gap: 0.25rem;
			flex: 1;
		}
		label {
			font-size: 0.75rem;
			font-weight: 500;
			color: var(--muted-foreground, #6b7280);
		}
		select, input {
			padding: 0.5rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.375rem;
			font-size: 0.875rem;
			background: var(--background, #fff);
			color: var(--foreground, #111);
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
		h3 {
			margin: 0 0 1rem 0;
			font-size: 1rem;
			font-weight: 600;
		}
	`;

	@property({ type: Function })
	getToken: (() => string | null) | undefined;

	@state()
	private keys: ProviderKeyInfo[] = [];

	@state()
	private loading = false;

	@state()
	private saving = false;

	@state()
	private statusMessage = "";

	@state()
	private statusType: "success" | "error" = "success";

	@state()
	private selectedProvider = "";

	@state()
	private apiKeyInput = "";

	@state()
	private azureBaseUrl = "";

	@state()
	private azureApiVersion = "";

	@state()
	private azureDeploymentNameMap = "";

	override connectedCallback() {
		super.connectedCallback();
		this.loadKeys();
	}

	private fetchApi = (url: string, options?: RequestInit) => apiFetch(url, options, this.getToken);

	private async loadKeys() {
		this.loading = true;
		try {
			const result = await this.fetchApi("/api/provider-keys");
			if (result.success) {
				this.keys = result.data.keys;
			}
		} catch (err) {
			console.error("Failed to load provider keys:", err);
		} finally {
			this.loading = false;
		}
	}

	private async handleAdd() {
		if (!this.selectedProvider || !this.apiKeyInput) return;
		if (this.selectedProvider === "azure-openai" && !this.azureBaseUrl) return;

		this.saving = true;
		this.statusMessage = "";
		try {
			const body: Record<string, unknown> = {
				provider: this.selectedProvider,
				apiKey: this.apiKeyInput,
			};

			if (this.selectedProvider === "azure-openai") {
				const config: Record<string, string> = { baseUrl: this.azureBaseUrl };
				if (this.azureApiVersion) config.apiVersion = this.azureApiVersion;
				if (this.azureDeploymentNameMap) config.deploymentNameMap = this.azureDeploymentNameMap;
				body.config = config;
			}

			const result = await this.fetchApi("/api/provider-keys", {
				method: "POST",
				body: JSON.stringify(body),
			});

			if (result.success) {
				this.statusMessage = `${PROVIDER_LABELS[this.selectedProvider] || this.selectedProvider} key saved.`;
				this.statusType = "success";
				this.apiKeyInput = "";
				this.selectedProvider = "";
				this.azureBaseUrl = "";
				this.azureApiVersion = "";
				this.azureDeploymentNameMap = "";
				await this.loadKeys();
			} else {
				this.statusMessage = result.error || "Failed to save key";
				this.statusType = "error";
			}
		} catch (err) {
			this.statusMessage = "Network error";
			this.statusType = "error";
		} finally {
			this.saving = false;
		}
	}

	private async handleDelete(provider: string) {
		if (!confirm(`Remove the ${PROVIDER_LABELS[provider] || provider} API key?`)) return;

		try {
			const result = await this.fetchApi(`/api/provider-keys/${provider}`, {
				method: "DELETE",
			});

			if (result.success) {
				this.statusMessage = `${PROVIDER_LABELS[provider] || provider} key removed.`;
				this.statusType = "success";
				await this.loadKeys();
			} else {
				this.statusMessage = result.error || "Failed to remove key";
				this.statusType = "error";
			}
		} catch {
			this.statusMessage = "Network error";
			this.statusType = "error";
		}
	}

	private get availableProviders(): string[] {
		const existing = new Set(this.keys.map((k) => k.provider));
		return Object.keys(PROVIDER_LABELS).filter((p) => !existing.has(p));
	}

	override render() {
		return html`
			<h3>Provider API Keys</h3>

			${this.statusMessage
				? html`<div class="status ${this.statusType === "success" ? "status-success" : "status-error"}">${this.statusMessage}</div>`
				: null}

			${this.loading
				? html`<div class="empty">Loading...</div>`
				: this.keys.length === 0
					? html`<div class="empty">No API keys configured. Add one below.</div>`
					: html`
						<div class="key-list">
							${this.keys.map(
								(key) => html`
									<div class="key-item">
										<div class="key-info">
											<span class="key-provider">${PROVIDER_LABELS[key.provider] || key.provider}</span>
											${key.config?.baseUrl ? html`<span class="key-date">${key.config.baseUrl}</span>` : null}
											<span class="key-date">Updated ${new Date(key.updatedAt).toLocaleDateString()}</span>
										</div>
										<button class="btn-danger" @click=${() => this.handleDelete(key.provider)}>Remove</button>
									</div>
								`,
							)}
						</div>
					`}

			<div class="add-form">
				<div class="form-row">
					<div class="form-field">
						<label>Provider</label>
						<select .value=${this.selectedProvider} @change=${(e: Event) => {
							this.selectedProvider = (e.target as HTMLSelectElement).value;
							this.azureBaseUrl = "";
							this.azureApiVersion = "";
							this.azureDeploymentNameMap = "";
						}}>
							<option value="">Select provider...</option>
							${this.availableProviders.map(
								(p) => html`<option value=${p}>${PROVIDER_LABELS[p] || p}</option>`,
							)}
						</select>
					</div>
					<div class="form-field">
						<label>API Key</label>
						<input
							type="password"
							placeholder="sk-..."
							.value=${this.apiKeyInput}
							@input=${(e: Event) => (this.apiKeyInput = (e.target as HTMLInputElement).value)}
						/>
					</div>
					<button
						class="btn-primary"
						?disabled=${!this.selectedProvider || !this.apiKeyInput || (this.selectedProvider === "azure-openai" && !this.azureBaseUrl) || this.saving}
						@click=${this.handleAdd}
					>
						${this.saving ? "Saving..." : "Add Key"}
					</button>
				</div>
				${this.selectedProvider === "azure-openai" ? html`
					<div class="form-row">
						<div class="form-field">
							<label>Endpoint URL *</label>
							<input
								type="url"
								placeholder="https://your-resource.openai.azure.com"
								.value=${this.azureBaseUrl}
								@input=${(e: Event) => (this.azureBaseUrl = (e.target as HTMLInputElement).value)}
							/>
						</div>
						<div class="form-field">
							<label>API Version</label>
							<input
								type="text"
								placeholder="2024-02-15-preview"
								.value=${this.azureApiVersion}
								@input=${(e: Event) => (this.azureApiVersion = (e.target as HTMLInputElement).value)}
							/>
						</div>
						<div class="form-field">
							<label>Deployment Name Map</label>
							<input
								type="text"
								placeholder="gpt-4o=my-gpt4o-deployment"
								.value=${this.azureDeploymentNameMap}
								@input=${(e: Event) => (this.azureDeploymentNameMap = (e.target as HTMLInputElement).value)}
							/>
						</div>
					</div>
				` : null}
			</div>
		`;
	}
}
