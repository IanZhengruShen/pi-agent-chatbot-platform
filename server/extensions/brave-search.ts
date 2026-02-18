/**
 * Brave Search extension for the pi agent.
 *
 * Registers a `web_search` tool that calls the Brave Web Search API.
 * Requires `BRAVE_SEARCH_API_KEY` in the process environment.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function braveSearchExtension(pi: ExtensionAPI) {
	const apiKey = process.env.BRAVE_SEARCH_API_KEY;
	if (!apiKey) {
		console.warn("[brave-search] BRAVE_SEARCH_API_KEY not set, skipping tool registration");
		return;
	}

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web using Brave Search. Use this when you need current information, facts, documentation, or anything beyond your training data.",
		parameters: Type.Object({
			query: Type.String({ description: "The search query" }),
			count: Type.Optional(Type.Number({ description: "Number of results to return (1-10, default 5)" })),
		}),
		async execute(_toolCallId, params) {
			const count = Math.min(Math.max(params.count ?? 5, 1), 10);

			const url = new URL("https://api.search.brave.com/res/v1/web/search");
			url.searchParams.set("q", params.query);
			url.searchParams.set("count", String(count));

			const response = await fetch(url.toString(), {
				headers: {
					Accept: "application/json",
					"Accept-Encoding": "gzip",
					"X-Subscription-Token": apiKey,
				},
			});

			if (!response.ok) {
				const body = await response.text().catch(() => "");
				throw new Error(`Brave Search API error ${response.status}: ${body}`);
			}

			const data = (await response.json()) as BraveSearchResponse;
			const results = data.web?.results ?? [];

			if (results.length === 0) {
				return {
					content: [{ type: "text", text: `No results found for: ${params.query}` }],
					details: {},
				};
			}

			const formatted = results
				.map((r, i) => `${i + 1}. [${r.title}](${r.url})\n   ${r.description ?? "No description"}`)
				.join("\n\n");

			return {
				content: [{ type: "text", text: formatted }],
				details: {},
			};
		},
	});
}

interface BraveSearchResult {
	title: string;
	url: string;
	description?: string;
}

interface BraveSearchResponse {
	web?: {
		results: BraveSearchResult[];
	};
}
