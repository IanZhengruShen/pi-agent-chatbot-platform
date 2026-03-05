/**
 * Scheduler Panel: manage scheduled jobs.
 *
 * Features:
 * - List jobs (user-scoped and team-scoped)
 * - Create/edit jobs
 * - Manual trigger
 * - View run history
 * - Enable/disable jobs
 */

import { apiFetch } from "../shared/api.js";
import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import "./CronBuilder.js";

interface Job {
	id: string;
	owner_type: string;
	name: string;
	description: string | null;
	cron_expr: string;
	next_run_at: string;
	prompt: string;
	skill_ids: string[] | null;
	file_ids: string[] | null;
	model_id: string | null;
	provider: string | null;
	delivery: { type: "email"; to: string } | { type: "teams"; webhook: string };
	enabled: boolean;
	last_status: string | null;
	last_error: string | null;
	created_at: string;
}

interface JobRun {
	id: string;
	started_at: string;
	finished_at: string | null;
	status: string;
	result: any;
	error: string | null;
	delivery_status: string | null;
}

type Skill = Pick<import("../studio/types.js").SkillInfo, "id" | "name" | "scope">;
type UserFile = Pick<import("../studio/types.js").FileInfo, "id" | "filename">;

@customElement("scheduler-panel")
export class SchedulerPanel extends LitElement {
	static override styles = css`
		:host {
			display: block;
			min-height: 400px;
		}
		.container {
			display: flex;
			flex-direction: column;
			gap: 1rem;
			max-height: 600px;
			overflow-y: auto;
		}
		.job-list {
			display: flex;
			flex-direction: column;
			gap: 0.5rem;
		}
		.job-item {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 0.75rem 1rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.5rem;
			background: var(--card, #fff);
		}
		.job-info {
			display: flex;
			flex-direction: column;
			gap: 0.25rem;
			flex: 1;
			min-width: 0;
		}
		.job-name {
			font-weight: 600;
			font-size: 0.875rem;
		}
		.job-prompt-preview {
			font-size: 0.75rem;
			color: var(--muted-foreground, #6b7280);
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			cursor: default;
		}
		.job-details {
			font-size: 0.75rem;
			color: var(--muted-foreground, #6b7280);
		}
		.job-actions {
			display: flex;
			gap: 0.5rem;
		}
		.status-badge {
			font-size: 0.625rem;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			padding: 0.125rem 0.375rem;
			border-radius: 0.25rem;
			font-weight: 500;
		}
		.status-success { background: #dcfce7; color: #166534; }
		.status-failed { background: #fef2f2; color: #991b1b; }
		.status-timeout { background: #fef9c3; color: #854d0e; }
		.status-disabled { background: #f3f4f6; color: #6b7280; }
		button {
			padding: 0.375rem 0.75rem;
			border: none;
			border-radius: 0.375rem;
			font-size: 0.75rem;
			cursor: pointer;
			font-weight: 500;
		}
		.btn-primary {
			background: var(--primary, #2563eb);
			color: white;
		}
		.btn-secondary {
			background: transparent;
			border: 1px solid var(--border, #e5e7eb);
			color: var(--foreground, #111);
		}
		.btn-danger {
			background: transparent;
			color: var(--destructive, #dc2626);
			border: 1px solid var(--destructive, #dc2626);
		}
		.btn-primary:disabled, .btn-secondary:disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}
		.form-section {
			display: flex;
			flex-direction: column;
			gap: 0.75rem;
			padding: 1rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.5rem;
			background: var(--card, #fff);
		}
		.form-field {
			display: flex;
			flex-direction: column;
			gap: 0.25rem;
		}
		label {
			font-size: 0.75rem;
			font-weight: 500;
			color: var(--muted-foreground, #6b7280);
		}
		input, select, textarea {
			padding: 0.5rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.375rem;
			font-size: 0.875rem;
			background: var(--background, #fff);
			color: var(--foreground, #111);
			font-family: inherit;
		}
		textarea {
			min-height: 100px;
			resize: vertical;
		}
		.form-actions {
			display: flex;
			gap: 0.5rem;
			justify-content: flex-end;
		}
		.status {
			font-size: 0.875rem;
			padding: 0.5rem;
			border-radius: 0.375rem;
			margin-bottom: 0.5rem;
		}
		.status-success-msg { background: #dcfce7; color: #166534; }
		.status-error { background: #fef2f2; color: #991b1b; }
		.empty {
			text-align: center;
			padding: 2rem;
			color: var(--muted-foreground, #6b7280);
			font-size: 0.875rem;
		}
		.modal-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			margin-bottom: 1rem;
		}
		.run-history {
			display: flex;
			flex-direction: column;
			gap: 0.5rem;
			max-height: 400px;
			overflow-y: auto;
		}
		.run-item {
			padding: 0.75rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.375rem;
		}
		.run-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			margin-bottom: 0.5rem;
		}
		.run-output {
			font-size: 0.75rem;
			font-family: monospace;
			background: #f9fafb;
			padding: 0.5rem;
			border-radius: 0.25rem;
			max-height: 200px;
			overflow-y: auto;
			white-space: pre-wrap;
			word-break: break-word;
		}
	`;

