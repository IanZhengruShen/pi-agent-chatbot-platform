/**
 * Memory Management Panel.
 *
 * Lists, creates, edits, and deletes persistent user memories.
 * Memories are automatically injected into agent sessions.
 */

import { apiFetch } from "../shared/api.js";
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

interface MemoryInfo {
	id: string;
	content: string;
	category: string;
	source: string;
	pinned: boolean;
	created_at: string;
	updated_at: string;
}

const CATEGORY_LABELS: Record<string, string> = {
	preference: "Preference",
	fact: "Fact",
	instruction: "Instruction",
	general: "General",
};

const CATEGORY_COLORS: Record<string, string> = {
	preference: "#8b5cf6",
	fact: "#3b82f6",
	instruction: "#f59e0b",
	general: "#6b7280",
};

@customElement("memory-panel")
export class MemoryPanel extends LitElement {
	static override styles = css`
		:host {
			display: block;
			padding: 1rem;
		}
		.memory-list {
			display: flex;
			flex-direction: column;
			gap: 0.5rem;
			margin-bottom: 1rem;
			max-height: 400px;
			overflow-y: auto;
		}
		.memory-item {
			display: flex;
			flex-direction: column;
			gap: 0.375rem;
			padding: 0.75rem 1rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.5rem;
			background: var(--card, #fff);
		}
		.memory-item:hover {
			border-color: var(--primary, #2563eb);
		}
		.memory-header {
			display: flex;
			align-items: center;
			gap: 0.5rem;
			flex-wrap: wrap;
		}
		.memory-content {
			font-size: 0.875rem;
			line-height: 1.4;
			color: var(--foreground, #111);
			word-break: break-word;
		}
		.memory-content.editing {
			display: none;
		}
		.badge {
			font-size: 0.625rem;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			padding: 0.125rem 0.375rem;
			border-radius: 0.25rem;
			font-weight: 600;
		}
		.badge-category {
			color: white;
		}
		.badge-source {
			background: var(--muted, #f3f4f6);
			color: var(--muted-foreground, #6b7280);
		}
		.badge-pinned {
			background: #fef3c7;
			color: #92400e;
		}
		.memory-actions {
			display: flex;
			gap: 0.25rem;
			margin-left: auto;
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
		textarea {
			padding: 0.5rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.375rem;
			font-size: 0.875rem;
			font-family: inherit;
			background: var(--background, #fff);
			color: var(--foreground, #111);
			resize: vertical;
			min-height: 60px;
		}
		select, input[type="text"] {
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
		.btn-ghost {
			background: transparent;
			color: var(--muted-foreground, #6b7280);
			padding: 0.25rem 0.5rem;
			font-size: 0.75rem;
		}
		.btn-ghost:hover {
			background: var(--muted, #f3f4f6);
			color: var(--foreground, #111);
		}
		.btn-danger {
			background: transparent;
			color: var(--destructive, #dc2626);
			padding: 0.25rem 0.5rem;
			font-size: 0.75rem;
		}
		.btn-danger:hover {
			background: var(--destructive, #dc2626);
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
		.search-bar {
			display: flex;
			gap: 0.5rem;
			margin-bottom: 1rem;
		}
		.search-bar input {
			flex: 1;
		}
		.search-bar select {
			width: auto;
		}
		.edit-area {
			width: 100%;
			margin-top: 0.25rem;
		}
		.edit-actions {
			display: flex;
			gap: 0.25rem;
			margin-top: 0.25rem;
		}
		h3 { margin: 0 0 1rem 0; font-size: 1rem; font-weight: 600; }
	`;

	@property({ type: Function })
	getToken: (() => string | null) | undefined;

	@state() private memories: MemoryInfo[] = [];
	@state() private loading = false;
	@state() private statusMessage = "";
	@state() private statusType: "success" | "error" = "success";
	@state() private searchQuery = "";
	@state() private filterCategory = "";
	@state() private newContent = "";
	@state() private newCategory = "general";
	@state() private editingId: string | null = null;
	@state() private editContent = "";
	@state() private total = 0;

	override connectedCallback() {
		super.connectedCallback();
		this.loadMemories();
	}

	private fetchApi = (url: string, options?: RequestInit) => apiFetch(url, options, this.getToken);

	private async loadMemories() {
		this.loading = true;
		try {
			const params = new URLSearchParams();
			if (this.searchQuery) params.set("q", this.searchQuery);
			if (this.filterCategory) params.set("category", this.filterCategory);
			params.set("limit", "200");

			const result = await this.fetchApi(`/api/memory?${params}`);
			if (result.success) {
				this.memories = result.data.memories;
				this.total = result.data.total;
			}
		} catch (err) {
			console.error("Failed to load memories:", err);
		} finally {
			this.loading = false;
		}
	}

	private async handleAdd() {
		if (!this.newContent.trim()) return;

		this.statusMessage = "";
		try {
			const result = await this.fetchApi("/api/memory", {
				method: "POST",
				body: JSON.stringify({
					content: this.newContent.trim(),
					category: this.newCategory,
				}),
			});

			if (result.success) {
				this.statusMessage = "Memory saved.";
				this.statusType = "success";
				this.newContent = "";
				await this.loadMemories();
			} else {
				this.statusMessage = result.error || "Failed to save";
				this.statusType = "error";
			}
		} catch {
			this.statusMessage = "Network error";
			this.statusType = "error";
		}
	}

	private startEdit(memory: MemoryInfo) {
		this.editingId = memory.id;
		this.editContent = memory.content;
	}

	private cancelEdit() {
		this.editingId = null;
		this.editContent = "";
	}

