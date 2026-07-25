/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-lane suite. */
import { describe, expect, test } from "bun:test";

import type { Envelope, ViewEntry } from "@supervillain/core";

import { formatSeatList } from "../src/chrome.js";
import { createTableFold } from "../src/fold.js";

const entry: ViewEntry<Record<string, never>, unknown, { type: string }> = {
	model: { apply: (state) => state, init: () => ({}) },
	view: { createPanels: () => [], renderEvent: () => null },
};

const GUEST = "guest:abc123def456";
const DESKTOP = "desktop-key-long";
const LAPTOP = "laptop-key-long";

const envelope = (
	type: `${string}.${string}`,
	payload: unknown,
	actor: string,
	seq: number
): Envelope => ({ actor, payload, seq, timestamp: "now", type });

describe("the render fold and core.actor-linked", () => {
	test("unions the linked actor and reaches a historical guest line", () => {
		const fold = createTableFold(entry, "game", LAPTOP);
		fold.apply(envelope("core.seat-claimed", { seatId: "gm" }, DESKTOP, 1));
		fold.apply(envelope("core.seat-claimed", { seatId: "player-1" }, GUEST, 2));
		// Before adoption the old guest line is anonymous.
		expect(fold.actorLabel(LAPTOP)).toBe("laptop-k");
		expect(fold.sameActor(LAPTOP, GUEST)).toBe(false);

		const line = fold.apply(
			envelope("core.actor-linked", { linked: GUEST }, LAPTOP, 3)
		);
		expect(line).toEqual({
			runs: [
				{ text: "player-1 is now ", token: "muted" },
				{ text: "player-1", token: "accent" },
			],
		});
		// The historical envelope is untouched; the union makes it reachable.
		expect(fold.sameActor(LAPTOP, GUEST)).toBe(true);
		expect(fold.actorLabel(LAPTOP)).toBe("player-1");
		expect(fold.table().seats).toEqual([
			{ actor: DESKTOP, characterId: null, id: "gm" },
			{ actor: GUEST, characterId: null, id: "player-1" },
		]);
	});

	test("refuses a linking event that names nobody, loudly", () => {
		const fold = createTableFold(entry, "game", LAPTOP);
		fold.endReplay();
		const line = fold.apply(envelope("core.actor-linked", {}, LAPTOP, 1));
		expect(line?.runs[0]?.text).toContain("linking event names no actor");
		expect(fold.skips()).toHaveLength(1);
	});

	test("a linked key does not read as a second seat claim", () => {
		const fold = createTableFold(entry, "game", DESKTOP);
		fold.endReplay();
		fold.apply(envelope("core.seat-claimed", { seatId: "gm" }, DESKTOP, 1));
		fold.apply(envelope("core.actor-linked", { linked: DESKTOP }, LAPTOP, 2));
		const line = fold.apply(
			envelope("core.seat-claimed", { seatId: "player-1" }, LAPTOP, 3)
		);
		expect(line?.runs[0]?.text).toContain("already holds a seat");
	});

	test("the seat marker follows the identity, not the key", () => {
		const fold = createTableFold(entry, "game", LAPTOP);
		fold.apply(envelope("core.seat-claimed", { seatId: "gm" }, DESKTOP, 1));
		expect(formatSeatList(fold.table(), LAPTOP, fold.sameActor)).toBe("○ gm");
		fold.apply(envelope("core.actor-linked", { linked: DESKTOP }, LAPTOP, 2));
		expect(formatSeatList(fold.table(), LAPTOP, fold.sameActor)).toBe("● gm");
	});
});
