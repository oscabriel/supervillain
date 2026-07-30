/* oxlint-disable eslint/no-bitwise, oxc/bad-bitwise-operator -- octant patterns are bitmask arithmetic by contract (ADR-0021). */
/**
 * The pixel-glyph tier (ADR-0007 as amended by ADR-0021): the same map
 * semantics as the text tier, drawn through the MEKMODE atlas instead of the
 * terminal's font. One map tile becomes 4×3 terminal cells of octant
 * characters — every one of the glyph's 96 pixels survives, which is proven
 * by test, not asserted here.
 *
 * The lookup chain is the design: a cell's character indexes the Dings atlas
 * first (the map surface speaks Ding mode), the Text atlas second (a legend
 * character without a ding still renders as itself, pixel-drawn), and the
 * Text question mark last (no state may render as whitespace). The text tier
 * prints the very characters these bitmaps are keyed by — that identity is
 * what keeps the toggle lossless.
 */
import {
	DINGS_ATLAS,
	glyphRowBytes,
	OCTANT_CHARS,
	octantPattern,
	TEXT_ATLAS,
	TILE_COLUMNS,
	TILE_ROWS,
} from "@supervillain/atlas";

import { mapCellSemantics } from "./map.js";
import type { MapCell, MapComposition } from "./map.js";

const UNKNOWN_GLYPH_KEY = "?";

/** The bitmap a map character renders as: ding first, text second, `?` last. */
const glyphBitmap = (glyph: string): Uint8Array => {
	const entry =
		DINGS_ATLAS[glyph] ?? TEXT_ATLAS[glyph] ?? TEXT_ATLAS[UNKNOWN_GLYPH_KEY];
	if (entry === undefined) {
		throw new Error("the Text atlas has no question mark — a bake bug");
	}
	return glyphRowBytes(entry);
};

/** How many whole tiles fit a terminal-cell budget, never fewer than one. */
export const pixelViewportSize = (cells: {
	readonly width: number;
	readonly height: number;
}): { readonly width: number; readonly height: number } => ({
	height: Math.max(1, Math.floor(cells.height / TILE_ROWS)),
	width: Math.max(1, Math.floor(cells.width / TILE_COLUMNS)),
});

/**
 * Composes the visible window into terminal-cell rows, 4×3 per map tile.
 * The viewport is in map cells, exactly as the text tier's — the two tiers
 * share scrolling, cursor, and hit-testing arithmetic and differ only here.
 */
export const composePixelCells = (
	composition: MapComposition
): readonly (readonly (MapCell | null)[])[] => {
	const { viewport } = composition;
	const rows: (MapCell | null)[][] = [];
	for (let row = 0; row < viewport.height * TILE_ROWS; row += 1) {
		rows.push(
			Array.from(
				{ length: viewport.width * TILE_COLUMNS },
				(): MapCell | null => null
			)
		);
	}
	for (let tileRow = 0; tileRow < viewport.height; tileRow += 1) {
		for (let tileColumn = 0; tileColumn < viewport.width; tileColumn += 1) {
			const cell = mapCellSemantics(
				composition,
				viewport.originX + tileColumn,
				viewport.originY + tileRow
			);
			const bitmap = cell === null ? null : glyphBitmap(cell.glyph);
			for (let cellRow = 0; cellRow < TILE_ROWS; cellRow += 1) {
				const row = rows[tileRow * TILE_ROWS + cellRow];
				if (row === undefined) {
					continue;
				}
				for (let cellCol = 0; cellCol < TILE_COLUMNS; cellCol += 1) {
					const column = tileColumn * TILE_COLUMNS + cellCol;
					if (cell === null || bitmap === null) {
						row[column] = null;
						continue;
					}
					const pattern = octantPattern(bitmap, cellCol, cellRow);
					row[column] = {
						bg: cell.bg,
						fg: cell.fg,
						glyph: OCTANT_CHARS[pattern] ?? " ",
					};
				}
			}
		}
	}
	return rows;
};
