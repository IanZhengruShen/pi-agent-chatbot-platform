/**
 * Tasks Dashboard: submit and monitor background tasks.
 *
 * Features:
 * - List tasks with status filters
 * - Submit new tasks with optional skills/files
 * - Real-time progress via SSE
 * - Download artifacts
 * - Re-run and cancel tasks
 */

import { apiFetch } from "../shared/api.js";
import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";

interface Task {
	id: string;
	prompt: string;
	status: string;
	progress: { percent?: number; message?: string };
	output: string | null;
	error: string | null;
	usage: any | null;
	skill_ids: string[] | null;
	file_ids: string[] | null;
	model_id: string | null;
	provider: string | null;
	parent_task_id: string | null;
	created_at: string;
	started_at: string | null;
	finished_at: string | null;
}

interface TaskArtifact {
	id: string;
	task_id: string;
	filename: string;
	content_type: string | null;
	size_bytes: number | null;
}

type Skill = Pick<import("../studio/types.js").SkillInfo, "id" | "name" | "scope">;
type UserFile = Pick<import("../studio/types.js").FileInfo, "id" | "filename">;

@customElement("tasks-dashboard")
export class TasksDashboard extends LitElement {
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
		.header {
			display: flex;
			justify-content: space-between;
			align-items: center;
		}
		.filters {
			display: flex;
			gap: 0.25rem;
		}
		.filter-btn {
			padding: 0.25rem 0.5rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.25rem;
			font-size: 0.75rem;
			cursor: pointer;
			background: transparent;
			color: var(--foreground, #111);
		}
		.filter-btn.active {
			background: var(--primary, #2563eb);
			color: white;
			border-color: var(--primary, #2563eb);
		}
		.task-list {
			display: flex;
			flex-direction: column;
			gap: 0.5rem;
		}
		.task-item {
			padding: 0.75rem 1rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.5rem;
			background: var(--card, #fff);
		}
		.task-header {
			display: flex;
			justify-content: space-between;
			align-items: flex-start;
			gap: 0.5rem;
		}
		.task-prompt {
			font-size: 0.875rem;
			font-weight: 500;
			flex: 1;
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			cursor: default;
		}
		.task-item.expanded .task-prompt {
			white-space: normal;
			overflow: visible;
			text-overflow: unset;
		}
		.task-meta {
			display: flex;
			align-items: center;
			gap: 0.5rem;
			font-size: 0.75rem;
			color: var(--muted-foreground, #6b7280);
			margin-top: 0.25rem;
		}
		.status-badge {
			font-size: 0.625rem;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			padding: 0.125rem 0.375rem;
			border-radius: 0.25rem;
			font-weight: 500;
			white-space: nowrap;
		}
		.status-pending { background: #f3f4f6; color: #6b7280; }
		.status-claimed { background: #dbeafe; color: #1e40af; }
		.status-running { background: #dbeafe; color: #1e40af; }
		.status-success { background: #dcfce7; color: #166534; }
		.status-failed { background: #fef2f2; color: #991b1b; }
		.status-cancelled { background: #f3f4f6; color: #6b7280; }
		.status-timeout { background: #fef9c3; color: #854d0e; }
		.progress-bar {
			width: 100%;
			height: 4px;
			background: var(--border, #e5e7eb);
			border-radius: 2px;
			margin-top: 0.5rem;
			overflow: hidden;
		}
		.progress-fill {
			height: 100%;
			background: var(--primary, #2563eb);
			border-radius: 2px;
			transition: width 0.3s ease;
		}
		.progress-fill.indeterminate {
			width: 30%;
			animation: indeterminate 1.5s ease-in-out infinite;
		}
		@keyframes indeterminate {
			0% { margin-left: 0; }
			50% { margin-left: 70%; }
			100% { margin-left: 0; }
		}
		.progress-message {
			font-size: 0.75rem;
			color: var(--muted-foreground, #6b7280);
			margin-top: 0.25rem;
			font-style: italic;
		}
		.task-actions {
			display: flex;
			gap: 0.5rem;
			margin-top: 0.5rem;
		}
		.artifacts {
			display: flex;
			flex-wrap: wrap;
			gap: 0.25rem;
			margin-top: 0.5rem;
		}
		.artifact-chip {
			display: inline-flex;
			align-items: center;
			padding: 0.125rem 0.5rem;
			background: var(--muted, #f3f4f6);
			border-radius: 0.25rem;
			font-size: 0.75rem;
			color: var(--primary, #2563eb);
			text-decoration: none;
			cursor: pointer;
		}
		.artifact-chip:hover {
			background: var(--border, #e5e7eb);
		}
		.usage-info {
			font-size: 0.75rem;
			color: var(--muted-foreground, #6b7280);
		}
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
		.btn-primary:disabled {
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
		.modal-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
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
		.task-output {
			font-size: 0.75rem;
			font-family: monospace;
			background: #f9fafb;
			padding: 0.5rem;
			border-radius: 0.25rem;
			max-height: 200px;
			overflow-y: auto;
			white-space: pre-wrap;
			word-break: break-word;
			margin-top: 0.5rem;
		}
	`;

	@property({ type: Function })
	getToken: (() => string | null) | undefined;

	@property({ type: String })
	userRole: string = "member";

	@state() private tasks: Task[] = [];
	@state() private taskArtifacts = new Map<string, TaskArtifact[]>();
	@state() private skills: Skill[] = [];
	@state() private files: UserFile[] = [];
	@state() private loading = false;
	@state() private showCreateForm = false;
	@state() private expandedTaskId: string | null = null;
	@state() private statusFilter = "all";
	@state() private statusMessage = "";
	@state() private statusType: "success" | "error" = "success";

	// SSE connections
	private eventSources = new Map<string, EventSource>();

	// Form state
	@state() private formData = {
		prompt: "",
		skill_ids: [] as string[],
		file_ids: [] as string[],
	};

	override connectedCallback() {
		super.connectedCallback();
		this.loadTasks();
		this.loadSkills();
		this.loadFiles();
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		// Close all SSE connections
		for (const [, es] of this.eventSources) {
			es.close();
		}
		this.eventSources.clear();
	}

	private fetchApi = (url: string, options?: RequestInit) => apiFetch(url, options, this.getToken);

	private async loadTasks() {
		this.loading = true;
		try {
			const statusParam = this.statusFilter !== "all" ? `?status=${this.statusFilter}` : "";
			const result = await this.fetchApi(`/api/tasks${statusParam}`);
			if (result.success) {
				this.tasks = result.data.tasks;
				// Connect SSE for active tasks
				for (const task of this.tasks) {
					if (task.status === "pending" || task.status === "claimed" || task.status === "running") {
						this.connectSse(task.id);
					}
				}
			}
		} catch (err) {
			console.error("Failed to load tasks:", err);
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
		} catch {}
	}

	private async loadFiles() {
		try {
			const result = await this.fetchApi("/api/files");
			if (result.success) {
				this.files = result.data.files;
			}
		} catch {}
	}

	private async connectSse(taskId: string) {
		if (this.eventSources.has(taskId)) return;

		const token = this.getToken?.();
		if (!token) return;

		// Obtain a single-use SSE ticket instead of sending the JWT directly
		let ticket: string;
		try {
			const res = await fetch("/api/auth/sse-ticket", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
				},
			});
			const data = await res.json();
			if (!data.success || !data.data?.ticket) return;
			ticket = data.data.ticket;
		} catch {
			return;
		}

		const es = new EventSource(`/api/tasks/${taskId}/events?ticket=${encodeURIComponent(ticket)}`);
		this.eventSources.set(taskId, es);

		es.addEventListener("progress", (e) => {
			const data = JSON.parse((e as MessageEvent).data);
			this.updateTaskInList(taskId, {
				status: "running",
				progress: data,
			});
		});

		es.addEventListener("output", (e) => {
			const data = JSON.parse((e as MessageEvent).data);
			// output events send the full current text (replaces previous value)
			this.updateTaskInList(taskId, {
				output: data.text || "",
			});
		});

		es.addEventListener("complete", (e) => {
			const data = JSON.parse((e as MessageEvent).data);
			this.updateTaskInList(taskId, {
				status: "success",
				output: data.output,
				usage: data.usage,
			});
			if (data.artifacts) {
				this.taskArtifacts.set(taskId, data.artifacts);
				this.requestUpdate();
			}
			this.disconnectSse(taskId);
		});

		es.addEventListener("task_error", (e) => {
			const data = JSON.parse((e as MessageEvent).data);
			this.updateTaskInList(taskId, {
				status: data.status || "failed",
				error: data.error,
			});
			this.disconnectSse(taskId);
		});

		es.addEventListener("cancelled", () => {
			this.updateTaskInList(taskId, { status: "cancelled" });
			this.disconnectSse(taskId);
		});

		es.onerror = () => {
			// EventSource will auto-reconnect; close if task is terminal
			const task = this.tasks.find((t) => t.id === taskId);
			if (task && ["success", "failed", "cancelled", "timeout"].includes(task.status)) {
				this.disconnectSse(taskId);
			}
		};
	}

	private disconnectSse(taskId: string) {
		const es = this.eventSources.get(taskId);
		if (es) {
			es.close();
			this.eventSources.delete(taskId);
		}
	}

	private updateTaskInList(taskId: string, updates: Partial<Task>) {
		this.tasks = this.tasks.map((t) =>
			t.id === taskId ? { ...t, ...updates } : t,
		);
	}

	private async handleSubmitTask() {
		if (!this.formData.prompt.trim()) return;

		try {
			const result = await this.fetchApi("/api/tasks", {
				method: "POST",
				body: JSON.stringify({
					prompt: this.formData.prompt,
					skill_ids: this.formData.skill_ids.length > 0 ? this.formData.skill_ids : undefined,
					file_ids: this.formData.file_ids.length > 0 ? this.formData.file_ids : undefined,
				}),
			});

			if (result.success) {
				this.statusMessage = "Task submitted.";
				this.statusType = "success";
				this.showCreateForm = false;
				this.formData = { prompt: "", skill_ids: [], file_ids: [] };
				// Add to list and connect SSE
				this.tasks = [result.data.task, ...this.tasks];
				this.connectSse(result.data.task.id);
			} else {
				this.statusMessage = result.error || "Failed to submit task";
				this.statusType = "error";
			}
		} catch (err: any) {
			this.statusMessage = err.message || "Network error";
			this.statusType = "error";
		}
	}

	private async handleCancel(task: Task) {
		try {
			const result = await this.fetchApi(`/api/tasks/${task.id}`, { method: "DELETE" });
			if (result.success) {
				if (result.data.action === "cancelled") {
					this.updateTaskInList(task.id, { status: "cancelled" });
				} else {
					this.tasks = this.tasks.filter((t) => t.id !== task.id);
				}
				this.statusMessage = result.data.action === "cancelled" ? "Task cancelled." : "Task deleted.";
				this.statusType = "success";
			}
		} catch {
			this.statusMessage = "Network error";
			this.statusType = "error";
		}
	}

	private async handleRerun(task: Task) {
		try {
			const result = await this.fetchApi(`/api/tasks/${task.id}/rerun`, { method: "POST" });
			if (result.success) {
				this.tasks = [result.data.task, ...this.tasks];
				this.connectSse(result.data.task.id);
				this.statusMessage = "Task re-submitted.";
				this.statusType = "success";
			}
		} catch {
			this.statusMessage = "Network error";
			this.statusType = "error";
		}
	}

	private async handleExpandTask(task: Task) {
		if (this.expandedTaskId === task.id) {
			this.expandedTaskId = null;
			return;
		}

		this.expandedTaskId = task.id;

		// Load artifacts if not already loaded
		if (!this.taskArtifacts.has(task.id)) {
			try {
				const result = await this.fetchApi(`/api/tasks/${task.id}`);
				if (result.success && result.data.artifacts) {
					this.taskArtifacts.set(task.id, result.data.artifacts);
					this.requestUpdate();
				}
			} catch {}
		}
	}

	private formatTime(dateStr: string | null): string {
		if (!dateStr) return "";
		const d = new Date(dateStr);
		const diff = Date.now() - d.getTime();
		if (diff < 60_000) return "just now";
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
		return d.toLocaleDateString();
	}

	private formatBytes(bytes: number | null): string {
		if (!bytes) return "";
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	private renderFilters() {
		const filters = [
			{ value: "all", label: "All" },
			{ value: "running,pending,claimed", label: "Running" },
			{ value: "success", label: "Completed" },
			{ value: "failed,timeout", label: "Failed" },
		];

		return html`
			<div class="filters">
				${filters.map(
					(f) => html`
						<button
							class="filter-btn ${this.statusFilter === f.value ? "active" : ""}"
							@click=${() => { this.statusFilter = f.value; this.loadTasks(); }}
						>${f.label}</button>
					`,
				)}
			</div>
		`;
	}

	private renderTaskList() {
		if (this.loading) {
			return html`<div class="empty">Loading...</div>`;
		}

		if (this.tasks.length === 0) {
			return html`<div class="empty">
				<div style="font-size: 1.5rem; margin-bottom: 0.5rem;">🤖</div>
				<div style="font-weight: 600; margin-bottom: 0.25rem;">No background tasks yet</div>
				<div>Background tasks let the AI work on longer jobs while you do other things. Results are saved and can include file attachments.</div>
			</div>`;
		}

		return html`
			<div class="task-list">
				${this.tasks.map((task) => this.renderTaskItem(task))}
			</div>
		`;
	}

	private async downloadArtifact(taskId: string, artifactId: string, filename: string) {
		const token = this.getToken?.();
		if (!token) return;
		try {
			const res = await fetch(`/api/tasks/${taskId}/artifacts/${artifactId}`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			if (!res.ok) return;
			const blob = await res.blob();
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = filename;
			a.click();
			URL.revokeObjectURL(url);
		} catch {
			this.statusMessage = "Download failed";
			this.statusType = "error";
		}
	}

	private renderTaskItem(task: Task) {
		const isActive = task.status === "pending" || task.status === "claimed" || task.status === "running";
		const isExpanded = this.expandedTaskId === task.id;
		const artifacts = this.taskArtifacts.get(task.id) || [];

		return html`
			<div class="task-item ${isExpanded ? "expanded" : ""}" @click=${() => this.handleExpandTask(task)}>
				<div class="task-header">
					<span class="task-prompt" title=${task.prompt}>${task.prompt}</span>
					<span class="status-badge status-${task.status}">${task.status}</span>
				</div>

				<div class="task-meta">
					<span>${this.formatTime(task.created_at)}</span>
					${task.usage ? html`<span class="usage-info">${task.usage.input + task.usage.output} tokens</span>` : ""}
					${artifacts.length > 0 ? html`<span>${artifacts.length} artifact${artifacts.length > 1 ? "s" : ""}</span>` : ""}
				</div>

				${isActive ? html`
					<div class="progress-bar">
						${task.progress?.percent !== undefined
							? html`<div class="progress-fill" style="width: ${task.progress.percent}%"></div>`
							: html`<div class="progress-fill indeterminate"></div>`}
					</div>
				` : ""}
				${isActive && task.progress?.message ? html`
					<div class="progress-message">${task.progress.message}</div>
				` : ""}

				${isExpanded ? html`
					${task.output ? html`<div class="task-output">${task.output}</div>` : ""}
					${task.error ? html`<div class="task-output" style="color: #dc2626;">${task.error}</div>` : ""}

					${artifacts.length > 0 ? html`
						<div class="artifacts">
							${artifacts.map(
								(a) => html`
									<span
										class="artifact-chip"
										@click=${(e: Event) => { e.stopPropagation(); this.downloadArtifact(task.id, a.id, a.filename); }}
									>
										${a.filename}${a.size_bytes ? ` (${this.formatBytes(a.size_bytes)})` : ""}
									</span>
								`,
							)}
						</div>
					` : ""}

					<div class="task-actions" @click=${(e: Event) => e.stopPropagation()}>
						${isActive
							? html`<button class="btn-danger" @click=${() => this.handleCancel(task)}>Cancel</button>`
							: html`
								<button class="btn-secondary" @click=${() => this.handleRerun(task)}>Re-run</button>
								<button class="btn-danger" @click=${() => this.handleCancel(task)}>Delete</button>
							`}
					</div>
				` : ""}
			</div>
		`;
	}

	private readonly taskTemplates = [
		"Summarize key points from this document",
		"Generate a weekly status report",
		"Analyze this spreadsheet",
		"Convert meeting notes into action items",
	];

	private renderCreateForm() {
		return html`
			<div class="form-section">
				<div class="modal-header">
					<h3>New Background Task</h3>
					<button class="btn-secondary" @click=${() => (this.showCreateForm = false)}>&#10005;</button>
				</div>

				<div class="form-field">
					<label>Prompt *</label>
					${!this.formData.prompt ? html`
						<div style="display: flex; flex-wrap: wrap; gap: 0.25rem; margin-bottom: 0.5rem;">
							${this.taskTemplates.map(t => html`
								<span
									style="padding: 0.25rem 0.5rem; border: 1px solid var(--border, #e5e7eb); border-radius: 1rem; font-size: 0.75rem; cursor: pointer; background: var(--background, #fff); color: var(--foreground, #111); transition: background 0.15s;"
									@click=${() => { this.formData = { ...this.formData, prompt: t }; }}
									@mouseenter=${(e: Event) => (e.target as HTMLElement).style.background = "var(--muted, #f3f4f6)"}
									@mouseleave=${(e: Event) => (e.target as HTMLElement).style.background = "var(--background, #fff)"}
								>${t}</span>
							`)}
						</div>
					` : ""}
					<textarea
						.value=${this.formData.prompt}
						@input=${(e: Event) => (this.formData = { ...this.formData, prompt: (e.target as HTMLTextAreaElement).value })}
						placeholder="What should the AI do?"
					></textarea>
				</div>

				${this.skills.length > 0 ? html`
					<div class="form-field">
						<label>Skills (optional)</label>
						<select
							multiple
							size="3"
							@change=${(e: Event) => {
								const select = e.target as HTMLSelectElement;
								this.formData = {
									...this.formData,
									skill_ids: Array.from(select.selectedOptions).map((o) => o.value),
								};
							}}
						>
							${this.skills.map(
								(s) => html`<option value=${s.id}>${s.name} (${s.scope})</option>`,
							)}
						</select>
					</div>
				` : ""}

				${this.files.length > 0 ? html`
					<div class="form-field">
						<label>Files (optional)</label>
						<select
							multiple
							size="3"
							@change=${(e: Event) => {
								const select = e.target as HTMLSelectElement;
								this.formData = {
									...this.formData,
									file_ids: Array.from(select.selectedOptions).map((o) => o.value),
								};
							}}
						>
							${this.files.map(
								(f) => html`<option value=${f.id}>${f.filename}</option>`,
							)}
						</select>
					</div>
				` : ""}

				<div class="form-actions">
					<button class="btn-secondary" @click=${() => (this.showCreateForm = false)}>Cancel</button>
					<button
						class="btn-primary"
						@click=${() => this.handleSubmitTask()}
						?disabled=${!this.formData.prompt.trim()}
					>Submit Task</button>
				</div>
			</div>
		`;
	}

	override render() {
		return html`
			<div class="container">
				${this.statusMessage ? html`
					<div class="status status-${this.statusType === "success" ? "success-msg" : "error"}">
						${this.statusMessage}
					</div>
				` : ""}

				${this.showCreateForm
					? this.renderCreateForm()
					: html`
						<div class="header">
							${this.renderFilters()}
							<button class="btn-primary" @click=${() => (this.showCreateForm = true)}>+ New Task</button>
						</div>
						${this.renderTaskList()}
					`}
			</div>
		`;
	}
}
