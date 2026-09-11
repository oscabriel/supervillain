/* oxlint-disable vitest/prefer-importing-vitest-globals -- dual-lane suite. */
import { isSeatedInLog, LOG_EGRESS_REFUSAL } from "../src/index.js";
import type { Envelope } from "../src/index.js";
import { describe, expect, test } from "./harness.js";

const GM = "a".repeat(64);
const GM_LAPTOP = "b".repeat(64);
const PLAYER = "c".repeat(64);
const STRANGER = "d".repeat(64);
const GUEST = "guest:abc123def456";

const log = (
	tail: readonly {
		readonly actor: string;
		readonly payload: unknown;
		readonly type: string;
	}[]
): readonly Envelope[] =>
	[
		{ actor: GM, payload: { gameId: "fake" }, type: "core.room-created" },
		{ actor: GM, payload: { seatId: "gm" }, type: "core.seat-claimed" },
		...tail,
	].map((envelope, index) => ({
		...envelope,
		seq: index + 1,
		timestamp: "2026-01-01T00:00:00.000Z",
		type: envelope.type as Envelope["type"],
	}));

describe("log egress authorization", () => {
	test("the room's creator can pull", () => {
		expect(isSeatedInLog(log([]), GM)).toBe(true);
	});

	test("a seat holder can pull; an identity the log never seated cannot", () => {
		const envelopes = log([
			{
				actor: PLAYER,
				payload: { seatId: "player-1" },
				type: "core.seat-claimed",
			},
			{ actor: STRANGER, payload: { text: "hi" }, type: "core.chat-posted" },
		]);
		expect(isSeatedInLog(envelopes, PLAYER)).toBe(true);
		// Writing a line is not holding a seat: the actor of a chat event that
		// never claimed one is refused, and so is a key the log never saw.
		expect(isSeatedInLog(envelopes, STRANGER)).toBe(false);
		expect(isSeatedInLog(envelopes, "e".repeat(64))).toBe(false);
	});

	test("a seat claimed by history authorizes, whatever came after", () => {
		const envelopes = log([
			{
				actor: PLAYER,
				payload: { seatId: "player-1" },
				type: "core.seat-claimed",
			},
			{ actor: GM, payload: { name: "arena" }, type: "core.map-loaded" },
			{ actor: GM, payload: { roll: 4 }, type: "fake.rolled" },
		]);
		expect(isSeatedInLog(envelopes, PLAYER)).toBe(true);
	});

	test("a key linked to a seat holder is that seat holder", () => {
		const linkedAfter = log([
			{
				actor: PLAYER,
				payload: { seatId: "player-1" },
				type: "core.seat-claimed",
			},
			{ actor: GM_LAPTOP, payload: { linked: GM }, type: "core.actor-linked" },
		]);
		expect(isSeatedInLog(linkedAfter, GM_LAPTOP)).toBe(true);
		// Adoption reaches a guest's seat from the adopting key, and the link
		// may be stated before the seat it makes reachable is claimed.
		const linkedBefore = log([
			{ actor: PLAYER, payload: { linked: GUEST }, type: "core.actor-linked" },
			{
				actor: GUEST,
				payload: { seatId: "player-1" },
				type: "core.seat-claimed",
			},
		]);
		expect(isSeatedInLog(linkedBefore, PLAYER)).toBe(true);
		expect(isSeatedInLog(linkedBefore, STRANGER)).toBe(false);
	});

	test("reads past malformed linking payloads and unknown types", () => {
		const envelopes = log([
			{ actor: GM_LAPTOP, payload: {}, type: "core.actor-linked" },
			{ actor: STRANGER, payload: {}, type: "core.something-new" },
		]);
		expect(isSeatedInLog(envelopes, GM)).toBe(true);
		expect(isSeatedInLog(envelopes, GM_LAPTOP)).toBe(false);
		expect(isSeatedInLog(envelopes, STRANGER)).toBe(false);
	});

	test("an empty stream seats nobody", () => {
		expect(isSeatedInLog([], GM)).toBe(false);
	});

	test("the refusal is one sentence", () => {
		expect(LOG_EGRESS_REFUSAL).toMatch(/seat/u);
	});
});
