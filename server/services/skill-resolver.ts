/**
 * Skill Resolver: downloads skill files to temp dirs for CLI injection.
 *
 * Resolves all skills visible to a user (platform + team + user scope),
 * downloads skill content from StorageService to temp directories, and returns
 * paths suitable for `--skill <path>` CLI args.
 *
 * Supports both single SKILL.md files and full zip bundle directory trees.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Database, SkillRow } from "../db/types.js";
import type { StorageService } from "./storage.js";

export interface ResolvedSkills {
	/** Absolute paths to skill directories (each contains a SKILL.md) */
	skillPaths: string[];
	/** Call to remove temp directories when session ends */
	cleanup: () => void;
}

export async function resolveSkillsForUser(
	db: Database,
	storage: StorageService,
	userId: string,
	teamId: string,
	filterIds?: string[],
): Promise<ResolvedSkills> {
	let result;
	if (filterIds && filterIds.length > 0) {
		// Resolve only specific skills by ID (used by agent profiles)
		// Still enforce visibility — user can only access skills in their scope
		result = await db.query<SkillRow>(
			`SELECT name, format, storage_key FROM skills
			 WHERE id = ANY($1)
			   AND ((scope = 'platform')
			     OR (scope = 'team' AND owner_id = $2)
			     OR (scope = 'user' AND owner_id = $3))
			 ORDER BY scope, name`,
			[filterIds, teamId, userId],
		);
	} else if (filterIds && filterIds.length === 0) {
		// Explicit empty array means no skills (profile with no skills selected)
		return { skillPaths: [], cleanup: () => {} };
	} else {
		// No filter — resolve all visible skills (default behavior)
		result = await db.query<SkillRow>(
			`SELECT name, format, storage_key FROM skills
			 WHERE (scope = 'platform')
			    OR (scope = 'team' AND owner_id = $1)
			    OR (scope = 'user' AND owner_id = $2)
			 ORDER BY scope, name`,
			[teamId, userId],
		);
	}

	if (result.rows.length === 0) {
		return { skillPaths: [], cleanup: () => {} };
	}

	const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "pi-skills-"));
	const skillPaths: string[] = [];

	await Promise.all(
		result.rows.map(async (skill) => {
			try {
				const skillDir = path.join(tmpBase, skill.name);
				await fs.mkdir(skillDir, { recursive: true });

				if (skill.format === "zip") {
					// Restore full directory tree from stored files
					const keys = await storage.listByPrefix(skill.storage_key);
					await Promise.all(
						keys.map(async (key) => {
							const relativePath = key.startsWith(skill.storage_key)
								? key.slice(skill.storage_key.length)
								: key;
							if (!relativePath) return;

							const filePath = path.join(skillDir, relativePath);
							await fs.mkdir(path.dirname(filePath), { recursive: true });
							const data = await storage.download(key);
							await fs.writeFile(filePath, data);
						}),
					);
				} else {
					// Single SKILL.md file
					const data = await storage.download(skill.storage_key);
					await fs.writeFile(path.join(skillDir, "SKILL.md"), data);
				}

				skillPaths.push(skillDir);
			} catch (err) {
				console.error(`[skill-resolver] Failed to resolve skill "${skill.name}":`, err);
			}
		}),
	);

	const cleanup = () => {
		fs.rm(tmpBase, { recursive: true, force: true }).catch((err) => {
			console.error("[skill-resolver] Failed to clean up temp dir:", err);
		});
	};

	return { skillPaths, cleanup };
}
