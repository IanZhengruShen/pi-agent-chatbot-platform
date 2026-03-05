/**
 * Full-page Agent Studio with browse (card grid) and edit views.
 * Supports three tabs: Profiles, Skills, Files.
 */

import { apiFetch } from "../shared/api.js";
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { ProfileInfo, SkillInfo, FileInfo, ProfileFormData } from "./types.js";
import { EMPTY_FORM } from "./types.js";
import { navigateTo } from "../router.js";
import "./ProfileCard.js";
import "./ProfileEditor.js";
import "./ProfilePreview.js";
import "./SkillsTab.js";
import "./FilesTab.js";

type ViewMode = "browse" | "quick-create" | "edit";
type ScopeFilter = "all" | "platform" | "team" | "user";
type StudioTab = "profiles" | "skills" | "files";

@customElement("studio-page")
export class StudioPage extends LitElement {
	static override styles = css`
		:host {
			display: block;
			height: 100%;
		}
		.studio {
			display: flex;
			flex-direction: column;
			height: 100%;
			overflow: hidden;
		}

		/* Header */
		.header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 0.75rem 1.5rem;
			border-bottom: 1px solid var(--border, #e5e7eb);
			flex-shrink: 0;
		}
		.header-left {
			display: flex;
			align-items: center;
			gap: 0.75rem;
		}
		.header-title {
			font-size: 1.125rem;
			font-weight: 600;
		}
		.back-link {
			font-size: 0.85rem;
			color: var(--primary, #2563eb);
			cursor: pointer;
			text-decoration: none;
			background: none;
			border: none;
			font-family: inherit;
			padding: 0.25rem 0.5rem;
			border-radius: 0.25rem;
		}
		.back-link:hover {
			background: var(--muted, #f3f4f6);
		}

		/* Tab bar */
		.tab-bar {
			display: flex;
			gap: 0;
			border-bottom: 1px solid var(--border, #e5e7eb);
			flex-shrink: 0;
			padding: 0 1.5rem;
		}
		.tab-bar-btn {
			padding: 0.625rem 1.25rem;
			font-size: 0.85rem;
			font-weight: 500;
			cursor: pointer;
			background: none;
			border: none;
			border-bottom: 2px solid transparent;
			color: var(--muted-foreground, #6b7280);
			font-family: inherit;
			transition: color 0.15s, border-color 0.15s;
		}
		.tab-bar-btn:hover {
			color: var(--foreground, #111);
		}
		.tab-bar-btn.active {
			color: var(--primary, #2563eb);
			border-bottom-color: var(--primary, #2563eb);
		}

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
		.tab-btn:hover {
			background: var(--muted, #f3f4f6);
		}
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

		/* Browse grid */
		.browse-content {
			flex: 1;
			overflow-y: auto;
			padding: 1.5rem;
		}
		.card-grid {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
			gap: 1rem;
			max-width: 1400px;
			margin: 0 auto;
		}
		.empty-state {
			text-align: center;
			padding: 3rem;
			color: var(--muted-foreground, #6b7280);
			font-size: 0.9rem;
		}

		/* Tab content wrapper */
		.tab-content {
			flex: 1;
			display: flex;
			flex-direction: column;
			overflow: hidden;
		}

		/* Edit view */
		.edit-content {
			flex: 1;
			display: grid;
			grid-template-columns: 1fr 1fr;
			gap: 1.5rem;
			padding: 1.5rem;
			overflow: hidden;
		}
		.edit-form-pane {
			overflow-y: auto;
		}
		.edit-preview-pane {
			overflow-y: auto;
		}
		@media (max-width: 768px) {
			.edit-content {
				grid-template-columns: 1fr;
				overflow-y: auto;
			}
		}

		/* Buttons */
		button {
			cursor: pointer;
		}
		.btn-primary {
			padding: 0.5rem 1rem;
			border: none;
			border-radius: 0.375rem;
			font-size: 0.85rem;
			font-weight: 500;
			background: var(--primary, #2563eb);
			color: white;
			font-family: inherit;
		}
		.btn-primary:hover {
			opacity: 0.9;
		}
		.btn-danger {
			padding: 0.375rem 0.75rem;
			border: 1px solid var(--destructive, #dc2626);
			border-radius: 0.375rem;
			font-size: 0.8rem;
			font-weight: 500;
			background: transparent;
			color: var(--destructive, #dc2626);
			font-family: inherit;
		}
		.btn-danger:hover {
			background: color-mix(in srgb, var(--destructive, #dc2626) 10%, transparent);
		}

		/* Skeleton loading */
		@keyframes shimmer {
			0% { background-position: -400px 0; }
			100% { background-position: 400px 0; }
		}
		.skeleton-card {
			height: 160px;
			border-radius: 0.75rem;
			background: linear-gradient(90deg, var(--muted, #f3f4f6) 25%, var(--background, #fff) 50%, var(--muted, #f3f4f6) 75%);
			background-size: 800px 100%;
			animation: shimmer 1.5s infinite;
		}
		.loading {
			text-align: center;
			padding: 3rem;
			color: var(--muted-foreground, #6b7280);
		}

		/* Quick Create */
		.quick-create-wrapper {
			flex: 1;
			display: flex;
			align-items: center;
			justify-content: center;
			padding: 2rem;
			overflow-y: auto;
		}
		.quick-create-card {
			max-width: 480px;
			width: 100%;
			padding: 2rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.75rem;
			background: var(--background, #fff);
		}
		.quick-create-card h2 {
			margin: 0 0 0.25rem;
			font-size: 1.125rem;
			font-weight: 600;
		}
		.quick-create-card .subtitle {
			margin: 0 0 1.5rem;
			font-size: 0.85rem;
			color: var(--muted-foreground, #6b7280);
		}
		.quick-create-card .form-field {
			display: flex;
			flex-direction: column;
			gap: 0.25rem;
			margin-bottom: 0.75rem;
		}
		.quick-create-card label {
			font-size: 0.75rem;
			font-weight: 500;
			color: var(--muted-foreground, #6b7280);
		}
		.quick-create-card input,
		.quick-create-card textarea,
		.quick-create-card select {
			padding: 0.5rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.375rem;
			font-size: 0.875rem;
			background: var(--background, #fff);
			color: var(--foreground, #111);
			font-family: inherit;
		}
		.quick-create-card input:focus,
		.quick-create-card textarea:focus,
		.quick-create-card select:focus {
			outline: none;
			border-color: var(--primary, #2563eb);
			box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary, #2563eb) 20%, transparent);
		}
		.quick-create-card textarea {
			resize: vertical;
			min-height: 4rem;
		}
		.quick-create-actions {
			display: flex;
			gap: 0.5rem;
			justify-content: flex-end;
			margin-top: 1.25rem;
		}
		.btn-secondary {
			padding: 0.5rem 1rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.375rem;
			font-size: 0.85rem;
			font-weight: 500;
			background: transparent;
			color: var(--foreground, #111);
			font-family: inherit;
		}
		.btn-secondary:hover {
			background: var(--muted, #f3f4f6);
		}
		.btn-primary:disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}
		.generate-error {
			margin-top: 0.75rem;
			padding: 0.5rem;
			border-radius: 0.375rem;
			background: #fef2f2;
			color: #991b1b;
			font-size: 0.8rem;
		}
	`;

