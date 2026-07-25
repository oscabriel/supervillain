import { Database } from "bun:sqlite";
/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; the gateway is Bun-bound by bun:sqlite. */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { migrate } from "../src/migrate.js";
import { openRoomRegistry } from "../src/registry.js";

const openTestRegistry = () =>
	openRoomRegistry({
		clock: () => "2026-07-14T00:00:00.000Z",
		path: ":memory:",
	});

describe("migrate", () => {
	test("applies pending steps once and records the version", () => {
		const db = new Database(":memory:");
		const steps = [
			"CREATE TABLE a (x TEXT)",
			"CREATE TABLE b (y TEXT)",
		] as const;
		migrate(db, steps);
		migrate(db, steps);
		const version = db.query("PRAGMA user_version").get() as {
			user_version: number;
		};
		expect(version.user_version).toBe(2);
		db.run("INSERT INTO a (x) VALUES ('1')");
		db.run("INSERT INTO b (y) VALUES ('2')");
		db.close();
	});

	test("applies only the missing suffix on upgrade", () => {
		const db = new Database(":memory:");
		migrate(db, ["CREATE TABLE a (x TEXT)"]);
		migrate(db, ["CREATE TABLE a (x TEXT)", "CREATE TABLE b (y TEXT)"]);
		const version = db.query("PRAGMA user_version").get() as {
			user_version: number;
		};
		expect(version.user_version).toBe(2);
		db.close();
	});
});

describe("openRoomRegistry", () => {
	test("claims a name for the key's owner identity", async () => {
		const registry = openTestRegistry();
		const outcome = await registry.claim("gm-key", "iron-keep");
		expect(outcome).toEqual({
			accepted: true,
			ownerId: registry.resolveIdentity("gm-key"),
		});
		expect(registry.isClaimed("iron-keep")).toBe(true);
		expect(registry.isClaimed("unknown")).toBe(false);
		registry.close();
	});

	test("resolves one key to one stable identity", () => {
		const registry = openTestRegistry();
		const first = registry.resolveIdentity("gm-key");
		expect(registry.resolveIdentity("gm-key")).toBe(first);
		// No linking exists yet: a second key is a second identity, which is
		// exactly why GM roaming does not work until ADR-0005 lands.
		expect(registry.resolveIdentity("laptop-key")).not.toBe(first);
		registry.close();
	});

	test("lets the owning identity renew but rejects another key", async () => {
		const registry = openTestRegistry();
		await registry.claim("gm-key", "iron-keep");
		const renewed = await registry.claim("gm-key", "iron-keep");
		expect(renewed).toMatchObject({ accepted: true });
		const stolen = await registry.claim("thief-key", "iron-keep");
		expect(stolen).toEqual({
			message: "The name 'iron-keep' is already claimed by another key.",
			rejected: true,
		});
		expect(registry.ownerOf("iron-keep")).toBe(
			registry.resolveIdentity("gm-key")
		);
		registry.close();
	});

	test("carries an iroh-era registration through the address column's death", async () => {
		const file = `${tmpdir()}/supervillain-legacy-${randomUUID()}.db`;
		const legacy = new Database(file, { create: true, strict: true });
		legacy.run(
			`CREATE TABLE rooms (
				name TEXT PRIMARY KEY,
				address TEXT NOT NULL,
				owner TEXT NOT NULL,
				updated_at TEXT NOT NULL
			) STRICT`
		);
		legacy.run("PRAGMA user_version = 1");
		legacy.run(
			"INSERT INTO rooms (name, address, owner, updated_at) VALUES ('iron-keep', 'ws://old.test:9000', 'gm-key', '2026-07-14T00:00:00.000Z')"
		);
		legacy.close();
		const registry = openRoomRegistry({ path: file });
		expect(registry.isClaimed("iron-keep")).toBe(true);
		expect(registry.ownerOf("iron-keep")).toBe(
			registry.resolveIdentity("gm-key")
		);
		expect(await registry.claim("gm-key", "iron-keep")).toMatchObject({
			accepted: true,
		});
		expect(await registry.claim("thief-key", "iron-keep")).toMatchObject({
			rejected: true,
		});
		registry.close();
		await rm(file, { force: true });
	});

	test("keeps a claimed name across a reopen of the same database", async () => {
		const file = `${tmpdir()}/supervillain-registry-${randomUUID()}.db`;
		const first = openRoomRegistry({ path: file });
		await first.claim("gm-key", "iron-keep");
		const owner = first.ownerOf("iron-keep");
		first.close();
		const second = openRoomRegistry({ path: file });
		expect(second.ownerOf("iron-keep")).toBe(owner);
		second.close();
		await rm(file, { force: true });
	});
});
