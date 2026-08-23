// PROTOTYPE — THROWAWAY (not production code; no tests by design).
//
// Question: is the Kitty graphics protocol feasible as a third battle-map
// render tier (above pixel-glyph and text)? Branch note: this is a
// mechanics-feasibility prototype, not a UI-variants or state-model one, so
// the artifact is a terminal program rather than an HTML file.
//
// It answers four things, and prints measurements for each:
//   Q1  Does the capability probe work over a real pty, and on what budget?
//   Q2  Can one raster pipeline feed all three tiers (kitty / octant / text)
//       from the same map state (ADR-0021's atlas + the core tile vocabulary)?
//   Q3  Is a token move a strip re-encode (kilobytes) rather than a full
//       map retransmit (the gloomberb crosshair lesson)?
//   Q4  Does cell-rect occlusion fragmenting keep a dialog over the map cheap?
//
// NOT validated here: OpenTUI `writeOut` integration (renderer-side wiring is
// a later step); remote-pty probe budgets (run this over ssh yourself: it
// honors KITTY_PROBE_MS).
//
// Run:      bun packages/table/prototype/kitty-map.ts
// Keys:     arrows = move selected token, tab = next token, t = cycle tier,
//           g = toggle dings/chars terrain, d = toggle dialog occluder,
//           f = force full redraw, q/Esc = quit.
// Non-TTY:  renders one frame per tier, prints byte counts, exits.

import { deflateSync } from "node:zlib";
import { appendFileSync } from "node:fs";
import {
	TEXT_ATLAS,
	DINGS_ATLAS,
	OCTANT_CHARS,
	glyphRowBytes,
	TILE_COLUMNS,
	TILE_ROWS,
} from "../../atlas/src/index.ts";

// ---------------------------------------------------------------------------
// Sample map — same shape as the core map file format (packages/core/src/map.ts):
// a character grid whose legend names the core tile vocabulary.
// ---------------------------------------------------------------------------

const DEFAULT_LEGEND: Record<string, MapTileKind> = {
	".": "floor",
	"#": "wall",
	"+": "door",
	"^": "hazard",
	"~": "difficult",
};

type MapTileKind = "difficult" | "door" | "floor" | "hazard" | "wall";

const SAMPLE_MAP = [
	"########################",
	"#.....#........~~....^.#",
	"#.++..#..####..~~......#",
	"#.....+..#..#..........#",
	"#.....#..#+.#....~~~...#",
	"#####.#..#..#....~~~...#",
	"#.....#..####..........#",
	"#..~~....#.....#####...#",
	"#..~~....#.........+...#",
	"########################",
];

// ---------------------------------------------------------------------------
// Dings terrain (ADR-0021's tile-art vocabulary): each tile kind renders from
// the baked MEKMODE Dings atlas instead of the legend character. Two variants
// per kind where texture wants variety, picked deterministically per tile.
// ---------------------------------------------------------------------------
const TILE_DINGS: Record<MapTileKind, [string, string]> = {
	// Walls and floors repeat ONE ding uniformly — MEK.txt composes textures
	// from uniform repetition (see the mek.gallery specimen's woven border),
	// not per-tile variety.
	floor: [".", "."],
	wall: ["A", "A"],
	door: ["[", "]"],
	hazard: ["/", "<"],
	// Vegetation areas mix dings in the specimen; keep the pair here.
	difficult: ["e", "k"], // scrub / bush pictograms
};

function dingForTile(kind: MapTileKind, tx: number, ty: number): string {
	const [a, b] = TILE_DINGS[kind]!;
	return (tx + ty) % 2 === 0 ? a : b;
}

interface Token {
	id: number;
	glyph: string; // atlas-keyed character, per ADR-0006
	label: string;
	color: Rgb;
	x: number; // map tile coords
	y: number;
}

const TOKENS: Token[] = [
	{ id: 1, glyph: "@", label: "Vael", color: [255, 120, 60], x: 2, y: 2 },
	{ id: 2, glyph: "H", label: "Harrow", color: [80, 170, 255], x: 7, y: 6 },
	{ id: 3, glyph: "S", label: "Skitter", color: [130, 255, 130], x: 17, y: 7 },
];

// Theme-ish RGB per tile kind (prototype stand-ins for the ANSI-16 theme
// tokens; the real tier would map theme tokens → truecolor only inside image
// bytes, per the ANSI-16 carve-out under discussion).
const TILE_COLORS: Record<MapTileKind, { fg: Rgb; bg: Rgb }> = {
	floor: { fg: [60, 60, 68], bg: [24, 24, 28] },
	wall: { fg: [200, 200, 205], bg: [70, 70, 80] },
	door: { fg: [220, 170, 80], bg: [60, 48, 28] },
	hazard: { fg: [240, 90, 80], bg: [50, 24, 24] },
	difficult: { fg: [110, 200, 110], bg: [26, 42, 26] },
};