	@property({ type: Function })
	getToken: (() => string | null) | undefined;

	@property({ type: String })
	userRole: string = "member";

	@state() private jobs: Job[] = [];
	@state() private skills: Skill[] = [];
	@state() private files: UserFile[] = [];
	@state() private loading = false;
	@state() private showCreateForm = false;
	@state() private editingJob: Job | null = null;
	@state() private viewingRuns: Job | null = null;
	@state() private runs: JobRun[] = [];
	@state() private statusMessage = "";
	@state() private statusType: "success" | "error" = "success";

	// Form state
	@state() private formData = this.getEmptyForm();

	override connectedCallback() {
		super.connectedCallback();
		this.loadJobs();
		this.loadSkills();
		this.loadFiles();
	}

	private getEmptyForm() {
		return {
			name: "",
			description: "",
			cron_expr: "0 9 * * *",
			prompt: "",
			skill_ids: [] as string[],
			file_ids: [] as string[],
			model_id: "",
			provider: "",
			delivery_type: "email" as "email" | "teams",
			delivery_to: "",
			delivery_webhook: "",
			owner_type: "user" as "user" | "team",
		};
	}

	private fetchApi = (url: string, options?: RequestInit) => apiFetch(url, options, this.getToken);

	private async loadJobs() {
		this.loading = true;
		try {
			const result = await this.fetchApi("/api/jobs");
			if (result.success) {
				this.jobs = result.data.jobs;
			}
		} catch (err) {
			console.error("Failed to load jobs:", err);
		} finally {
			this.loading = false;
		}
	}

	private async loadSkills() {
		try {
			const result = await this.fetchApi("/api/skills");
			if (result.success) {
				this.skills = result.data.skills;
			}
		} catch (err) {
			console.error("Failed to load skills:", err);
		}
	}

	private async loadFiles() {
		try {
			const result = await this.fetchApi("/api/files");
			if (result.success) {
				this.files = result.data.files;
			}
		} catch (err) {
			console.error("Failed to load files:", err);
		}
	}

	private async handleCreateJob() {
		try {
			const delivery =
				this.formData.delivery_type === "email"
					? { type: "email", to: this.formData.delivery_to }
					: { type: "teams", webhook: this.formData.delivery_webhook };

			const payload = {
				owner_type: this.formData.owner_type,
				name: this.formData.name,
				description: this.formData.description || null,
				cron_expr: this.formData.cron_expr,
				prompt: this.formData.prompt,
				skill_ids: this.formData.skill_ids.length > 0 ? this.formData.skill_ids : null,
				file_ids: this.formData.file_ids.length > 0 ? this.formData.file_ids : null,
				model_id: this.formData.model_id || null,
				provider: this.formData.provider || null,
				delivery,
			};

			const result = await this.fetchApi("/api/jobs", {
				method: "POST",
				body: JSON.stringify(payload),
			});

			if (result.success) {
				this.statusMessage = `Job "${result.data.job.name}" created.`;
				this.statusType = "success";
				this.showCreateForm = false;
				this.formData = this.getEmptyForm();
				await this.loadJobs();
			} else {
				this.statusMessage = result.error || "Failed to create job";
				this.statusType = "error";
			}
		} catch (err: any) {
			this.statusMessage = err.message || "Network error";
			this.statusType = "error";
		}
	}