	@property({ type: Function })
	getToken: (() => string | null) | undefined;

	@property({ type: String })
	userRole: string = "member";

	@property({ type: String })
	userId: string = "";

	@property({ type: String })
	editProfileId: string | null = null;

	@property({ type: String })
	activeTab: StudioTab = "profiles";

	@state() private profiles: ProfileInfo[] = [];
	@state() private availableSkills: SkillInfo[] = [];
	@state() private availableFiles: FileInfo[] = [];
	@state() private loading = false;
	@state() private viewMode: ViewMode = "browse";
	@state() private editingProfile: ProfileInfo | null = null;
	@state() private scopeFilter: ScopeFilter = "all";
	@state() private searchQuery = "";
	@state() private previewForm: ProfileFormData = { ...EMPTY_FORM };

	// Quick Create state
	@state() private quickCreateName = "";
	@state() private quickCreateDescription = "";
	@state() private quickCreateScope = "user";
	@state() private generating = false;
	@state() private generateError = "";
	@state() private initialFormData: ProfileFormData | null = null;

	override connectedCallback() {
		super.connectedCallback();
		this._loadData();
	}

	override updated(changed: Map<string, unknown>) {
		if (changed.has("editProfileId") && this.editProfileId) {
			this._openEditById(this.editProfileId);
		}
	}