type Rgb = readonly [number, number, number];

// ---------------------------------------------------------------------------
// Framebuffer — one raster pipeline (Q2). The kitty tier emits it as RGBA; the
// octant tier samples its 2×4 sub-blocks; nothing here knows about terminals.
// ---------------------------------------------------------------------------

// Raster metrics derive from the terminal's reported cell pixel size
// (\x1b[16t), adopted once the probe answers — the bitmap is transmitted at
// the placement rect's exact native resolution and the terminal never scales
// it (the softness lesson; gloomberb requires pixel resolution known before
// its kitty path engages). Until the probe answers: 12×24 cells keep atlas
// pixels square at a clean 6×6 block.
let CELL_PX = { w: 12, h: 24 };
let TILE_PX_W = TILE_COLUMNS * CELL_PX.w;
let TILE_PX_H = TILE_ROWS * CELL_PX.h;

function adoptCellMetrics(cellW: number, cellH: number): void {
	CELL_PX = { w: cellW, h: cellH };
	TILE_PX_W = TILE_COLUMNS * cellW;
	TILE_PX_H = TILE_ROWS * cellH;
}

/**
 * Atlas-pixel grid → framebuffer rows for one glyph row: rounding each edge
 * independently distributes non-integer scale factors without gaps or drift,
 * keeping every edge on an exact pixel boundary (crisp nearest-neighbor).
 */
function rowSpan(gy: number): [number, number] {
	return [Math.round((gy * TILE_PX_H) / 12), Math.round(((gy + 1) * TILE_PX_H) / 12)];
}

/** Same as rowSpan, horizontally. */
function colSpan(gx: number): [number, number] {
	return [Math.round((gx * TILE_PX_W) / 8), Math.round(((gx + 1) * TILE_PX_W) / 8)];
}

class Framebuffer {
	readonly width: number;
	readonly height: number;
	readonly pixels: Uint8Array;

	constructor(width: number, height: number) {
		this.width = width;
		this.height = height;
		this.pixels = new Uint8Array(width * height * 4);
	}

	setPx(x: number, y: number, rgb: Rgb, alpha = 255): void {
		if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
		const i = (y * this.width + x) * 4;
		this.pixels[i] = rgb[0];
		this.pixels[i + 1] = rgb[1];
		this.pixels[i + 2] = rgb[2];
		this.pixels[i + 3] = alpha;
	}

	getPx(x: number, y: number): Rgb {
		const i = (y * this.width + x) * 4;
		return [this.pixels[i]!, this.pixels[i + 1]!, this.pixels[i + 2]!];
	}

	cut(rx: number, ry: number, rw: number, rh: number): Framebuffer {
		const out = new Framebuffer(rw, rh);
		for (let y = 0; y < rh; y++) {
			for (let x = 0; x < rw; x++) {
				const src = ((ry + y) * this.width + (rx + x)) * 4;
				const dst = (y * rw + x) * 4;
				for (let b = 0; b < 4; b++) out.pixels[dst + b] = this.pixels[src + b]!;
			}
		}
		return out;
	}
}

function drawGlyph(
	fb: Framebuffer,
	originX: number,
	originY: number,
	glyphChar: string,
	fg: Rgb,
	atlas: Readonly<Record<string, string>> = TEXT_ATLAS,
): void {
	const entry = atlas[glyphChar] ?? atlas["?"] ?? TEXT_ATLAS["?"]!;
	const rows = glyphRowBytes(entry);
	for (let gy = 0; gy < 12; gy++) {
		const byte = rows[gy]!;
		const [y0, y1] = rowSpan(gy);
		for (let gx = 0; gx < 8; gx++) {
			if (!((byte >> (7 - gx)) & 1)) continue;
			const [x0, x1] = colSpan(gx);
			for (let py = y0; py < y1; py++) {
				for (let px = x0; px < x1; px++) {
					fb.setPx(originX + px, originY + py, fg);
				}
			}
		}
	}
}

function fillRect(fb: Framebuffer, x: number, y: number, w: number, h: number, rgb: Rgb): void {
	for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) fb.setPx(x + dx, y + dy, rgb);
}

