/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; the web store is Bun-bound by bun:sqlite. */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { migrate } from "../src/server/migrate";
import {
	assertSchemaMatchesMigrations,
	MIGRATIONS,
} from "../src/server/schema";
import { openBackendStore, DATABASE_FILE } from "../src/server/store";

const document = {
	artifactType: "character",
	card: {
		description: "A test snapshot",
		fields: [],
		title: "Doctor Malignant",
	},
	schemaVersion: 1,
	sections: [],
} as const;

const roots: string[] = [];

const makeRoot = async (): Promise<string> => {
	const root = await mkdtemp(path.join(tmpdir(), "supervillain-web-store-"));
	roots.push(root);
	return root;
};

const openTestStore = async () => {
	const root = await makeRoot();
	return {
		root,
		store: openBackendStore({
			stateRoot: path.join(root, "state"),
			tokenKeyPath: path.join(root, "secrets", "web-token-key"),
		}),
	};
};

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
	);
});

describe("backend migrations", () => {
	test("apply once and retain exactly the three pinned durable tables", () => {
		const sqlite = new Database(":memory:", { strict: true });
		migrate(sqlite, MIGRATIONS);
		migrate(sqlite, MIGRATIONS);

		const version = sqlite.query("PRAGMA user_version").get() as {
			readonly user_version: number;
		};
		const tables = sqlite
			.query(
				"SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
			)
			.all() as readonly { readonly name: string }[];
		expect(version.user_version).toBe(MIGRATIONS.length);
		expect(tables.map(({ name }) => name)).toEqual([
			"capability_tokens",
			"dead_token_tombstones",
			"published_artifacts",
		]);
		assertSchemaMatchesMigrations(sqlite);
		sqlite.close();
	});

	test("schema drift fails loudly", () => {
		const sqlite = new Database(":memory:", { strict: true });
		migrate(sqlite, MIGRATIONS);
		sqlite.run("ALTER TABLE published_artifacts ADD COLUMN game_state TEXT");
		expect(() => assertSchemaMatchesMigrations(sqlite)).toThrow(
			/Schema drift.*game_state/u
		);
		sqlite.close();
	});
});

