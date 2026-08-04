/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; the preference store uses bun:sqlite. */
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
