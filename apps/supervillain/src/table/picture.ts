import { crc32, deflateSync } from "node:zlib";

import { charsOf, LEGEND } from "@supervillain/domain";
import type { Tone } from "@supervillain/domain";

import { DINGS_ATLAS } from "./atlas/dings.ts";
import { TEXT_ATLAS } from "./atlas/text.ts";
import { MAP_FRAME, followed } from "./map.ts";
import type { Focus } from "./map.ts";
import type { MapToken, MapView } from "./view.ts";

export const SQUARE = { cols: 4, rows: 2 } as const;

export const TILE = 36;

export const GUTTER = 3;

export const LABEL_ROWS = 1;

export const pictureRowsWanted = (map: MapView): number =>
	map.height * SQUARE.rows + LABEL_ROWS + MAP_FRAME.height;

export interface Tile {
	readonly width: number;
	readonly height: number;
	readonly scale: number;
}

export interface CellPixels {
	readonly width: number;
	readonly height: number;
}

const CELL_MAX: CellPixels = { width: 48, height: 96 };

const PICTURE_PIXELS_MAX = 16_000_000;

const GRID_MAX = { cols: 300, rows: 100 } as const;

export const FALLBACK_TILE: Tile = { width: TILE, height: TILE, scale: 3 };

export const tileFor = (cell: CellPixels | undefined, squares = 1): Tile => {
	if (cell === undefined) {
		return FALLBACK_TILE;
	}

	const { width, height } = cell;

	if (!Number.isInteger(width) || !Number.isInteger(height)) {
		return FALLBACK_TILE;
	}

	if (
		width < 1 ||
		height < 1 ||
		width > CELL_MAX.width ||
		height > CELL_MAX.height
	) {
		return FALLBACK_TILE;
	}

	const tile = { width: width * SQUARE.cols, height: height * SQUARE.rows };
	const scale = Math.floor(Math.min(tile.width / 8, tile.height / 12));

	if (scale < 1 || tile.width * tile.height * squares > PICTURE_PIXELS_MAX) {
		return FALLBACK_TILE;
	}

	return { ...tile, scale };
};

export const cellPixels = (
	window:
		| { readonly width: number; readonly height: number }
		| null
		| undefined,
	cols: number,
	rows: number
): CellPixels | undefined => {
	if (!window || cols < 1 || rows < 1) {
		return undefined;
	}

	if (cols >= GRID_MAX.cols || rows >= GRID_MAX.rows) {
		return undefined;
	}

	const width = Math.floor(window.width / cols);
	const height = Math.floor(window.height / rows);

	return width >= 1 && height >= 1 ? { width, height } : undefined;
};

type Rgb = readonly [number, number, number];

const hex = (h: string): Rgb => [
	Number.parseInt(h.slice(1, 3), 16),
	Number.parseInt(h.slice(3, 5), 16),
	Number.parseInt(h.slice(5, 7), 16),
];

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
	Math.round(a[0] + (b[0] - a[0]) * t),
	Math.round(a[1] + (b[1] - a[1]) * t),
	Math.round(a[2] + (b[2] - a[2]) * t),
];

export const TONES: Readonly<
	Record<Tone, { readonly fg: Rgb; readonly bg: Rgb }>
> = {
	ground: { fg: hex("#6b6f5a"), bg: hex("#1a1c18") },
	grass: { fg: hex("#6f9a4f"), bg: hex("#172015") },
	tree: { fg: hex("#4f8a3f"), bg: hex("#121e10") },
	rock: { fg: hex("#958e80"), bg: hex("#1f1e1b") },
	water: { fg: hex("#5f9fcf"), bg: hex("#10202e") },
	stone: { fg: hex("#b0aa9a"), bg: hex("#26262b") },
	wood: { fg: hex("#b08050"), bg: hex("#261d16") },
	roof: { fg: hex("#c0664c"), bg: hex("#2a1814") },
	floor: { fg: hex("#857e70"), bg: hex("#201e1b") },
	iron: { fg: hex("#8a9aac"), bg: hex("#1a1e22") },
};

