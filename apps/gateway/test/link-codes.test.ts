/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; the gateway store is Bun-bound by bun:sqlite. */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import type { IdentityDirectory } from "@supervillain/identity";

import { openRoomRegistry } from "../src/registry.js";
import type { GatewayRoomRegistry } from "../src/registry.js";

const DESKTOP = "a".repeat(64);
const LAPTOP = "b".repeat(64);
const PHONE = "c".repeat(64);
const GUEST = "guest:abc123def456";

/** A clock the test drives, so a seven-day expiry is a fact this suite can
 * reach without waiting seven days. */
const at = (iso: string) => () => iso;

const DAY_ONE = "2026-07-25T00:00:00.000Z";
const DAY_FOUR = "2026-07-29T00:00:00.000Z";
const DAY_NINE = "2026-08-03T00:00:00.000Z";

const openAt = (iso: string, path = ":memory:"): GatewayRoomRegistry =>
	openRoomRegistry({ clock: at(iso), path });

const mintDevice = async (
	registry: GatewayRoomRegistry,
	key: string
): Promise<string> => {
	const minted = await registry.mintDeviceCode(key);
	if ("rejected" in minted) {
		throw new Error(minted.message);
	}
	return minted.code;
};

describe("device linking", () => {
	test("a fresh key redeems an established key's code and both become one identity", async () => {
		const registry = openAt(DAY_ONE);
		const desktopIdentity = registry.resolveIdentity(DESKTOP);
		const code = await mintDevice(registry, DESKTOP);
		expect(await registry.redeemLinkCode(code, LAPTOP)).toEqual({
			accepted: true,
			identityId: desktopIdentity,
			linked: DESKTOP,
		});
		expect(registry.identityOf(LAPTOP)).toBe(desktopIdentity);
		expect(registry.identityOf(DESKTOP)).toBe(desktopIdentity);
		expect([...registry.actorsOf(desktopIdentity)].toSorted()).toEqual(
			[DESKTOP, LAPTOP].toSorted()
		);
		registry.close();
	});

	test("a linked key does not take the room's ownership with it", async () => {
		const registry = openAt(DAY_ONE);
		await registry.claim(DESKTOP, "iron-keep");
		const owner = registry.ownerOf("iron-keep");
		const code = await mintDevice(registry, DESKTOP);
		await registry.redeemLinkCode(code, LAPTOP);
		// GM roaming with no mechanism of its own: the laptop's claim resolves to
		// the same identity, so the name does not change hands.
		expect(await registry.claim(LAPTOP, "iron-keep")).toMatchObject({
			accepted: true,
		});
		expect(registry.ownerOf("iron-keep")).toBe(owner);
		registry.close();
	});

	test("a device code is single use", async () => {
		const registry = openAt(DAY_ONE);
		const code = await mintDevice(registry, DESKTOP);
		await registry.redeemLinkCode(code, LAPTOP);
		expect(await registry.redeemLinkCode(code, PHONE)).toEqual({
			message: "That link code has already been used.",
			rejected: true,
		});
		registry.close();
	});

	test("a device code expires after fifteen minutes", async () => {
		const file = `${tmpdir()}/supervillain-device-${randomUUID()}.db`;
		const registry = openRoomRegistry({ clock: at(DAY_ONE), path: file });
		const minted = await registry.mintDeviceCode(DESKTOP);
		if ("rejected" in minted) {
			throw new Error(minted.message);
		}
		expect(minted.code).toHaveLength(8);
		expect(minted.expiresAt).toBe("2026-07-25T00:15:00.000Z");
		registry.close();

		const later = openRoomRegistry({
			clock: () => "2026-07-25T00:16:00.000Z",
			path: file,
		});
		expect(await later.redeemLinkCode(minted.code, LAPTOP)).toEqual({
			message: "That link code has expired.",
			rejected: true,
		});
		later.close();
		await rm(file, { force: true });
	});

	test("refuses an unknown code", async () => {
		const registry = openAt(DAY_ONE);
		expect(await registry.redeemLinkCode("ZZZZZZZZ", LAPTOP)).toEqual({
			message: "That link code is not valid.",
			rejected: true,
		});
		registry.close();
	});

	test("refuses a key that already holds an identity of its own", async () => {
		const registry = openAt(DAY_ONE);
		registry.resolveIdentity(LAPTOP);
		await registry.claim(LAPTOP, "wine-cellar");
		const code = await mintDevice(registry, DESKTOP);
		expect(await registry.redeemLinkCode(code, LAPTOP)).toMatchObject({
			rejected: true,
		});
		registry.close();
	});

	test("says so when a key is already linked to that identity", async () => {
		const registry = openAt(DAY_ONE);
		const code = await mintDevice(registry, DESKTOP);
		await registry.redeemLinkCode(code, LAPTOP);
		const again = await mintDevice(registry, DESKTOP);
		expect(await registry.redeemLinkCode(again, LAPTOP)).toEqual({
			message: "This key is already linked to that identity.",
			rejected: true,
		});
		registry.close();
	});

	test("codes are typed by hand, so case and hyphens are noise", async () => {
		const registry = openAt(DAY_ONE);
		const code = await mintDevice(registry, DESKTOP);
		expect(
			await registry.redeemLinkCode(` ${code.toLowerCase()}-`, LAPTOP)
		).toMatchObject({ accepted: true });
		registry.close();
	});
});