	private async saveEdit(memoryId: string) {
		if (!this.editContent.trim()) return;

		try {
			const result = await this.fetchApi(`/api/memory/${memoryId}`, {
				method: "PUT",
				body: JSON.stringify({ content: this.editContent.trim() }),
			});

			if (result.success) {
				this.editingId = null;
				this.editContent = "";
				await this.loadMemories();
			} else {
				this.statusMessage = result.error || "Failed to update";
				this.statusType = "error";
			}
		} catch {
			this.statusMessage = "Network error";
			this.statusType = "error";
		}
	}

	private async togglePin(memory: MemoryInfo) {
		try {
			await this.fetchApi(`/api/memory/${memory.id}`, {
				method: "PUT",
				body: JSON.stringify({ pinned: !memory.pinned }),
			});
			await this.loadMemories();
		} catch {
			this.statusMessage = "Network error";
			this.statusType = "error";
		}
	}

	private async handleDelete(memory: MemoryInfo) {
		if (!confirm(`Delete this memory?\n\n"${memory.content.slice(0, 100)}..."`)) return;

		try {
			const result = await this.fetchApi(`/api/memory/${memory.id}`, { method: "DELETE" });
			if (result.success) {
				this.statusMessage = "Memory deleted.";
				this.statusType = "success";
				await this.loadMemories();
			} else {
				this.statusMessage = result.error || "Delete failed";
				this.statusType = "error";
			}
		} catch {
			this.statusMessage = "Network error";
			this.statusType = "error";
		}
	}

	private onSearchInput(e: Event) {
		this.searchQuery = (e.target as HTMLInputElement).value;
		this.loadMemories();
	}

	private onFilterChange(e: Event) {
		this.filterCategory = (e.target as HTMLSelectElement).value;
		this.loadMemories();
	}

	override render() {
		return html`
			<h3>Memory</h3>

			${this.statusMessage
				? html`<div class="status ${this.statusType === "success" ? "status-success" : "status-error"}">${this.statusMessage}</div>`
				: nothing}

			<!-- Search and filter -->
			<div class="search-bar">
				<input
					type="text"
					placeholder="Search memories..."
					.value=${this.searchQuery}
					@input=${this.onSearchInput}
				/>
				<select .value=${this.filterCategory} @change=${this.onFilterChange}>
					<option value="">All categories</option>
					<option value="preference">Preferences</option>
					<option value="fact">Facts</option>
					<option value="instruction">Instructions</option>
					<option value="general">General</option>
				</select>
			</div>

			<!-- Memory list -->
			${this.loading
				? html`<div class="empty">Loading...</div>`
				: this.memories.length === 0
					? html`<div class="empty">
						<div style="font-size: 1.5rem; margin-bottom: 0.5rem;">🧠</div>
						<div style="font-weight: 600; margin-bottom: 0.25rem;">No memories yet</div>
						<div>Memories help the AI remember things about you across sessions. Add a memory below, or ask the AI to "remember" something during a chat.</div>
					</div>`
					: html`
						<div class="memory-list">
							${this.memories.map(memory => html`
								<div class="memory-item">
									<div class="memory-header">
										<span
											class="badge badge-category"
											style="background: ${CATEGORY_COLORS[memory.category] || CATEGORY_COLORS.general}"
										>${CATEGORY_LABELS[memory.category] || memory.category}</span>
										${memory.pinned ? html`<span class="badge badge-pinned">Pinned</span>` : nothing}
										${memory.source === "agent" ? html`<span class="badge badge-source">AI</span>` : nothing}
										<div class="memory-actions">
											<button class="btn-ghost" title="${memory.pinned ? "Unpin" : "Pin"}" @click=${() => this.togglePin(memory)}>
												${memory.pinned ? "Unpin" : "Pin"}
											</button>
											<button class="btn-ghost" @click=${() => this.startEdit(memory)}>Edit</button>
											<button class="btn-danger" @click=${() => this.handleDelete(memory)}>Delete</button>
										</div>
									</div>
									${this.editingId === memory.id
										? html`
											<textarea
												class="edit-area"
												.value=${this.editContent}
												@input=${(e: Event) => { this.editContent = (e.target as HTMLTextAreaElement).value; }}
											></textarea>
											<div class="edit-actions">
												<button class="btn-primary" style="padding: 0.25rem 0.75rem; font-size: 0.75rem;" @click=${() => this.saveEdit(memory.id)}>Save</button>
												<button class="btn-ghost" @click=${this.cancelEdit}>Cancel</button>
											</div>
										`
										: html`<div class="memory-content">${memory.content}</div>`
									}
								</div>
							`)}
						</div>
						<div style="font-size: 0.75rem; color: var(--muted-foreground, #6b7280); margin-bottom: 1rem;">
							${this.total} memor${this.total === 1 ? "y" : "ies"}
						</div>
					`
			}

			<!-- Add form -->
			<div class="add-form">
				<div class="form-field">
					<label>Add a memory</label>
					<textarea
						placeholder="E.g., I prefer TypeScript over JavaScript..."
						.value=${this.newContent}
						@input=${(e: Event) => { this.newContent = (e.target as HTMLTextAreaElement).value; }}
					></textarea>
				</div>
				<div class="form-row">
					<div class="form-field" style="flex: 0 0 auto;">
						<label>Category</label>
						<select .value=${this.newCategory} @change=${(e: Event) => { this.newCategory = (e.target as HTMLSelectElement).value; }}>
							<option value="general">General</option>
							<option value="preference">Preference</option>
							<option value="fact">Fact</option>
							<option value="instruction">Instruction</option>
						</select>
					</div>
					<button
						class="btn-primary"
						?disabled=${!this.newContent.trim()}
						@click=${this.handleAdd}
					>
						Save Memory
					</button>
				</div>
			</div>
		`;
	}
}
