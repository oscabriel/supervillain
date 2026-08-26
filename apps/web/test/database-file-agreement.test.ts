/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; the web store is Bun-bound by bun:sqlite. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DATABASE_FILE, openBackendStore } from "../src/server/store";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
	);
});

describe("web database filename", () => {
	test("agrees with the infra recovery contract", async () => {
		const root = await mkdtemp(
			path.join(tmpdir(), "supervillain-web-db-name-")
		);
		roots.push(root);
		const stateRoot = path.join(root, "state");
		mkdirSync(stateRoot, { recursive: true });

		const store = openBackendStore({
			stateRoot,
			tokenKeyPath: path.join(root, "secrets", "web-token-key"),
		});
		store.close();

		const topLevelFiles = readdirSync(stateRoot, {
			withFileTypes: true,
		})
			.filter((entry) => entry.isFile())
			.map((entry) => entry.name);
		expect(topLevelFiles).toEqual([DATABASE_FILE]);

		// infra/files/litestream.yml replicates every "*.db" file recursively
		// under /var/lib/supervillain; a suffix outside that glob (the old
		// "web.sqlite") would leave the web store unreplicated and restore-drill
		// restoring a key nothing produces.
		expect(DATABASE_FILE).toMatch(/\.db$/u);
		expect(DATABASE_FILE.endsWith(".db")).toBe(true);
	});
});
