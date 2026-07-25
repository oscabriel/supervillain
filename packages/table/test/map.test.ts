/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-lane suite. */
import { describe, expect, test } from "bun:test";

import type { BattleMap, MapToken, ThemeToken } from "@supervillain/core";

import {
	composeMapCells,
	mapCellAt,
	mapStatusLine,
	mapTitleLine,
	moveMapCursor,
	scrollViewport,
} from "../src/map.js";
import type { MapViewport } from "../src/map.js";

const CAVERN: BattleMap = {
	legend: { "#": "wall", "+": "door", ".": "floor", "^": "hazard" },
	name: "Cavern Mouth",
	rows: ["#####", "#...#", "#.^.#", "##+##"],
};

const WHOLE: MapViewport = { height: 4, originX: 0, originY: 0, width: 5 };

const token = (over: Partial<MapToken> = {}): MapToken => ({
	glyph: "@",
	id: "token-1",
	label: "Kraan",
	seatId: null,
	x: 1,
	y: 1,
	...over,
});

const compose = (
	over: Partial<Parameters<typeof composeMapCells>[0]> = {}
): readonly (readonly ReturnType<typeof composeMapCells>[0][0][])[] =>
	composeMapCells({
		cursor: null,
		map: CAVERN,
		ownSeatId: null,
		selectedTokenId: null,
		tokens: [],
		viewport: WHOLE,
		...over,
	});

const glyphs = (rows: ReturnType<typeof compose>): string =>
	rows.map((row) => row.map((cell) => cell?.glyph ?? " ").join("")).join("\n");

describe("map composition", () => {
	test("renders the author's own glyphs with legend-derived theme tokens", () => {
		const rows = compose();
		expect(glyphs(rows)).toBe(CAVERN.rows.join("\n"));
		expect(rows[0]?.[0]).toEqual({ bg: "primary", fg: "muted", glyph: "#" });
		expect(rows[1]?.[1]).toEqual({ bg: "muted", fg: "primary", glyph: "." });
		expect(rows[2]?.[2]).toEqual({ bg: "muted", fg: "danger", glyph: "^" });
		expect(rows[3]?.[2]).toEqual({ bg: "muted", fg: "accent", glyph: "+" });
	});

	test("spends nothing outside the five theme tokens", () => {
		const allowed: ReadonlySet<ThemeToken> = new Set([
			"accent",
			"danger",
			"muted",
			"primary",
			"success",
		]);
		const rows = compose({
			cursor: { x: 3, y: 1 },
			ownSeatId: "player-1",
			selectedTokenId: "token-2",
			tokens: [
				token({ seatId: "player-1" }),
				token({ id: "token-2", x: 2, y: 1 }),
			],
		});
		for (const row of rows) {
			for (const cell of row) {
				if (cell !== null) {
					expect(allowed.has(cell.fg)).toBe(true);
					expect(allowed.has(cell.bg)).toBe(true);
				}
			}
		}
	});

	test("draws tokens as foreground glyphs over the terrain background", () => {
		const rows = compose({ tokens: [token()] });
		expect(rows[1]?.[1]).toEqual({ bg: "muted", fg: "accent", glyph: "@" });
	});

	test("reads a token bound to your own seat differently", () => {
		const mine = compose({
			ownSeatId: "player-1",
			tokens: [token({ seatId: "player-1" })],
		});
		const theirs = compose({
			ownSeatId: "player-1",
			tokens: [token({ seatId: "player-2" })],
		});
		expect(mine[1]?.[1]?.fg).toBe("success");
		expect(theirs[1]?.[1]?.fg).toBe("accent");
	});

	test("marks the cursor and the held token", () => {
		const rows = compose({
			cursor: { x: 3, y: 2 },
			selectedTokenId: "token-1",
			tokens: [token()],
		});
		expect(rows[2]?.[3]?.bg).toBe("accent");
		expect(rows[1]?.[1]?.bg).toBe("success");
	});

	test("leaves cells the map does not have empty", () => {
		const rows = composeMapCells({
			cursor: null,
			map: CAVERN,
			ownSeatId: null,
			selectedTokenId: null,
			tokens: [],
			viewport: { height: 5, originX: 0, originY: 0, width: 7 },
		});
		expect(rows[0]?.[5]).toBeNull();
		expect(rows[4]?.[0]).toBeNull();
	});
});