describe("backend store", () => {
	test("round-trips a snapshot through its durable file pointer", async () => {
		const { root, store } = await openTestStore();
		const capability = store.ingestArtifact({
			document,
			name: "Doctor Malignant",
			ownerIdentity: "identity-1",
			type: "character",
		});
		const snapshotNames = readdirSync(path.join(root, "state", "snapshots"));
		expect(snapshotNames).toHaveLength(1);
		expect(snapshotNames[0]).toMatch(/^[0-9a-f-]+\.json$/u);
		expect(
			JSON.parse(
				readFileSync(
					path.join(root, "state", "snapshots", snapshotNames[0] ?? ""),
					"utf-8"
				)
			)
		).toEqual(document);
		store.close();
		expect(
			readFileSync(path.join(root, "state", "store.db")).includes(capability)
		).toBe(false);

		const reopened = openBackendStore({
			stateRoot: path.join(root, "state"),
			tokenKeyPath: path.join(root, "secrets", "web-token-key"),
		});
		expect(reopened.getArtifact(capability)).toEqual({
			document,
			name: "Doctor Malignant",
			type: "character",
		});
		reopened.close();
	});

	test("tombstones make a capability dead forever and republish mints fresh", async () => {
		const root = await makeRoot();
		const seeds = [
			Buffer.alloc(32, 1),
			Buffer.alloc(32, 1),
			Buffer.alloc(32, 2),
		];
		let seedCalls = 0;
		const store = openBackendStore({
			newSeed: () => {
				const seed = seeds[seedCalls];
				seedCalls += 1;
				if (!seed) {
					throw new Error("test exhausted its capability seeds");
				}
				return seed;
			},
			stateRoot: path.join(root, "state"),
			tokenKeyPath: path.join(root, "secrets", "web-token-key"),
		});
		const key = {
			name: "Doctor Malignant",
			ownerIdentity: "identity-1",
			type: "character" as const,
		};
		const first = store.ingestArtifact({ ...key, document });
		expect(store.revokeArtifact(key)).toBe(true);
		expect(store.getArtifact(first)).toBeUndefined();

		const second = store.ingestArtifact({ ...key, document });
		expect(second).not.toBe(first);
		expect(seedCalls).toBe(3);
		expect(store.getArtifact(first)).toBeUndefined();
		expect(store.getArtifact(second)?.name).toBe("Doctor Malignant");
		store.close();
	});

	test("persists no game-derived state outside the pushed snapshot document", async () => {
		const { root, store } = await openTestStore();
		const forbiddenCanary = `game-fold-${randomUUID()}`;
		const documentCanary = `snapshot-${randomUUID()}`;
		const input = {
			document: {
				...document,
				card: { ...document.card, description: documentCanary },
			},
			gameFold: forbiddenCanary,
			name: "safe-name",
			ownerIdentity: "identity-1",
			type: "character" as const,
		};
		store.ingestArtifact(input);
		store.close();

		const files = readdirSync(root, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => path.join(entry.parentPath, entry.name));
		const durableBytes = files.map((file) => readFileSync(file));
		const databaseBytes = readFileSync(path.join(root, "state", "store.db"));
		const snapshotBytes = files
			.filter((file) => file.endsWith(".json"))
			.map((file) => readFileSync(file));
		expect(durableBytes.some((bytes) => bytes.includes(forbiddenCanary))).toBe(
			false
		);
		expect(databaseBytes.includes(documentCanary)).toBe(false);
		expect(snapshotBytes.some((bytes) => bytes.includes(documentCanary))).toBe(
			true
		);
	});

	test("creates the token key outside the state tree with private permissions", async () => {
		const root = await makeRoot();
		const stateRoot = path.join(root, "state");
		const tokenKeyPath = path.join(root, "secrets", "web-token-key");
		mkdirSync(stateRoot, { recursive: true });
		const store = openBackendStore({ stateRoot, tokenKeyPath });
		store.close();
		const key = readFileSync(tokenKeyPath);
		expect(key.byteLength).toBe(32);
		// oxlint-disable-next-line eslint/no-bitwise -- Unix permission masks are bit fields.
		expect(statSync(tokenKeyPath).mode & 0o777).toBe(0o600);
	});

	test("migrates a legacy web.sqlite over to store.db on open", async () => {
		const root = await makeRoot();
		const stateRoot = path.join(root, "state");
		mkdirSync(stateRoot, { recursive: true });
		const legacyCanary = `legacy-${randomUUID()}`;
		// A real-shaped database with known durable bytes: built from the pinned
		// migrations like a deployed box's `web.sqlite` would be, so the migrated
		// file opens cleanly through drizzle's schema assertions.
		const legacy = new Database(path.join(stateRoot, "web.sqlite"), {
			strict: true,
		});
		migrate(legacy, MIGRATIONS);
		legacy.run(
			"INSERT INTO published_artifacts (id, name, owner_identity, published_at, snapshot_path, type) VALUES (?, ?, ?, ?, ?, ?)",
			[randomUUID(), legacyCanary, "identity-1", "2026-08-26T00:00:00Z", "snapshots/x.json", "character"]
		);
		legacy.close();

		const store = openBackendStore({
			stateRoot,
			tokenKeyPath: path.join(root, "secrets", "web-token-key"),
		});
		store.close();

		expect(existsSync(path.join(stateRoot, "web.sqlite"))).toBe(false);
		const migratedBytes = readFileSync(
			path.join(stateRoot, DATABASE_FILE)
		).toString("utf-8");
		expect(migratedBytes.includes(legacyCanary)).toBe(true);

		const reopened = openBackendStore({
			stateRoot,
			tokenKeyPath: path.join(root, "secrets", "web-token-key"),
		});
		reopened.close();
	});
});