function renderMap(map: MapState, terrainStyle: "chars" | "dings" = "dings"): Framebuffer {
	const cols = SAMPLE_MAP[0]!.length;
	const rows = SAMPLE_MAP.length;
	const fb = new Framebuffer(cols * TILE_PX_W, rows * TILE_PX_H);

	for (let ty = 0; ty < rows; ty++) {
		for (let tx = 0; tx < cols; tx++) {
			const ch = SAMPLE_MAP[ty]![tx]!;
			const kind = DEFAULT_LEGEND[ch] ?? "floor";
			const colors = TILE_COLORS[kind];
			const ox = tx * TILE_PX_W;
			const oy = ty * TILE_PX_H;
			// subtle checker so adjacent floors read as tiles
			const shade = (tx + ty) % 2 === 0 ? colors.bg : brighten(colors.bg, 6);
			fillRect(fb, ox, oy, TILE_PX_W, TILE_PX_H, shade);
			if (terrainStyle === "dings") {
				// dings terrain: the pictogram at full tile size, fg lifted so
				// the texture reads against the bg without shouting
				drawGlyph(fb, ox, oy, dingForTile(kind, tx, ty), brighten(colors.fg, 24), DINGS_ATLAS);
			} else {
				drawGlyph(fb, ox, oy, ch, colors.fg);
			}
			// 1px tile grid at low contrast
			for (let py = 0; py < TILE_PX_H; py++) fb.setPx(ox + TILE_PX_W - 1, oy + py, [16, 16, 20]);
			for (let px = 0; px < TILE_PX_W; px++) fb.setPx(ox, oy + py0(px), [16, 16, 20]);
		}
	}

	for (const token of map.tokens) {
		drawToken(fb, token, token.id === map.selectedId);
	}
	return fb;
}

function py0(_px: number): number {
	return 0; // placeholder kept simple; left/top grid line only
}

function drawToken(fb: Framebuffer, token: Token, selected: boolean): void {
	const cx = token.x * TILE_PX_W + TILE_PX_W / 2;
	const cy = token.y * TILE_PX_H + TILE_PX_H / 2;
	const r = TILE_PX_W / 2 - 1;
	// disc
	for (let y = Math.floor(cy - r) - 1; y <= Math.ceil(cy + r) + 1; y++) {
		for (let x = Math.floor(cx - r) - 1; x <= Math.ceil(cx + r) + 1; x++) {
			const d = Math.hypot(x - cx, y - cy);
			if (d <= r - 1.5) fb.setPx(x, y, [14, 14, 18]);
			else if (d <= r) fb.setPx(x, y, token.color);
			else if (selected && d <= r + 1.5) fb.setPx(x, y, [255, 255, 255]);
		}
	}
	// glyph centered on the disc — per-axis spans keep it crisp at odd scales
	const entry = TEXT_ATLAS[token.glyph] ?? TEXT_ATLAS["?"]!;
	const rows = glyphRowBytes(entry);
	for (let gy = 0; gy < 12; gy++) {
		const byte = rows[gy]!;
		for (let gx = 0; gx < 8; gx++) {
			if (!((byte >> (7 - gx)) & 1)) continue;
			const cxL = cx + (gx - 4) * (TILE_PX_W / 8);
			const cyT = cy + (gy - 6) * (TILE_PX_H / 12);
			const x0 = Math.round(cxL);
			const x1 = Math.round(cxL + TILE_PX_W / 8);
			const y0 = Math.round(cyT);
			const y1 = Math.round(cyT + TILE_PX_H / 12);
			for (let py = y0; py < y1; py++) {
				for (let px = x0; px < x1; px++) {
					fb.setPx(px, py, token.color);
				}
			}
		}
	}
}

function brighten(rgb: Rgb, by: number): Rgb {
	return [Math.min(255, rgb[0] + by), Math.min(255, rgb[1] + by), Math.min(255, rgb[2] + by)];
}

interface MapState {
	tokens: Token[];
	selectedId: number;
}

// ---------------------------------------------------------------------------
// Kitty protocol encoder (APC sequences) — the ~100-line core of the tier.
// ---------------------------------------------------------------------------

const APC = (control: string, payload = "") => `\x1b_G${control};${payload}\x1b\\`;

export interface Stats {
	lastOpBytes: number;
	lastEncodeMs: number;
	totalBytes: number;
}

function transmitSequences(
	imageId: number,
	fb: Framebuffer,
	stats: Stats,
	chunkSize = 4096,
): string[] {
	const t0 = performance.now();
	// deflate level 3: gloomberb's measured local-pty choice (compresses ~2.5x
	// faster than default for ~40% more bytes). This prototype measures the
	// byte side; the benchmarks run owns the final number.
	const compressed = deflateSync(fb.pixels, { level: 3 });
	const base64 = compressed.toString("base64");
	// m=1 only when a continuation actually follows — a lone chunk marked m=1
	// leaves the terminal waiting forever and the image never commits (the
	// dead-arrow-keys lesson: full maps have enough chunks to terminate,
	// kilobyte strips don't).
	const lastChunkOf = (i: number): 0 | 1 => (i + chunkSize >= base64.length ? 0 : 1);
	const first = APC(
		`a=t,f=32,t=d,o=z,s=${fb.width},v=${fb.height},i=${imageId},q=2,m=${lastChunkOf(0)}`,
		base64.slice(0, chunkSize),
	);
	const seqs: string[] = [first];
	for (let i = chunkSize; i < base64.length; i += chunkSize) {
		seqs.push(APC(`m=${lastChunkOf(i)}`, base64.slice(i, i + chunkSize)));
	}
	stats.lastEncodeMs = performance.now() - t0;
	return seqs;
}

