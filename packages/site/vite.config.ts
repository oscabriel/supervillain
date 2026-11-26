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

const protocolSnapshotPlugin = (): Plugin => {
	const buildOnly = [
		new URL("../domain/", import.meta.url).pathname,
		"/node_modules/@supervillain/domain/",
		`${import.meta.dirname}/src/ProtocolData.ts`,
	];

	return {
		name: "supervillain-protocol-snapshot",
		load(id) {
			const [file = ""] = id.split("?");

			if (file !== SNAPSHOT_FILE) {
				return null;
			}

			const snapshot = buildProtocolSnapshot();

			const filled =
				ALL_RULESETS.every(
					(ruleset) => snapshot.commands[ruleset].length > 0
				) &&
				snapshot.metaTools.length > 0 &&
				snapshot.resources.length > 0 &&
				snapshot.campaignSchemas.length > 0 &&
				snapshot.envelopeSchemaJson !== "";

			if (!filled) {
				this.error(
					"The protocol snapshot is empty, so the protocol page would ship blank."
				);
			}

			return `export const PROTOCOL_SNAPSHOT = ${JSON.stringify(snapshot)};\n`;
		},
		generateBundle(_options, bundle) {
			if (this.environment.name !== "client") {
				return;
			}

			const leaked = Object.values(bundle).flatMap((output) =>
				output.type === "chunk"
					? output.moduleIds.filter((id) =>
							buildOnly.some((part) => id.includes(part))
						)
					: []
			);

			if (leaked.length > 0) {
				this.error(
					`The client bundle holds build-only modules: ${leaked.join(", ")}.`
				);
			}
		},
	};
};

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

export default defineConfig(({ command, mode }) => {
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
		port: 3026,
		strictPort: true,
	};

	if (host !== "") {
		server.allowedHosts = ["localhost", "127.0.0.1", host];
		server.hmr = { clientPort: 443, host, protocol: "wss" };
	}

	const foldkitOptions =
		command === "serve"
			? {
					buildId: "development",
					ssr: {
						serverEntry: "/src/entry.server.ts",
						clientEntry: "/src/entry.ts",
						build: { prerender: { origin: `https://${domain}` } },
					},
				}
			: {
					ssr: {
						serverEntry: "/src/entry.server.ts",
						clientEntry: "/src/entry.ts",
						build: { prerender: { origin: `https://${domain}` } },
					},
				};

	return {
		define: {
			"import.meta.env.VITE_SITE_ORIGIN": JSON.stringify(`https://${domain}`),
			"import.meta.env.VITE_RELAY_HOST": JSON.stringify(relayHost),
			"import.meta.env.VITE_RELAY_HOST_KEY": JSON.stringify(relayKey),
			"import.meta.env.VITE_RELAY_FINGERPRINT":
				JSON.stringify(relayFingerprint),
		},
		optimizeDeps: {
			include: [
				"@foldkit/markdown",
				"effect/http",
				"foldkit > @effect/platform-browser",
			],
		},
		plugins: [
			protocolSnapshotPlugin(),
			foldkit(foldkitOptions),
			markdown({ frontmatter: Frontmatter }),
			staticAssets(),
		],
		server,
	};
});