describe("map hit-testing", () => {
	test("resolves a region offset to the cell under it", () => {
		expect(mapCellAt(CAVERN, WHOLE, 2, 1)).toEqual({ x: 2, y: 1 });
		expect(
			mapCellAt(CAVERN, { ...WHOLE, originX: 1, originY: 2 }, 1, 1)
		).toEqual({ x: 2, y: 3 });
	});

	test("rejects an offset outside the region or off the grid", () => {
		expect(mapCellAt(CAVERN, WHOLE, -1, 0)).toBeNull();
		expect(mapCellAt(CAVERN, WHOLE, 5, 0)).toBeNull();
		expect(
			mapCellAt(CAVERN, { height: 6, originX: 0, originY: 0, width: 8 }, 6, 0)
		).toBeNull();
	});
});

describe("map cursor and viewport", () => {
	test("moves on arrows and vi keys, and stops at the edge", () => {
		expect(moveMapCursor(CAVERN, { x: 1, y: 1 }, "right")).toEqual({
			x: 2,
			y: 1,
		});
		expect(moveMapCursor(CAVERN, { x: 1, y: 1 }, "j")).toEqual({ x: 1, y: 2 });
		expect(moveMapCursor(CAVERN, { x: 0, y: 0 }, "up")).toBeNull();
		expect(moveMapCursor(CAVERN, { x: 4, y: 3 }, "right")).toBeNull();
		expect(moveMapCursor(CAVERN, { x: 1, y: 1 }, "return")).toBeNull();
	});

	test("pans only as far as it must to keep the cursor visible", () => {
		const size = { height: 2, width: 3 };
		const origin = { originX: 0, originY: 0 };
		expect(scrollViewport(CAVERN, size, origin, { x: 4, y: 3 })).toEqual({
			height: 2,
			originX: 2,
			originY: 2,
			width: 3,
		});
		expect(
			scrollViewport(CAVERN, size, { originX: 2, originY: 2 }, { x: 0, y: 0 })
		).toEqual({ height: 2, originX: 0, originY: 0, width: 3 });
		expect(
			scrollViewport(CAVERN, size, { originX: 1, originY: 1 }, null)
		).toEqual({ height: 2, originX: 1, originY: 1, width: 3 });
	});

	test("never scrolls past a map smaller than the region", () => {
		expect(
			scrollViewport(
				CAVERN,
				{ height: 10, width: 10 },
				{ originX: 3, originY: 3 },
				{ x: 4, y: 3 }
			)
		).toMatchObject({ originX: 0, originY: 0 });
	});
});

describe("map chrome lines", () => {
	test("titles the region with the map's name and extent", () => {
		expect(
			mapTitleLine(CAVERN)
				.runs.map((run) => run.text)
				.join("")
		).toBe("map · Cavern Mouth 5×4");
	});

	test("says where the cursor is, what it stands on, and what is held", () => {
		expect(
			mapStatusLine({
				cursor: { x: 2, y: 2 },
				map: CAVERN,
				selectedTokenId: "token-1",
				tokens: [token()],
			})
				.runs.map((run) => run.text)
				.join("")
		).toBe("2,2 hazard · holding @ — Enter to drop");
		expect(
			mapStatusLine({
				cursor: null,
				map: CAVERN,
				selectedTokenId: null,
				tokens: [token()],
			})
				.runs.map((run) => run.text)
				.join("")
		).toBe("1 token · Tab to take the map");
	});
});