	private _fetchApi = (url: string, options?: RequestInit) => apiFetch(url, options, this.getToken);

	private async _loadData() {
		this.loading = true;
		try {
			const [profilesRes, skillsRes, filesRes] = await Promise.all([
				this._fetchApi("/api/agent-profiles"),
				this._fetchApi("/api/skills"),
				this._fetchApi("/api/files"),
			]);
			if (profilesRes.success) this.profiles = profilesRes.data.profiles;
			if (skillsRes.success) this.availableSkills = skillsRes.data.skills;
			if (filesRes.success) this.availableFiles = filesRes.data.files;
		} catch (err) {
			console.error("Failed to load studio data:", err);
		} finally {
			this.loading = false;
		}

		if (this.editProfileId) {
			this._openEditById(this.editProfileId);
		}
	}

	private _openEditById(id: string) {
		const profile = this.profiles.find(p => p.id === id);
		if (profile) {
			this.editingProfile = profile;
			this.initialFormData = null;
			this.viewMode = "edit";
			this._initPreviewFromProfile(profile);
		}
	}

	private _initPreviewFromProfile(profile: ProfileInfo) {
		this.previewForm = {
			name: profile.name,
			description: profile.description || "",
			icon: profile.icon || "",
			scope: profile.scope,
			system_prompt: profile.system_prompt,
			prompt_mode: profile.prompt_mode,
			skill_ids: profile.skill_ids || [],
			file_ids: profile.file_ids || [],
			model_id: profile.model_id || "",
			provider: profile.provider || "",
			starter_message: profile.starter_message || "",
			suggested_prompts: profile.suggested_prompts || [],
		};
	}

	private _openNewForm() {
		this.editingProfile = null;
		this.initialFormData = null;
		this.quickCreateName = "";
		this.quickCreateDescription = "";
		this.quickCreateScope = "user";
		this.generating = false;
		this.generateError = "";
		this.viewMode = "quick-create";
	}

	private _backToBrowse() {
		this.viewMode = "browse";
		this.editingProfile = null;
		navigateTo("/studio");
	}

	private _switchTab(tab: StudioTab) {
		if (tab === "profiles") navigateTo("/studio");
		else if (tab === "skills") navigateTo("/studio/skills");
		else if (tab === "files") navigateTo("/studio/files");
	}

	private async _handleDelete(profile: ProfileInfo) {
		if (!confirm(`Delete agent profile "${profile.name}"?`)) return;
		try {
			const result = await this._fetchApi(`/api/agent-profiles/${profile.id}`, { method: "DELETE" });
			if (result.success) {
				await this._loadData();
				if (this.viewMode === "edit" && this.editingProfile?.id === profile.id) {
					this._backToBrowse();
				}
			}
		} catch (err) {
			console.error("Failed to delete profile:", err);
		}
	}

	private async _onSave() {
		await this._loadData();
		this._backToBrowse();
		this.dispatchEvent(new CustomEvent("profiles-changed", { bubbles: true, composed: true }));
	}

	private _canEdit(profile: ProfileInfo): boolean {
		const isAdmin = this.userRole === "admin";
		return (profile.scope === "user") ||
			((profile.scope === "platform" || profile.scope === "team") && isAdmin);
	}

	private get _filteredProfiles(): ProfileInfo[] {
		let list = this.profiles;
		if (this.scopeFilter !== "all") {
			list = list.filter(p => p.scope === this.scopeFilter);
		}
		if (this.searchQuery) {
			const q = this.searchQuery.toLowerCase();
			list = list.filter(p =>
				p.name.toLowerCase().includes(q) ||
				(p.description || "").toLowerCase().includes(q),
			);
		}
		return list;
	}

	private _getHeaderActionLabel(): string {
		switch (this.activeTab) {
			case "skills": return "+ Upload Skill";
			case "files": return "+ Upload File";
			default: return "+ New Profile";
		}
	}

	private _handleHeaderAction() {
		if (this.activeTab === "profiles") {
			this._openNewForm();
		}
		// Skills and Files tabs handle their own upload UI inline
	}

