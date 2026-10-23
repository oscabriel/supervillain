import { LEGEND, type Tone } from "../game/drawSteel/mekmode.ts";
import { DINGS_ATLAS } from "./atlas/dings.ts";
import { TEXT_ATLAS } from "./atlas/text.ts";
import { MAP_FRAME, type Focus, followed } from "./map.ts";
import type { MapToken, MapView } from "./view.ts";

/**
 * The picture map: the map painted in MEKMODE's pictures, for a seat whose terminal shows kitty
 * graphics. A square is 4 columns by 2 rows, about square, and big enough for a figure, painted at
 * those cells' size in pixels where the seat's terminal says it, so nothing scales MEKMODE's pixels
 * blurry. Terrain is each square's map letter (a mekmode map), or a stand-in for `.`, `#` and `~`
 * (a plain map); a token is a figure in its side's colour with its mark in the corner. Pure:
 * PictureMap.tsx turns the pixels into an image.
 */

/** A square's cells. */
export const SQUARE = { cols: 4, rows: 2 } as const;
/** Pixels per square side when the seat's cell size is unknown; the terminal scales it to fit. */
export const TILE = 36;
/** The row-number gutter and the column-letter row around the picture. */
export const GUTTER = 3;
export const LABEL_ROWS = 1;

/** The rows a pane needs to show `map` whole in pictures, border to border. */
export const pictureRowsWanted = (map: MapView): number =>
  map.height * SQUARE.rows + LABEL_ROWS + MAP_FRAME.height;

/** A square's size in the painted image, and the whole-number scale its 8x12 glyphs are drawn at. */
export interface Tile {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}

/** A terminal cell's size in pixels. */
export interface CellPixels {
  readonly width: number;
  readonly height: number;
}

/** Cells bigger than this are a client's mistake or a lie, since a client can say any size. */
const CELL_MAX: CellPixels = { width: 48, height: 96 };
/** At most this many pixels in one picture: 64 MB of RGBA, under OpenTUI's 64 MiB to compress. */
const PICTURE_PIXELS_MAX = 16_000_000;
/**
 * packages/ssh caps an SSH seat's size in cells here, while the window in pixels its terminal
 * reports is the whole of it, so at the cap the cells it divides out would come out too big.
 */
const GRID_MAX = { cols: 300, rows: 100 } as const;

/** `TILE` square, the glyphs at 3x: what a seat gets until its terminal says its cell size. */
export const FALLBACK_TILE: Tile = { width: TILE, height: TILE, scale: 3 };

/**
 * The tile for a seat whose cells are `cell` pixels: exactly a square's cells, so the terminal
 * shows the image pixel for pixel and the glyphs stay sharp, with the biggest whole-number glyph
 * scale that fits. `FALLBACK_TILE` when the size is unknown, implausible or too small for a glyph,
 * or when `squares` of it would pass `PICTURE_PIXELS_MAX`.
 */
export function tileFor(cell: CellPixels | undefined, squares = 1): Tile {
  if (cell === undefined) return FALLBACK_TILE;
  const { width, height } = cell;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return FALLBACK_TILE;
  if (width < 1 || height < 1 || width > CELL_MAX.width || height > CELL_MAX.height)
    return FALLBACK_TILE;
  const tile = { width: width * SQUARE.cols, height: height * SQUARE.rows };
  const scale = Math.floor(Math.min(tile.width / 8, tile.height / 12));
  if (scale < 1 || tile.width * tile.height * squares > PICTURE_PIXELS_MAX) return FALLBACK_TILE;
  return { ...tile, scale };
}

/**
 * A seat's cell size from its terminal's window in pixels and its size in cells, if known: not
 * for a seat at `GRID_MAX`, whose terminal may be bigger than its cells say.
 */
export function cellPixels(
  window: { readonly width: number; readonly height: number } | null | undefined,
  cols: number,
  rows: number,
): CellPixels | undefined {
  if (!window || cols < 1 || rows < 1) return undefined;
  if (cols >= GRID_MAX.cols || rows >= GRID_MAX.rows) return undefined;
  const width = Math.floor(window.width / cols);
  const height = Math.floor(window.height / rows);
  return width >= 1 && height >= 1 ? { width, height } : undefined;
}

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

