/**
 * Memory Resolver: generates a MEMORY.md file for CLI injection.
 *
 * Queries user memories from PostgreSQL, groups by category (pinned first),
 * writes to a temp file, and returns the path for `--file` CLI arg.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Database } from "../db/types.js";

export interface ResolvedMemory {
	/** Absolute path to the generated MEMORY.md file, or null if no memories */
	filePath: string | null;
	/** Call to remove temp file when session ends */
	cleanup: () => void;
}

interface MemoryRow {
	content: string;
	category: string;
	pinned: boolean;
}

export async function resolveMemoryForUser(
	db: Database,
	userId: string,
): Promise<ResolvedMemory> {
	const result = await db.query<MemoryRow>(
		`SELECT content, category, pinned FROM agent_memories
		 WHERE user_id = $1
		 ORDER BY pinned DESC, category, updated_at DESC
		 LIMIT 200`,
		[userId],
	);

	if (result.rows.length === 0) {
		return { filePath: null, cleanup: () => {} };
	}

	// Group memories by category, pinned first
	const pinned: string[] = [];
	const groups = new Map<string, string[]>();

	for (const row of result.rows) {
		if (row.pinned) {
			pinned.push(row.content);
		} else {
			const list = groups.get(row.category) || [];
			list.push(row.content);
			groups.set(row.category, list);
		}
	}

	// Build Markdown content
	const lines: string[] = [
		"# User Memory",
		"",
		"These are things the user has asked you to remember. Reference them naturally in conversation.",
		"",
	];

	if (pinned.length > 0) {
		lines.push("## Pinned");
		for (const item of pinned) {
			lines.push(`- ${item}`);
		}
		lines.push("");
	}

	const categoryLabels: Record<string, string> = {
		preference: "Preferences",
		fact: "Facts",
		instruction: "Instructions",
		general: "General",
	};

	for (const [category, items] of groups) {
		lines.push(`## ${categoryLabels[category] || category}`);
		for (const item of items) {
			lines.push(`- ${item}`);
		}
		lines.push("");
	}

	const content = lines.join("\n");
	const filePath = path.join(os.tmpdir(), `pi-memory-${randomUUID()}.md`);
	await fs.writeFile(filePath, content);

	const cleanup = () => {
		fs.unlink(filePath).catch(() => {});
	};

	return { filePath, cleanup };
}
