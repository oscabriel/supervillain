/* oxlint-disable eslint/no-bitwise, oxc/bad-bitwise-operator, vitest/prefer-importing-vitest-globals -- Bun-lane suite; 1-bit glyph packing is bitmask arithmetic by nature. */
import { describe, expect, test } from "bun:test";

import {
	DINGS_ATLAS,
	GLYPH_HEIGHT,
	GLYPH_WIDTH,
	glyphRowBytes,
	OCTANT_CHARS,
	TEXT_ATLAS,
	TILE_COLUMNS,
	TILE_ROWS,
} from "@supervillain/atlas";
import type { BattleMap, MapToken } from "@supervillain/core";

import { mapKeyAction } from "../src/map-interaction.js";
import { composePixelCells, pixelViewportSize } from "../src/map-pixel.js";
import { mapRegionSize } from "../src/map-region.js";
import type { MapCell, MapViewport } from "../src/map.js";

const CAVERN: BattleMap = {
	legend: { "#": "wall", "+": "door", ".": "floor", "^": "hazard" },
	name: "Cavern Mouth",
	rows: ["#####", "#...#", "#.^.#", "##+##"],
};

const WHOLE: MapViewport = { height: 4, originX: 0, originY: 0, width: 5 };

const compose = (
	over: Partial<Parameters<typeof composePixelCells>[0]> = {}
): readonly (readonly (MapCell | null)[])[] =>
	composePixelCells({
		cursor: null,
		map: CAVERN,
		ownSeatId: null,
		selectedTokenId: null,
		tokens: [],
		viewport: WHOLE,
		...over,
	});

/** The 4×3 block of one tile, as the octant characters it painted. */
const tileBlock = (
	rows: readonly (readonly (MapCell | null)[])[],
	tileX: number,
	tileY: number
): readonly (MapCell | null)[][] => {
	const block: (MapCell | null)[][] = [];
	for (let row = 0; row < TILE_ROWS; row += 1) {
		const cells: (MapCell | null)[] = [];
		for (let column = 0; column < TILE_COLUMNS; column += 1) {
			cells.push(
				rows[tileY * TILE_ROWS + row]?.[tileX * TILE_COLUMNS + column] ?? null
			);
		}
		block.push(cells);
	}
	return block;
};

/** Decodes a painted 4×3 block back into 12 bitmap row bytes. */
const decodeBlock = (
	block: readonly (readonly (MapCell | null)[])[]
): Uint8Array => {
	const inverse = new Map<string, number>();
	for (const [pattern, char] of OCTANT_CHARS.entries()) {
		inverse.set(char as string, pattern);
	}
	const rows: number[] = Array.from({ length: GLYPH_HEIGHT }, () => 0);
	for (const [cellRow, cells] of block.entries()) {
		for (const [cellColumn, cell] of cells.entries()) {
			const pattern = inverse.get(cell?.glyph ?? " ") ?? 0;
			for (let dy = 0; dy < GLYPH_HEIGHT / TILE_ROWS; dy += 1) {
				for (let dx = 0; dx < GLYPH_WIDTH / TILE_COLUMNS; dx += 1) {
					const bit = (pattern >> (dy * (GLYPH_WIDTH / TILE_COLUMNS) + dx)) & 1;
					const y = cellRow * (GLYPH_HEIGHT / TILE_ROWS) + dy;
					const x = cellColumn * (GLYPH_WIDTH / TILE_COLUMNS) + dx;
					rows[y] = (rows[y] ?? 0) | (bit << (GLYPH_WIDTH - 1 - x));
				}
			}
		}
	}
	return Uint8Array.from(rows);
};

const atlasBitmap = (glyph: string): Uint8Array => {
	const entry = DINGS_ATLAS[glyph] ?? TEXT_ATLAS[glyph];
	if (entry === undefined) {
		throw new Error(`no atlas entry for ${glyph}`);
	}
	return glyphRowBytes(entry);
};

