/**
 * Files Management Panel.
 *
 * Lists, uploads, and deletes user files.
 */

import { apiFetch } from "../shared/api.js";
import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { FileInfo } from "../studio/types.js";

function formatBytes(bytes: number | null): string {
	if (bytes == null) return "—";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

@customElement("files-panel")
export class FilesPanel extends LitElement {
	static override styles = css`
		:host {
			display: block;
			padding: 1rem;
		}
		.file-list {
			display: flex;
			flex-direction: column;
			gap: 0.5rem;
			margin-bottom: 1rem;
		}
		.file-item {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 0.75rem 1rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.5rem;
			background: var(--card, #fff);
		}
		.file-info {
			display: flex;
			flex-direction: column;
			gap: 0.25rem;
			flex: 1;
			min-width: 0;
		}
		.file-name {
			font-weight: 600;
			font-size: 0.875rem;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.file-meta {
			font-size: 0.75rem;
			color: var(--muted-foreground, #6b7280);
		}
		.file-actions {
			display: flex;
			gap: 0.5rem;
			align-items: center;
		}
		.upload-form {
			display: flex;
			gap: 0.5rem;
			align-items: flex-end;
			padding: 1rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.5rem;
			background: var(--card, #fff);
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
		input[type="file"] {
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
			color: var(--foreground, #111);
			padding: 0.25rem 0.75rem;
			font-size: 0.75rem;
			border: 1px solid var(--border, #e5e7eb);
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

	@state() private files: FileInfo[] = [];
	@state() private loading = false;
	@state() private uploading = false;
	@state() private statusMessage = "";
	@state() private statusType: "success" | "error" = "success";
	@state() private selectedFile: File | null = null;

	override connectedCallback() {
		super.connectedCallback();
		this.loadFiles();
	}

	private fetchApi = (url: string, options?: RequestInit) => apiFetch(url, options, this.getToken);

	private async loadFiles() {
		this.loading = true;
		try {
			const result = await this.fetchApi("/api/files");
			if (result.success) {
				this.files = result.data.files;
			}
		} catch (err) {
			console.error("Failed to load files:", err);
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

			const token = this.getToken?.();
			const res = await fetch("/api/files", {
				method: "POST",
				headers: token ? { Authorization: `Bearer ${token}` } : {},
				body: formData,
			});
			const result = await res.json();

			if (result.success) {
				this.statusMessage = `"${result.data.filename}" uploaded.`;
				this.statusType = "success";
				this.selectedFile = null;
				const fileInput = this.shadowRoot?.querySelector('input[type="file"]') as HTMLInputElement;
				if (fileInput) fileInput.value = "";
				await this.loadFiles();
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

	private handleDownload(file: FileInfo) {
		const token = this.getToken?.();
		const a = document.createElement("a");
		// Use a fetch-based download to include auth header
		fetch(`/api/files/${file.id}`, {
			headers: token ? { Authorization: `Bearer ${token}` } : {},
		})
			.then((res) => res.blob())
			.then((blob) => {
				const url = URL.createObjectURL(blob);
				a.href = url;
				a.download = file.filename;
				a.click();
				URL.revokeObjectURL(url);
			})
			.catch(() => {
				this.statusMessage = "Download failed";
				this.statusType = "error";
			});
	}

	private async handleDelete(file: FileInfo) {
		if (!confirm(`Delete "${file.filename}"?`)) return;

		try {
			const result = await this.fetchApi(`/api/files/${file.id}`, { method: "DELETE" });
			if (result.success) {
				this.statusMessage = `"${file.filename}" deleted.`;
				this.statusType = "success";
				await this.loadFiles();
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
		return html`
			<h3>Files</h3>

			${this.statusMessage
				? html`<div class="status ${this.statusType === "success" ? "status-success" : "status-error"}">${this.statusMessage}</div>`
				: null}

			${this.loading
				? html`<div class="empty">Loading...</div>`
				: this.files.length === 0
					? html`<div class="empty">
						<div style="font-size: 1.5rem; margin-bottom: 0.5rem;">📁</div>
						<div style="font-weight: 600; margin-bottom: 0.25rem;">No files uploaded yet</div>
						<div>Upload documents, spreadsheets, or other files to use them with your AI assistant. Files are available across all your conversations.</div>
					</div>`
					: html`
						<div class="file-list">
							${this.files.map(
								(file) => html`
									<div class="file-item">
										<div class="file-info">
											<span class="file-name">${file.filename}</span>
											<span class="file-meta">
												${formatBytes(file.size_bytes)} &middot;
												${new Date(file.created_at).toLocaleDateString()}
											</span>
										</div>
										<div class="file-actions">
											<button class="btn-ghost" @click=${() => this.handleDownload(file)}>Download</button>
											<button class="btn-danger" @click=${() => this.handleDelete(file)}>Delete</button>
										</div>
									</div>
								`,
							)}
						</div>
					`}

			<div class="upload-form">
				<div class="form-field">
					<label>File (max 50MB)</label>
					<input
						type="file"
						@change=${(e: Event) => {
							const input = e.target as HTMLInputElement;
							this.selectedFile = input.files?.[0] || null;
						}}
					/>
				</div>
				<button
					class="btn-primary"
					?disabled=${!this.selectedFile || this.uploading}
					@click=${this.handleUpload}
				>
					${this.uploading ? "Uploading..." : "Upload"}
				</button>
			</div>
		`;
	}
}