	private async handleUpdateJob() {
		if (!this.editingJob) return;

		try {
			const delivery =
				this.formData.delivery_type === "email"
					? { type: "email", to: this.formData.delivery_to }
					: { type: "teams", webhook: this.formData.delivery_webhook };

			const payload = {
				name: this.formData.name,
				description: this.formData.description || null,
				cron_expr: this.formData.cron_expr,
				prompt: this.formData.prompt,
				skill_ids: this.formData.skill_ids.length > 0 ? this.formData.skill_ids : null,
				file_ids: this.formData.file_ids.length > 0 ? this.formData.file_ids : null,
				model_id: this.formData.model_id || null,
				provider: this.formData.provider || null,
				delivery,
			};

			const result = await this.fetchApi(`/api/jobs/${this.editingJob.id}`, {
				method: "PATCH",
				body: JSON.stringify(payload),
			});

			if (result.success) {
				this.statusMessage = `Job "${result.data.job.name}" updated.`;
				this.statusType = "success";
				this.editingJob = null;
				this.formData = this.getEmptyForm();
				await this.loadJobs();
			} else {
				this.statusMessage = result.error || "Failed to update job";
				this.statusType = "error";
			}
		} catch (err: any) {
			this.statusMessage = err.message || "Network error";
			this.statusType = "error";
		}
	}

	private async handleDeleteJob(job: Job) {
		if (!confirm(`Delete job "${job.name}"?`)) return;

		try {
			const result = await this.fetchApi(`/api/jobs/${job.id}`, { method: "DELETE" });
			if (result.success) {
				this.statusMessage = `Job "${job.name}" deleted.`;
				this.statusType = "success";
				await this.loadJobs();
			} else {
				this.statusMessage = result.error || "Delete failed";
				this.statusType = "error";
			}
		} catch {
			this.statusMessage = "Network error";
			this.statusType = "error";
		}
	}

	private async handleToggleEnabled(job: Job) {
		try {
			const result = await this.fetchApi(`/api/jobs/${job.id}`, {
				method: "PATCH",
				body: JSON.stringify({ enabled: !job.enabled }),
			});

			if (result.success) {
				this.statusMessage = `Job "${job.name}" ${!job.enabled ? "enabled" : "disabled"}.`;
				this.statusType = "success";
				await this.loadJobs();
			} else {
				this.statusMessage = result.error || "Update failed";
				this.statusType = "error";
			}
		} catch {
			this.statusMessage = "Network error";
			this.statusType = "error";
		}
	}

	private async handleTriggerJob(job: Job) {
		if (!confirm(`Manually trigger job "${job.name}" now?`)) return;

		try {
			const result = await this.fetchApi(`/api/jobs/${job.id}/trigger`, { method: "POST" });
			if (result.success) {
				this.statusMessage = `Job "${job.name}" triggered. Check run history in a moment.`;
				this.statusType = "success";
			} else {
				this.statusMessage = result.error || "Trigger failed";
				this.statusType = "error";
			}
		} catch {
			this.statusMessage = "Network error";
			this.statusType = "error";
		}
	}

	private async handleViewRuns(job: Job) {
		this.viewingRuns = job;
		try {
			const result = await this.fetchApi(`/api/jobs/${job.id}/runs`);
			if (result.success) {
				this.runs = result.data.runs;
			}
		} catch (err) {
			console.error("Failed to load runs:", err);
		}
	}

	private openEditForm(job: Job) {
		this.editingJob = job;
		this.formData = {
			name: job.name,
			description: job.description || "",
			cron_expr: job.cron_expr,
			prompt: job.prompt,
			skill_ids: job.skill_ids || [],
			file_ids: job.file_ids || [],
			model_id: job.model_id || "",
			provider: job.provider || "",
			delivery_type: job.delivery.type,
			delivery_to: job.delivery.type === "email" ? job.delivery.to : "",
			delivery_webhook: job.delivery.type === "teams" ? job.delivery.webhook : "",
			owner_type: job.owner_type as "user" | "team",
		};
	}

