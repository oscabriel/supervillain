import { LEGEND, type Tone } from "../game/drawSteel/mekmode.ts";
import { DINGS_ATLAS } from "./atlas/dings.ts";
import { TEXT_ATLAS } from "./atlas/text.ts";
import { MAP_FRAME, type Focus, followed } from "./map.ts";
import type { MapToken, MapView } from "./view.ts";

/**
 * The picture map: the map painted in MEKMODE's pictures, for a seat whose terminal shows kitty
 * graphics. A square is 4 columns by 2 rows, about square, and big enough for a figure. Terrain is
 * each square's map letter (a mekmode map), or a stand-in for `.`, `#` and `~` (a plain map); a
 * token is a figure in its side's colour with its mark in the corner. Pure: PictureMap.tsx turns
 * the pixels into an image.
 */

/** Pixels per square in the painted image; the terminal scales it to the square's cells. */
export const TILE = 36;
/** A square's cells. */
export const SQUARE = { cols: 4, rows: 2 } as const;
/** The row-number gutter and the column-letter row around the picture. */
export const GUTTER = 3;
export const LABEL_ROWS = 1;

/** The rows a pane needs to show `map` whole in pictures, border to border. */
export const pictureRowsWanted = (map: MapView): number =>
  map.height * SQUARE.rows + LABEL_ROWS + MAP_FRAME.height;

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

/** The tokens a window leaves out, living first. */
export const outOfView = (map: MapView, w: PictureWindow): ReadonlyArray<MapToken> =>
  map.tokens.filter(
    (t) => !t.dead && (t.x < w.x0 || t.x >= w.x0 + w.cols || t.y < w.y0 || t.y >= w.y0 + w.rows),
  );

/** One token's square: its figure at 3x in its side's colour, its mark on black in the corner. */
function paintToken(c: Canvas, ox: number, oy: number, t: MapToken, ground: Rgb) {
  const colour = sideColour(t);
  c.rect(ox, oy, TILE, TILE, mix(ground, colour, 0.18));
  c.glyph(DINGS_ATLAS[figureOf(t)], ox + 2, oy, 3, colour);
  const markW = t.mark.length * 8;
  const mx = ox + TILE - markW - 1;
  const my = oy + TILE - 13;
  c.rect(mx - 1, my - 1, markW + 2, 14, BLACK);
  [...t.mark].forEach((ch, i) => c.glyph(TEXT_ATLAS[ch], mx + i * 8, my, 1, WHITE));
  if (t.acting) c.frame(ox, oy, TILE, TILE, 2, WHITE);
  if (t.dead)
    for (let i = 4; i < TILE - 4; i++) {
      c.set(ox + i, oy + i, RED);
      c.set(ox + i + 1, oy + i, RED);
    }
}

/** The window of `map` as pixels, `TILE` per square: terrain, the reach tint, then tokens. */
export function paintPicture(map: MapView, w: PictureWindow): Canvas {
  const c = new Canvas(w.cols * TILE, w.rows * TILE);
  const reach = new Set(map.reach.map((r) => `${r.x},${r.y}`));
  const tokens = new Map<string, MapToken>();
  // The living are drawn over the dead.
  for (const t of map.tokens.toSorted((a, b) => Number(b.dead) - Number(a.dead)))
    tokens.set(`${t.x},${t.y}`, t);
  for (let sy = 0; sy < w.rows; sy++)
    for (let sx = 0; sx < w.cols; sx++) {
      const x = w.x0 + sx;
      const y = w.y0 + sy;
      const ox = sx * TILE;
      const oy = sy * TILE;
      const letter = letterAt(map, x, y);
      const entry = letter === undefined ? undefined : LEGEND[letter];
      if (letter === undefined || entry === undefined) {
        c.rect(ox, oy, TILE, TILE, VOID);
        continue;
      }
      const tone = TONES[entry.tone];
      const ground = reach.has(`${x},${y}`) ? REACH : tone.bg;
      const token = tokens.get(`${x},${y}`);
      if (token !== undefined) {
        paintToken(c, ox, oy, token, ground);
        continue;
      }
      c.rect(ox, oy, TILE, TILE, ground);
      c.glyph(DINGS_ATLAS[letter], ox + 6, oy, 3, tone.fg);
    }
  return c;
}
