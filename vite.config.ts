import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { defineConfig } from "vite";

// Server-only packages (AWS SDK, @smithy, proxy-agent, etc.) transitively
// import Node.js built-ins. These never execute in the browser but both
// esbuild (dev) and Rollup (build) need valid exports to resolve them.
// Alias every Node built-in to a single stub file with no-op exports.
const stub = path.resolve(__dirname, "src/node-stub/index.ts");

const nodeBuiltins = [
	"assert",
	"async_hooks",
	"buffer",
	"child_process",
	"cluster",
	"console",
	"crypto",
	"dgram",
	"diagnostics_channel",
	"dns",
	"events",
	"fs",
	"fs/promises",
	"http",
	"http2",
	"https",
	"net",
	"os",
	"path",
	"perf_hooks",
	"process",
	"querystring",
	"readline",
	"sqlite",
	"stream",
	"string_decoder",
	"timers",
	"tls",
	"url",
	"util",
	"util/types",
	"vm",
	"worker_threads",
	"zlib",
];

// Use RegExp for exact matching so "util" doesn't prefix-match "util/types"
// causing Vite to try opening stub/types as a path.
// Order: longer paths first so "fs/promises" matches before "fs".
const sorted = [...nodeBuiltins].sort((a, b) => b.length - a.length);
const alias = sorted.flatMap((mod) => {
	const escaped = mod.replace(/\//g, "\\/");
	return [
		{ find: new RegExp(`^${escaped}$`), replacement: stub },
		{ find: new RegExp(`^node:${escaped}$`), replacement: stub },
	];
});

export default defineConfig({
	plugins: [tailwindcss()],
	resolve: { alias },
});
