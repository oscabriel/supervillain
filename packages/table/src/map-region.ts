/**
 * The chrome map region: core chrome's own region, not a layout slot. Slots
 * place *module* panels; the battle map is the core's furniture, which is
 * exactly why a future game module inherits maps for free (ADR-0006).
 *
 * The whole surface is one cell-grid `FrameBufferRenderable` — #38's settled
 * baseline. Terrain and tokens compose in `map.ts`; this file only paints the
 * composed cells and turns a click into a cell. There is no drag handler here,
 * and adding one is a churn row, not a patch: #38 leaves drag unvalidated
 * across clients and multiplexers.
 */
import { FrameBufferRenderable, RGBA } from "@opentui/core";
import type { OptimizedBuffer, RenderContext } from "@opentui/core";
import type { BattleMap, MapToken } from "@supervillain/core";
import { mapDimensions } from "@supervillain/core";

import {
	composePixelCells,
	pixelViewportSize,
	TILE_COLUMNS,
	TILE_ROWS,
} from "./map-pixel.js";
import { composeMapCells, mapCellAt, scrollViewport } from "./map.js";
import type { MapCursor, MapViewport } from "./map.js";
import { resolveThemeToken } from "./theme.js";

/** The two render tiers (ADR-0007/0021): pixel is the default, text is the
 * per-session toggle, and no capability detection sits between them. */
export type MapRenderMode = "pixel" | "text";

/** Rows outside the main band, plus the map's title/status and the feed's
 * header/one-line floor. The feed is non-negotiable; everything left is the
 * map grid's live terminal-cell budget. */
const MAP_VIEWPORT_RESERVED_ROWS = 8;

/** The map grid's terminal-row budget at a terminal height. This is dynamic:
 * 80×24 retains the feed beneath a 15-row pixel grid, while 188×60 can spend
 * 51 rows on 17 whole 4×3 tiles instead of carrying the text tier's old
 * 16-row ceiling into pixel mode. */
export const mapViewportCellRows = (terminalRows: number): number =>
	Math.max(1, Math.floor(terminalRows) - MAP_VIEWPORT_RESERVED_ROWS);

/** The blank beyond a map's edge: the terminal's own default, never a color.
 * `defaultBackground` emits the SGR reset, so it adds nothing to the palette. */
const BLANK_FG = RGBA.defaultForeground();
const BLANK_BG = RGBA.defaultBackground();
const BLANK_GLYPH = " ";

export interface MapRegionState {
	readonly mode: MapRenderMode;
	readonly map: BattleMap;
	readonly tokens: readonly MapToken[];
	readonly cursor: MapCursor | null;
	readonly selectedTokenId: string | null;
	readonly ownSeatId: string | null;
}

/** Where a click landed, in map cells. */
export type MapClickHandler = (cell: MapCursor) => void;

/**
 * The surface itself. It owns the viewport origin because panning is a
 * consequence of the cursor moving, not a state anyone else sets.
 */
export class MapSurfaceRenderable extends FrameBufferRenderable {
	#state: MapRegionState | null = null;
	#origin: { originX: number; originY: number } = { originX: 0, originY: 0 };
	#viewport: MapViewport = { height: 1, originX: 0, originY: 0, width: 1 };

	constructor(
		ctx: RenderContext,
		options: { readonly width: number; readonly height: number },
		onClick: MapClickHandler
	) {
		super(ctx, { height: options.height, width: options.width });
		// Mouse click is progressive enhancement and nothing depends on it. Only
		// `down` is bound: no drag, no drag-end, no drop.
		this.onMouseDown = (event) => {
			const map = this.#state?.map;
			if (map === undefined) {
				return;
			}
			// In pixel mode a click lands somewhere in a tile's 4×3 block; the
			// division makes both tiers resolve through the same hit-test.
			const pixel = this.#state?.mode === "pixel";
			const cell = mapCellAt(
				map,
				this.#viewport,
				pixel
					? Math.floor((event.x - this.x) / TILE_COLUMNS)
					: event.x - this.x,
				pixel ? Math.floor((event.y - this.y) / TILE_ROWS) : event.y - this.y
			);
			if (cell !== null) {
				event.preventDefault();
				onClick(cell);
			}
		};
	}

	/** The window the last paint showed — what hit-testing resolves against. */
	get viewport(): MapViewport {
		return this.#viewport;
	}

	/** Hands the region new state and asks for the one frame that shows it. */
	update(state: MapRegionState): void {
		this.#state = state;
		this.requestRender();
	}

	protected override renderSelf(buffer: OptimizedBuffer): void {
		this.#paint();
		super.renderSelf(buffer);
	}

	#paint(): void {
		const state = this.#state;
		if (state === null) {
			return;
		}
		const cells = {
			height: this.frameBuffer.height,
			width: this.frameBuffer.width,
		};
		// The viewport is always in map cells; the pixel tier just fits fewer
		// of them into the same terminal budget. Scrolling, cursor following,
		// and hit-testing never learn which tier is drawing.
		const size = state.mode === "pixel" ? pixelViewportSize(cells) : cells;
		this.#viewport = scrollViewport(
			state.map,
			size,
			this.#origin,
			state.cursor
		);
		this.#origin = {
			originX: this.#viewport.originX,
			originY: this.#viewport.originY,
		};
		const compose =
			state.mode === "pixel" ? composePixelCells : composeMapCells;
		const rows = compose({
			cursor: state.cursor,
			map: state.map,
			ownSeatId: state.ownSeatId,
			selectedTokenId: state.selectedTokenId,
			tokens: state.tokens,
			viewport: this.#viewport,
		});
		// Iterate the framebuffer, not the composition: in pixel mode the
		// composed rows cover whole tiles only, and any remainder column or row
		// must blank rather than hold a stale cell.
		for (let row = 0; row < cells.height; row += 1) {
			for (let column = 0; column < cells.width; column += 1) {
				const cell = rows[row]?.[column] ?? null;
				if (cell === null) {
					this.frameBuffer.setCell(
						column,
						row,
						BLANK_GLYPH,
						BLANK_FG,
						BLANK_BG
					);
					continue;
				}
				this.frameBuffer.setCell(
					column,
					row,
					cell.glyph,
					resolveThemeToken(cell.fg),
					resolveThemeToken(cell.bg)
				);
			}
		}
	}
}

/** The region's size for a map: as wide as the grid or the space, whichever is
 * smaller, and never taller than the rows the region is allowed to spend. In
 * pixel mode the same budget holds whole 4×3 tiles — the size is rounded to
 * tile multiples so no partial tile ever paints. */
export const mapRegionSize = (
	map: BattleMap,
	available: { readonly width: number; readonly height: number },
	mode: MapRenderMode
): { readonly width: number; readonly height: number } => {
	const { height, width } = mapDimensions(map);
	if (mode === "text") {
		return {
			height: Math.max(1, Math.min(height, available.height)),
			width: Math.max(1, Math.min(width, available.width)),
		};
	}
	const tiles = {
		height: Math.min(height, Math.floor(available.height / TILE_ROWS)),
		width: Math.min(width, Math.floor(available.width / TILE_COLUMNS)),
	};
	return {
		height: Math.max(1, tiles.height) * TILE_ROWS,
		width: Math.max(1, tiles.width) * TILE_COLUMNS,
	};
};

export type { MapCursor, MapViewport } from "./map.js";
