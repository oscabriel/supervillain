/* oxlint-disable eslint/no-bitwise, oxc/bad-bitwise-operator -- octant patterns are bitmask arithmetic by contract (ADR-0021). */
/**
 * The lobby's one atlas-rendered chrome set-piece. Its interface accepts no
 * text: callers can render the pinned wordmark and nothing else, so this
 * ornamental exception cannot become a back door for atlas-rendered prose.
 */
import { FrameBufferRenderable, RGBA } from "@opentui/core";
import type { OptimizedBuffer, RenderContext } from "@opentui/core";
import {
	glyphRowBytes,
	OCTANT_CHARS,
	octantPattern,
	TEXT_ATLAS,
	TILE_COLUMNS,
	TILE_ROWS,
} from "@supervillain/atlas";

import { resolveThemeToken } from "./theme.js";
import { WORDMARK_SOURCE } from "./wordmark-data.js";

export const PIXEL_WORDMARK_COLUMNS =
	[...WORDMARK_SOURCE].length * TILE_COLUMNS;
export const PIXEL_WORDMARK_ROWS = TILE_ROWS;

const wordmarkRows = (): readonly (readonly string[])[] => {
	const rows = Array.from({ length: PIXEL_WORDMARK_ROWS }, () =>
		Array.from({ length: PIXEL_WORDMARK_COLUMNS }, () => " ")
	);
	for (const [glyphIndex, glyph] of [...WORDMARK_SOURCE].entries()) {
		const entry = TEXT_ATLAS[glyph];
		if (entry === undefined) {
			throw new Error(`the Text atlas has no '${glyph}' for the wordmark`);
		}
		const bitmap = glyphRowBytes(entry);
		for (let row = 0; row < TILE_ROWS; row += 1) {
			for (let column = 0; column < TILE_COLUMNS; column += 1) {
				const pattern = octantPattern(bitmap, column, row);
				const target = rows[row];
				if (target !== undefined) {
					target[glyphIndex * TILE_COLUMNS + column] =
						OCTANT_CHARS[pattern] ?? " ";
				}
			}
		}
	}
	return rows;
};

/** The exact octant rows painted by the ornamental wordmark. */
export const pixelWordmarkRows = wordmarkRows();

/** Width-only demotion is layout, not capability detection: octant support is
 * never probed, remembered, or guessed. */
export const wordmarkTierForWidth = (
	availableColumns: number
): "pixel" | "text" =>
	availableColumns >= PIXEL_WORDMARK_COLUMNS ? "pixel" : "text";

/** Fixed-purpose ornamental renderer: no arbitrary string enters this module. */
export class PixelWordmarkRenderable extends FrameBufferRenderable {
	constructor(ctx: RenderContext) {
		super(ctx, {
			height: PIXEL_WORDMARK_ROWS,
			width: PIXEL_WORDMARK_COLUMNS,
		});
	}

	protected override renderSelf(buffer: OptimizedBuffer): void {
		const foreground = resolveThemeToken("accent");
		const background = RGBA.defaultBackground();
		for (const [row, cells] of pixelWordmarkRows.entries()) {
			for (const [column, glyph] of cells.entries()) {
				this.frameBuffer.setCell(column, row, glyph, foreground, background);
			}
		}
		super.renderSelf(buffer);
	}
}