describe("pixel composition (ADR-0021)", () => {
	test("one map tile becomes exactly 4×3 terminal cells", () => {
		const rows = compose();
		expect(rows).toHaveLength(WHOLE.height * TILE_ROWS);
		for (const row of rows) {
			expect(row).toHaveLength(WHOLE.width * TILE_COLUMNS);
		}
	});

	test("a terrain tile paints its legend character's ding, losslessly", () => {
		const rows = compose();
		// (0,0) is '#' — a wall; the ding keyed by '#' is what must appear.
		expect(decodeBlock(tileBlock(rows, 0, 0))).toEqual(atlasBitmap("#"));
		// (2,3) is '+' — the door.
		expect(decodeBlock(tileBlock(rows, 2, 3))).toEqual(atlasBitmap("+"));
	});

	test("a legend character without a ding falls back to its text glyph", () => {
		const macron = "\u0100";
		const map: BattleMap = {
			legend: { [macron]: "floor" },
			name: "Fallback",
			rows: [macron],
		};
		const rows = compose({
			map,
			viewport: { height: 1, originX: 0, originY: 0, width: 1 },
		});
		expect(DINGS_ATLAS[macron]).toBeUndefined();
		expect(decodeBlock(tileBlock(rows, 0, 0))).toEqual(
			glyphRowBytes(TEXT_ATLAS[macron] as string)
		);
	});

	test("a character in neither atlas renders the question mark, not blank", () => {
		const snowman = "\u2603";
		const map: BattleMap = {
			legend: { [snowman]: "floor" },
			name: "Unknown",
			rows: [snowman],
		};
		const rows = compose({
			map,
			viewport: { height: 1, originX: 0, originY: 0, width: 1 },
		});
		expect(decodeBlock(tileBlock(rows, 0, 0))).toEqual(
			glyphRowBytes(TEXT_ATLAS["?"] as string)
		);
	});

	test("a token tile paints the token's glyph over the terrain", () => {
		const kraan: MapToken = {
			glyph: "K",
			id: "token-1",
			label: "Kraan",
			seatId: "gm",
			x: 1,
			y: 1,
		};
		const rows = compose({ ownSeatId: "gm", tokens: [kraan] });
		expect(decodeBlock(tileBlock(rows, 1, 1))).toEqual(atlasBitmap("K"));
		for (const cell of tileBlock(rows, 1, 1).flat()) {
			expect(cell?.fg).toBe("success");
		}
	});

	test("the cursor tile wears the cursor background on every cell", () => {
		const rows = compose({ cursor: { x: 2, y: 2 } });
		for (const cell of tileBlock(rows, 2, 2).flat()) {
			expect(cell?.bg).toBe("accent");
		}
	});

	test("beyond the map's edge the region paints nothing", () => {
		const rows = compose({
			viewport: { height: 4, originX: 0, originY: 0, width: 6 },
		});
		for (const cell of tileBlock(rows, 5, 0).flat()) {
			expect(cell).toBeNull();
		}
	});
});

describe("pixel viewport arithmetic", () => {
	test("fits whole tiles into a terminal-cell budget", () => {
		expect(pixelViewportSize({ height: 7, width: 9 })).toEqual({
			height: 2,
			width: 2,
		});
	});

	test("never shrinks below one tile", () => {
		expect(pixelViewportSize({ height: 1, width: 1 })).toEqual({
			height: 1,
			width: 1,
		});
	});

	test("sizes the region to tile multiples in pixel mode", () => {
		expect(mapRegionSize(CAVERN, { height: 16, width: 100 }, "pixel")).toEqual({
			height: 12,
			width: 20,
		});
	});

	test("text mode sizing is ADR-0006's, unchanged", () => {
		expect(mapRegionSize(CAVERN, { height: 16, width: 100 }, "text")).toEqual({
			height: 4,
			width: 5,
		});
	});
});

describe("the render-mode toggle", () => {
	test("t asks for the toggle and no other key does", () => {
		const state = {
			cursor: { x: 0, y: 0 },
			map: CAVERN,
			selectedTokenId: null,
			tokens: [],
		};
		expect(mapKeyAction(state, { name: "t" })).toEqual({
			kind: "toggle-render-mode",
		});
		expect(mapKeyAction(state, { name: "q" })).toBeNull();
	});
});
