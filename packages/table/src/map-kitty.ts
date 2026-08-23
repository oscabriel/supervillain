/* oxlint-disable eslint/no-bitwise, oxc/bad-bitwise-operator -- 1-bit glyph packing is bitmask arithmetic by contract (ADR-0021). */
/* oxlint-disable unicorn/escape-case, unicorn/no-hex-escape -- kitty APC bytes are written \x1b throughout gloomberb and the protocol documents; another notation breaks greppability against them. */
/* oxlint-disable eslint/no-control-regex -- probe responses are control-character streams; recognizing them requires matching control characters. */
/* oxlint-disable eslint/sort-keys -- cell rects keep the protocol's own x,y,w,h field order everywhere. */
/**
 * The bitmap tier (ADR-0032): the same composed map as the two lower tiers,
 * rasterized to RGBA and emitted through the kitty graphics protocol — APC
 * escape sequences on stdout, which is why it traverses the ssh Door
 * unchanged. One map cell stays one 4×3-cell tile (ADR-0021), so viewport,
 * hit-testing, and demotion math are shared with the pixel tier; only
 * rasterization differs.
 *
 * Two deliberate departures from ADR-0032's letter, both tracked on #134:
 *
 * - Placement is classic (`a=p` placements + rect subtraction), because that
 *   is what the prototype validated live. The ADR's committed placeholders-
 *   first mechanism (U+10EEEE cells riding OpenTUI diffing) is still owed its
 *   OptimizedBuffer experiment; until that lands or the ADR reopens with
 *   evidence, this module ships the recorded fallback plan.
 * - Cell metrics fall back to a fixed 12×24 instead of the terminal's
 *   reported size: OpenTUI at pin `a0b9064` parses-and-drops CSI 16 t
 *   responses (`parse.keypress.ts` returns null for window/cell reports), so
 *   the answer never reaches us through the renderer we borrow stdin from.
 *   12×24 keeps atlas pixels square at a clean 6×6 block; a wrong guess costs
 *   nearest-neighbor softness, never breakage.
 *
 * Everything in here is bytes and arithmetic — no renderer import — so the
 * whole tier is testable headlessly. The raster buffer lives beside this file
 * (`map-kitty-framebuffer.ts`); the renderer-facing half (capability gate,
 * guarded raw write) lives in `map-kitty-channel.ts`. The lattice keeps all
 * three render-side only.
 */
import { deflateSync } from "node:zlib";

import type { MapCell, MapSize } from "./map.js";
import { glyphBitmap, TILE_COLUMNS, TILE_ROWS } from "./map-pixel.js";

import { Framebuffer } from "./map-kitty-framebuffer.js";

export { Framebuffer } from "./map-kitty-framebuffer.js";

/** Truecolor, used only inside transmitted image bytes (ADR-0032's ANSI-16 carve-out). */
export type Rgb = readonly [number, number, number];

/** A cell extent: 1-based terminal-cell origin plus counts. */
export interface CellRect {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
}

/** Pixels per terminal cell, as the terminal itself would report them. */
export interface CellMetrics {
	readonly width: number;
	readonly height: number;
}

/**
 * The pre-probe default. OpenTUI at the pinned clone swallows the CSI 16 t
 * cell-size reply before any surface could read it, so native-resolution
 * rasterization is blocked at the channel, not here. Revisit when OpenTUI
 * exposes terminal query responses (ADR-0032's raw-write revisit trigger).
 */
export const FALLBACK_CELL_METRICS: CellMetrics = { width: 12, height: 24 };

/**
 * Truecolor stand-ins for the five theme tokens — the bitmap interior's only
 * colors. They approximate the classic ANSI palette those tokens index in
 * `theme.ts`; tuned art values are a design follow-up, not lattice work.
 */
export const BITMAP_THEME_RGB = {
	accent: [0, 175, 175],
	danger: [205, 49, 49],
	muted: [112, 112, 112],
	primary: [204, 204, 204],
	success: [80, 175, 80],
} satisfies Readonly<Record<MapCell["fg"], Rgb>>;

// ---------------------------------------------------------------------------
// APC encoding — the core of the tier.
// ---------------------------------------------------------------------------

