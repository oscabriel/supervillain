import { readFile } from "node:fs/promises";

import { markdown } from "@foldkit/markdown/vite";
import { foldkit } from "@foldkit/vite-plugin";
import type { Plugin, ServerOptions } from "vite";
import { defineConfig, loadEnv } from "vite";

import { Frontmatter } from "./src/Frontmatter.ts";

const FALLBACK = "supervillain.example.com";

const INSTALLER = `${import.meta.dirname}/../../scripts/install.sh`;

const installer = (): Plugin => ({
	name: "supervillain-install",
	apply: "build",
	async generateBundle() {
		if (this.environment.name !== "client") {
			return;
		}

		this.emitFile({
			type: "asset",
			fileName: "install",
			source: await readFile(INSTALLER, "utf-8"),
		});
	},
});

export default defineConfig(({ mode }) => {
	const root = `${import.meta.dirname}/../..`;

	const named =
		loadEnv(mode, root, "SUPERVILLAIN_").SUPERVILLAIN_SITE_DOMAIN ?? "";

	const domain = named === "" ? FALLBACK : named;
	const host = loadEnv(mode, import.meta.dirname, "").CADDY_DEV_HOST ?? "";

	const server: ServerOptions = {
		host: "127.0.0.1",
		port: 3035,
		strictPort: true,
	};

	if (host !== "") {
		server.allowedHosts = ["localhost", "127.0.0.1", host];
		server.hmr = { clientPort: 443, host, protocol: "wss" };
	}

	return {
		plugins: [
			foldkit({
				ssr: {
					serverEntry: "/src/entry.server.ts",
					clientEntry: "/src/entry.ts",
					build: { prerender: { origin: `https://${domain}` } },
				},
			}),
			markdown({ frontmatter: Frontmatter }),
			installer(),
		],
		server,
	};
});
