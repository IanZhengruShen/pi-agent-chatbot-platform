/**
 * Skills management routes.
 *
 * CRUD for skills (SKILL.md files or zip bundles) with scope-based authorization.
 * Skills are stored via StorageService and metadata in PostgreSQL.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import multer from "multer";
import JSZip from "jszip";
import { getDatabase } from "../db/index.js";
import type { SkillRow } from "../db/types.js";
import { requireAuth } from "../auth/middleware.js";
import type { StorageService } from "../services/storage.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } }); // 25MB max

/** Validate SKILL.md frontmatter: extract name and description */
function parseSkillMd(content: string): { name: string; description: string } | { error: string } {
	// SKILL.md uses YAML frontmatter: ---\nname: ...\ndescription: ...\n---
	const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
	if (!match) {
		return { error: "SKILL.md must contain YAML frontmatter (--- delimited)" };
	}

	const frontmatter = match[1];
	const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
	const descMatch = frontmatter.match(/^description:\s*(.+)$/m);

	if (!nameMatch) {
		return { error: "SKILL.md frontmatter must contain a 'name' field" };
	}
	if (!descMatch) {
		return { error: "SKILL.md frontmatter must contain a 'description' field" };
	}

	const name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
	const description = descMatch[1].trim().replace(/^["']|["']$/g, "");

	if (!/^[a-z0-9-]+$/.test(name) || name.length > 64) {
		return { error: "Skill name must be lowercase a-z, 0-9, hyphens only, max 64 chars" };
	}
	if (description.length === 0 || description.length > 1024) {
		return { error: "Skill description is required and must be max 1024 chars" };
	}

	return { name, description };
}

/** Validate a zip entry path for safety */
function isPathSafe(entryPath: string): boolean {
	if (entryPath.includes("..") || entryPath.startsWith("/") || entryPath.startsWith("\\")) {
		return false;
	}
	// No absolute paths on Windows either
	if (/^[a-zA-Z]:/.test(entryPath)) {
		return false;
	}
	return true;
}

/** Check if a zip entry is OS junk that should be ignored */
function isJunkEntry(entryPath: string): boolean {
	const segments = entryPath.split("/");
	return segments.some(
		(s) => s === "__MACOSX" || s === ".DS_Store" || s.startsWith("._"),
	);
}

/**
 * Process a zip buffer: find SKILL.md, validate, and return extracted files.
 * Returns file entries with normalized paths (top-level dir stripped if present).
 */
async function processZipBundle(
	buffer: Buffer,
): Promise<{ name: string; description: string; files: Array<{ path: string; data: Buffer }> } | { error: string }> {
	let zip: JSZip;
	try {
		zip = await JSZip.loadAsync(buffer);
	} catch {
		return { error: "Invalid zip file" };
	}

	const allEntries = Object.keys(zip.files);
	// Filter out macOS junk entries (__MACOSX, .DS_Store, ._ resource forks)
	const entries = allEntries.filter((e) => !isJunkEntry(e));
	if (entries.length === 0) {
		return { error: "Zip file is empty" };
	}

	// Validate all paths
	for (const entryPath of entries) {
		if (!isPathSafe(entryPath)) {
			return { error: `Unsafe path in zip: ${entryPath}` };
		}
	}

	// Find SKILL.md — check root first, then look for a single top-level directory
	let skillMdPath: string | null = null;
	let stripPrefix = "";

	if (zip.files["SKILL.md"] && !zip.files["SKILL.md"].dir) {
		skillMdPath = "SKILL.md";
	} else {
		// Look for a single top-level directory containing SKILL.md
		const topLevelDirs = new Set<string>();
		for (const entryPath of entries) {
			const firstSegment = entryPath.split("/")[0];
			if (zip.files[entryPath].dir && entryPath === firstSegment + "/") {
				topLevelDirs.add(firstSegment);
			} else if (!entryPath.includes("/")) {
				// A root-level file that's not SKILL.md — multiple top-level items
				topLevelDirs.add("__file__");
			} else {
				topLevelDirs.add(entryPath.split("/")[0]);
			}
		}

		if (topLevelDirs.size === 1) {
			const dirName = [...topLevelDirs][0];
			if (dirName !== "__file__") {
				const candidate = `${dirName}/SKILL.md`;
				if (zip.files[candidate] && !zip.files[candidate].dir) {
					skillMdPath = candidate;
					stripPrefix = dirName + "/";
				}
			}
		}
	}

	if (!skillMdPath) {
		const topLevel = [...new Set(entries.map((e) => e.split("/")[0]))].slice(0, 10);
		return { error: `Zip must contain SKILL.md at root or inside a single top-level directory. Found top-level items: [${topLevel.join(", ")}]` };
	}

	// Parse SKILL.md frontmatter
	const skillMdContent = await zip.files[skillMdPath].async("string");
	const parsed = parseSkillMd(skillMdContent);
	if ("error" in parsed) {
		return parsed;
	}

	// If there's a top-level directory, its name must match the skill name
	if (stripPrefix) {
		const dirName = stripPrefix.slice(0, -1); // remove trailing "/"
		if (dirName !== parsed.name) {
			return {
				error: `Top-level directory "${dirName}" must match skill name "${parsed.name}" from SKILL.md frontmatter`,
			};
		}
	}

	// Extract all files with normalized paths (skip junk)
	const files: Array<{ path: string; data: Buffer }> = [];
	for (const [entryPath, entry] of Object.entries(zip.files)) {
		if (entry.dir || isJunkEntry(entryPath)) continue;

		// Normalize path: strip top-level directory prefix
		let normalizedPath = entryPath;
		if (stripPrefix && entryPath.startsWith(stripPrefix)) {
			normalizedPath = entryPath.slice(stripPrefix.length);
		}
		if (!normalizedPath) continue;

		const data = await entry.async("nodebuffer");
		files.push({ path: normalizedPath, data });
	}

	return { name: parsed.name, description: parsed.description, files };
}

export function createSkillsRouter(storage: StorageService): Router {
	const router = Router();
	router.use(requireAuth);

	// -----------------------------------------------------------------------
	// GET / — List visible skills (platform + user's team + user's own)
	// -----------------------------------------------------------------------
	router.get("/", async (req: Request, res: Response) => {
		try {
			const db = getDatabase();
			const result = await db.query<SkillRow>(
				`SELECT id, scope, owner_id, name, description, format, created_at, updated_at
				 FROM skills
				 WHERE (scope = 'platform')
				    OR (scope = 'team' AND owner_id = $1)
				    OR (scope = 'user' AND owner_id = $2)
				 ORDER BY scope, name`,
				[req.user!.teamId, req.user!.userId],
			);

			res.json({ success: true, data: { skills: result.rows } });
		} catch (err) {
			console.error("[skills] GET / error:", err);
			res.status(500).json({ success: false, error: "Internal server error" });
		}
	});

	// -----------------------------------------------------------------------
	// POST / — Upload a new skill (multipart: file + scope field)
	// -----------------------------------------------------------------------
	router.post("/", upload.single("file"), async (req: Request, res: Response) => {
		try {
			const scope = req.body.scope as string;
			if (!scope || !["platform", "team", "user"].includes(scope)) {
				res.status(400).json({ success: false, error: "scope must be 'platform', 'team', or 'user'" });
				return;
			}

			// Authorization: platform/team scope requires admin
			if ((scope === "platform" || scope === "team") && req.user!.role !== "admin") {
				res.status(403).json({ success: false, error: "Only admins can create platform/team skills" });
				return;
			}

			if (!req.file) {
				res.status(400).json({ success: false, error: "file field (SKILL.md or .zip) is required" });
				return;
			}

			// Determine owner_id based on scope
			const ownerId = scope === "team" ? req.user!.teamId : scope === "platform" ? req.user!.teamId : req.user!.userId;
			const db = getDatabase();

			const originalName = req.file.originalname.toLowerCase();
			const isZip = originalName.endsWith(".zip");

			if (isZip) {
				// --- Zip bundle upload ---
				const result = await processZipBundle(req.file.buffer);
				if ("error" in result) {
					res.status(400).json({ success: false, error: result.error });
					return;
				}

				const storagePrefix = `skills/${ownerId}/${result.name}/`;

				// Delete any previously stored files for this skill
				await storage.deleteByPrefix(storagePrefix);

				// Store each extracted file
				for (const file of result.files) {
					await storage.upload(storagePrefix + file.path, file.data);
				}

				// Upsert metadata
				await db.query(
					`INSERT INTO skills (scope, owner_id, name, description, format, storage_key)
					 VALUES ($1, $2, $3, $4, 'zip', $5)
					 ON CONFLICT (scope, owner_id, name)
					 DO UPDATE SET description = $4, format = 'zip', storage_key = $5, updated_at = now()`,
					[scope, ownerId, result.name, result.description, storagePrefix],
				);

				res.status(201).json({ success: true, data: { name: result.name, scope, format: "zip" } });
			} else {
				// --- Single SKILL.md upload ---
				const content = req.file.buffer.toString("utf-8");
				const parsed = parseSkillMd(content);
				if ("error" in parsed) {
					res.status(400).json({ success: false, error: parsed.error });
					return;
				}

				const storageKey = `skills/${ownerId}/${parsed.name}/SKILL.md`;

				// If re-uploading as md, clean up any previous zip files
				const existing = await db.query<SkillRow>(
					`SELECT format, storage_key FROM skills WHERE scope = $1 AND owner_id = $2 AND name = $3`,
					[scope, ownerId, parsed.name],
				);
				if (existing.rows.length > 0 && existing.rows[0].format === "zip") {
					await storage.deleteByPrefix(existing.rows[0].storage_key);
				}

				await storage.upload(storageKey, req.file.buffer, "text/markdown");

				await db.query(
					`INSERT INTO skills (scope, owner_id, name, description, format, storage_key)
					 VALUES ($1, $2, $3, $4, 'md', $5)
					 ON CONFLICT (scope, owner_id, name)
					 DO UPDATE SET description = $4, format = 'md', storage_key = $5, updated_at = now()`,
					[scope, ownerId, parsed.name, parsed.description, storageKey],
				);

				res.status(201).json({ success: true, data: { name: parsed.name, scope, format: "md" } });
			}
		} catch (err) {
			console.error("[skills] POST / error:", err);
			res.status(500).json({ success: false, error: "Internal server error" });
		}
	});

	// -----------------------------------------------------------------------
	// GET /:id/download — Download skill content
	// -----------------------------------------------------------------------
	router.get("/:id/download", async (req: Request, res: Response) => {
		try {
			const db = getDatabase();
			const result = await db.query<SkillRow>(
				`SELECT * FROM skills WHERE id = $1`,
				[req.params.id],
			);

			if (result.rows.length === 0) {
				res.status(404).json({ success: false, error: "Skill not found" });
				return;
			}

			const skill = result.rows[0];

			// Check visibility
			const canAccess =
				skill.scope === "platform" ||
				(skill.scope === "team" && skill.owner_id === req.user!.teamId) ||
				(skill.scope === "user" && skill.owner_id === req.user!.userId);

			if (!canAccess) {
				res.status(403).json({ success: false, error: "Access denied" });
				return;
			}

			if (skill.format === "zip") {
				// Re-zip all files under the storage prefix
				const keys = await storage.listByPrefix(skill.storage_key);
				const zip = new JSZip();

				for (const key of keys) {
					// key is like "skills/owner/name/SKILL.md" — strip the storage_key prefix
					const relativePath = key.startsWith(skill.storage_key)
						? key.slice(skill.storage_key.length)
						: key;
					const data = await storage.download(key);
					zip.file(relativePath, data);
				}

				const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
				res.setHeader("Content-Type", "application/zip");
				res.setHeader("Content-Disposition", `attachment; filename="${skill.name}.zip"`);
				res.send(zipBuffer);
			} else {
				const data = await storage.download(skill.storage_key);
				res.setHeader("Content-Type", "text/markdown");
				res.setHeader("Content-Disposition", `attachment; filename="SKILL.md"`);
				res.send(data);
			}
		} catch (err) {
			console.error("[skills] GET /:id/download error:", err);
			res.status(500).json({ success: false, error: "Internal server error" });
		}
	});

	// -----------------------------------------------------------------------
	// DELETE /:id — Delete a skill
	// -----------------------------------------------------------------------
	router.delete("/:id", async (req: Request, res: Response) => {
		try {
			const db = getDatabase();
			const result = await db.query<SkillRow>(
				`SELECT * FROM skills WHERE id = $1`,
				[req.params.id],
			);

			if (result.rows.length === 0) {
				res.status(404).json({ success: false, error: "Skill not found" });
				return;
			}

			const skill = result.rows[0];

			// Authorization
			const canDelete =
				((skill.scope === "platform" || skill.scope === "team") && req.user!.role === "admin") ||
				(skill.scope === "user" && skill.owner_id === req.user!.userId);

			if (!canDelete) {
				res.status(403).json({ success: false, error: "Insufficient permissions" });
				return;
			}

			// Delete from storage and DB
			if (skill.format === "zip") {
				await storage.deleteByPrefix(skill.storage_key);
			} else {
				await storage.delete(skill.storage_key);
			}
			await db.query(`DELETE FROM skills WHERE id = $1`, [req.params.id]);

			res.json({ success: true });
		} catch (err) {
			console.error("[skills] DELETE /:id error:", err);
			res.status(500).json({ success: false, error: "Internal server error" });
		}
	});

	return router;
}