function placementSequence(
	imageId: number,
	placementId: number,
	cellX: number,
	cellY: number,
	cellW: number,
	cellH: number,
	zIndex: number,
	crop?: { x: number; y: number; w: number; h: number },
): string {
	const cropFields = crop
		? `,x=${crop.x},y=${crop.y},w=${crop.w},h=${crop.h}`
		: "";
	return `\x1b[s\x1b[${cellY};${cellX}H${APC(
		`a=p,i=${imageId},p=${placementId},q=2,c=${cellW},r=${cellH},z=${zIndex},C=1${cropFields}`,
	)}\x1b[u`;
}

const deleteImage = (imageId: number, placementId?: number): string =>
	placementId === undefined
		? APC(`a=d,d=I,i=${imageId},q=2`)
		: APC(`a=d,d=I,i=${imageId},p=${placementId},q=2`);

// ---------------------------------------------------------------------------
// Kitty map surface — double-buffered base image, strip updates for token
// moves (Q3), cell-rect occlusion fragmenting (Q4).
// ---------------------------------------------------------------------------

interface CellRect {
	x: number; // 1-based terminal cell coords
	y: number;
	w: number;
	h: number;
}

const MAP_ANCHOR: CellRect = { x: 2, y: 3, w: 0, h: 0 }; // filled from map dims
const mapCellRect = (): CellRect => ({
	x: MAP_ANCHOR.x,
	y: MAP_ANCHOR.y,
	w: SAMPLE_MAP[0]!.length * TILE_COLUMNS,
	h: SAMPLE_MAP.length * TILE_ROWS,
});

/** tile coords → terminal cell rect (tile = 4×3 cells, ADR-0021 geometry) */
function tileCellRect(tx: number, ty: number, tw = 1, th = 1): CellRect {
	return {
		x: MAP_ANCHOR.x + tx * TILE_COLUMNS,
		y: MAP_ANCHOR.y + ty * TILE_ROWS,
		w: tw * TILE_COLUMNS,
		h: th * TILE_ROWS,
	};
}

/** Rectangle subtraction: `whole` minus `hole`, as up to 4 rects. */
function subtractRect(whole: CellRect, hole: CellRect | null): CellRect[] {
	if (!hole) return [whole];
	const x2 = hole.x + hole.w;
	const y2 = hole.y + hole.h;
	const out: CellRect[] = [];
	if (hole.y > whole.y) out.push({ ...whole, h: hole.y - whole.y });
	if (y2 < whole.y + whole.h) out.push({ x: whole.x, y: y2, w: whole.w, h: whole.y + whole.h - y2 });
	for (const band of [
		{ y: Math.max(whole.y, hole.y), h: Math.min(whole.y + whole.h, y2) - Math.max(whole.y, hole.y) },
	]) {
		if (band.h <= 0) return out;
		if (hole.x > whole.x) out.push({ x: whole.x, y: band.y, w: hole.x - whole.x, h: band.h });
		if (x2 < whole.x + whole.w) out.push({ x: x2, y: band.y, w: whole.x + whole.w - x2, h: band.h });
	}
	return out;
}

class KittyMapSurface {
	private baseIds = [3100, 3101];
	private stripIds = [3200, 3201];
	private activeBase: 0 | 1 | null = null;
	private activeStrip: 0 | 1 | null = null;
	private lastStripRect: CellRect | null = null;

	constructor(private readonly stats: Stats) {}

	/** Full redraw: transmit into the inactive slot, place fragments, delete old. */
	renderBase(fb: Framebuffer, occluder: CellRect | null): void {
		const next: 0 | 1 = this.activeBase === 0 ? 1 : 0;
		const id = this.baseIds[next]!;
		const seqs = transmitSequences(id, fb, this.stats);
		const fragments = subtractRect(mapCellRect(), occluder);
		const pxPerCellX = fb.width / mapCellRect().w;
		const pxPerCellY = fb.height / mapCellRect().h;
		fragments.forEach((frag, i) => {
			seqs.push(
				placementSequence(id, 41 + i, frag.x, frag.y, frag.w, frag.h, -1, {
					x: Math.round((frag.x - MAP_ANCHOR.x) * pxPerCellX),
					y: Math.round((frag.y - MAP_ANCHOR.y) * pxPerCellY),
					w: Math.round(frag.w * pxPerCellX),
					h: Math.round(frag.h * pxPerCellY),
				}),
			);
		});
		if (this.activeBase !== null) seqs.push(deleteImage(this.baseIds[this.activeBase]!));
		this.write(seqs);
		this.activeBase = next;
		this.stats.lastOpBytes = seqs.join("").length;
		this.stats.totalBytes += this.stats.lastOpBytes;
	}