/** Each tone's glyph and ground: greens for plants, blues for water, warm for wood and roofs. */
export const TONES: Readonly<Record<Tone, { readonly fg: Rgb; readonly bg: Rgb }>> = {
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

/** The table's own colours, as in theme.ts: heroes blue, the Director's purple, your own green. */
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

/** A plain map's stand-ins: ground, brick and rough mounds, the same on every plain map. */
const PLAIN: Readonly<Record<string, string>> = { ".": "q", "#": "s", "~": "E" };

/** The map letter a square is drawn with: its own on a mekmode map, else its terrain's stand-in. */
export const letterAt = (map: MapView, x: number, y: number): string | undefined => {
  const own = map.dressing?.[y]?.[x];
  if (own !== undefined && own !== " ") return own;
  return PLAIN[map.terrain[y]?.[x] ?? " "];
};

export class Canvas {
  readonly pixels: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.pixels = new Uint8Array(width * height * 4);
  }
  set(x: number, y: number, c: Rgb) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    this.pixels[i] = c[0];
    this.pixels[i + 1] = c[1];
    this.pixels[i + 2] = c[2];
    this.pixels[i + 3] = 255;
  }
  get(x: number, y: number): Rgb {
    const i = (y * this.width + x) * 4;
    return [this.pixels[i]!, this.pixels[i + 1]!, this.pixels[i + 2]!];
  }
  rect(x: number, y: number, w: number, h: number, c: Rgb) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c);
  }
  frame(x: number, y: number, w: number, h: number, t: number, c: Rgb) {
    this.rect(x, y, w, t, c);
    this.rect(x, y + h - t, w, t, c);
    this.rect(x, y, t, h, c);
    this.rect(x + w - t, y, t, h, c);
  }
  /** An 8x12 atlas glyph (24 hex chars, a row byte each), each bit a `scale` block. */
  glyph(rows: string | undefined, x: number, y: number, scale: number, c: Rgb) {
    if (rows === undefined) return;
    for (let row = 0; row < 12; row++) {
      const bits = Number.parseInt(rows.slice(row * 2, row * 2 + 2), 16);
      for (let col = 0; col < 8; col++)
        if ((bits >> (7 - col)) & 1) this.rect(x + col * scale, y + row * scale, scale, scale, c);
    }
  }
}

/** MEKMODE's people and creatures (digits and punctuation in Ding Mode), split for the two sides. */
const HERO_FIGURES = [..."1234567890&@"];
const DIRECTOR_FIGURES = [..."!\"#$%'()*+/:;=?"];
const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);

/** A token's figure: chosen by its id, so a creature looks the same every fight. */
export const figureOf = (token: Pick<MapToken, "id" | "side">): string => {
  const figures = token.side === "heroes" ? HERO_FIGURES : DIRECTOR_FIGURES;
  return figures[hash(token.id) % figures.length]!;
};

export const sideColour = (t: MapToken): Rgb =>
  t.dead ? SIDES.dead : t.mine ? SIDES.mine : t.side === "heroes" ? SIDES.heroes : SIDES.director;

/** The squares a view shows: `cols` by `rows` from (`x0`, `y0`). */
export interface PictureWindow {
  readonly x0: number;
  readonly y0: number;
  readonly cols: number;
  readonly rows: number;
}

/**
 * Which squares fit in `cols` by `rows` squares: all of them when they fit, else centred on the
 * seat's `/view` focus, else the acting token or the seat's own, else the middle, kept on the map.
 */
export function pictureWindow(
  map: MapView,
  cols: number,
  rows: number,
  focus?: Focus,
): PictureWindow {
  const fitC = Math.max(1, Math.min(map.width, cols));
  const fitR = Math.max(1, Math.min(map.height, rows));
  const centre = focus ?? followed(map.tokens) ?? { x: map.width / 2, y: map.height / 2 };
  const start = (at: number, span: number, total: number) =>
    Math.max(0, Math.min(total - span, Math.round(at - (span - 1) / 2)));
  return {
    x0: start(centre.x, fitC, map.width),
    y0: start(centre.y, fitR, map.height),
    cols: fitC,
    rows: fitR,
  };
}

/**
 * The square a click at `col` and `row` lands on, counted inside the pane's frame (the column
 * letters' row is row 0, the row numbers' gutter columns 0 to 2), or undefined off the squares.
 * A square is SQUARE.cols columns by SQUARE.rows rows, and any of its cells is it.
 */