	private renderJobList() {
		if (this.loading) {
			return html`<div class="empty">Loading...</div>`;
		}

		if (this.jobs.length === 0) {
			return html`<div class="empty">
				<div style="font-size: 1.5rem; margin-bottom: 0.5rem;">📅</div>
				<div style="font-weight: 600; margin-bottom: 0.25rem;">No scheduled jobs yet</div>
				<div>Schedule recurring AI tasks that run automatically and deliver results via email or Teams. Great for daily reports, data monitoring, and routine analyses.</div>
			</div>`;
		}

		return html`
			<div class="job-list">
				${this.jobs.map(
					(job) => html`
						<div class="job-item">
							<div class="job-info">
								<div class="job-name">
									${job.name}
									${!job.enabled ? html`<span class="status-badge status-disabled">Disabled</span>` : ""}
									${job.last_status
										? html`<span class="status-badge status-${job.last_status}">${job.last_status}</span>`
										: ""}
								</div>
								<div class="job-prompt-preview" title=${job.prompt}>${job.prompt}</div>
								<div class="job-details">
									${job.cron_expr} • Next: ${new Date(job.next_run_at).toLocaleString()}
								</div>
								${job.last_error ? html`<div class="job-details" style="color: #dc2626;">${job.last_error}</div>` : ""}
							</div>
							<div class="job-actions">
								<button class="btn-secondary" @click=${() => this.handleViewRuns(job)}>History</button>
								<button class="btn-secondary" @click=${() => this.handleTriggerJob(job)}>Trigger</button>
								<button class="btn-secondary" @click=${() => this.handleToggleEnabled(job)}>
									${job.enabled ? "Disable" : "Enable"}
								</button>
								<button class="btn-secondary" @click=${() => this.openEditForm(job)}>Edit</button>
								<button class="btn-danger" @click=${() => this.handleDeleteJob(job)}>Delete</button>
							</div>
						</div>
					`,
				)}
			</div>
		`;
	}