describe("guest adoption", () => {
	test("a code minted during a session still redeems seven days later, across a restart", async () => {
		const file = `${tmpdir()}/supervillain-adoption-${randomUUID()}.db`;
		const session = openRoomRegistry({ clock: at(DAY_ONE), path: file });
		const minted = session.mintAdoptionCode(GUEST);
		if ("rejected" in minted) {
			throw new Error(minted.message);
		}
		expect(minted.code).toHaveLength(10);
		expect(minted.expiresAt).toBe("2026-08-01T00:00:00.000Z");
		session.close();

		// The gateway restarts; four days pass; the guest installs the CLI.
		const later = openRoomRegistry({ clock: at(DAY_FOUR), path: file });
		const redeemed = await later.redeemLinkCode(minted.code, LAPTOP);
		expect(redeemed).toMatchObject({ accepted: true, linked: GUEST });
		expect(later.identityOf(GUEST)).toBe(later.identityOf(LAPTOP));
		later.close();
		await rm(file, { force: true });
	});

	test("an adoption code past seven days is refused", async () => {
		const file = `${tmpdir()}/supervillain-adoption-${randomUUID()}.db`;
		const session = openRoomRegistry({ clock: at(DAY_ONE), path: file });
		const minted = session.mintAdoptionCode(GUEST);
		if ("rejected" in minted) {
			throw new Error(minted.message);
		}
		session.close();

		const later = openRoomRegistry({ clock: at(DAY_NINE), path: file });
		expect(await later.redeemLinkCode(minted.code, LAPTOP)).toEqual({
			message: "That link code has expired.",
			rejected: true,
		});
		later.close();
		await rm(file, { force: true });
	});

	test("a guest is adopted once", async () => {
		const registry = openAt(DAY_ONE);
		const first = registry.mintAdoptionCode(GUEST);
		const second = registry.mintAdoptionCode(GUEST);
		if ("rejected" in first || "rejected" in second) {
			throw new Error("mint failed");
		}
		await registry.redeemLinkCode(first.code, LAPTOP);
		expect(await registry.redeemLinkCode(second.code, PHONE)).toEqual({
			message: "That guest has already been adopted.",
			rejected: true,
		});
		registry.close();
	});
});