const APC = (control: string, payload = "") =>
	payload === ""
		? `\x1b_G${control}\x1b\\`
		: `\x1b_G${control};${payload}\x1b\\`;

export const TRANSMIT_CHUNK_BYTES = 4096;

/**
 * Transmit one RGBA framebuffer as a deflated, base64-chunked `a=t` sequence
 * chain. `m=1` is set only when a continuation actually follows: a lone chunk
 * marked `m=1` leaves the terminal waiting forever and nothing ever commits
 * (the dead-arrow-keys lesson, fixed and validated over real ssh).
 */
export const transmitSequences = (
	imageId: number,
	fb: Framebuffer,
	chunkSize: number = TRANSMIT_CHUNK_BYTES
): readonly string[] => {
	// Deflate level 3 is gloomberb's local-pty CPU tuning; our constraint is
	// ssh bandwidth, which likely wants something slower and tighter.
	// Placeholder until a benchmarks-dir run exists (ADR-0012/NQ-10).
	const base64 = deflateSync(fb.pixels, { level: 3 }).toString("base64");
	const continues = (start: number): 0 | 1 =>
		start + chunkSize < base64.length ? 1 : 0;
	const first = APC(
		`a=t,f=32,t=d,o=z,s=${fb.width},v=${fb.height},i=${imageId},q=2,m=${continues(0)}`,
		base64.slice(0, chunkSize)
	);
	const rest: string[] = [];
	for (let start = chunkSize; start < base64.length; start += chunkSize) {
		rest.push(
			APC(`m=${continues(start)}`, base64.slice(start, start + chunkSize))
		);
	}
	return [first, ...rest];
};

/** Places a crop of a transmitted image onto the cell grid, 1-based. */
export const placementSequence = (
	imageId: number,
	placementId: number,
	rect: CellRect,
	zIndex: number,
	crop?: {
		readonly x: number;
		readonly y: number;
		readonly w: number;
		readonly h: number;
	}
): string => {
	const cropFields =
		crop === undefined
			? ""
			: `,x=${crop.x},y=${crop.y},w=${crop.w},h=${crop.h}`;
	return `\x1b[s\x1b[${rect.y};${rect.x}H${APC(
		`a=p,i=${imageId},p=${placementId},q=2,c=${rect.w},r=${rect.h},z=${zIndex},C=1${cropFields}`
	)}\x1b[u`;
};

export const deleteImageSequence = (
	imageId: number,
	placementId?: number
): string =>
	placementId === undefined
		? APC(`a=d,d=I,i=${imageId},q=2`)
		: APC(`a=d,d=I,i=${imageId},p=${placementId},q=2`);

/** Rectangle subtraction: `whole` minus `hole`, as up to four rects. */
export const subtractRect = (
	whole: CellRect,
	hole: CellRect | null
): CellRect[] => {
	if (hole === null) {
		return [whole];
	}
	const holeEndX = hole.x + hole.w;
	const holeEndY = hole.y + hole.h;
	const fragments: CellRect[] = [];
	if (hole.y > whole.y) {
		fragments.push({ ...whole, h: hole.y - whole.y });
	}
	if (holeEndY < whole.y + whole.h) {
		fragments.push({
			x: whole.x,
			y: holeEndY,
			w: whole.w,
			h: whole.y + whole.h - holeEndY,
		});
	}
	const bandY = Math.max(whole.y, hole.y);
	const bandH = Math.min(whole.y + whole.h, holeEndY) - bandY;
	if (bandH > 0) {
		if (hole.x > whole.x) {
			fragments.push({
				x: whole.x,
				y: bandY,
				w: hole.x - whole.x,
				h: bandH,
			});
		}
		if (holeEndX < whole.x + whole.w) {
			fragments.push({
				x: holeEndX,
				y: bandY,
				w: whole.x + whole.w - holeEndX,
				h: bandH,
			});
		}
	}
	return fragments;
};

// ---------------------------------------------------------------------------
// Probe response parsing. The product verdict comes from the renderer's own
// capability detection (`map-kitty-channel.ts`); this parser exists for the
// recorded-response tests and for any surface that must read raw replies
// again — it mirrors the two signals the prototype matched over real ssh.
// ---------------------------------------------------------------------------

