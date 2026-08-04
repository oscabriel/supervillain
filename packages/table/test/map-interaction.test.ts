/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-lane suite. */
import { describe, expect, test } from "bun:test";

import type { BattleMap, MapToken } from "@supervillain/core";

import { parseInput } from "../src/input.js";
import { mapCommandFor, mapKeyAction } from "../src/map-interaction.js";
import type { MapInteraction } from "../src/map-interaction.js";

const CAVERN: BattleMap = {
	legend: { "#": "wall", "+": "door", ".": "floor", "^": "hazard" },
	name: "Cavern Mouth",
	rows: ["#####", "#...#", "#.^.#", "##+##"],
};

const kraan: MapToken = {
	glyph: "@",
	id: "token-1",
	label: "Kraan",
	seatId: "player-1",
	x: 1,
	y: 1,
};

const state = (over: Partial<MapInteraction> = {}): MapInteraction => ({
	cursor: { x: 1, y: 1 },
	map: CAVERN,
	selectedTokenId: null,
	tokens: [kraan],
	...over,
});

describe("map keys", () => {
	test("arrows and vi keys move the cursor", () => {
		expect(mapKeyAction(state(), { name: "right" })).toEqual({
			cursor: { x: 2, y: 1 },
			kind: "cursor",
		});
		expect(mapKeyAction(state(), { name: "l" })).toEqual({
			cursor: { x: 2, y: 1 },
			kind: "cursor",
		});
	});

	test("Enter picks up the token under the cursor", () => {
		expect(mapKeyAction(state(), { name: "return" })).toEqual({
			kind: "select",
			tokenId: "token-1",
		});
		expect(
			mapKeyAction(state({ cursor: { x: 3, y: 1 } }), { name: "return" })
		).toEqual({ kind: "notice", message: "No token here to pick up." });
	});

	test("Enter drops the held token on the cursor", () => {
		expect(
			mapKeyAction(
				state({ cursor: { x: 3, y: 2 }, selectedTokenId: "token-1" }),
				{
					name: "return",
				}
			)
		).toEqual({
			command: { id: "token-1", type: "core.move-token", x: 3, y: 2 },
			kind: "command",
		});
	});

	test("Escape drops what is held, and claims nothing when nothing is held", () => {
		expect(
			mapKeyAction(state({ selectedTokenId: "token-1" }), { name: "escape" })
		).toEqual({ kind: "select", tokenId: null });
		// #126: no Esc→Message row exists in ADR-0030's key table; the key falls
		// through unclaimed.
		expect(mapKeyAction(state(), { name: "escape" })).toBeNull();
	});

	test("x removes the token under the cursor", () => {
		expect(mapKeyAction(state(), { name: "x" })).toEqual({
			command: { id: "token-1", type: "core.remove-token" },
			kind: "command",
		});
		expect(
			mapKeyAction(state({ cursor: { x: 3, y: 1 } }), { name: "x" })
		).toEqual({ kind: "notice", message: "No token here to remove." });
	});

	test("claims no key it has no meaning for", () => {
		expect(mapKeyAction(state(), { name: "q", text: "q" })).toBeNull();
		expect(mapKeyAction(state(), { name: "tab" })).toBeNull();
	});
});

const command = (line: string, mapState: MapInteraction | null) => {
	const parsed = parseInput(line);
	if (
		parsed.kind === "chat" ||
		parsed.kind === "roll" ||
		parsed.kind === "quit" ||
		parsed.kind === "empty" ||
		parsed.kind === "usage" ||
		parsed.kind === "unknown-command"
	) {
		throw new Error(`'${line}' did not parse to a map command.`);
	}
	return mapCommandFor(parsed, mapState);
};

describe("typed map commands", () => {
	test("loads and clears without needing a map or a cursor", () => {
		expect(command("/map load cavern", null)).toEqual({
			command: { name: "cavern", type: "core.load-map" },
		});
		expect(command("/map clear", null)).toEqual({
			command: { type: "core.clear-map" },
		});
	});

	test("places at the cursor with the glyph, label, and seat given", () => {
		expect(
			command(
				"/token place g Cave Goblin @player-1",
				state({ cursor: { x: 3, y: 2 } })
			)
		).toEqual({
			command: {
				glyph: "g",
				label: "Cave Goblin",
				seatId: "player-1",
				type: "core.place-token",
				x: 3,
				y: 2,
			},
		});
	});

	test("re-glyphs by placing onto the id already on the surface", () => {
		expect(command("/token glyph K", state())).toEqual({
			command: {
				glyph: "K",
				id: "token-1",
				label: "Kraan",
				seatId: "player-1",
				type: "core.place-token",
				x: 1,
				y: 1,
			},
		});
	});

	test("removes the held token, or the one under the cursor", () => {
		expect(command("/token remove", state())).toEqual({
			command: { id: "token-1", type: "core.remove-token" },
		});
		expect(command("/token remove", state({ cursor: { x: 3, y: 1 } }))).toEqual(
			{ message: "Select a token first, or put the cursor on one." }
		);
	});

	test("says so when there is no map to touch", () => {
		expect(command("/token place g", null)).toEqual({
			message: "No battle map is loaded.",
		});
	});
});
