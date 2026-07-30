import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

/**
 * ADR-0020: production output is nitro's `bun` preset — a `.output/` tree
 * booted with plain `bun .output/server/index.mjs`. The #43 spike verified
 * this path boots, serves SSR, and drains SIGTERM out of the box (srvx).
 *
 * Experimental RSC is deliberately excluded (ADR-0020): `tanstackStart()`
 * is called without `rsc.enabled`, which defaults to off.
 */
export default defineConfig({
	plugins: [
		tanstackStart(),
		viteReact(),
		nitro({
			config: {
				// See src/server/shutdown.ts — the preset's entry has no signal
				// handling of its own.
				plugins: ["./src/server/shutdown"],
				preset: "bun",
			},
		}),
	],
});
