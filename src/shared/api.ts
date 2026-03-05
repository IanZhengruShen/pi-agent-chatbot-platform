/**
 * Shared fetch wrapper that injects the Bearer token and auto-sets
 * Content-Type: application/json when the body is a string (JSON).
 */
export async function apiFetch(
	url: string,
	options: RequestInit = {},
	getToken?: (() => string | null) | null,
): Promise<any> {
	const token = getToken?.();
	const res = await fetch(url, {
		...options,
		headers: {
			...(typeof options.body === "string" ? { "Content-Type": "application/json" } : {}),
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...options.headers,
		},
	});
	return res.json();
}