export const SIDES = {
	heroes: hex("#61afef"),
	director: hex("#c678dd"),
	mine: hex("#98c379"),
	dead: hex("#606060"),
} as const;

export const VOID = hex("#0e0f12");

export const REACH = hex("#1f4a4a");

const WHITE = hex("#ffffff");

const BLACK = hex("#000000");

const RED = hex("#ff5f5f");

const PLAIN = new Map([
	[".", "q"],
	["#", "s"],
	["~", "E"],
]);

export const letterAt = (
	map: MapView,
	x: number,
	y: number
): string | undefined => {
	const own = map.dressing?.[y]?.[x];

	if (own !== undefined && own !== " ") {
		return own;
	}

	return PLAIN.get(map.terrain[y]?.[x] ?? " ");
};

const pngChunk = (type: string, data: Uint8Array) => {
	const chunk = new Uint8Array(12 + data.length);
	const view = new DataView(chunk.buffer);
	view.setUint32(0, data.length);
	chunk.set(new TextEncoder().encode(type), 4);
	chunk.set(data, 8);
	view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));

	return chunk;
};

export class Canvas {
	readonly width: number;
	readonly height: number;
	readonly pixels: Uint8Array;

	constructor(width: number, height: number) {
		this.width = width;
		this.height = height;
		this.pixels = new Uint8Array(width * height * 4);
	}
	set(x: number, y: number, c: Rgb) {
		if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
			return;
		}

		const [r, g, b] = c;
		const i = (y * this.width + x) * 4;
		this.pixels[i] = r;
		this.pixels[i + 1] = g;
		this.pixels[i + 2] = b;
		this.pixels[i + 3] = 255;
	}
	get(x: number, y: number): Rgb {
		const i = (y * this.width + x) * 4;

		const [r = 0, g = 0, b = 0] = this.pixels.subarray(i, i + 3);

		return [r, g, b];
	}
	rect(x: number, y: number, w: number, h: number, c: Rgb) {
		for (let j = 0; j < h; j += 1) {
			for (let i = 0; i < w; i += 1) {
				this.set(x + i, y + j, c);
			}
		}
	}
	frame(x: number, y: number, w: number, h: number, t: number, c: Rgb) {
		this.rect(x, y, w, t, c);
		this.rect(x, y + h - t, w, t, c);
		this.rect(x, y, t, h, c);
		this.rect(x + w - t, y, t, h, c);
	}
	png(): Uint8Array {
		const { width, height, pixels } = this;
		const row = 1 + width * 3;
		const rows = new Uint8Array(row * height);

		for (let y = 0; y < height; y += 1) {
			rows[y * row] = 2;

			for (let x = 0; x < width; x += 1) {
				for (let c = 0; c < 3; c += 1) {
					const i = (y * width + x) * 4 + c;
					const above = y > 0 ? (pixels[i - width * 4] ?? 0) : 0;
					rows[y * row + 1 + x * 3 + c] = (pixels[i] ?? 0) - above;
				}
			}
		}

		const header = new Uint8Array(13);
		const view = new DataView(header.buffer);
		view.setUint32(0, width);
		view.setUint32(4, height);
		header.set([8, 2], 8);

		return Buffer.concat([
			Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
			pngChunk("IHDR", header),
			pngChunk("IDAT", deflateSync(rows)),
			pngChunk("IEND", new Uint8Array(0)),
		]);
	}
	glyph(rows: string | undefined, x: number, y: number, scale: number, c: Rgb) {
		if (rows === undefined) {
			return;
		}

		for (let row = 0; row < 12; row += 1) {
			const bits = Number.parseInt(rows.slice(row * 2, row * 2 + 2), 16);

			for (let col = 0; col < 8; col += 1) {
				if (Math.floor(bits / 2 ** (7 - col)) % 2 === 1) {
					this.rect(x + col * scale, y + row * scale, scale, scale, c);
				}
			}
		}
	}
}

