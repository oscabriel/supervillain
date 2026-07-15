import { Database } from "bun:sqlite";
/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; the gateway is Bun-bound by bun:sqlite. */
import { describe, expect, test } from "bun:test";

import { migrate } from "../src/migrate.js";
import { openRoomRegistry } from "../src/registry.js";

const openTestRegistry = () =>
	openRoomRegistry({
		clock: () => "2026-07-14T00:00:00.000Z",
		path: ":memory:",
		sshHost: "supervillain.test",
		sshPort: 2222,
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
	test("registers a name and resolves it to the host address", async () => {
		const registry = openTestRegistry();
		const outcome = await registry.register("gm-key", {
			address: "iroh:host-a",
			name: "iron-keep",
		});
		expect(outcome).toEqual({
			accepted: true,
			sshHost: "supervillain.test",
			sshPort: 2222,
		});
		expect(registry.resolve("iron-keep")).toBe("iroh:host-a");
		expect(registry.resolve("unknown")).toBe(undefined);
		registry.close();
	});

	test("lets the owning key update its address but rejects other keys", async () => {
		const registry = openTestRegistry();
		await registry.register("gm-key", {
			address: "iroh:host-a",
			name: "iron-keep",
		});
		const updated = await registry.register("gm-key", {
			address: "iroh:host-b",
			name: "iron-keep",
		});
		expect(updated).toMatchObject({ accepted: true });
		expect(registry.resolve("iron-keep")).toBe("iroh:host-b");
		const stolen = await registry.register("thief-key", {
			address: "iroh:host-c",
			name: "iron-keep",
		});
		expect(stolen).toEqual({
			message: "The name 'iron-keep' is already claimed by another key.",
			rejected: true,
		});
		expect(registry.resolve("iron-keep")).toBe("iroh:host-b");
		registry.close();
	});
});