describe("derived linking facts", () => {
	test("names the actors a room's roster is missing, anchored on one it knows", async () => {
		const registry = openAt(DAY_ONE);
		const code = await mintDevice(registry, DESKTOP);
		await registry.redeemLinkCode(code, LAPTOP);
		expect(await registry.resolveActorLinks([DESKTOP])).toEqual([
			{ actor: LAPTOP, linked: DESKTOP },
		]);
		registry.close();
	});

	test("returns nothing when the roster already carries both actors", async () => {
		const registry = openAt(DAY_ONE);
		const code = await mintDevice(registry, DESKTOP);
		await registry.redeemLinkCode(code, LAPTOP);
		expect(await registry.resolveActorLinks([DESKTOP, LAPTOP])).toEqual([]);
		registry.close();
	});

	test("reaches an adopted guest from the key that adopted it", async () => {
		const registry = openAt(DAY_ONE);
		const minted = registry.mintAdoptionCode(GUEST);
		if ("rejected" in minted) {
			throw new Error(minted.message);
		}
		await registry.redeemLinkCode(minted.code, LAPTOP);
		expect(await registry.resolveActorLinks([GUEST])).toEqual([
			{ actor: LAPTOP, linked: GUEST },
		]);
		registry.close();
	});

	test("knows nothing about actors the graph has never seen", async () => {
		const registry = openAt(DAY_ONE);
		expect(await registry.resolveActorLinks([DESKTOP, GUEST])).toEqual([]);
		registry.close();
	});

	test("the schema holds no queue of pending linkings", async () => {
		const file = `${tmpdir()}/supervillain-schema-${randomUUID()}.db`;
		const store = openRoomRegistry({ clock: at(DAY_ONE), path: file });
		store.close();
		// A queue would be a staler second copy of a computable fact (ADR-0013),
		// so the assertion is against the schema itself: these tables and no
		// others.
		const { Database } = await import("bun:sqlite");
		const raw = new Database(file, { strict: true });
		const tables = raw
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
			)
			.all()
			.map((row) => row.name);
		raw.close();
		await rm(file);
		expect(tables).toEqual([
			"identities",
			"identity_keys",
			"link_codes",
			"rooms",
		]);
	});
});

describe("the identity directory", () => {
	test("resolution and the revoked check are local reads", () => {
		const registry = openAt(DAY_ONE);
		// A structural assertion, not a ceremony: the gateway store *is*
		// ADR-0013's local implementation, and both answers are synchronous
		// because they must work with no network and no backend in existence.
		const directory: IdentityDirectory = registry;
		const identity = registry.resolveIdentity(DESKTOP);
		expect(directory.identityOf(DESKTOP)).toBe(identity);
		expect(directory.isRevoked(DESKTOP)).toBe(false);
		registry.close();
	});

	test("an unknown key is unknown, not revoked, and is never minted by a read", () => {
		const registry = openAt(DAY_ONE);
		expect(registry.identityOf(PHONE)).toBeUndefined();
		expect(registry.isRevoked(PHONE)).toBe(false);
		expect(registry.identityOf(PHONE)).toBeUndefined();
		registry.close();
	});

	test("a revoked key may not mint or redeem", async () => {
		const file = `${tmpdir()}/supervillain-revoked-${randomUUID()}.db`;
		const registry = openRoomRegistry({ clock: at(DAY_ONE), path: file });
		const code = await mintDevice(registry, DESKTOP);
		const identity = registry.resolveIdentity(LAPTOP);
		expect(identity).toBeDefined();
		registry.close();

		// #59 owns the `key revoke` verb; this asserts only that the column the
		// refusal reads is here and already honoured.
		const { Database } = await import("bun:sqlite");
		const raw = new Database(file, { create: true, strict: true });
		raw.run(`UPDATE identity_keys SET revoked = 1 WHERE key = '${LAPTOP}'`);
		raw.close();

		const reopened = openRoomRegistry({ clock: at(DAY_ONE), path: file });
		expect(reopened.isRevoked(LAPTOP)).toBe(true);
		expect(await reopened.redeemLinkCode(code, LAPTOP)).toEqual({
			message: "This key has been retired.",
			rejected: true,
		});
		expect(await reopened.mintDeviceCode(LAPTOP)).toEqual({
			message: "This key has been retired.",
			rejected: true,
		});
		reopened.close();
		await rm(file, { force: true });
	});
});