const HERO_FIGURES = charsOf("1234567890&@");

const DIRECTOR_FIGURES = charsOf("!\"#$%'()*+/:;=?");

const TWO_32 = 4_294_967_296;

const hash = (s: string) => {
	let h = 7;

	for (const c of charsOf(s)) {
		const sum = Math.imul(h, 31) + (c.codePointAt(0) ?? 0);
		h = ((sum % TWO_32) + TWO_32) % TWO_32;
	}

	return h;
};

export const figureOf = (
	token: Pick<MapToken, "id" | "side" | "figure">
): string => {
	const figures = token.side === "heroes" ? HERO_FIGURES : DIRECTOR_FIGURES;

	return figures[hash(token.figure ?? token.id) % figures.length] ?? "";
};

export const sideColour = (t: MapToken): Rgb => {
	if (t.dead) {
		return SIDES.dead;
	}

	if (t.mine) {
		return SIDES.mine;
	}

	return t.side === "heroes" ? SIDES.heroes : SIDES.director;
};

const windowStart = (at: number, span: number, total: number) =>
	Math.max(0, Math.min(total - span, Math.round(at - (span - 1) / 2)));

const groundAt = (
	map: MapView,
	reach: ReadonlySet<string>,
	x: number,
	y: number
): Rgb => {
	if (reach.has(`${x},${y}`)) {
		return REACH;
	}

	const letter = letterAt(map, x, y);
	const entry = letter === undefined ? undefined : LEGEND.get(letter);

	return entry === undefined ? VOID : TONES[entry.tone].bg;
};

export interface PictureWindow {
	readonly x0: number;
	readonly y0: number;
	readonly cols: number;
	readonly rows: number;
}

export const pictureWindow = (
	map: MapView,
	cols: number,
	rows: number,
	focus?: Focus
): PictureWindow => {
	const fitC = Math.max(1, Math.min(map.width, cols));
	const fitR = Math.max(1, Math.min(map.height, rows));

	const centre = focus ??
		followed(map.tokens) ?? { x: map.width / 2, y: map.height / 2 };

	return {
		x0: windowStart(centre.x, fitC, map.width),
		y0: windowStart(centre.y, fitR, map.height),
		cols: fitC,
		rows: fitR,
	};
};

export const pictureSquareAt = (
	w: PictureWindow,
	col: number,
	row: number
): Focus | undefined => {
	if (col < GUTTER || row < LABEL_ROWS) {
		return undefined;
	}

	const sx = Math.floor((col - GUTTER) / SQUARE.cols);
	const sy = Math.floor((row - LABEL_ROWS) / SQUARE.rows);

	if (sx >= w.cols || sy >= w.rows) {
		return undefined;
	}

	return { x: w.x0 + sx, y: w.y0 + sy };
};

const sizeOf = (t: MapToken) => t.footprint ?? 1;

const inWindow = (t: MapToken, w: PictureWindow) =>
	t.x + sizeOf(t) > w.x0 &&
	t.x < w.x0 + w.cols &&
	t.y + sizeOf(t) > w.y0 &&
	t.y < w.y0 + w.rows;

export const outOfView = (
	map: MapView,
	w: PictureWindow
): ReadonlyArray<MapToken> =>
	map.tokens.filter((t) => !t.dead && !inWindow(t, w));

