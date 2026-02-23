/**
 * Full-page skills management tab for the Agent Studio.
 * Lists skills in a card grid, supports upload and delete.
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

interface SkillInfo {
	id: string;
	scope: string;
	name: string;
	description: string;
	created_at: string;
}

type ScopeFilter = "all" | "platform" | "team" | "user";

@customElement("studio-skills-tab")
export class SkillsTab extends LitElement {
	static override styles = css`
		:host { display: flex; flex-direction: column; flex: 1; overflow: hidden; }

		/* Filter bar */
		.filter-bar {
			display: flex;
			align-items: center;
			gap: 0.75rem;
			padding: 0.5rem 1.5rem;
			border-bottom: 1px solid var(--border, #e5e7eb);
			flex-shrink: 0;
		}
		.tab-group {
			display: flex;
			gap: 0.25rem;
		}
		.tab-btn {
			padding: 0.375rem 0.75rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.375rem;
			font-size: 0.8rem;
			cursor: pointer;
			background: transparent;
			color: var(--foreground, #111);
			font-family: inherit;
		}
		.tab-btn:hover { background: var(--muted, #f3f4f6); }
		.tab-btn.active {
			background: var(--primary, #2563eb);
			color: white;
			border-color: var(--primary, #2563eb);
		}
		.search-input {
			padding: 0.375rem 0.75rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.375rem;
			font-size: 0.8rem;
			background: var(--background, #fff);
			color: var(--foreground, #111);
			font-family: inherit;
			margin-left: auto;
			width: 200px;
		}
		.search-input:focus {
			outline: none;
			border-color: var(--primary, #2563eb);
		}

		/* Content area */
		.content {
			flex: 1;
			overflow-y: auto;
			padding: 1.5rem;
		}

		/* Upload form */
		.upload-form {
			display: flex;
			gap: 0.75rem;
			align-items: flex-end;
			padding: 1rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.75rem;
			background: var(--card, #fff);
			margin-bottom: 1.5rem;
		}
		.form-field {
			display: flex;
			flex-direction: column;
			gap: 0.25rem;
		}
		.form-field.grow { flex: 1; }
		label {
			font-size: 0.75rem;
			font-weight: 500;
			color: var(--muted-foreground, #6b7280);
		}
		select, input[type="file"] {
			padding: 0.5rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.375rem;
			font-size: 0.85rem;
			background: var(--background, #fff);
			color: var(--foreground, #111);
			font-family: inherit;
		}

		/* Card grid */
		.card-grid {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
			gap: 1rem;
			max-width: 1400px;
			margin: 0 auto;
		}
		.card {
			display: flex;
			flex-direction: column;
			gap: 0.5rem;
			padding: 1rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.75rem;
			background: var(--card, #fff);
			transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
		}
		.card:hover {
			box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
			border-color: var(--primary, #2563eb);
			transform: scale(1.02);
		}
		.card-header {
			display: flex;
			align-items: center;
			gap: 0.5rem;
		}
		.card-name {
			font-weight: 600;
			font-size: 0.9rem;
			flex: 1;
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.scope-badge {
			text-transform: uppercase;
			letter-spacing: 0.05em;
			font-size: 0.6rem;
			padding: 0.125rem 0.375rem;
			border-radius: 0.25rem;
			flex-shrink: 0;
		}
		.scope-badge.platform {
			background: color-mix(in srgb, #3b82f6 15%, var(--muted, #f3f4f6));
			color: #1d4ed8;
		}
		.scope-badge.team {
			background: color-mix(in srgb, #8b5cf6 15%, var(--muted, #f3f4f6));
			color: #6d28d9;
		}
		.scope-badge.user {
			background: color-mix(in srgb, #22c55e 15%, var(--muted, #f3f4f6));
			color: #15803d;
		}
		.card-desc {
			font-size: 0.8rem;
			color: var(--muted-foreground, #6b7280);
			overflow: hidden;
			text-overflow: ellipsis;
			display: -webkit-box;
			-webkit-line-clamp: 2;
			-webkit-box-orient: vertical;
			line-height: 1.4;
		}
		.card-meta {
			font-size: 0.7rem;
			color: var(--muted-foreground, #6b7280);
			margin-top: auto;
		}
		.card-actions {
			display: flex;
			justify-content: flex-end;
			margin-top: 0.25rem;
		}

		/* Buttons */
		button { cursor: pointer; font-family: inherit; }
		.btn-primary {
			padding: 0.5rem 1rem;
			border: none;
			border-radius: 0.375rem;
			font-size: 0.85rem;
			font-weight: 500;
			background: var(--primary, #2563eb);
			color: white;
		}
		.btn-primary:hover { opacity: 0.9; }
		.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
		.btn-danger {
			padding: 0.25rem 0.75rem;
			border: 1px solid var(--destructive, #dc2626);
			border-radius: 0.375rem;
			font-size: 0.75rem;
			font-weight: 500;
			background: transparent;
			color: var(--destructive, #dc2626);
		}
		.btn-danger:hover {
			background: color-mix(in srgb, var(--destructive, #dc2626) 10%, transparent);
		}

		/* Status */
		.status {
			font-size: 0.875rem;
			padding: 0.5rem;
			border-radius: 0.375rem;
			margin-bottom: 1rem;
		}
		.status-success { background: #dcfce7; color: #166534; }
		.status-error { background: #fef2f2; color: #991b1b; }
		.empty-state {
			text-align: center;
			padding: 3rem;
			color: var(--muted-foreground, #6b7280);
			font-size: 0.9rem;
		}

		/* Skeleton loading */
		@keyframes shimmer {
			0% { background-position: -400px 0; }
			100% { background-position: 400px 0; }
		}
		.skeleton-card {
			height: 140px;
			border-radius: 0.75rem;
			background: linear-gradient(90deg, var(--muted, #f3f4f6) 25%, var(--background, #fff) 50%, var(--muted, #f3f4f6) 75%);
			background-size: 800px 100%;
			animation: shimmer 1.5s infinite;
		}
	`;

	@property({ type: Function })
	getToken: (() => string | null) | undefined;

	@property({ type: String })
	userRole: string = "member";

	@state() private skills: SkillInfo[] = [];
	@state() private loading = false;
	@state() private uploading = false;
	@state() private statusMessage = "";
	@state() private statusType: "success" | "error" = "success";
	@state() private scopeFilter: ScopeFilter = "all";
	@state() private searchQuery = "";
	@state() private selectedScope = "user";
	@state() private selectedFile: File | null = null;

	override connectedCallback() {
		super.connectedCallback();
		this._loadSkills();
	}

	private async _fetchApi(url: string, options: RequestInit = {}): Promise<any> {
		const token = this.getToken?.();
		const res = await fetch(url, {
			...options,
			headers: {
				...(token ? { Authorization: `Bearer ${token}` } : {}),
				...options.headers,
			},
		});
		return res.json();
	}

	private async _loadSkills() {
		this.loading = true;
		try {
			const result = await this._fetchApi("/api/skills");
			if (result.success) {
				this.skills = result.data.skills;
			}
		} catch (err) {
			console.error("Failed to load skills:", err);
		} finally {
			this.loading = false;
		}
	}

	private async _handleUpload() {
		if (!this.selectedFile) return;

		this.uploading = true;
		this.statusMessage = "";
		try {
			const formData = new FormData();
			formData.append("file", this.selectedFile);
			formData.append("scope", this.selectedScope);

			const token = this.getToken?.();
			const res = await fetch("/api/skills", {
				method: "POST",
				headers: token ? { Authorization: `Bearer ${token}` } : {},
				body: formData,
			});
			const result = await res.json();

			if (result.success) {
				this.statusMessage = `Skill "${result.data.name}" uploaded.`;
				this.statusType = "success";
				this.selectedFile = null;
				const fileInput = this.shadowRoot?.querySelector('input[type="file"]') as HTMLInputElement;
				if (fileInput) fileInput.value = "";
				await this._loadSkills();
			} else {
				this.statusMessage = result.error || "Upload failed";
				this.statusType = "error";
			}
		} catch {
			this.statusMessage = "Network error";
			this.statusType = "error";
		} finally {
			this.uploading = false;
		}
	}

	private async _handleDelete(skill: SkillInfo) {
		if (!confirm(`Delete skill "${skill.name}"?`)) return;

		try {
			const result = await this._fetchApi(`/api/skills/${skill.id}`, { method: "DELETE" });
			if (result.success) {
				this.statusMessage = `Skill "${skill.name}" deleted.`;
				this.statusType = "success";
				await this._loadSkills();
			} else {
				this.statusMessage = result.error || "Delete failed";
				this.statusType = "error";
			}
		} catch {
			this.statusMessage = "Network error";
			this.statusType = "error";
		}
	}

	private get _filteredSkills(): SkillInfo[] {
		let list = this.skills;
		if (this.scopeFilter !== "all") {
			list = list.filter(s => s.scope === this.scopeFilter);
		}
		if (this.searchQuery) {
			const q = this.searchQuery.toLowerCase();
			list = list.filter(s =>
				s.name.toLowerCase().includes(q) ||
				(s.description || "").toLowerCase().includes(q),
			);
		}
		return list;
	}

	override render() {
		const isAdmin = this.userRole === "admin";
		const scopes = isAdmin
			? [
				{ value: "user", label: "My Skills" },
				{ value: "team", label: "Team" },
				{ value: "platform", label: "Platform" },
			]
			: [{ value: "user", label: "My Skills" }];

		const filtered = this._filteredSkills;

		return html`
			<!-- Filter bar -->
			<div class="filter-bar">
				<div class="tab-group">
					${(["all", "platform", "team", "user"] as ScopeFilter[]).map(scope => html`
						<button
							class="tab-btn ${this.scopeFilter === scope ? "active" : ""}"
							@click=${() => { this.scopeFilter = scope; }}
						>
							${scope === "all" ? "All" : scope === "user" ? "Personal" : scope.charAt(0).toUpperCase() + scope.slice(1)}
						</button>
					`)}
				</div>
				<input
					class="search-input"
					type="text"
					placeholder="Search skills..."
					.value=${this.searchQuery}
					@input=${(e: Event) => { this.searchQuery = (e.target as HTMLInputElement).value; }}
				/>
			</div>

			<div class="content">
				${this.statusMessage ? html`
					<div class="status ${this.statusType === "success" ? "status-success" : "status-error"}">
						${this.statusMessage}
					</div>
				` : nothing}

				<!-- Upload form -->
				<div class="upload-form">
					<div class="form-field">
						<label>Scope</label>
						<select
							.value=${this.selectedScope}
							@change=${(e: Event) => { this.selectedScope = (e.target as HTMLSelectElement).value; }}
						>
							${scopes.map(s => html`<option value=${s.value}>${s.label}</option>`)}
						</select>
					</div>
					<div class="form-field grow">
						<label>Skill File (.md or .zip)</label>
						<input
							type="file"
							accept=".md,.zip"
							@change=${(e: Event) => {
								this.selectedFile = (e.target as HTMLInputElement).files?.[0] || null;
							}}
						/>
					</div>
					<button
						class="btn-primary"
						?disabled=${!this.selectedFile || this.uploading}
						@click=${() => this._handleUpload()}
					>
						${this.uploading ? "Uploading..." : "Upload Skill"}
					</button>
				</div>

				<!-- Card grid -->
				${this.loading ? html`
					<div class="card-grid">
						<div class="skeleton-card"></div>
						<div class="skeleton-card"></div>
						<div class="skeleton-card"></div>
					</div>
				` : filtered.length === 0 ? html`
					<div class="empty-state">
						${this.skills.length === 0
							? "No skills yet. Upload a SKILL.md or skill zip bundle above."
							: "No skills match your filter."}
					</div>
				` : html`
					<div class="card-grid">
						${filtered.map(skill => html`
							<div class="card">
								<div class="card-header">
									<span class="card-name">${skill.name}</span>
									<span class="scope-badge ${skill.scope}">${skill.scope}</span>
								</div>
								${skill.description ? html`<div class="card-desc">${skill.description}</div>` : nothing}
								<div class="card-meta">
									${new Date(skill.created_at).toLocaleDateString()}
								</div>
								<div class="card-actions">
									<button class="btn-danger" @click=${() => this._handleDelete(skill)}>Delete</button>
								</div>
							</div>
						`)}
					</div>
				`}
			</div>
		`;
	}
}
