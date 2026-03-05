/**
 * Skills Management Panel.
 *
 * Lists, uploads, and deletes skills.
 * All users can manage their own (user-scope) skills.
 * Admins can manage platform/team skills.
 */

import { apiFetch } from "../shared/api.js";
import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { SkillInfo } from "../studio/types.js";

@customElement("skills-panel")
export class SkillsPanel extends LitElement {
	static override styles = css`
		:host {
			display: block;
			padding: 1rem;
		}
		.skill-list {
			display: flex;
			flex-direction: column;
			gap: 0.5rem;
			margin-bottom: 1rem;
		}
		.skill-item {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 0.75rem 1rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.5rem;
			background: var(--card, #fff);
		}
		.skill-info {
			display: flex;
			flex-direction: column;
			gap: 0.25rem;
			flex: 1;
			min-width: 0;
		}
		.skill-name {
			font-weight: 600;
			font-size: 0.875rem;
		}
		.skill-desc {
			font-size: 0.75rem;
			color: var(--muted-foreground, #6b7280);
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.skill-scope {
			font-size: 0.625rem;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			padding: 0.125rem 0.375rem;
			border-radius: 0.25rem;
			background: var(--muted, #f3f4f6);
			color: var(--muted-foreground, #6b7280);
		}
		.upload-form {
			display: flex;
			flex-direction: column;
			gap: 0.5rem;
			padding: 1rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.5rem;
			background: var(--card, #fff);
		}
		.drop-zone {
			border: 2px dashed var(--border, #e5e7eb);
			border-radius: 0.5rem;
			padding: 1.5rem;
			text-align: center;
			cursor: pointer;
			transition: border-color 0.15s, background 0.15s;
			color: var(--muted-foreground, #6b7280);
			font-size: 0.875rem;
		}
		.drop-zone:hover {
			border-color: var(--primary, #2563eb);
		}
		.drop-zone.drag-over {
			border-color: var(--primary, #2563eb);
			background: color-mix(in srgb, var(--primary, #2563eb) 5%, transparent);
		}
		.drop-zone .file-name {
			color: var(--foreground, #111);
			font-weight: 500;
		}
		.form-row {
			display: flex;
			gap: 0.5rem;
			align-items: flex-end;
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
		select {
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
		h3 { margin: 0 0 1rem 0; font-size: 1rem; font-weight: 600; }
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
	@state() private selectedScope = "user";
	@state() private selectedFile: File | null = null;
	@state() private dragOver = false;

	override connectedCallback() {
		super.connectedCallback();
		this.loadSkills();
	}

	private fetchApi = (url: string, options?: RequestInit) => apiFetch(url, options, this.getToken);

	private async loadSkills() {
		this.loading = true;
		try {
			const result = await this.fetchApi("/api/skills");
			if (result.success) {
				this.skills = result.data.skills;
			}
		} catch (err) {
			console.error("Failed to load skills:", err);
		} finally {
			this.loading = false;
		}
	}

	private async handleUpload() {
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
				// Reset file input
				const fileInput = this.shadowRoot?.querySelector<HTMLInputElement>("#file-input");
				if (fileInput) fileInput.value = "";
				await this.loadSkills();
			} else {
				this.statusMessage = result.error || "Upload failed";
				this.statusType = "error";
			}
		} catch (err) {
			this.statusMessage = "Network error";
			this.statusType = "error";
		} finally {
			this.uploading = false;
		}
	}

	private async handleDelete(skill: SkillInfo) {
		if (!confirm(`Delete skill "${skill.name}"?`)) return;

		try {
			const result = await this.fetchApi(`/api/skills/${skill.id}`, { method: "DELETE" });
			if (result.success) {
				this.statusMessage = `Skill "${skill.name}" deleted.`;
				this.statusType = "success";
				await this.loadSkills();
			} else {
				this.statusMessage = result.error || "Delete failed";
				this.statusType = "error";
			}
		} catch {
			this.statusMessage = "Network error";
			this.statusType = "error";
		}
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

		return html`
			<h3>Agent Tools</h3>

			${this.statusMessage
				? html`<div class="status ${this.statusType === "success" ? "status-success" : "status-error"}">${this.statusMessage}</div>`
				: null}

			${this.loading
				? html`<div class="empty">Loading...</div>`
				: this.skills.length === 0
					? html`<div class="empty">
						<div style="font-size: 1.5rem; margin-bottom: 0.5rem;">🧩</div>
						<div style="font-weight: 600; margin-bottom: 0.25rem;">No agent tools configured</div>
						<div>Agent tools teach the AI new capabilities. Upload a SKILL.md file or zip bundle to extend what your AI assistant can do.</div>
					</div>`
					: html`
						<div class="skill-list">
							${this.skills.map(
								(skill) => html`
									<div class="skill-item">
										<div class="skill-info">
											<div style="display: flex; align-items: center; gap: 0.5rem;">
												<span class="skill-name">${skill.name}</span>
												<span class="skill-scope">${skill.scope}</span>
											</div>
											<span class="skill-desc">${skill.description}</span>
										</div>
										<button class="btn-danger" @click=${() => this.handleDelete(skill)}>Delete</button>
									</div>
								`,
							)}
						</div>
					`}

			<div class="upload-form">
				<input
					id="file-input"
					type="file"
					accept=".md,.zip"
					style="display: none"
					@change=${(e: Event) => {
						const input = e.target as HTMLInputElement;
						this.selectedFile = input.files?.[0] || null;
					}}
				/>
				<div
					class="drop-zone ${this.dragOver ? "drag-over" : ""}"
					@click=${() => this.shadowRoot?.querySelector<HTMLInputElement>("#file-input")?.click()}
					@dragover=${(e: DragEvent) => { e.preventDefault(); this.dragOver = true; }}
					@dragleave=${() => { this.dragOver = false; }}
					@drop=${(e: DragEvent) => {
						e.preventDefault();
						this.dragOver = false;
						const file = e.dataTransfer?.files[0];
						if (file && (file.name.endsWith(".md") || file.name.endsWith(".zip"))) {
							this.selectedFile = file;
						} else if (file) {
							this.statusMessage = "Only .md and .zip files are supported";
							this.statusType = "error";
						}
					}}
				>
					${this.selectedFile
						? html`<span class="file-name">${this.selectedFile.name}</span>`
						: html`Drop a .md or .zip file here, or click to browse`}
				</div>
				<div class="form-row">
					<div class="form-field">
						<label>Scope</label>
						<select .value=${this.selectedScope} @change=${(e: Event) => (this.selectedScope = (e.target as HTMLSelectElement).value)}>
							${scopes.map((s) => html`<option value=${s.value}>${s.label}</option>`)}
						</select>
					</div>
					<button
						class="btn-primary"
						?disabled=${!this.selectedFile || this.uploading}
						@click=${this.handleUpload}
					>
						${this.uploading ? "Uploading..." : "Upload"}
					</button>
				</div>
			</div>
		`;
	}
}