	private _renderTabBar() {
		const tabs: { id: StudioTab; label: string }[] = [
			{ id: "profiles", label: "Profiles" },
			{ id: "skills", label: "Agent Tools" },
			{ id: "files", label: "Files" },
		];
		return html`
			<div class="tab-bar">
				${tabs.map(t => html`
					<button
						class="tab-bar-btn ${this.activeTab === t.id ? "active" : ""}"
						@click=${() => this._switchTab(t.id)}
					>
						${t.label}
					</button>
				`)}
			</div>
		`;
	}

	private _renderProfilesBrowse() {
		const filtered = this._filteredProfiles;

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
					placeholder="Search profiles..."
					.value=${this.searchQuery}
					@input=${(e: Event) => { this.searchQuery = (e.target as HTMLInputElement).value; }}
				/>
			</div>

			<!-- Card grid -->
			<div class="browse-content">
				${this.loading ? html`
					<div class="card-grid">
						<div class="skeleton-card"></div>
						<div class="skeleton-card"></div>
						<div class="skeleton-card"></div>
					</div>
				` :
				filtered.length === 0 ? html`
					<div class="empty-state">
						${this.profiles.length === 0
							? "No agent profiles yet. Create one to get started."
							: "No profiles match your filter."}
					</div>
				` : html`
					<div class="card-grid">
						${filtered.map(profile => html`
							<profile-card
								.profile=${profile}
								.availableSkills=${this.availableSkills}
								.showActions=${this._canEdit(profile)}
								@select=${() => {
									if (this._canEdit(profile)) {
										navigateTo(`/studio/${profile.id}/edit`);
										this.editingProfile = profile;
										this.viewMode = "edit";
										this._initPreviewFromProfile(profile);
									}
								}}
								@edit=${() => {
									navigateTo(`/studio/${profile.id}/edit`);
									this.editingProfile = profile;
									this.viewMode = "edit";
									this._initPreviewFromProfile(profile);
								}}
								@delete=${() => this._handleDelete(profile)}
							></profile-card>
						`)}
					</div>
				`}
			</div>
		`;
	}

	private async _generateProfile() {
		if (!this.quickCreateName) return;
		this.generating = true;
		this.generateError = "";

		try {
			const result = await this._fetchApi("/api/agent-profiles/generate", {
				method: "POST",
				body: JSON.stringify({
					name: this.quickCreateName,
					description: this.quickCreateDescription || undefined,
					available_skills: this.availableSkills.map(s => ({
						id: s.id, name: s.name, description: s.description, scope: s.scope,
					})),
					available_files: this.availableFiles.map(f => ({
						id: f.id, filename: f.filename,
					})),
				}),
			});

			if (result.success && result.data) {
				const d = result.data;
				this.initialFormData = {
					name: this.quickCreateName,
					description: this.quickCreateDescription,
					icon: d.icon || "",
					scope: this.quickCreateScope,
					system_prompt: d.system_prompt || "",
					prompt_mode: "replace",
					skill_ids: Array.isArray(d.skill_ids) ? d.skill_ids : [],
					file_ids: Array.isArray(d.file_ids) ? d.file_ids : [],
					model_id: "",
					provider: "",
					starter_message: d.starter_message || "",
					suggested_prompts: Array.isArray(d.suggested_prompts) ? d.suggested_prompts : [],
				};
			} else {
				this.generateError = result.error || "Generation failed. You can try again or skip to the editor.";
				return;
			}
		} catch {
			this.generateError = "Network error. You can try again or skip to the editor.";
			return;
		} finally {
			this.generating = false;
		}

		this.previewForm = { ...this.initialFormData! };
		this.viewMode = "edit";
	}

	private _skipToEditor() {
		this.initialFormData = {
			...EMPTY_FORM,
			name: this.quickCreateName,
			description: this.quickCreateDescription,
			scope: this.quickCreateScope,
		};
		this.previewForm = { ...this.initialFormData };
		this.viewMode = "edit";
	}

	private _renderQuickCreate() {
		const isAdmin = this.userRole === "admin";

		return html`
			<div class="quick-create-wrapper">
				<div class="quick-create-card">
					<h2>Create New Agent Profile</h2>
					<p class="subtitle">Enter a name and description, then let AI generate the profile for you.</p>

					<div class="form-field">
						<label>Name *</label>
						<input
							type="text"
							placeholder="e.g. Finance Agent"
							maxlength="100"
							.value=${this.quickCreateName}
							@input=${(e: Event) => { this.quickCreateName = (e.target as HTMLInputElement).value; }}
						/>
					</div>

					<div class="form-field">
						<label>Description</label>
						<textarea
							placeholder="What should this agent do? e.g. Helps analyze budgets and financial reports"
							.value=${this.quickCreateDescription}
							@input=${(e: Event) => { this.quickCreateDescription = (e.target as HTMLTextAreaElement).value; }}
						></textarea>
					</div>

					${isAdmin ? html`
						<div class="form-field">
							<label>Scope</label>
							<select
								.value=${this.quickCreateScope}
								@change=${(e: Event) => { this.quickCreateScope = (e.target as HTMLSelectElement).value; }}
							>
								<option value="user">Personal</option>
								<option value="team">Team</option>
								<option value="platform">Platform</option>
							</select>
						</div>
					` : nothing}

					${this.generateError ? html`<div class="generate-error">${this.generateError}</div>` : nothing}

					<div class="quick-create-actions">
						<button class="btn-secondary" @click=${() => this._backToBrowse()}>Cancel</button>
						<button class="btn-secondary" @click=${() => this._skipToEditor()}>Skip to Editor</button>
						<button
							class="btn-primary"
							?disabled=${this.generating || !this.quickCreateName}
							@click=${() => this._generateProfile()}
						>
							${this.generating ? "Generating..." : "Generate with AI"}
						</button>
					</div>
				</div>
			</div>
		`;
	}

	private _renderEdit() {
		return html`
			<div class="edit-content">
				<div class="edit-form-pane">
					<profile-editor
						.profile=${this.editingProfile}
						.initialForm=${this.initialFormData}
						.getToken=${this.getToken}
						.userRole=${this.userRole}
						.availableSkills=${this.availableSkills}
						.availableFiles=${this.availableFiles}
						@save=${() => this._onSave()}
						@cancel=${() => this._backToBrowse()}
						@preview-change=${(e: CustomEvent) => { this.previewForm = e.detail.form; }}
					></profile-editor>
				</div>
				<div class="edit-preview-pane">
					<profile-preview
						.form=${this.previewForm}
						.availableSkills=${this.availableSkills}
						.availableFiles=${this.availableFiles}
					></profile-preview>
				</div>
			</div>
		`;
	}

	override render() {
		const isEdit = this.viewMode === "edit";
		const isQuickCreate = this.viewMode === "quick-create";
		const isBrowse = this.viewMode === "browse";

		const headerTitle = isEdit
			? (this.editingProfile ? "Edit Profile" : "New Profile")
			: isQuickCreate ? "New Profile" : "Agent Builder";

		return html`
			<div class="studio">
				<!-- Header -->
				<div class="header">
					<div class="header-left">
						<button class="back-link" @click=${() => {
							if (isEdit || isQuickCreate) this._backToBrowse();
							else navigateTo("/");
						}}>
							&larr; ${isEdit || isQuickCreate ? "Back to Browse" : "Back to Chat"}
						</button>
						<span class="header-title">${headerTitle}</span>
					</div>
					<div>
						${isEdit && this.editingProfile ? html`
							<button class="btn-danger" @click=${() => this._handleDelete(this.editingProfile!)}>Delete</button>
						` : nothing}
						${isBrowse && this.activeTab === "profiles" ? html`
							<button class="btn-primary" @click=${() => this._handleHeaderAction()}>${this._getHeaderActionLabel()}</button>
						` : nothing}
					</div>
				</div>

				${isEdit ? this._renderEdit() : isQuickCreate ? this._renderQuickCreate() : html`
					${this._renderTabBar()}
					<div class="tab-content">
						${this.activeTab === "profiles" ? this._renderProfilesBrowse() : nothing}
						${this.activeTab === "skills" ? html`
							<studio-skills-tab
								.getToken=${this.getToken}
								.userRole=${this.userRole}
							></studio-skills-tab>
						` : nothing}
						${this.activeTab === "files" ? html`
							<studio-files-tab
								.getToken=${this.getToken}
							></studio-files-tab>
						` : nothing}
					</div>
				`}
			</div>
		`;
	}
}
