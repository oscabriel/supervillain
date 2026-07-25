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

import { composeMapCells, mapCellAt, scrollViewport } from "./map.js";
import type { MapCursor, MapViewport } from "./map.js";
import { resolveThemeToken } from "./theme.js";

/** How many terminal rows the region may spend on the grid before it pans. */
export const MAP_VIEWPORT_MAX_ROWS = 16;

/** The blank beyond a map's edge: the terminal's own default, never a color.
 * `defaultBackground` emits the SGR reset, so it adds nothing to the palette. */
const BLANK_FG = RGBA.defaultForeground();
const BLANK_BG = RGBA.defaultBackground();
const BLANK_GLYPH = " ";

export interface MapRegionState {
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
			const cell = mapCellAt(
				map,
				this.#viewport,
				event.x - this.x,
				event.y - this.y
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
		const size = {
			height: this.frameBuffer.height,
			width: this.frameBuffer.width,
		};
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
		const rows = composeMapCells({
			cursor: state.cursor,
			map: state.map,
			ownSeatId: state.ownSeatId,
			selectedTokenId: state.selectedTokenId,
			tokens: state.tokens,
			viewport: this.#viewport,
		});
		for (const [row, cells] of rows.entries()) {
			for (const [column, cell] of cells.entries()) {
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
 * smaller, and never taller than the rows the region is allowed to spend. */
export const mapRegionSize = (
	map: BattleMap,
	available: { readonly width: number; readonly height: number }
): { readonly width: number; readonly height: number } => {
	const { height, width } = mapDimensions(map);
	return {
		height: Math.max(1, Math.min(height, available.height)),
		width: Math.max(1, Math.min(width, available.width)),
	};
};

export type { MapCursor, MapViewport } from "./map.js";
