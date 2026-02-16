/**
 * One-time migration script to export sessions from the old pi-web-ui-agent
 * IndexedDB database. Can be run from the browser console or a /migrate page.
 *
 * Usage:
 *   import { exportIndexedDB, importToServer } from './migration/export-indexeddb.js';
 *   const data = await exportIndexedDB();
 *   await importToServer(data, token);
 */

const OLD_DB_NAME = "pi-web-ui-agent";

export interface ExportedData {
	sessions: Array<{ id: string; data: any }>;
	metadata: Array<{ id: string; data: any }>;
	exportedAt: string;
}

/**
 * Open the old IndexedDB and export all sessions + metadata.
 * Returns null if the old database doesn't exist.
 */
export async function exportIndexedDB(): Promise<ExportedData | null> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(OLD_DB_NAME);

		request.onerror = () => {
			// Database doesn't exist or can't be opened
			resolve(null);
		};

		request.onsuccess = () => {
			const db = request.result;
			const storeNames = Array.from(db.objectStoreNames);

			if (!storeNames.includes("sessions")) {
				db.close();
				resolve(null);
				return;
			}

			const result: ExportedData = {
				sessions: [],
				metadata: [],
				exportedAt: new Date().toISOString(),
			};

			const tx = db.transaction(storeNames.filter((s) => s === "sessions" || s === "sessions-metadata"), "readonly");

			// Export sessions
			if (storeNames.includes("sessions")) {
				const sessionsStore = tx.objectStore("sessions");
				const sessionsReq = sessionsStore.getAll();
				sessionsReq.onsuccess = () => {
					for (const item of sessionsReq.result) {
						result.sessions.push({ id: item.id, data: item });
					}
				};
			}

			// Export metadata
			if (storeNames.includes("sessions-metadata")) {
				const metaStore = tx.objectStore("sessions-metadata");
				const metaReq = metaStore.getAll();
				metaReq.onsuccess = () => {
					for (const item of metaReq.result) {
						result.metadata.push({ id: item.id, data: item });
					}
				};
			}

			tx.oncomplete = () => {
				db.close();
				resolve(result);
			};

			tx.onerror = () => {
				db.close();
				reject(new Error("Failed to read IndexedDB"));
			};
		};
	});
}

/**
 * Download exported data as a JSON file.
 */
export function downloadAsJson(data: ExportedData): void {
	const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = `pi-sessions-export-${new Date().toISOString().slice(0, 10)}.json`;
	a.click();
	URL.revokeObjectURL(url);
}

/**
 * Import exported data to the new server.
 * Returns { imported, skipped } counts.
 */
export async function importToServer(
	data: ExportedData,
	token: string,
): Promise<{ imported: number; skipped: number }> {
	const res = await fetch("/api/import/sessions", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({
			sessions: data.sessions.map((s) => s.data),
			metadata: data.metadata.map((m) => m.data),
		}),
	});

	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(body.error || `Import failed: ${res.status}`);
	}

	const body = await res.json();
	return body.data;
}
