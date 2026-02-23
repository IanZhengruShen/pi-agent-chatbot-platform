/**
 * Agent Profiles Management Panel.
 *
 * CRUD for agent profiles: create, edit, delete specialist agents
 * with custom system prompts, curated skills, and model preferences.
 *
 * Uses shared types from src/studio/types.ts and delegates to
 * ProfileCard and ProfileEditor sub-components.
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { ProfileInfo, SkillInfo, ProfileFormData } from "../studio/types.js";
import { EMPTY_FORM } from "../studio/types.js";
import "../studio/ProfileCard.js";
import "../studio/ProfileEditor.js";

@customElement("agent-profiles-panel")
export class AgentProfilesPanel extends LitElement {
	static override styles = css`
		:host {
			display: block;
			min-height: 400px;
		}
		.container {
			display: flex;
			flex-direction: column;
			gap: 1rem;
			max-height: 70vh;
			overflow-y: auto;
		}
		.profile-list {
			display: flex;
			flex-direction: column;
			gap: 0.5rem;
		}
		.section-label {
			font-size: 0.75rem;
			font-weight: 600;
			color: var(--muted-foreground, #6b7280);
			text-transform: uppercase;
			letter-spacing: 0.05em;
			margin-top: 0.5rem;
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
		.status {
			font-size: 0.875rem;
			padding: 0.5rem;
			border-radius: 0.375rem;
			margin-bottom: 0.5rem;
		}
		.status-success { background: #dcfce7; color: #166534; }
		.status-error { background: #fef2f2; color: #991b1b; }
		.empty {
			text-align: center;
			padding: 2rem;
			color: var(--muted-foreground, #6b7280);
			font-size: 0.875rem;
		}
		h3 { margin: 0 0 0.5rem 0; font-size: 1rem; font-weight: 600; }
		.header-row {
			display: flex;
			justify-content: space-between;
			align-items: center;
		}
	`;

	@property({ type: Function })
	getToken: (() => string | null) | undefined;

	@property({ type: String })
	userRole: string = "member";

	@property({ type: Function })
	onProfilesChanged: (() => void) | undefined;

	@state() private profiles: ProfileInfo[] = [];
	@state() private availableSkills: SkillInfo[] = [];
	@state() private loading = false;
	@state() private statusMessage = "";
	@state() private statusType: "success" | "error" = "success";
	@state() private editingProfile: ProfileInfo | null = null;
	@state() private showForm = false;

	override connectedCallback() {
		super.connectedCallback();
		this.loadProfiles();
		this.loadSkills();
	}

	private async fetchApi(url: string, options: RequestInit = {}): Promise<any> {
		const token = this.getToken?.();
		const res = await fetch(url, {
			...options,
			headers: {
				"Content-Type": "application/json",
				...(token ? { Authorization: `Bearer ${token}` } : {}),
				...options.headers,
			},
		});
		return res.json();
	}

	private async loadProfiles() {
		this.loading = true;
		try {
			const result = await this.fetchApi("/api/agent-profiles");
			if (result.success) {
				this.profiles = result.data.profiles;
			}
		} catch (err) {
			console.error("Failed to load profiles:", err);
		} finally {
			this.loading = false;
		}
	}

	private async loadSkills() {
		try {
			const result = await this.fetchApi("/api/skills");
			if (result.success) {
				this.availableSkills = result.data.skills;
			}
		} catch (err) {
			console.error("Failed to load skills:", err);
		}
	}

	private openNewForm() {
		this.editingProfile = null;
		this.showForm = true;
		this.statusMessage = "";
	}

	private openEditForm(profile: ProfileInfo) {
		this.editingProfile = profile;
		this.showForm = true;
		this.statusMessage = "";
	}

	private async handleDelete(profile: ProfileInfo) {
		if (!confirm(`Delete agent profile "${profile.name}"?`)) return;

		try {
			const result = await this.fetchApi(`/api/agent-profiles/${profile.id}`, { method: "DELETE" });
			if (result.success) {
				this.statusMessage = `Profile "${profile.name}" deleted.`;
				this.statusType = "success";
				await this.loadProfiles();
				this.onProfilesChanged?.();
			} else {
				this.statusMessage = result.error || "Delete failed";
				this.statusType = "error";
			}
		} catch {
			this.statusMessage = "Network error";
			this.statusType = "error";
		}
	}

	private async onEditorSave() {
		this.showForm = false;
		this.editingProfile = null;
		await this.loadProfiles();
		this.onProfilesChanged?.();
	}

	private _canEdit(profile: ProfileInfo): boolean {
		const isAdmin = this.userRole === "admin";
		return (profile.scope === "user") ||
			((profile.scope === "platform" || profile.scope === "team") && isAdmin);
	}

	override render() {
		if (this.showForm) {
			return html`
				<div class="container">
					${this.statusMessage
						? html`<div class="status ${this.statusType === "success" ? "status-success" : "status-error"}">${this.statusMessage}</div>`
						: nothing}
					<profile-editor
						.profile=${this.editingProfile}
						.getToken=${this.getToken}
						.userRole=${this.userRole}
						.availableSkills=${this.availableSkills}
						@save=${() => this.onEditorSave()}
						@cancel=${() => { this.showForm = false; this.editingProfile = null; }}
					></profile-editor>
				</div>
			`;
		}

		// Group profiles by scope
		const platformProfiles = this.profiles.filter(p => p.scope === "platform");
		const teamProfiles = this.profiles.filter(p => p.scope === "team");
		const userProfiles = this.profiles.filter(p => p.scope === "user");

		const renderSection = (label: string, profiles: ProfileInfo[]) => {
			if (profiles.length === 0) return nothing;
			return html`
				<div class="section-label">${label}</div>
				<div class="profile-list">
					${profiles.map(p => html`
						<profile-card
							compact
							.profile=${p}
							.availableSkills=${this.availableSkills}
							.showActions=${this._canEdit(p)}
							@edit=${() => this.openEditForm(p)}
							@delete=${() => this.handleDelete(p)}
						></profile-card>
					`)}
				</div>
			`;
		};

		return html`
			<div class="container">
				<div class="header-row">
					<h3>Agent Profiles</h3>
					<button class="btn-primary" @click=${() => this.openNewForm()}>+ New Profile</button>
				</div>

				${this.statusMessage
					? html`<div class="status ${this.statusType === "success" ? "status-success" : "status-error"}">${this.statusMessage}</div>`
					: nothing}

				${this.loading
					? html`<div class="empty">Loading...</div>`
					: this.profiles.length === 0
						? html`<div class="empty">No agent profiles yet. Create one to get started.</div>`
						: html`
							${renderSection("Platform", platformProfiles)}
							${renderSection("Team", teamProfiles)}
							${renderSection("Personal", userProfiles)}
						`}
			</div>
		`;
	}
}