	/**
	 * Strip update (Q3): re-encode only `region` of the framebuffer, place it
	 * above the resident base image, delete the previous strip. A token move
	 * calls this with the union of old and new tile rects.
	 */
	updateStrip(fb: Framebuffer, region: CellRect): void {
		const mapRect = mapCellRect();
		const next: 0 | 1 = this.activeStrip === 0 ? 1 : 0;
		const id = this.stripIds[next]!;
		const pxPerCellX = fb.width / mapRect.w;
		const pxPerCellY = fb.height / mapRect.h;
		const px = fb.cut(
			Math.round((region.x - MAP_ANCHOR.x) * pxPerCellX),
			Math.round((region.y - MAP_ANCHOR.y) * pxPerCellY),
			Math.round(region.w * pxPerCellX),
			Math.round(region.h * pxPerCellY),
		);
		const seqs = transmitSequences(id, px, this.stats);
		seqs.push(placementSequence(id, 51, region.x, region.y, region.w, region.h, 1));
		if (this.activeStrip !== null) seqs.push(deleteImage(this.stripIds[this.activeStrip]!));
		this.write(seqs);
		this.activeStrip = next;
		this.lastStripRect = region;
		this.stats.lastOpBytes = seqs.join("").length;
		this.stats.totalBytes += this.stats.lastOpBytes;
	}

	clear(): void {
		const seqs = [
			deleteImage(this.baseIds[0]!),
			deleteImage(this.baseIds[1]!),
			deleteImage(this.stripIds[0]!),
			deleteImage(this.stripIds[1]!),
		];
		this.write(seqs);
		this.activeBase = null;
		this.activeStrip = null;
	}

	private write(seqs: string[]): void {
		process.stdout.write(seqs.join(""));
	}
}

// ---------------------------------------------------------------------------
// Octant tier (Q2): same map state, sampled from the same raster geometry but
// packed 2×4 sub-pixels per cell into the Unicode-16 octant chars (ADR-0021).
// ---------------------------------------------------------------------------

function octantCharForTile(
	rows: Uint8Array,
	qx: number,
	qy: number,
): string {
	let pattern = 0;
	for (let dy = 0; dy < 4; dy++) {
		for (let dx = 0; dx < 2; dx++) {
			const gx = qx * 2 + dx;
			const gy = qy * 4 + dy;
			const bit = (rows[gy]! >> (7 - gx)) & 1;
			pattern |= bit << (dy * 2 + dx);
		}
	}
	return OCTANT_CHARS[pattern]!;
}

// ---------------------------------------------------------------------------
// Terminal plumbing: probe, raw input, screen setup, per-tier draw, stats.
// ---------------------------------------------------------------------------

const MAP_COLS = SAMPLE_MAP[0]!.length;
const MAP_ROWS = SAMPLE_MAP.length;
MAP_ANCHOR.w = MAP_COLS * TILE_COLUMNS;
MAP_ANCHOR.h = MAP_ROWS * TILE_ROWS;

const DIALOG_RECT: CellRect = {
	x: MAP_ANCHOR.x + 8,
	y: MAP_ANCHOR.y + 3,
	w: 20,
	h: 6,
};

type Tier = "kitty" | "octant" | "text";

interface ProbeResult {
	supported: boolean;
	elapsedMs: number;
	cellPx: { w: number; h: number } | null;
}