export interface ProbeReading {
	readonly graphicsSupported: boolean;
	readonly cellPx: CellMetrics | null;
}

export const parseProbeResponse = (raw: string): ProbeReading => {
	// Either an APC graphics response (the a=q reply), or `_G` advertised in
	// the primary-device-attributes reply (kitty and ghostty do this).
	const graphicsSupported =
		/\x1b_G(?<body>[\s\S]*?)\x1b\\/u.test(raw) ||
		/\x1b\[\?[\d;]*_G/u.test(raw);
	const cellMatch = raw.match(/\x1b\[6;(?<height>\d+);(?<width>\d+)t/u);
	return {
		cellPx:
			cellMatch?.groups === undefined
				? null
				: {
						height: Number(cellMatch.groups.height),
						width: Number(cellMatch.groups.width),
					},
		graphicsSupported,
	};
};

// ---------------------------------------------------------------------------
// The raster pipeline: atlas glyphs onto RGBA tiles.
// ---------------------------------------------------------------------------

export const tilePixelSize = (tiles: MapSize, cell: CellMetrics) => ({
	height: tiles.height * TILE_ROWS * cell.height,
	width: tiles.width * TILE_COLUMNS * cell.width,
});

/**
 * Atlas-pixel grid → framebuffer rows for one glyph axis: rounding each edge
 * independently distributes non-integer scale factors with no gaps and no
 * drift, keeping every edge on an exact pixel boundary (crisp
 * nearest-neighbor — the native-resolution lesson, holding at whatever
 * metrics we actually have).
 */
export const spanBounds = (
	index: number,
	count: number,
	extent: number
): readonly [number, number] => [
	Math.round((index * extent) / count),
	Math.round(((index + 1) * extent) / count),
];

const drawGlyphInto = (
	fb: Framebuffer,
	originX: number,
	originY: number,
	glyph: string,
	fg: Rgb,
	tileWidthPx: number,
	tileHeightPx: number
): void => {
	const rows = glyphBitmap(glyph);
	for (let gy = 0; gy < rows.length; gy += 1) {
		const byte = rows[gy] ?? 0;
		const [y0, y1] = spanBounds(gy, rows.length, tileHeightPx);
		for (let gx = 0; gx < 8; gx += 1) {
			if (!((byte >> (7 - gx)) & 1)) {
				continue;
			}
			const [x0, x1] = spanBounds(gx, 8, tileWidthPx);
			for (let py = y0; py < y1; py += 1) {
				for (let px = x0; px < x1; px += 1) {
					fb.setPixel(originX + px, originY + py, fg);
				}
			}
		}
	}
};

const brighten = (rgb: Rgb, by: number): Rgb => [
	Math.min(255, rgb[0] + by),
	Math.min(255, rgb[1] + by),
	Math.min(255, rgb[2] + by),
];

/**
 * Rasterizes composed map-cell rows (one cell = one 4×3-cell tile, exactly
 * `composeMapCells`' output) into an RGBA framebuffer. Terrain gets a subtle
 * checker so adjacent same-kind tiles read as tiles — the prototype's
 * validated look. Cells outside the map stay transparent so the terminal's
 * own background shows through the image.
 */
export const rasterizeCells = (
	rows: readonly (readonly (MapCell | null)[])[],
	cell: CellMetrics
): Framebuffer => {
	const tiles = {
		height: rows.length,
		width: rows[0]?.length ?? 0,
	};
	const size = tilePixelSize(tiles, cell);
	const fb = new Framebuffer(size.width, size.height);
	const tileWidthPx = TILE_COLUMNS * cell.width;
	const tileHeightPx = TILE_ROWS * cell.height;
	for (let ty = 0; ty < tiles.height; ty += 1) {
		for (let tx = 0; tx < tiles.width; tx += 1) {
			const composed = rows[ty]?.[tx];
			if (composed === null || composed === undefined) {
				continue;
			}
			const originX = tx * tileWidthPx;
			const originY = ty * tileHeightPx;
			const bg = BITMAP_THEME_RGB[composed.bg];
			const shade = (tx + ty) % 2 === 0 ? bg : brighten(bg, 6);
			for (let py = 0; py < tileHeightPx; py += 1) {
				for (let px = 0; px < tileWidthPx; px += 1) {
					fb.setPixel(originX + px, originY + py, shade);
				}
			}
			drawGlyphInto(
				fb,
				originX,
				originY,
				composed.glyph,
				BITMAP_THEME_RGB[composed.fg],
				tileWidthPx,
				tileHeightPx
			);
		}
	}
	return fb;
};

// ---------------------------------------------------------------------------
// The map surface: double-buffered base image, strip updates for cheap moves,
// occluder fragmentation for chrome over the map. Writes through an injected
// sink, so tests drive it without a renderer.
// ---------------------------------------------------------------------------

const BASE_IMAGE_IDS = [3100, 3101] as const;
const STRIP_IMAGE_IDS = [3200, 3201] as const;
// Below text: blanked cells let the image show. Strips sit one layer above.
const BASE_Z_INDEX = -1;
const STRIP_Z_INDEX = 1;
const BASE_PLACEMENT_ID_START = 41;
const STRIP_PLACEMENT_ID = 51;

/**
 * When a changed region stays within this many tiles, an update rides a strip
 * re-encode instead of a full transmit. Placeholder pending the benchmarks
 * run (ADR-0012/NQ-10); the prototype measured strips at 4–10 KiB against a
 * ~120 KiB full map.
 */
const MAX_STRIP_TILES = 12;

const rectEquals = (a: CellRect | null, b: CellRect | null): boolean =>
	a === b ||
	(a !== null &&
		b !== null &&
		a.x === b.x &&
		a.y === b.y &&
		a.w === b.w &&
		a.h === b.h);

/**
 * The changed region between two frames, snapped outward to whole tiles, in
 * map-cell coords — or null when the frames agree pixel for pixel.
 */
const changedTileRegion = (
	previous: Framebuffer,
	frame: Framebuffer,
	mapRect: CellRect
): CellRect | null => {
	let minX = frame.width;
	let minY = frame.height;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < frame.height; y += 1) {
		const rowOffset = y * frame.width * 4;
		for (let x = 0; x < frame.width; x += 1) {
			const offset = rowOffset + x * 4;
			if (
				previous.pixels[offset] !== frame.pixels[offset] ||
				previous.pixels[offset + 1] !== frame.pixels[offset + 1] ||
				previous.pixels[offset + 2] !== frame.pixels[offset + 2]
			) {
				minX = Math.min(minX, x);
				maxX = Math.max(maxX, x);
				minY = Math.min(minY, y);
				maxY = Math.max(maxY, y);
			}
		}
	}
	if (maxX < 0) {
		return null;
	}
	const tileWidthPx = (frame.width / mapRect.w) * TILE_COLUMNS;
	const tileHeightPx = (frame.height / mapRect.h) * TILE_ROWS;
	const firstTileX = Math.floor(minX / tileWidthPx);
	const lastTileX = Math.floor(maxX / tileWidthPx);
	const firstTileY = Math.floor(minY / tileHeightPx);
	const lastTileY = Math.floor(maxY / tileHeightPx);
	return {
		x: mapRect.x + firstTileX * TILE_COLUMNS,
		y: mapRect.y + firstTileY * TILE_ROWS,
		w: (lastTileX - firstTileX + 1) * TILE_COLUMNS,
		h: (lastTileY - firstTileY + 1) * TILE_ROWS,
	};
};

export class KittyMapSurface {
	private readonly baseIds = [...BASE_IMAGE_IDS];
	private readonly stripIds = [...STRIP_IMAGE_IDS];
	private activeBase: 0 | 1 | null = null;
	private activeStrip: 0 | 1 | null = null;
	private previousFrame: Framebuffer | null = null;
	private lastOccluder: CellRect | null = null;
	private readonly write: (data: string) => void;
	private readonly chunkSize: number;

	constructor(
		write: (data: string) => void,
		chunkSize: number = TRANSMIT_CHUNK_BYTES
	) {
		this.write = write;
		this.chunkSize = chunkSize;
	}

	/**
	 * Shows `frame` on the cell rect `mapRect`. Diffs against the previous
	 * frame: a small changed region rides a kilobyte-scale strip re-encode,
	 * anything larger retransmits the whole double-buffered image, an
	 * identical frame emits nothing at all (chrome repaints freely). Strips
	 * ignore occluders, so while one is present every update takes the full
	 * path, whose fragmenting handles the hole correctly.
	 */
	render(frame: Framebuffer, mapRect: CellRect, occluder: CellRect | null): void {
		const previous = this.previousFrame;
		const previousOccluder = this.lastOccluder;
		this.previousFrame = frame;
		this.lastOccluder = occluder;
		if (
			previous !== null &&
			previous.width === frame.width &&
			previous.height === frame.height &&
			rectEquals(previousOccluder, occluder)
		) {
			const stripRegion =
				occluder === null
					? changedTileRegion(previous, frame, mapRect)
					: null;
			if (stripRegion === null) {
				// Pixel-identical, same occlusion: the terminal already has it.
				return;
			}
			const changedTiles =
				(stripRegion.w / TILE_COLUMNS) * (stripRegion.h / TILE_ROWS);
			if (changedTiles <= MAX_STRIP_TILES) {
				this.updateStrip(frame, mapRect, stripRegion);
				return;
			}
		}
		this.renderBase(frame, mapRect, occluder);
	}

	/** Frees every image slot; teardown and any exit from bitmap mode. */
	clear(): void {
		this.write(
			[...this.baseIds, ...this.stripIds]
				.map((id) => deleteImageSequence(id))
				.join("")
		);
		this.activeBase = null;
		this.activeStrip = null;
		this.previousFrame = null;
		this.lastOccluder = null;
	}

	private renderBase(
		fb: Framebuffer,
		mapRect: CellRect,
		occluder: CellRect | null
	): void {
		const next: 0 | 1 = this.activeBase === 0 ? 1 : 0;
		const id = this.baseIds[next] ?? 0;
		const pxPerCellX = fb.width / mapRect.w;
		const pxPerCellY = fb.height / mapRect.h;
		const fragmentPlacements = subtractRect(mapRect, occluder).map(
			(fragment, index) =>
				placementSequence(
					id,
					BASE_PLACEMENT_ID_START + index,
					fragment,
					BASE_Z_INDEX,
					{
						x: Math.round((fragment.x - mapRect.x) * pxPerCellX),
						y: Math.round((fragment.y - mapRect.y) * pxPerCellY),
						w: Math.round(fragment.w * pxPerCellX),
						h: Math.round(fragment.h * pxPerCellY),
					}
				)
		);
		// A resident strip would ghost above the new base — retire it with the
		// base it annotated.
		const stripRetirement =
			this.activeStrip === null
				? []
				: [deleteImageSequence(this.stripIds[this.activeStrip] ?? 0)];
		if (this.activeStrip !== null) {
			this.activeStrip = null;
		}
		const baseRetirement =
			this.activeBase === null
				? []
				: [deleteImageSequence(this.baseIds[this.activeBase] ?? 0)];
		this.write(
			[
				...transmitSequences(id, fb, this.chunkSize),
				...fragmentPlacements,
				...stripRetirement,
				...baseRetirement,
			].join("")
		);
		this.activeBase = next;
	}

	private updateStrip(
		fb: Framebuffer,
		mapRect: CellRect,
		region: CellRect
	): void {
		const next: 0 | 1 = this.activeStrip === 0 ? 1 : 0;
		const id = this.stripIds[next] ?? 0;
		const pxPerCellX = fb.width / mapRect.w;
		const pxPerCellY = fb.height / mapRect.h;
		const cut = fb.cut(
			Math.round((region.x - mapRect.x) * pxPerCellX),
			Math.round((region.y - mapRect.y) * pxPerCellY),
			Math.round(region.w * pxPerCellX),
			Math.round(region.h * pxPerCellY)
		);
		const retirement =
			this.activeStrip === null
				? []
				: [deleteImageSequence(this.stripIds[this.activeStrip] ?? 0)];
		this.write(
			[
				...transmitSequences(id, cut, this.chunkSize),
				placementSequence(id, STRIP_PLACEMENT_ID, region, STRIP_Z_INDEX),
				...retirement,
			].join("")
		);
		this.activeStrip = next;
	}
}