	private renderJobForm() {
		const isEdit = !!this.editingJob;
		const isAdmin = this.userRole === "admin";

		return html`
			<div class="form-section">
				<div class="modal-header">
					<h3>${isEdit ? "Edit Job" : "Create New Job"}</h3>
					<button class="btn-secondary" @click=${() => {
						this.showCreateForm = false;
						this.editingJob = null;
						this.formData = this.getEmptyForm();
					}}>✕</button>
				</div>

				<div class="form-field">
					<label>Name *</label>
					<input
						type="text"
						.value=${this.formData.name}
						@input=${(e: Event) => (this.formData.name = (e.target as HTMLInputElement).value)}
						placeholder="Daily report"
					/>
				</div>

				<div class="form-field">
					<label>Description</label>
					<input
						type="text"
						.value=${this.formData.description}
						@input=${(e: Event) => (this.formData.description = (e.target as HTMLInputElement).value)}
						placeholder="Optional description"
					/>
				</div>

				<div class="form-field">
					<label>Schedule *</label>
					<cron-builder
						.value=${this.formData.cron_expr}
						@cron-change=${(e: CustomEvent) => { this.formData.cron_expr = e.detail.value; }}
					></cron-builder>
				</div>

				<div class="form-field">
					<label>Prompt *</label>
					<textarea
						.value=${this.formData.prompt}
						@input=${(e: Event) => (this.formData.prompt = (e.target as HTMLTextAreaElement).value)}
						placeholder="What should the AI do?"
					></textarea>
				</div>

				${isAdmin && !isEdit
					? html`
							<div class="form-field">
								<label>Scope</label>
								<select
									.value=${this.formData.owner_type}
									@change=${(e: Event) =>
										(this.formData.owner_type = (e.target as HTMLSelectElement).value as "user" | "team")}
								>
									<option value="user">My Jobs</option>
									<option value="team">Team Jobs</option>
								</select>
							</div>
						`
					: ""}

				<div class="form-field">
					<label>Skills (optional)</label>
					<select
						multiple
						size="4"
						@change=${(e: Event) => {
							const select = e.target as HTMLSelectElement;
							this.formData.skill_ids = Array.from(select.selectedOptions).map((o) => o.value);
						}}
					>
						${this.skills.map(
							(skill) => html`
								<option value=${skill.id} ?selected=${this.formData.skill_ids.includes(skill.id)}>
									${skill.name} (${skill.scope})
								</option>
							`,
						)}
					</select>
				</div>

				<div class="form-field">
					<label>Files (optional)</label>
					<select
						multiple
						size="4"
						@change=${(e: Event) => {
							const select = e.target as HTMLSelectElement;
							this.formData.file_ids = Array.from(select.selectedOptions).map((o) => o.value);
						}}
					>
						${this.files.map(
							(file) => html`
								<option value=${file.id} ?selected=${this.formData.file_ids.includes(file.id)}>${file.filename}</option>
							`,
						)}
					</select>
				</div>

				<div class="form-field">
					<label>Delivery Method *</label>
					<select
						.value=${this.formData.delivery_type}
						@change=${(e: Event) =>
							(this.formData.delivery_type = (e.target as HTMLSelectElement).value as "email" | "teams")}
					>
						<option value="email">Email</option>
						<option value="teams">Microsoft Teams</option>
					</select>
				</div>

				${this.formData.delivery_type === "email"
					? html`
							<div class="form-field">
								<label>Email Address *</label>
								<input
									type="email"
									.value=${this.formData.delivery_to}
									@input=${(e: Event) => (this.formData.delivery_to = (e.target as HTMLInputElement).value)}
									placeholder="you@example.com"
								/>
							</div>
						`
					: html`
							<div class="form-field">
								<label>Teams Webhook URL *</label>
								<input
									type="url"
									.value=${this.formData.delivery_webhook}
									@input=${(e: Event) => (this.formData.delivery_webhook = (e.target as HTMLInputElement).value)}
									placeholder="https://..."
								/>
							</div>
						`}

				<div class="form-actions">
					<button class="btn-secondary" @click=${() => {
						this.showCreateForm = false;
						this.editingJob = null;
						this.formData = this.getEmptyForm();
					}}>Cancel</button>
					<button
						class="btn-primary"
						@click=${isEdit ? () => this.handleUpdateJob() : () => this.handleCreateJob()}
						?disabled=${!this.formData.name || !this.formData.cron_expr || !this.formData.prompt}
					>
						${isEdit ? "Update" : "Create"}
					</button>
				</div>
			</div>
		`;
	}

	private renderRunHistory() {
		if (!this.viewingRuns) return "";

		return html`
			<div class="form-section">
				<div class="modal-header">
					<h3>Run History: ${this.viewingRuns.name}</h3>
					<button class="btn-secondary" @click=${() => (this.viewingRuns = null)}>✕</button>
				</div>

				${this.runs.length === 0
					? html`<div class="empty">No runs yet.</div>`
					: html`
							<div class="run-history">
								${this.runs.map(
									(run) => html`
										<div class="run-item">
											<div class="run-header">
												<span>${new Date(run.started_at).toLocaleString()}</span>
												<span class="status-badge status-${run.status}">${run.status}</span>
											</div>
											${run.error
												? html`<div class="run-output" style="color: #dc2626;">${run.error}</div>`
												: run.result?.output
													? html`<div class="run-output">${run.result.output}</div>`
													: ""}
											${run.delivery_status
												? html`<div class="job-details">Delivery: ${run.delivery_status}</div>`
												: ""}
										</div>
									`,
								)}
							</div>
						`}
			</div>
		`;
	}

	override render() {
		return html`
			<div class="container">
				${this.statusMessage
					? html`
							<div class="status status-${this.statusType === "success" ? "success-msg" : "error"}">
								${this.statusMessage}
							</div>
						`
					: ""}

				${this.viewingRuns
					? this.renderRunHistory()
					: this.showCreateForm || this.editingJob
						? this.renderJobForm()
						: html`
								<div>
									<button class="btn-primary" @click=${() => (this.showCreateForm = true)} style="margin-bottom: 1rem;">
										Create New Job
									</button>
								</div>
								${this.renderJobList()}
							`}
			</div>
		`;
	}
}
