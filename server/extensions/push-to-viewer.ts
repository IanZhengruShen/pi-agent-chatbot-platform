/**
 * Push-to-viewer extension for the pi agent.
 *
 * Registers a `push_to_viewer` tool that the agent can call after creating
 * a file via bash. The tool's `file_path` parameter is detected by the
 * existing bridge in main.ts, which fetches the file via /api/agent-files
 * and renders it in the browser's artifact viewer.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function pushToViewerExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "push_to_viewer",
		label: "Push to Viewer",
		description:
			"Push a file to the user's browser for visual rendering. " +
			"Supported formats: .pptx (slide viewer with navigation), .pdf (document pages), " +
			".docx (document viewer), .xlsx (spreadsheet tables), .html (full rendering with JS), .svg, .md, images, and code files. " +
			"Use this after creating files via bash (e.g., with python-pptx, reportlab, python-docx, plotly). " +
			"The file must exist on disk. The browser will automatically render it with the appropriate viewer. " +
			"For interactive charts/plots, generate a self-contained .html file using libraries like Plotly " +
			"(fig.write_html with include_plotlyjs='cdn' or True), Bokeh, or Altair. " +
			"Trusted CDNs (cdn.plot.ly, cdn.jsdelivr.net, cdnjs.cloudflare.com, unpkg.com, d3js.org) are allowed.",
		parameters: Type.Object({
			file_path: Type.String({ description: "Absolute path to the file on disk" }),
		}),
		async execute(_toolCallId, params) {
			const fs = await import("node:fs/promises");
			const path = await import("node:path");
			const stats = await fs.stat(params.file_path);
			const filename = path.basename(params.file_path);
			return {
				content: [{ type: "text", text: `Pushed ${filename} (${(stats.size / 1024).toFixed(1)} KB) to viewer.` }],
				details: {},
			};
		},
	});
}