async function probeKitty(budgetMs: number): Promise<ProbeResult> {
	if (!process.stdout.isTTY) {
		return { supported: false, elapsedMs: 0, cellPx: null };
	}
	const started = performance.now();
	let settled = false;
	let supported = false;
	let cellPx: { w: number; h: number } | null = null;

	const onData = (chunk: Buffer) => {
		const s = chunk.toString("latin1");
		// Two signals: an APC graphics response (the a=q reply), or `_G` in the
		// primary DA response (kitty and ghostty advertise graphics support there).
		if (/\x1b_G[\s\S]*?\x1b\\/.test(s) || /^\x1b\[\?[\d;]*_G/.test(s.trim())) {
			supported = true;
		}
		const cellMatch = s.match(/\x1b\[6;(\d+);(\d+)t/);
		if (cellMatch) {
			cellPx = { h: Number(cellMatch[1]), w: Number(cellMatch[2]) };
		}
		if (supported && cellPx) finish();
	};
	const finish = () => {
		if (settled) return;
		settled = true;
		process.stdin.off("data", onData);
		resolvers.pop()?.();
	};
	const resolvers: Array<() => void> = [];

	process.stdin.on("data", onData);
	// graphics query with NO quiet flag (q=2 would suppress the very response
	// we are listening for — that bit me once; gloomberb's q=2 query works only
	// because OpenTUI's capabilities event does the detection) + DA1 (always
	// answers; kitty/ghostty embed _G) + cell-pixel-size query for the stats line.
	process.stdout.write(
		`${APC("a=q,t=d,f=24,s=1,v=1,i=31", "AAAA")}\x1b[c\x1b[16t`,
	);

	const timer = setTimeout(finish, budgetMs);
	await new Promise<void>((resolve) => {
		resolvers.push(resolve);
	});
	clearTimeout(timer);
	return { supported, elapsedMs: performance.now() - started, cellPx };
}

const SGR = (fg: Rgb, bg?: Rgb): string =>
	`\x1b[38;2;${fg[0]};${fg[1]};${fg[2]}m` + (bg ? `\x1b[48;2;${bg[0]};${bg[1]};${bg[2]}m` : "");
const at = (row: number, col: number): string => `\x1b[${row};${col}H`;
const RESET = "\x1b[0m";

function drawHeader(state: AppState): void {
	const lines = [
		"PROTOTYPE — kitty battle-map tier — arrows move, tab token, t tier, g dings/chars, d dialog, f redraw, q quit",
	];
	lines.forEach((line, i) => {
		process.stdout.write(`${at(1 + i, 1)}\x1b[2K\x1b[1m${line}${RESET}`);
	});
}

function drawFooter(state: AppState): void {
	const probe = state.probe
		? `probe: ${state.probe.supported ? "SUPPORTED" : "no/timeout"} in ${Math.round(state.probe.elapsedMs)}ms${
				state.probe.cellPx ? ` (cell ${state.probe.cellPx.w}×${state.probe.cellPx.h}px)` : ""
			}`
		: "probe: n/a";
	const rows = [
		`tier: ${state.tier.toUpperCase()}   terrain: ${state.terrainStyle}   token: ${state.map.tokens.find((t) => t.id === state.map.selectedId)?.label}   dialog: ${state.dialog ? "on" : "off"}   fb: ${MAP_COLS * TILE_PX_W}×${MAP_ROWS * TILE_PX_H}px`,
		`${probe}   last op: ${state.stats.lastOpBytes} B / ${state.stats.lastEncodeMs.toFixed(1)} ms encode   total: ${(state.stats.totalBytes / 1024).toFixed(1)} KiB`,
	];
	const topRow = MAP_ANCHOR.y + MAP_ANCHOR.h + 2;
	rows.forEach((line, i) => {
		process.stdout.write(`${at(topRow + i, 1)}\x1b[2K${line}${RESET}`);
	});
	// PROTOTYPE: optional footer log so a GUI-terminal run (no capture) is verifiable.
	if (process.env.PROTO_LOG) {
		appendFileSync(process.env.PROTO_LOG, rows.join("\n") + "\n");
	}
}

function drawDialog(): void {
	const { x, y, w, h } = DIALOG_RECT;
	for (let dy = 0; dy < h; dy++) {
		let line = "";
		for (let dx = 0; dx < w; dx++) {
			const edgeX = dx === 0 || dx === w - 1;
			const edgeY = dy === 0 || dy === h - 1;
			line += edgeX || edgeY ? (edgeX && edgeY ? "+" : edgeX ? "│" : "─") : " ";
		}
		const label = dy === 1 ? " OCCLUDER " : "";
		const text = label ? line.slice(0, w) : line;
		process.stdout.write(
			`${at(y + dy, x)}${SGR([255, 255, 255], [40, 40, 52])}${text.slice(0, w - 1)}${label}${" ".repeat(Math.max(0, w - 1 - text.slice(0, w - 1).length - label.length))}+${RESET}`,
		);
	}
}

function drawTextTiers(state: AppState): void {
	const t0 = performance.now();
	const chunks: string[] = [];
	// ... (body writes into chunks instead of stdout)
	const write = (s: string) => chunks.push(s);
	// text tier: the map file's own characters, one per cell — the ADR-0007 fallback.
	// octant tier: atlas glyphs packed 2×4 per cell over the same geometry.
	for (let ty = 0; ty < MAP_ROWS; ty++) {
		for (let cy = 0; cy < TILE_ROWS; cy++) {
			let line = "";
			let sgr = "";
			for (let tx = 0; tx < MAP_COLS; tx++) {
				const ch = SAMPLE_MAP[ty]![tx]!;
				const kind = DEFAULT_LEGEND[ch] ?? "floor";
				const colors = TILE_COLORS[kind];
				for (let cx = 0; cx < TILE_COLUMNS; cx++) {
					const token = tokenAt(state.map, tx, ty);
					let char: string;
					let fg: Rgb;
					let bg: Rgb = colors.bg;
					if (token) {
						// token occupies the middle cell of its tile; the rest dims
						const mid = cx === 1 && cy === 1;
						char = mid ? token.glyph : " ";
						fg = token.color;
						bg = mid ? [14, 14, 18] : colors.bg;
						if (token.id === state.map.selectedId && mid) fg = [255, 255, 255];
					} else if (state.tier === "text") {
						char = ch;
						fg = colors.fg;
					} else {
						// octant tier: dings style samples the pictogram atlas;
						// chars style samples the legend characters
						const useDings = state.terrainStyle === "dings";
						const atlas = useDings ? DINGS_ATLAS : TEXT_ATLAS;
						const key = useDings ? dingForTile(kind, tx, ty) : ch;
						char = octantCharForTile(glyphRowBytes(atlas[key] ?? atlas["?"]!), cx, cy);
						fg = colors.fg;
					}
					const nextSgr = SGR(fg, bg);
					if (nextSgr !== sgr) {
						line += nextSgr;
						sgr = nextSgr;
					}
					line += char;
				}
			}
			write(
				`${at(MAP_ANCHOR.y + ty * TILE_ROWS + cy + 1, MAP_ANCHOR.x)}\x1b[2K${line}${RESET}`,
			);
		}
	}
	state.stats.lastEncodeMs = performance.now() - t0;
	state.stats.lastOpBytes = chunks.join("").length;
	state.stats.totalBytes += state.stats.lastOpBytes;
	process.stdout.write(chunks.join(""));
}

function tokenAt(map: MapState, x: number, y: number): Token | undefined {
	return map.tokens.find((t) => t.x === x && t.y === y);
}

interface AppState {
	map: MapState;
	tier: Tier;
	terrainStyle: "chars" | "dings";
	dialog: boolean;
	probe: ProbeResult | null;
	stats: Stats;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

const state: AppState = {
	map: { tokens: structuredClone(TOKENS), selectedId: TOKENS[0]!.id },
	tier: "octant",
	terrainStyle: "dings",
	dialog: false,
	probe: null,
	stats: { lastOpBytes: 0, lastEncodeMs: 0, totalBytes: 0 },
};

function fullRedraw(state: AppState, surface: KittyMapSurface | null): void {
	drawHeader(state);
	if (state.tier === "kitty" && surface) {
		// text cells are not written over the map region; the image is the map
		const fb = renderMap(state.map, state.terrainStyle);
		surface.renderBase(fb, state.dialog ? DIALOG_RECT : null);
	} else {
		drawTextTiers(state);
	}
	if (state.dialog) drawDialog();
	drawFooter(state);
}

function moveToken(state: AppState, dx: number, dy: number, surface: KittyMapSurface | null): void {
	const token = state.map.tokens.find((t) => t.id === state.map.selectedId)!;
	const nx = Math.max(0, Math.min(MAP_COLS - 1, token.x + dx));
	const ny = Math.max(0, Math.min(MAP_ROWS - 1, token.y + dy));
	if (nx === token.x && ny === token.y) return;
	const old = tileCellRect(token.x - 1, token.y - 1, 3, 3);
	token.x = nx;
	token.y = ny;
	const moved = tileCellRect(token.x - 1, token.y - 1, 3, 3);
	const union: CellRect = {
		x: Math.min(old.x, moved.x),
		y: Math.min(old.y, moved.y),
		w: Math.max(old.x + old.w, moved.x + moved.w) - Math.min(old.x, moved.x),
		h: Math.max(old.y + old.h, moved.y + moved.h) - Math.min(old.y, moved.y),
	};
	if (state.tier === "kitty" && surface) {
		// Q3: strip re-encode over the union region only. Strips ignore the
		// dialog occluder, so with the dialog open fall back to a full redraw
		// whose fragmenting handles the hole correctly.
		if (state.dialog) {
			fullRedraw(state, surface);
		} else {
			const fb = renderMap(state.map, state.terrainStyle);
			surface.updateStrip(fb, union);
		}
	} else {
		fullRedraw(state, null);
	}
	drawFooter(state);
}

async function main(): Promise<void> {
	if (!process.stdout.isTTY) {
		// Non-TTY smoke mode: print the per-tier byte costs and exit.
		console.log("PROTOTYPE smoke mode (no TTY) — per-tier byte costs for one full render:");
		const fb = renderMap(state.map);
		const stats: Stats = { lastOpBytes: 0, lastEncodeMs: 0, totalBytes: 0 };
		const seqs = transmitSequences(9001, fb, stats);
		const kittyBytes = seqs.join("").length;
		console.log(
			`  kitty:   bitmap ${fb.width}×${fb.height}px, transmit ${kittyBytes} B (${(kittyBytes / 1024).toFixed(1)} KiB), deflate ${stats.lastEncodeMs.toFixed(1)} ms`,
		);
		const strip = fb.cut(0, 0, 3 * TILE_PX_W, 3 * TILE_PX_H);
		const stripSeqs = transmitSequences(9002, strip, stats);
		console.log(
			`  strip:   3-tile region ${strip.width}×${strip.height}px, transmit ${stripSeqs.join("").length} B — the per-token-move cost vs ${(kittyBytes / 1024).toFixed(0)} KiB full`,
		);
		// exercise the octant/text encoders for both terrain styles (headless
		// coverage of the draw path; byte counts are the cell-grid payload)
		const realWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = (() => true) as typeof process.stdout.write;
		try {
			for (const tier of ["octant", "text"] as const) {
				for (const terrainStyle of ["dings", "chars"] as const) {
					state.tier = tier;
					state.terrainStyle = terrainStyle;
					state.stats.lastOpBytes = 0;
					drawTextTiers(state);
					realWrite(`  ${tier}/${terrainStyle}: ${state.stats.lastOpBytes} B of cells\n`);
				}
			}
		} finally {
			process.stdout.write = realWrite;
		}
		return;
	}

	const budgetMs = Number(process.env.KITTY_PROBE_MS ?? 400);
	process.stdout.write("\x1b[?1049h\x1b[?25l");
	process.stdin.setRawMode(true);
	process.stdin.resume();

	state.probe = await probeKitty(budgetMs);
	if (state.probe.cellPx) adoptCellMetrics(state.probe.cellPx.w, state.probe.cellPx.h);
	state.tier = state.probe.supported ? "kitty" : "octant";

	const surface = state.probe.supported ? new KittyMapSurface(state.stats) : null;
	fullRedraw(state, surface);

	// PROTOTYPE: scripted self-driving (a GUI-terminal window can't receive
	// synthetic keys from the agent harness). PROTO_SCRIPT="Right,Right,Down,d,f"
	const script = (process.env.PROTO_SCRIPT ?? "")
		.split(",")
		.filter(Boolean)
		.map((k) => k.trim());
	const KEY_ESCAPES: Record<string, string> = {
		Up: "\x1b[A",
		Down: "\x1b[B",
		Right: "\x1b[C",
		Left: "\x1b[D",
		tab: "\t",
		t: "t",
		g: "g",
		d: "d",
		f: "f",
	};
	if (script.length > 0) {
		const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
		const handle = (s: string) => {
			// mirrors the onKey body below, factored for reuse by the script
			const token = state.map.tokens.find((t) => t.id === state.map.selectedId)!;
			if (s === "\x1b[A") moveToken(state, 0, -1, surface);
			else if (s === "\x1b[B") moveToken(state, 0, 1, surface);
			else if (s === "\x1b[C") moveToken(state, 1, 0, surface);
			else if (s === "\x1b[D") moveToken(state, -1, 0, surface);
			else if (s === "\t") {
				const idx = state.map.tokens.findIndex((t) => t.id === state.map.selectedId);
				state.map.selectedId = state.map.tokens[(idx + 1) % state.map.tokens.length]!.id;
				fullRedraw(state, surface);
			} else if (s === "t") {
				state.tier = state.tier === "kitty" ? "octant" : state.tier === "octant" ? "text" : "kitty";
				if (state.tier !== "kitty" && surface) surface.clear();
				fullRedraw(state, surface);
			} else if (s === "d") {
				state.dialog = !state.dialog;
				fullRedraw(state, surface);
			} else if (s === "g") {
				state.terrainStyle = state.terrainStyle === "dings" ? "chars" : "dings";
				fullRedraw(state, surface);
			} else if (s === "f") fullRedraw(state, surface);
		};
		for (const step of script) {
			await sleep(700);
			handle(KEY_ESCAPES[step] ?? step);
		}
	}

	await new Promise<void>((resolve) => {
		const onKey = (chunk: Buffer) => {
			const s = chunk.toString("latin1");
			const token = state.map.tokens.find((t) => t.id === state.map.selectedId)!;
			if (s === "q" || s === "\x1b") {
				cleanup();
				resolve();
				return;
			}
			if (s === "\x1b[A") moveToken(state, 0, -1, surface);
			else if (s === "\x1b[B") moveToken(state, 0, 1, surface);
			else if (s === "\x1b[C") moveToken(state, 1, 0, surface);
			else if (s === "\x1b[D") moveToken(state, -1, 0, surface);
			else if (s === "\t") {
				const idx = state.map.tokens.findIndex((t) => t.id === state.map.selectedId);
				state.map.selectedId = state.map.tokens[(idx + 1) % state.map.tokens.length]!.id;
				fullRedraw(state, surface);
			} else if (s === "t") {
				state.tier =
					state.tier === "kitty" ? "octant" : state.tier === "octant" ? "text" : "kitty";
				if (state.tier !== "kitty" && surface) surface.clear();
				fullRedraw(state, surface);
			} else if (s === "d") {
				state.dialog = !state.dialog;
				fullRedraw(state, surface);
			} else if (s === "g") {
				state.terrainStyle = state.terrainStyle === "dings" ? "chars" : "dings";
				fullRedraw(state, surface);
			} else if (s === "f") {
				fullRedraw(state, surface);
			}
		};
		const cleanup = () => {
			process.stdin.off("data", onKey);
		};
		process.stdin.on("data", onKey);
	});

	if (surface) surface.clear();
	process.stdout.write("\x1b[?25h\x1b[?1049l");
	if (process.stdin.isTTY) process.stdin.setRawMode(false);
	process.stdin.pause();
}

void main();
