/**
 * Full-page files management tab for the Agent Studio.
 * Lists files in a card grid, supports upload (file or folder), download, and delete.
 */

import { apiFetch } from "../shared/api.js";
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { FileInfo } from "./types.js";

function formatBytes(bytes: number | null): string {
	if (bytes == null) return "\u2014";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

@customElement("studio-files-tab")
export class FilesTab extends LitElement {
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
		.file-count {
			font-size: 0.8rem;
			color: var(--muted-foreground, #6b7280);
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
			flex-wrap: wrap;
		}
		.form-field {
			display: flex;
			flex-direction: column;
			gap: 0.25rem;
		}
		.form-field.grow { flex: 1; min-width: 200px; }
		label {
			font-size: 0.75rem;
			font-weight: 500;
			color: var(--muted-foreground, #6b7280);
		}
		input[type="file"] {
			padding: 0.5rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.375rem;
			font-size: 0.85rem;
			background: var(--background, #fff);
			color: var(--foreground, #111);
			font-family: inherit;
		}
		.upload-buttons {
			display: flex;
			gap: 0.5rem;
			align-items: flex-end;
		}
		.hidden-input { display: none; }

		/* Progress bar */
		.upload-progress {
			width: 100%;
			margin-top: 0.5rem;
		}
		.progress-text {
			font-size: 0.75rem;
			color: var(--muted-foreground, #6b7280);
			margin-bottom: 0.25rem;
		}
		.progress-bar {
			height: 6px;
			border-radius: 3px;
			background: var(--muted, #f3f4f6);
			overflow: hidden;
		}
		.progress-fill {
			height: 100%;
			border-radius: 3px;
			background: var(--primary, #2563eb);
			transition: width 0.2s ease;
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
		.card-name {
			font-weight: 600;
			font-size: 0.9rem;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.card-meta {
			display: flex;
			gap: 0.5rem;
			align-items: center;
			font-size: 0.75rem;
			color: var(--muted-foreground, #6b7280);
			flex-wrap: wrap;
		}
		.meta-sep::before { content: "\u00b7"; }
		.card-actions {
			display: flex;
			gap: 0.375rem;
			justify-content: flex-end;
			margin-top: auto;
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
		.btn-secondary {
			padding: 0.5rem 1rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.375rem;
			font-size: 0.85rem;
			font-weight: 500;
			background: transparent;
			color: var(--foreground, #111);
		}
		.btn-secondary:hover { background: var(--muted, #f3f4f6); }
		.btn-secondary:disabled { opacity: 0.5; cursor: not-allowed; }
		.btn-ghost {
			padding: 0.25rem 0.75rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.375rem;
			font-size: 0.75rem;
			font-weight: 500;
			background: transparent;
			color: var(--foreground, #111);
		}
		.btn-ghost:hover { background: var(--muted, #f3f4f6); }
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
			height: 120px;
			border-radius: 0.75rem;
			background: linear-gradient(90deg, var(--muted, #f3f4f6) 25%, var(--background, #fff) 50%, var(--muted, #f3f4f6) 75%);
			background-size: 800px 100%;
			animation: shimmer 1.5s infinite;
		}
	`;

	@property({ type: Function })
	getToken: (() => string | null) | undefined;

	@state() private files: FileInfo[] = [];
	@state() private loading = false;
	@state() private uploading = false;
	@state() private statusMessage = "";
	@state() private statusType: "success" | "error" = "success";
	@state() private searchQuery = "";
	@state() private selectedFile: File | null = null;
	// Folder upload progress
	@state() private folderUploading = false;
	@state() private folderProgress = 0;
	@state() private folderTotal = 0;
	@state() private folderErrors: string[] = [];

	override connectedCallback() {
		super.connectedCallback();
		this._loadFiles();
	}

	private _fetchApi = (url: string, options?: RequestInit) => apiFetch(url, options, this.getToken);

	private async _loadFiles() {
		this.loading = true;
		try {
			const result = await this._fetchApi("/api/files");
			if (result.success) {
				this.files = result.data.files;
			}
		} catch (err) {
			console.error("Failed to load files:", err);
		} finally {
			this.loading = false;
		}
	}

	private async _uploadOneFile(file: File): Promise<{ success: boolean; filename: string; error?: string }> {
		const formData = new FormData();
		formData.append("file", file);

		const token = this.getToken?.();
		try {
			const res = await fetch("/api/files", {
				method: "POST",
				headers: token ? { Authorization: `Bearer ${token}` } : {},
				body: formData,
			});
			const result = await res.json();
			if (result.success) {
				return { success: true, filename: result.data.filename };
			}
			return { success: false, filename: file.name, error: result.error || "Upload failed" };
		} catch {
			return { success: false, filename: file.name, error: "Network error" };
		}
	}

	private async _handleUpload() {
		if (!this.selectedFile) return;

		this.uploading = true;
		this.statusMessage = "";
		const result = await this._uploadOneFile(this.selectedFile);
		if (result.success) {
			this.statusMessage = `"${result.filename}" uploaded.`;
			this.statusType = "success";
			this.selectedFile = null;
			const fileInput = this.shadowRoot?.querySelector('#file-input') as HTMLInputElement;
			if (fileInput) fileInput.value = "";
			await this._loadFiles();
		} else {
			this.statusMessage = result.error || "Upload failed";
			this.statusType = "error";
		}
		this.uploading = false;
	}

	private _triggerFolderPicker() {
		const input = this.shadowRoot?.querySelector('#folder-input') as HTMLInputElement;
		if (input) input.click();
	}

	private async _handleFolderSelected(e: Event) {
		const input = e.target as HTMLInputElement;
		const fileList = input.files;
		if (!fileList || fileList.length === 0) return;

		// Collect all files from the folder
		const filesToUpload: File[] = [];
		for (let i = 0; i < fileList.length; i++) {
			filesToUpload.push(fileList[i]);
		}

		this.folderUploading = true;
		this.folderProgress = 0;
		this.folderTotal = filesToUpload.length;
		this.folderErrors = [];
		this.statusMessage = "";

		let successCount = 0;
		for (const file of filesToUpload) {
			const result = await this._uploadOneFile(file);
			this.folderProgress++;
			if (result.success) {
				successCount++;
			} else {
				this.folderErrors = [...this.folderErrors, `${file.name}: ${result.error}`];
			}
		}

		// Reset folder input
		input.value = "";
		this.folderUploading = false;

		if (this.folderErrors.length === 0) {
			this.statusMessage = `Uploaded ${successCount} file${successCount !== 1 ? "s" : ""} from folder.`;
			this.statusType = "success";
		} else {
			this.statusMessage = `Uploaded ${successCount}/${filesToUpload.length} files. ${this.folderErrors.length} failed.`;
			this.statusType = this.folderErrors.length === filesToUpload.length ? "error" : "success";
		}

		await this._loadFiles();
	}

	private _handleDownload(file: FileInfo) {
		const token = this.getToken?.();
		fetch(`/api/files/${file.id}`, {
			headers: token ? { Authorization: `Bearer ${token}` } : {},
		})
			.then(res => res.blob())
			.then(blob => {
				const url = URL.createObjectURL(blob);
				const a = document.createElement("a");
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

	private async _handleDelete(file: FileInfo) {
		if (!confirm(`Delete "${file.filename}"?`)) return;

		try {
			const result = await this._fetchApi(`/api/files/${file.id}`, { method: "DELETE" });
			if (result.success) {
				this.statusMessage = `"${file.filename}" deleted.`;
				this.statusType = "success";
				await this._loadFiles();
			} else {
				this.statusMessage = result.error || "Delete failed";
				this.statusType = "error";
			}
		} catch {
			this.statusMessage = "Network error";
			this.statusType = "error";
		}
	}

	private get _filteredFiles(): FileInfo[] {
		if (!this.searchQuery) return this.files;
		const q = this.searchQuery.toLowerCase();
		return this.files.filter(f => f.filename.toLowerCase().includes(q));
	}

	override render() {
		const filtered = this._filteredFiles;
		const isUploading = this.uploading || this.folderUploading;

		return html`
			<!-- Hidden folder input -->
			<input
				id="folder-input"
				class="hidden-input"
				type="file"
				webkitdirectory
				multiple
				@change=${(e: Event) => this._handleFolderSelected(e)}
			/>

			<!-- Filter bar -->
			<div class="filter-bar">
				<span class="file-count">${this.files.length} file${this.files.length !== 1 ? "s" : ""}</span>
				<input
					class="search-input"
					type="text"
					placeholder="Search files..."
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
					<div class="form-field grow">
						<label>File (max 50MB)</label>
						<input
							id="file-input"
							type="file"
							@change=${(e: Event) => {
								this.selectedFile = (e.target as HTMLInputElement).files?.[0] || null;
							}}
						/>
					</div>
					<div class="upload-buttons">
						<button
							class="btn-primary"
							?disabled=${!this.selectedFile || isUploading}
							@click=${() => this._handleUpload()}
						>
							${this.uploading ? "Uploading..." : "Upload File"}
						</button>
						<button
							class="btn-secondary"
							?disabled=${isUploading}
							@click=${() => this._triggerFolderPicker()}
						>
							${this.folderUploading ? "Uploading..." : "Upload Folder"}
						</button>
					</div>

					${this.folderUploading ? html`
						<div class="upload-progress">
							<div class="progress-text">
								Uploading ${this.folderProgress} of ${this.folderTotal} files...
							</div>
							<div class="progress-bar">
								<div
									class="progress-fill"
									style="width: ${this.folderTotal > 0 ? (this.folderProgress / this.folderTotal) * 100 : 0}%"
								></div>
							</div>
						</div>
					` : nothing}
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
						${this.files.length === 0
							? "No files uploaded yet. Upload a file or folder above."
							: "No files match your search."}
					</div>
				` : html`
					<div class="card-grid">
						${filtered.map(file => html`
							<div class="card">
								<div class="card-name">${file.filename}</div>
								<div class="card-meta">
									<span>${formatBytes(file.size_bytes)}</span>
									${file.content_type ? html`<span class="meta-sep"></span><span>${file.content_type}</span>` : nothing}
									<span class="meta-sep"></span>
									<span>${new Date(file.created_at).toLocaleDateString()}</span>
								</div>
								<div class="card-actions">
									<button class="btn-ghost" @click=${() => this._handleDownload(file)}>Download</button>
									<button class="btn-danger" @click=${() => this._handleDelete(file)}>Delete</button>
								</div>
							</div>
						`)}
					</div>
				`}
			</div>
		`;
	}
}
