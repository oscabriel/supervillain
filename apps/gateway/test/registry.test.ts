import { Database } from "bun:sqlite";
/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; the gateway is Bun-bound by bun:sqlite. */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { fingerprintFromActor } from "@supervillain/identity";

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

	test("reports a keyless or minted guest without inventing a matched key", () => {
		const registry = openTestRegistry();
		const guest = {
			identity: "guest",
			linkedFingerprints: [],
			matchedFingerprint: undefined,
		} as const;
		expect(registry.whoAmI()).toEqual(guest);
		expect(registry.whoAmI("guest:abc123def456")).toEqual(guest);
		registry.close();
	});

	test("reports the matched key separately from its other linked keys", async () => {
		const registry = openTestRegistry();
		const desktop = "11".repeat(32);
		const laptop = "22".repeat(32);
		registry.resolveIdentity(desktop);
		const code = await registry.mintDeviceCode(desktop);
		if ("rejected" in code) {
			throw new Error(code.message);
		}
		await registry.redeemLinkCode(code.code, laptop);

		expect(registry.whoAmI(laptop)).toEqual({
			identity: "keyed",
			linkedFingerprints: [fingerprintFromActor(desktop)],
			matchedFingerprint: fingerprintFromActor(laptop),
		});
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

	test("retires a key without disturbing its identity's other keys or rooms", async () => {
		const registry = openTestRegistry();
		const identity = registry.resolveIdentity("gm-key");
		await registry.claim("gm-key", "iron-keep");
		const code = await registry.mintDeviceCode("gm-key");
		if ("rejected" in code) {
			throw new Error(code.message);
		}
		const linked = await registry.redeemLinkCode(code.code, "homelab-key");
		expect(linked).toMatchObject({ accepted: true });

		expect(await registry.revokeKey("homelab-key", "gm-key")).toEqual({
			accepted: true,
			identityId: identity,
			remaining: ["gm-key"],
			revoked: "homelab-key",
		});
		expect(registry.isRevoked("homelab-key")).toBe(true);
		// The other key still answers, the room is still owned by the identity,
		// and the retired key is still in the class for attribution.
		expect(registry.isRevoked("gm-key")).toBe(false);
		expect(registry.ownerOf("iron-keep")).toBe(identity);
		expect(registry.actorsOf(identity)).toContain("homelab-key");
		expect(registry.liveActorsOf(identity)).toEqual(["gm-key"]);
		expect(registry.identityOf("homelab-key")).toBe(identity);
		registry.close();
	});

	test("tells apart every way a revocation can fail", async () => {
		const registry = openTestRegistry();
		const identity = registry.resolveIdentity("gm-key");
		const code = await registry.mintDeviceCode("gm-key");
		if ("rejected" in code) {
			throw new Error(code.message);
		}
		await registry.redeemLinkCode(code.code, "homelab-key");
		const stranger = registry.resolveIdentity("stranger-key");
		expect(stranger).not.toBe(identity);

		expect(await registry.revokeKey("gm-key", "gm-key")).toEqual({
			message:
				"That is the key you are using. Revoke a key from a machine you still control.",
			rejected: true,
		});
		expect(await registry.revokeKey("never-seen", "gm-key")).toEqual({
			message:
				"This gateway has never seen that key. Check it with 'supervillain key show' on the machine you are retiring.",
			rejected: true,
		});
		expect(await registry.revokeKey("stranger-key", "gm-key")).toEqual({
			message: "That key is not one of yours.",
			rejected: true,
		});
		// A guest actor is in the graph but is not a credential; retiring it
		// would promise a safety property it cannot deliver.
		const guest = registry.mintAdoptionCode("guest:abc123def456");
		if ("rejected" in guest) {
			throw new Error(guest.message);
		}
		await registry.redeemLinkCode(guest.code, "gm-key");
		expect(await registry.revokeKey("guest:abc123def456", "gm-key")).toEqual({
			message:
				"That is a guest actor, not a key. Nothing can authenticate as it, so there is nothing to retire.",
			rejected: true,
		});
		expect(await registry.revokeKey("homelab-key", "gm-key")).toMatchObject({
			accepted: true,
		});
		expect(await registry.revokeKey("homelab-key", "gm-key")).toEqual({
			message: "That key is already retired.",
			rejected: true,
		});
		// Nothing was retired by the refusals.
		expect(registry.isRevoked("gm-key")).toBe(false);
		expect(registry.isRevoked("stranger-key")).toBe(false);
		registry.close();
	});

	test("a retired key may not revoke, nor be re-linked into the graph", async () => {
		const registry = openTestRegistry();
		const first = await registry.mintDeviceCode("gm-key");
		if ("rejected" in first) {
			throw new Error(first.message);
		}
		await registry.redeemLinkCode(first.code, "homelab-key");
		await registry.revokeKey("homelab-key", "gm-key");

		// A retired key cannot mint, cannot redeem a fresh code, and cannot turn
		// around and retire the key that retired it.
		const second = await registry.mintDeviceCode("gm-key");
		if ("rejected" in second) {
			throw new Error(second.message);
		}
		expect(await registry.redeemLinkCode(second.code, "homelab-key")).toEqual({
			message: "This key has been retired.",
			rejected: true,
		});
		expect(await registry.mintDeviceCode("homelab-key")).toEqual({
			message: "This key has been retired.",
			rejected: true,
		});
		expect(await registry.revokeKey("gm-key", "homelab-key")).toEqual({
			message: "The key you are revoking with has itself been retired.",
			rejected: true,
		});
		expect(registry.isRevoked("homelab-key")).toBe(true);
		expect(registry.isRevoked("gm-key")).toBe(false);
		registry.close();
	});

	test("keeps a retirement across a reopen of the same database", async () => {
		const file = `${tmpdir()}/supervillain-revoked-${randomUUID()}.db`;
		const first = openRoomRegistry({ path: file });
		const code = await first.mintDeviceCode("gm-key");
		if ("rejected" in code) {
			throw new Error(code.message);
		}
		await first.redeemLinkCode(code.code, "homelab-key");
		expect(await first.revokeKey("homelab-key", "gm-key")).toMatchObject({
			accepted: true,
		});
		first.close();
		const second = openRoomRegistry({ path: file });
		// A retired key must never quietly become adoptable again.
		expect(second.isRevoked("homelab-key")).toBe(true);
		second.close();
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
