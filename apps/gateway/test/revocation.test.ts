/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; the gateway is Bun-bound by bun:sqlite. */
import { describe, expect, test } from "bun:test";

import { guestIdentity, keyedIdentity } from "../src/guest.js";
import { openRoomRegistry } from "../src/registry.js";
import {
	createKeyedSessions,
	doorRefusal,
	keyedActorOf,
	REVOKED_DOOR_MESSAGE,
	REVOKED_SESSION_MESSAGE,
} from "../src/revocation.js";

const GM = "gm-key";
const HOMELAB = "homelab-key";

describe("the door's revoked-key rule", () => {
	test("refuses a retired key and lets an unknown one in", async () => {
		const registry = openRoomRegistry({ path: ":memory:" });
		const code = await registry.mintDeviceCode(GM);
		if ("rejected" in code) {
			throw new Error(code.message);
		}
		await registry.redeemLinkCode(code.code, HOMELAB);
		await registry.revokeKey(HOMELAB, GM);

		expect(doorRefusal(keyedIdentity(HOMELAB), registry)).toBe(
			REVOKED_DOOR_MESSAGE
		);
		// An unknown key is not revoked — it is merely unknown, and a keyless
		// visitor has no key to have retired at all (ADR-0008).
		expect(doorRefusal(keyedIdentity("never-seen"), registry)).toBeUndefined();
		expect(doorRefusal(keyedIdentity(GM), registry)).toBeUndefined();
		expect(doorRefusal(guestIdentity(), registry)).toBeUndefined();
		registry.close();
	});

	test("reads the keyed actor and nothing from a guest", () => {
		expect(keyedActorOf(keyedIdentity(GM))).toBe(GM);
		expect(keyedActorOf(guestIdentity(() => "guest:abc123def456"))).toBe(
			undefined
		);
	});

	test("says something different from what a dropped session is told", () => {
		expect(REVOKED_DOOR_MESSAGE).not.toBe(REVOKED_SESSION_MESSAGE);
	});
});

describe("the live keyed sessions", () => {
	test("drops every terminal a retired key is holding, once", () => {
		const sessions = createKeyedSessions();
		const dropped: string[] = [];
		sessions.hold(GM, () => dropped.push("desk"));
		sessions.hold(GM, () => dropped.push("laptop"));
		sessions.hold(HOMELAB, () => dropped.push("box"));
		expect(sessions.count(GM)).toBe(2);

		expect(sessions.drop(GM)).toBe(2);
		expect(dropped).toEqual(["desk", "laptop"]);
		// Nobody else's session moved, and the key is empty afterwards.
		expect(sessions.count(HOMELAB)).toBe(1);
		expect(sessions.drop(GM)).toBe(0);
		expect(dropped).toEqual(["desk", "laptop"]);
	});

	test("releases a session that ended on its own", () => {
		const sessions = createKeyedSessions();
		const dropped: string[] = [];
		const release = sessions.hold(GM, () => dropped.push("desk"));
		sessions.hold(GM, () => dropped.push("laptop"));
		release();
		expect(sessions.count(GM)).toBe(1);
		expect(sessions.drop(GM)).toBe(1);
		expect(dropped).toEqual(["laptop"]);
	});

	test("a released last session leaves no actor behind", () => {
		const sessions = createKeyedSessions();
		const dropped: string[] = [];
		const release = sessions.hold(GM, () => dropped.push("desk"));
		release();
		release();
		expect(dropped).toEqual([]);
		expect(sessions.count(GM)).toBe(0);
		expect(sessions.drop(GM)).toBe(0);
	});
});