const paintToken = (
	c: Canvas,
	ox: number,
	oy: number,
	tile: Tile,
	t: MapToken,
	ground: Rgb
) => {
	const { width, height, scale } = tile;
	const small = Math.max(1, Math.round(scale / 3));
	const line = Math.max(1, Math.round((2 * scale) / 3));
	const colour = sideColour(t);
	c.rect(ox, oy, width, height, mix(ground, colour, 0.18));
	c.glyph(
		DINGS_ATLAS[figureOf(t)],
		ox + Math.floor((width - 8 * scale) / 6),
		oy + Math.floor((height - 12 * scale) / 2),
		scale,
		colour
	);
	const markW = t.mark.length * 8 * small;
	const mx = ox + width - markW - small;
	const my = oy + height - 13 * small;
	c.rect(mx - small, my - small, markW + 2 * small, 14 * small, BLACK);

	for (const [i, ch] of charsOf(t.mark).entries()) {
		c.glyph(TEXT_ATLAS[ch], mx + i * 8 * small, my, small, WHITE);
	}

	if (t.acting) {
		c.frame(ox, oy, width, height, line, WHITE);
	}

	if (t.dead) {
		const inset = Math.round((4 * scale) / 3);

		for (let j = inset; j < height - inset; j += 1) {
			c.rect(ox + Math.floor((j * width) / height), oy + j, line, 1, RED);
		}
	}
};

export const paintPicture = (
	map: MapView,
	w: PictureWindow,
	tile: Tile = FALLBACK_TILE
): Canvas => {
	const { width, height, scale } = tile;
	const c = new Canvas(w.cols * width, w.rows * height);
	const reach = new Set(map.reach.map((r) => `${r.x},${r.y}`));
	const living = map.tokens.toSorted((a, b) => Number(b.dead) - Number(a.dead));
	const deadSmall = new Map<string, MapToken>();
	const liveSmall = new Map<string, MapToken>();

	for (const t of living.filter((u) => sizeOf(u) === 1)) {
		(t.dead ? deadSmall : liveSmall).set(`${t.x},${t.y}`, t);
	}

	const paintLarge = (t: MapToken) => {
		const size = sizeOf(t);
		const ground = groundAt(map, reach, t.x, t.y);

		paintToken(
			c,
			(t.x - w.x0) * width,
			(t.y - w.y0) * height,
			{ width: width * size, height: height * size, scale: scale * size },
			t,
			ground
		);
	};

	const gx = Math.floor((width - 8 * scale) / 2);
	const gy = Math.floor((height - 12 * scale) / 2);

	for (let sy = 0; sy < w.rows; sy += 1) {
		for (let sx = 0; sx < w.cols; sx += 1) {
			const x = w.x0 + sx;
			const y = w.y0 + sy;
			const ox = sx * width;
			const oy = sy * height;
			const letter = letterAt(map, x, y);
			const entry = letter === undefined ? undefined : LEGEND.get(letter);

			if (letter === undefined || entry === undefined) {
				c.rect(ox, oy, width, height, VOID);
				continue;
			}

			const tone = TONES[entry.tone];
			const ground = reach.has(`${x},${y}`) ? REACH : tone.bg;
			const token = deadSmall.get(`${x},${y}`);

			if (token !== undefined) {
				paintToken(c, ox, oy, tile, token, ground);
				continue;
			}

			c.rect(ox, oy, width, height, ground);
			c.glyph(DINGS_ATLAS[letter], ox + gx, oy + gy, scale, tone.fg);
		}
	}

	for (const t of living.filter(
		(u) => u.dead && sizeOf(u) > 1 && inWindow(u, w)
	)) {
		paintLarge(t);
	}

	for (let sy = 0; sy < w.rows; sy += 1) {
		for (let sx = 0; sx < w.cols; sx += 1) {
			const x = w.x0 + sx;
			const y = w.y0 + sy;
			const token = liveSmall.get(`${x},${y}`);

			if (token === undefined) {
				continue;
			}

			const ground = groundAt(map, reach, x, y);

			paintToken(c, sx * width, sy * height, tile, token, ground);
		}
	}

	for (const t of living.filter(
		(u) => !u.dead && sizeOf(u) > 1 && inWindow(u, w)
	)) {
		paintLarge(t);
	}

	return c;
};
