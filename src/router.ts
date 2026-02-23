/**
 * Minimal client-side router (pathname-based).
 *
 * Routes:
 *   /             → chat
 *   /studio       → studio (tab = profiles)
 *   /studio/skills → studio (tab = skills)
 *   /studio/files  → studio (tab = files)
 *   /studio/:id/edit → studio-edit
 */

export type RouteName = "chat" | "studio" | "studio-edit";

export interface RouteResult {
	route: RouteName;
	params: Record<string, string>;
}

const STUDIO_EDIT_RE = /^\/studio\/([^/]+)\/edit$/;

export function resolveRoute(pathname = window.location.pathname): RouteResult {
	if (pathname === "/studio") {
		return { route: "studio", params: { tab: "profiles" } };
	}
	if (pathname === "/studio/skills") {
		return { route: "studio", params: { tab: "skills" } };
	}
	if (pathname === "/studio/files") {
		return { route: "studio", params: { tab: "files" } };
	}
	const m = STUDIO_EDIT_RE.exec(pathname);
	if (m) {
		return { route: "studio-edit", params: { id: m[1] } };
	}
	return { route: "chat", params: {} };
}

export function navigateTo(path: string): void {
	history.pushState(null, "", path);
	window.dispatchEvent(new CustomEvent("route-change"));
}
