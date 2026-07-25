/* oxlint-disable vitest/prefer-importing-vitest-globals -- dual-lane suite. */
import {
	foldTokenMoved,
	foldTokenPlaced,
	foldTokenRemoved,
	isInsideMap,
	isValidTokenGlyph,
	isValidTokenId,
	MAP_MAX_TOKENS,
	mapDimensions,
	mapGlyphAt,
	mapTileAt,
	tokenAt,
} from "../src/index.js";
import type { BattleMap, MapToken } from "../src/index.js";
import { describe, expect, test } from "./harness.js";

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

describe("map geometry", () => {
	test("measures the grid and reads a cell's glyph and tile", () => {
		expect(mapDimensions(CAVERN)).toEqual({ height: 4, width: 5 });
		expect(mapGlyphAt(CAVERN, 2, 2)).toBe("^");
		expect(mapTileAt(CAVERN, 2, 2)).toBe("hazard");
		expect(mapTileAt(CAVERN, 0, 0)).toBe("wall");
		expect(mapGlyphAt(CAVERN, 5, 0)).toBeNull();
		expect(mapGlyphAt(CAVERN, 0, 4)).toBeNull();
	});

	test("bounds a coordinate against the grid it addresses", () => {
		expect(isInsideMap(CAVERN, 0, 0)).toBe(true);
		expect(isInsideMap(CAVERN, 4, 3)).toBe(true);
		expect(isInsideMap(CAVERN, 5, 3)).toBe(false);
		expect(isInsideMap(CAVERN, -1, 0)).toBe(false);
		expect(isInsideMap(CAVERN, 1.5, 0)).toBe(false);
	});
});

describe("token validation", () => {
	test("a glyph is exactly one printable character", () => {
		expect(isValidTokenGlyph("@")).toBe(true);
		expect(isValidTokenGlyph("★")).toBe(true);
		expect(isValidTokenGlyph("")).toBe(false);
		expect(isValidTokenGlyph("@@")).toBe(false);
		expect(isValidTokenGlyph(" ")).toBe(false);
		expect(isValidTokenGlyph("\n")).toBe(false);
	});

	test("an id is filename-safe, like a map name", () => {
		expect(isValidTokenId("token-1")).toBe(true);
		expect(isValidTokenId("Kraan_2")).toBe(true);
		expect(isValidTokenId("")).toBe(false);
		expect(isValidTokenId("../escape")).toBe(false);
	});
});

describe("foldTokenPlaced", () => {
	test("adds a token the map has room for", () => {
		const folded = foldTokenPlaced(CAVERN, [], kraan);
		expect(folded).toEqual({ ok: true, tokens: [kraan] });
	});

	test("replaces an id already on the surface — the re-glyph path", () => {
		const folded = foldTokenPlaced(CAVERN, [kraan], { ...kraan, glyph: "K" });
		expect(folded).toEqual({ ok: true, tokens: [{ ...kraan, glyph: "K" }] });
	});

	test("refuses a malformed token, an unloaded map, and an outside cell", () => {
		expect(foldTokenPlaced(CAVERN, [], { ...kraan, glyph: "@@" })).toEqual({
			ok: false,
			reason: "malformed token",
		});
		expect(foldTokenPlaced(null, [], kraan)).toEqual({
			ok: false,
			reason: "no map is loaded",
		});
		expect(foldTokenPlaced(CAVERN, [], { ...kraan, x: 9 })).toEqual({
			ok: false,
			reason: "position 9,1 is outside the map",
		});
	});

	test("holds the token set to its bound", () => {
		const full = Array.from({ length: MAP_MAX_TOKENS }, (_, index) => ({
			...kraan,
			id: `token-${index + 1}`,
		}));
		expect(foldTokenPlaced(CAVERN, full, { ...kraan, id: "extra" })).toEqual({
			ok: false,
			reason: `the map already holds ${MAP_MAX_TOKENS} tokens`,
		});
		// Replacing one of them is still fine — the set does not grow.
		expect(
			foldTokenPlaced(CAVERN, full, { ...kraan, glyph: "K" })
		).toMatchObject({ ok: true });
	});
});

describe("foldTokenMoved and foldTokenRemoved", () => {
	test("moves a token that is on the map to a cell that exists", () => {
		expect(
			foldTokenMoved(CAVERN, [kraan], { id: "token-1", x: 3, y: 2 })
		).toEqual({ ok: true, tokens: [{ ...kraan, x: 3, y: 2 }] });
	});

	test("refuses a move off the grid or of a token nobody placed", () => {
		expect(
			foldTokenMoved(CAVERN, [kraan], { id: "token-1", x: 0, y: 9 })
		).toEqual({ ok: false, reason: "position 0,9 is outside the map" });
		expect(
			foldTokenMoved(CAVERN, [kraan], { id: "token-2", x: 1, y: 1 })
		).toEqual({ ok: false, reason: "no token 'token-2' is on the map" });
	});

	test("removes a token that is there and refuses one that is not", () => {
		expect(foldTokenRemoved([kraan], { id: "token-1" })).toEqual({
			ok: true,
			tokens: [],
		});
		expect(foldTokenRemoved([kraan], { id: "token-2" })).toEqual({
			ok: false,
			reason: "no token 'token-2' is on the map",
		});
	});
});

describe("tokenAt", () => {
	test("resolves the token standing on a cell, latest first", () => {
		const goblin = { ...kraan, glyph: "g", id: "token-2" };
		expect(tokenAt([kraan, goblin], 1, 1)).toEqual(goblin);
		expect(tokenAt([kraan], 2, 2)).toBeNull();
	});
});
