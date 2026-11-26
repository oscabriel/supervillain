import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { markdown } from "@foldkit/markdown/vite";
import { foldkit } from "@foldkit/vite-plugin";
import type { Plugin, ServerOptions } from "vite";
import { defineConfig, loadEnv } from "vite";

import { Frontmatter } from "./src/Frontmatter.ts";
import {
	ALL_RULESETS,
	buildProtocolSnapshot,
	ENVELOPE_SCHEMA_JSON,
	mcpCatalogDocument,
} from "./src/ProtocolData.ts";
import { parsePublicKey } from "./src/RelayInfo.ts";

const FALLBACK = "supervillain.example.com";

const INSTALLER = `${import.meta.dirname}/../../scripts/install.sh`;

const SNAPSHOT_FILE = `${import.meta.dirname}/src/ProtocolSnapshot.ts`;

const protocolSnapshotPlugin = (): Plugin => ({
	name: "supervillain-protocol-snapshot",
	load(id) {
		if (id !== SNAPSHOT_FILE) {
			return null;
		}

		return `export const PROTOCOL_SNAPSHOT = ${JSON.stringify(buildProtocolSnapshot())};\n`;
	},
});

const fingerprintOf = (rawKey: string): string => {
	const parsed = parsePublicKey(rawKey);

	if (parsed === undefined) {
		return "";
	}

	const digest = createHash("sha256")
		.update(Buffer.from(parsed.keyData, "base64"))
		.digest("base64")
		.replace(/[=]+$/u, "");

	return `SHA256:${digest}`;
};

const staticAssets = (): Plugin => ({
	name: "supervillain-static-assets",
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

		this.emitFile({
			type: "asset",
			fileName: "schemas/envelope.schema.json",
			source: `${ENVELOPE_SCHEMA_JSON}\n`,
		});

		for (const ruleset of ALL_RULESETS) {
			this.emitFile({
				type: "asset",
				fileName: `schemas/mcp/${ruleset}.json`,
				source: `${JSON.stringify(mcpCatalogDocument(ruleset), null, 2)}\n`,
			});
		}
	},
});

export default defineConfig(({ mode }) => {
	const root = `${import.meta.dirname}/../..`;
	const svEnv = loadEnv(mode, root, "SUPERVILLAIN_");
	const named = svEnv.SUPERVILLAIN_SITE_DOMAIN ?? "";
	const domain = named === "" ? FALLBACK : named;
	const relayHost = svEnv.SUPERVILLAIN_RELAY_HOST ?? "";
	const relayKey = svEnv.SUPERVILLAIN_RELAY_HOST_KEY ?? "";
	const relayFingerprint = fingerprintOf(relayKey);
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
		define: {
			"import.meta.env.VITE_SITE_ORIGIN": JSON.stringify(`https://${domain}`),
			"import.meta.env.VITE_RELAY_HOST": JSON.stringify(relayHost),
			"import.meta.env.VITE_RELAY_HOST_KEY": JSON.stringify(relayKey),
			"import.meta.env.VITE_RELAY_FINGERPRINT":
				JSON.stringify(relayFingerprint),
		},
		plugins: [
			protocolSnapshotPlugin(),
			foldkit({
				ssr: {
					serverEntry: "/src/entry.server.ts",
					clientEntry: "/src/entry.ts",
					build: { prerender: { origin: `https://${domain}` } },
				},
			}),
			markdown({ frontmatter: Frontmatter }),
			staticAssets(),
		],
		server,
	};
});
