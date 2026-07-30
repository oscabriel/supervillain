/* oxlint-disable eslint/no-bitwise, oxc/bad-bitwise-operator -- 1-bit glyph rows and octant patterns are bitmask arithmetic by contract (ADR-0021). */
/**
 * The glyph atlas (ADR-0007 as amended by ADR-0021): build-time-baked 1-bit
 * MEKMODE bitmaps plus the Unicode octant table. Data-only — consumed by the
 * render side; the host and gateway never see it. Every atlas entry is keyed
 * by the character it depicts, which is what keeps the text tier a lossless
 * fallback.
 */

export { DINGS_ATLAS } from "./generated/dings.js";
export { OCTANT_CHARS } from "./generated/octants.js";
export { TEXT_ATLAS } from "./generated/text.js";

/** Glyph bitmap width in pixels. */
export const GLYPH_WIDTH = 8;

/** Glyph bitmap height in pixels. */
export const GLYPH_HEIGHT = 12;

/** Octant sub-pixels per terminal cell, horizontally. */
export const CELL_PIXEL_WIDTH = 2;

/** Octant sub-pixels per terminal cell, vertically. */
export const CELL_PIXEL_HEIGHT = 4;

/** One map tile's width in terminal cells (ADR-0021). */
export const TILE_COLUMNS = GLYPH_WIDTH / CELL_PIXEL_WIDTH;

/** One map tile's height in terminal cells (ADR-0021). */
export const TILE_ROWS = GLYPH_HEIGHT / CELL_PIXEL_HEIGHT;

const HEX_RADIX = 16;
const HEX_CHARS_PER_ROW = 2;

/**
 * Decode an atlas entry's 24 hex chars into 12 row bytes (MSB = leftmost
 * pixel). Throws on malformed input — atlas data is generated, so a bad row
 * is a bake bug, not a runtime condition to tolerate.
 */
export const glyphRowBytes = (entry: string): Uint8Array => {
	if (entry.length !== GLYPH_HEIGHT * HEX_CHARS_PER_ROW) {
		throw new Error(`atlas entry has ${entry.length} hex chars, expected 24`);
	}
	const rows = new Uint8Array(GLYPH_HEIGHT);
	for (let y = 0; y < GLYPH_HEIGHT; y += 1) {
		const byte = Number.parseInt(
			entry.slice(y * HEX_CHARS_PER_ROW, (y + 1) * HEX_CHARS_PER_ROW),
			HEX_RADIX
		);
		if (Number.isNaN(byte)) {
			throw new TypeError(`atlas entry row ${y} is not hex: ${entry}`);
		}
		rows[y] = byte;
	}
	return rows;
};

/**
 * The 2x4 pixel pattern for one terminal cell of a glyph, suitable for
 * indexing OCTANT_CHARS. Bit i = cell i+1 in the Unicode octant numbering
 * (row-major, two columns, cell 1 top-left).
 */
export const octantPattern = (
	rows: Uint8Array,
	cellColumn: number,
	cellRow: number
): number => {
	let pattern = 0;
	for (let dy = 0; dy < CELL_PIXEL_HEIGHT; dy += 1) {
		for (let dx = 0; dx < CELL_PIXEL_WIDTH; dx += 1) {
			const x = cellColumn * CELL_PIXEL_WIDTH + dx;
			const y = cellRow * CELL_PIXEL_HEIGHT + dy;
			const rowByte = rows[y];
			if (rowByte === undefined) {
				throw new Error(`octant cell row ${cellRow} is outside the glyph`);
			}
			const bit = (rowByte >> (GLYPH_WIDTH - 1 - x)) & 1;
			pattern |= bit << (dy * CELL_PIXEL_WIDTH + dx);
		}
	}
	return pattern;
};
