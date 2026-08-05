/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; the preference store uses bun:sqlite. */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { tablePreferenceAdapter } from "../src/index.js";
import { openRoomRegistry } from "../src/registry.js";

describe("gateway presentation preferences", () => {
	test("migrates and retains preferences across a registry reopen", async () => {
		const file = `${tmpdir()}/supervillain-prefs-${randomUUID()}.db`;
		const first = openRoomRegistry({ path: file });
		const identityId = first.resolveIdentity("key");
		expect(first.presentationPreferences(identityId)).toEqual({});
		first.setPresentationPreference(identityId, "focusMarker", false);
		first.setPresentationPreference(identityId, "feedRail", true);
		first.close();

		const reopened = openRoomRegistry({ path: file });
		expect(reopened.presentationPreferences(identityId)).toEqual({
			feedRail: true,
			focusMarker: false,
		});
		reopened.close();
		await rm(file, { force: true });
	});

	test("reads and writes all nullable rows by resolved linked identity", async () => {
		const registry = openRoomRegistry({ path: ":memory:" });
		const desktop = "11".repeat(32);
		const laptop = "22".repeat(32);
		const identityId = registry.resolveIdentity(desktop);
		registry.setPresentationPreference(identityId, "focusMarker", true);
		registry.setPresentationPreference(identityId, "feedRail", true);
		const code = await registry.mintDeviceCode(desktop);
		if ("rejected" in code) {
			throw new Error(code.message);
		}
		await registry.redeemLinkCode(code.code, laptop);

		const laptopRound = tablePreferenceAdapter({
			actor: laptop,
			keyed: true,
			registry,
			sessionPreferences: {},
		});
		expect(laptopRound.viewOptions).toEqual({
			feedRail: true,
			focusMarker: true,
		});
		laptopRound.onPreferenceChange({
			preference: "sidebarRail",
			value: true,
		});

		const desktopReconnect = tablePreferenceAdapter({
			actor: desktop,
			keyed: true,
			registry,
			sessionPreferences: {},
		});
		expect(desktopReconnect.viewOptions).toEqual({
			feedRail: true,
			focusMarker: true,
			sidebarRail: true,
		});
		registry.close();
	});

	test("folding merges prefs: explicit beats unset, destination wins conflicts, no orphan survives", async () => {
		// #127 / ADR-0008 (amended 2026-08-05). The fold runs on the registry's own
		// connection, where PRAGMA foreign_keys is ON — so the fold *succeeding* is
		// itself proof the source row died before its identity did.
		const file = `${tmpdir()}/supervillain-fold-${randomUUID()}.db`;
		const registry = openRoomRegistry({ path: file });
		const desktop = "11".repeat(32);
		const laptop = "22".repeat(32);
		const destination = registry.resolveIdentity(desktop);
		registry.setPresentationPreference(destination, "feedRail", true);
		registry.setPresentationPreference(destination, "focusMarker", true);
		const source = registry.resolveIdentity(laptop);
		// True conflict on feedRail (destination must win) and an explicit
		// sidebarRail choice the destination never made (must survive the fold).
		registry.setPresentationPreference(source, "feedRail", false);
		registry.setPresentationPreference(source, "sidebarRail", true);

		const code = await registry.mintDeviceCode(desktop);
		if ("rejected" in code) {
			throw new Error(code.message);
		}
		const outcome = await registry.redeemLinkCode(code.code, laptop);
		expect("accepted" in outcome).toBe(true);

		expect(registry.presentationPreferences(destination)).toEqual({
			feedRail: true,
			focusMarker: true,
			sidebarRail: true,
		});
		expect(registry.presentationPreferences(source)).toEqual({});
		registry.close();

		const raw = new Database(file, { strict: true });
		const orphans = raw
			.query(
				`SELECT COUNT(*) AS count FROM presentation_preferences
				 WHERE identity_id NOT IN (SELECT id FROM identities)`
			)
			.get() as { count: number };
		expect(orphans.count).toBe(0);
		raw.close();
		await rm(file, { force: true });
	});

	test("folding into an identity with no prefs row carries the source's choices over", async () => {
		// The player-mints-on-the-new-machine ordering (#127): the established,
		// prefs-carrying identity is the *source*. Row-level destination-wins
		// would have silently discarded these.
		const registry = openRoomRegistry({ path: ":memory:" });
		const fresh = "33".repeat(32);
		const veteran = "44".repeat(32);
		const destination = registry.resolveIdentity(fresh);
		const source = registry.resolveIdentity(veteran);
		registry.setPresentationPreference(source, "feedRail", true);
		registry.setPresentationPreference(source, "focusMarker", false);

		const code = await registry.mintDeviceCode(fresh);
		if ("rejected" in code) {
			throw new Error(code.message);
		}
		const outcome = await registry.redeemLinkCode(code.code, veteran);
		expect("accepted" in outcome).toBe(true);

		expect(registry.presentationPreferences(destination)).toEqual({
			feedRail: true,
			focusMarker: false,
		});
		expect(registry.presentationPreferences(source)).toEqual({});
		registry.close();
	});

	test("foreign keys are enforced on the registry's connection", () => {
		// Behavioral proof that PRAGMA foreign_keys is ON where it matters: a
		// pref write for an identity that does not exist throws at the write
		// site instead of planting an orphan (#127).
		const registry = openRoomRegistry({ path: ":memory:" });
		expect(() => {
			registry.setPresentationPreference("no-such-identity", "feedRail", true);
		}).toThrow();
		registry.close();
	});

	test("the cleanup migration purges orphaned prefs rows left by pre-#127 folds", async () => {
		const file = `${tmpdir()}/supervillain-orphan-${randomUUID()}.db`;
		const first = openRoomRegistry({ path: file });
		const identityId = first.resolveIdentity("55".repeat(32));
		first.setPresentationPreference(identityId, "feedRail", true);
		first.close();

		// Manufacture the legacy litter on a raw connection (foreign_keys is OFF
		// by default there, exactly as it was for every pre-#127 fold), then
		// rewind user_version one step so reopening replays the purge — which is
		// the final migration.
		const raw = new Database(file, { strict: true });
		raw.query("DELETE FROM identities WHERE id = $id").run({ id: identityId });
		const version = raw.query("PRAGMA user_version").get() as {
			user_version: number;
		};
		raw.run(`PRAGMA user_version = ${version.user_version - 1}`);
		raw.close();

		const reopened = openRoomRegistry({ path: file });
		expect(reopened.presentationPreferences(identityId)).toEqual({});
		reopened.close();
		await rm(file, { force: true });
	});

	test("keeps Guest choices for one Door session and nowhere else", () => {
		const registry = openRoomRegistry({ path: ":memory:" });
		const doorSession = {};
		const firstRoom = tablePreferenceAdapter({
			actor: "guest:abc123def456",
			keyed: false,
			registry,
			sessionPreferences: doorSession,
		});
		firstRoom.onPreferenceChange({ preference: "feedRail", value: true });
		firstRoom.onPreferenceChange({ preference: "sidebarRail", value: true });
		expect(firstRoom.viewOptions).toEqual({});

		const secondRoom = tablePreferenceAdapter({
			actor: "guest:abc123def456",
			keyed: false,
			registry,
			sessionPreferences: doorSession,
		});
		expect(secondRoom.viewOptions).toEqual({
			feedRail: true,
			sidebarRail: true,
		});
		const nextDoor = tablePreferenceAdapter({
			actor: "guest:fed654cba321",
			keyed: false,
			registry,
			sessionPreferences: {},
		});
		expect(nextDoor.viewOptions).toEqual({});
		registry.close();
	});
});
