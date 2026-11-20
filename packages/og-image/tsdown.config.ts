import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts"],
	format: "esm",
	platform: "neutral",
	dts: true,
	outDir: "dist",
	hash: false,
	// Resolved by the Workers runtime. Peer dependencies (astro, emdash) stay external by default.
	deps: { neverBundle: [/^cloudflare:/] },
});
