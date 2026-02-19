/**
 * ArtifactCollector: scans a task's working directory for output files,
 * uploads them to storage, and inserts task_artifact rows.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Database, TaskArtifactRow } from "../db/types.js";
import type { StorageService } from "./storage.js";
import { RENDERABLE_EXTENSIONS, BINARY_EXTENSIONS } from "../../src/shared/file-extensions.js";

const MIME_MAP: Record<string, string> = {
	png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
	webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml",
	pdf: "application/pdf", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	xls: "application/vnd.ms-excel", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	ppt: "application/vnd.ms-powerpoint",
	html: "text/html", htm: "text/html", css: "text/css",
	js: "text/javascript", ts: "text/typescript", json: "application/json",
	xml: "application/xml", yaml: "text/yaml", yml: "text/yaml",
	csv: "text/csv", md: "text/markdown", txt: "text/plain", sh: "text/x-shellscript",
	py: "text/x-python", java: "text/x-java", c: "text/x-c", cpp: "text/x-c++", h: "text/x-c",
};

const ARTIFACT_MAX_SIZE_BYTES = parseInt(process.env.ARTIFACT_MAX_SIZE_BYTES || String(50 * 1024 * 1024), 10);

/** All extensions we'll collect as artifacts. */
const COLLECTIBLE_EXTENSIONS = new Set([...RENDERABLE_EXTENSIONS, ...BINARY_EXTENSIONS]);

export class ArtifactCollector {
	constructor(private db: Database, private storage: StorageService) {}

	/**
	 * Scan cwdPath for new files, upload to storage, insert task_artifact rows.
	 * @param excludePaths - absolute paths to skip (e.g. input files injected before execution)
	 */
	async collect(taskId: string, cwdPath: string, excludePaths?: Set<string>): Promise<TaskArtifactRow[]> {
		const artifacts: TaskArtifactRow[] = [];

		let entries: string[];
		try {
			entries = await this.readDirRecursive(cwdPath);
		} catch {
			return artifacts;
		}

		for (const relativePath of entries) {
			const absolutePath = path.join(cwdPath, relativePath);

			// Skip excluded paths (pre-existing input files)
			if (excludePaths?.has(absolutePath)) continue;

			// Check extension
			const ext = path.extname(relativePath).slice(1).toLowerCase();
			if (!COLLECTIBLE_EXTENSIONS.has(ext)) continue;

			// Check size
			let stat;
			try {
				stat = await fs.stat(absolutePath);
			} catch {
				continue;
			}
			if (!stat.isFile() || stat.size > ARTIFACT_MAX_SIZE_BYTES || stat.size === 0) continue;

			// Upload to storage
			const storageKey = `tasks/${taskId}/artifacts/${relativePath}`;
			try {
				const data = await fs.readFile(absolutePath);
				await this.storage.upload(storageKey, data);

				// Insert DB row
				const contentType = MIME_MAP[ext] || "application/octet-stream";
				const result = await this.db.query<TaskArtifactRow>(
					`INSERT INTO task_artifacts (task_id, filename, content_type, size_bytes, storage_key)
					 VALUES ($1, $2, $3, $4, $5) RETURNING *`,
					[taskId, relativePath, contentType, stat.size, storageKey],
				);
				if (result.rows[0]) {
					artifacts.push(result.rows[0]);
				}
			} catch (err) {
				console.error(`[artifact-collector] Failed to collect "${relativePath}":`, err);
			}
		}

		return artifacts;
	}

	private async readDirRecursive(dir: string, prefix = ""): Promise<string[]> {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		const results: string[] = [];

		for (const entry of entries) {
			const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				// Skip node_modules and hidden dirs
				if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
				const nested = await this.readDirRecursive(path.join(dir, entry.name), relativePath);
				results.push(...nested);
			} else if (entry.isFile()) {
				results.push(relativePath);
			}
		}

		return results;
	}
}