export function pictureSquareAt(w: PictureWindow, col: number, row: number): Focus | undefined {
  if (col < GUTTER || row < LABEL_ROWS) return undefined;
  const sx = Math.floor((col - GUTTER) / SQUARE.cols);
  const sy = Math.floor((row - LABEL_ROWS) / SQUARE.rows);
  if (sx >= w.cols || sy >= w.rows) return undefined;
  return { x: w.x0 + sx, y: w.y0 + sy };
}

/** The tokens a window leaves out, living first. */
export const outOfView = (map: MapView, w: PictureWindow): ReadonlyArray<MapToken> =>
  map.tokens.filter(
    (t) => !t.dead && (t.x < w.x0 || t.x >= w.x0 + w.cols || t.y < w.y0 || t.y >= w.y0 + w.rows),
  );

/** A token's square: its figure in its side's colour, its mark on black in the corner. */
function paintToken(c: Canvas, ox: number, oy: number, tile: Tile, t: MapToken, ground: Rgb) {
  const { width, height, scale } = tile;
  // Marks, the frame and the cross grow with the figure: 1, 2 and 2 pixels at 3x.
  const small = Math.max(1, Math.round(scale / 3));
  const line = Math.max(1, Math.round((2 * scale) / 3));
  const colour = sideColour(t);
  c.rect(ox, oy, width, height, mix(ground, colour, 0.18));
  c.glyph(
    DINGS_ATLAS[figureOf(t)],
    ox + Math.floor((width - 8 * scale) / 6),
    oy + Math.floor((height - 12 * scale) / 2),
    scale,
    colour,
  );
  const markW = t.mark.length * 8 * small;
  const mx = ox + width - markW - small;
  const my = oy + height - 13 * small;
  c.rect(mx - small, my - small, markW + 2 * small, 14 * small, BLACK);
  [...t.mark].forEach((ch, i) => c.glyph(TEXT_ATLAS[ch], mx + i * 8 * small, my, small, WHITE));
  if (t.acting) c.frame(ox, oy, width, height, line, WHITE);
  if (t.dead) {
    const inset = Math.round((4 * scale) / 3);
    for (let j = inset; j < height - inset; j++)
      c.rect(ox + Math.floor((j * width) / height), oy + j, line, 1, RED);
  }
}

/**
 * The window of `map` as pixels, a `tile` per square: terrain, the reach tint, then tokens. The
 * tile is the seat's own (`tileFor`), `FALLBACK_TILE` when its cells are unknown.
 */
export function paintPicture(map: MapView, w: PictureWindow, tile: Tile = FALLBACK_TILE): Canvas {
  const { width, height, scale } = tile;
  const c = new Canvas(w.cols * width, w.rows * height);
  const reach = new Set(map.reach.map((r) => `${r.x},${r.y}`));
  const tokens = new Map<string, MapToken>();
  // The living are drawn over the dead.
  for (const t of map.tokens.toSorted((a, b) => Number(b.dead) - Number(a.dead)))
    tokens.set(`${t.x},${t.y}`, t);
  // Terrain glyphs sit in the middle of their square.
  const gx = Math.floor((width - 8 * scale) / 2);
  const gy = Math.floor((height - 12 * scale) / 2);
  for (let sy = 0; sy < w.rows; sy++)
    for (let sx = 0; sx < w.cols; sx++) {
      const x = w.x0 + sx;
      const y = w.y0 + sy;
      const ox = sx * width;
      const oy = sy * height;
      const letter = letterAt(map, x, y);
      const entry = letter === undefined ? undefined : LEGEND[letter];
      if (letter === undefined || entry === undefined) {
        c.rect(ox, oy, width, height, VOID);
        continue;
      }
      const tone = TONES[entry.tone];
      const ground = reach.has(`${x},${y}`) ? REACH : tone.bg;
      const token = tokens.get(`${x},${y}`);
      if (token !== undefined) {
        paintToken(c, ox, oy, tile, token, ground);
        continue;
      }
      c.rect(ox, oy, width, height, ground);
      c.glyph(DINGS_ATLAS[letter], ox + gx, oy + gy, scale, tone.fg);
    }
  return c;
}
