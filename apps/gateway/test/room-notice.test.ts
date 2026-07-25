import { describe, expect, test } from "bun:test";
/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite: the gateway is Bun-bound by bun:sqlite. */

import { noticeForMissingRoom } from "../src/index.js";

/* The seam #57 and #67 meet at: #57 split registration into a durable half and
 * a live half, and #67 turned the old unknown/unreachable disconnects into
 * inline lobby notices. Which notice a name gets is therefore read off both
 * halves at once — the live half said "no pipe", the durable half says whether
 * anyone owns the name at all. */
describe("the notice a name with no live pipe gets", () => {
	test("a claimed name whose Host is not connected reads as offline", () => {
		expect(noticeForMissingRoom("the-keep", { isClaimed: () => true })).toEqual(
			{ kind: "offline-room", roomName: "the-keep" }
		);
	});

	test("a name nobody has ever claimed reads as unknown", () => {
		expect(
			noticeForMissingRoom("the-keep", { isClaimed: () => false })
		).toEqual({ kind: "unknown-room", roomName: "the-keep" });
	});

	test("the typed name is preserved verbatim for the lobby to echo back", () => {
		expect(
			noticeForMissingRoom("Oscar's Table", { isClaimed: () => false }).roomName
		).toBe("Oscar's Table");
	});
});
