// PROTOTYPE, throwaway (branch prototype/map-art). Paints the battlemap as RGBA pixels from the
// MEKMODE atlas (dings.ts, text.ts: 8x12 1-bit glyphs baked from MEK.txt's font, used with MEK's
// permission). Three looks, one per variant; see README.md beside this file.
import type { MapToken, MapView } from "../view.ts";
import { DINGS_ATLAS } from "./dings.ts";
import { TEXT_ATLAS } from "./text.ts";
import { LEGEND, type Tone } from "../../game/prototype-map-gen/legend.ts";

/** Pixels per square in a painted image. A square is 4 columns by 2 rows of the terminal. */
export const TILE = 36;

type Rgb = readonly [number, number, number];

const hex = (h: string): Rgb => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

const C = {
  void: hex("#0e0f12"),
  ground: hex("#16181d"),
  floor: hex("#5c6370"),
  wallBg: hex("#2a2d34"),
  wall: hex("#8a8a8a"),
  difficult: hex("#87875f"),
  heroes: hex("#61afef"),
  director: hex("#c678dd"),
  mine: hex("#98c379"),
  dead: hex("#606060"),
  reach: hex("#1f4a4a"),
  white: hex("#ffffff"),
  black: hex("#000000"),
  red: hex("#ff5f5f"),
  felt: hex("#1f262b"),
  grid: hex("#2b343a"),
  stone: hex("#585d65"),
  stoneHi: hex("#787d85"),
  stoneLo: hex("#3a3e44"),
  marsh: hex("#272b20"),
};

export class Canvas {
  readonly pixels: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.pixels = new Uint8Array(width * height * 4);
  }
  set(x: number, y: number, c: Rgb, alpha = 255) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    this.pixels[i] = c[0];
    this.pixels[i + 1] = c[1];
    this.pixels[i + 2] = c[2];
    this.pixels[i + 3] = alpha;
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
  /** An 8x12 atlas glyph, each bit a `scale` x `scale` block. */
  glyph(hexRows: string | undefined, x: number, y: number, scale: number, c: Rgb) {
    if (hexRows === undefined) return;
    for (let row = 0; row < 12; row++) {
      const bits = parseInt(hexRows.slice(row * 2, row * 2 + 2), 16);
      for (let col = 0; col < 8; col++)
        if ((bits >> (7 - col)) & 1) this.rect(x + col * scale, y + row * scale, scale, scale, c);
    }
  }
  disc(cx: number, cy: number, r: number, c: Rgb) {
    for (let y = -r; y <= r; y++)
      for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r) this.set(cx + x, cy + y, c);
  }
  ring(cx: number, cy: number, r: number, t: number, c: Rgb) {
    for (let y = -r; y <= r; y++)
      for (let x = -r; x <= r; x++) {
        const d = x * x + y * y;
        if (d <= r * r && d > (r - t) * (r - t)) this.set(cx + x, cy + y, c);
      }
  }
}

// ---- Which picture is whose. MEKMODE Dings is keyed by keyboard character; these were picked by eye
// from its figures. A hero or monster not named here gets one by its id's hash.
const HERO_FIGURES: Record<string, string> = { brann: "8", kesh: "9", wren: "2", ilsa: "6" };
const MONSTER_FIGURES: Record<string, string> = {
  "bandit-chief": '"',
  "bandit-bruiser": "+",
  "bandit-cutpurse": ")",
  "bandit-slinger": "$",
};
const SPARE_HEROES = ["1", "3", "5", "7", "&", "'", "0", "4"];
const SPARE_MONSTERS = ["(", "*", "#", "%", "/", ":", ";", "="];
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

export const figureOf = (token: MapToken): string => {
  const table = token.side === "heroes" ? HERO_FIGURES : MONSTER_FIGURES;
  const named = Object.entries(table).find(([id]) => token.id.startsWith(id));
  if (named) return named[1];
  const spare = token.side === "heroes" ? SPARE_HEROES : SPARE_MONSTERS;
  return spare[hash(token.id) % spare.length]!;
};

const sideColour = (t: MapToken): Rgb =>
  t.dead ? C.dead : t.mine ? C.mine : t.side === "heroes" ? C.heroes : C.director;

/** The squares of `map` a view shows: `cols` x `rows` from (`x0`, `y0`). */
export interface Window {
  readonly x0: number;
  readonly y0: number;
  readonly cols: number;
  readonly rows: number;
}

const reachSet = (map: MapView) => new Set(map.reach.map((r) => `${r.x},${r.y}`));
const tokenAt = (map: MapView) => {
  const at = new Map<string, MapToken>();
  // The living are drawn over the dead.
  for (const t of map.tokens.toSorted((a, b) => Number(b.dead) - Number(a.dead)))
    at.set(`${t.x},${t.y}`, t);
  return at;
};

// ---- Variant A, "Painted": a DOS-tile scene. Terrain and tokens are MEKMODE dings at 3x.

const TERRAIN_DING: Record<string, { ding: string; fg: Rgb; bg: Rgb }> = {
  ".": { ding: "c", fg: C.floor, bg: C.ground },
  "#": { ding: "B", fg: C.wall, bg: C.wallBg },
  "~": { ding: "z", fg: C.difficult, bg: C.ground },
};

/** One token as a painted tile: its figure at 3x in its side's colour, its mark in the corner. */
export const paintTokenTile = (c: Canvas, ox: number, oy: number, t: MapToken, bg: Rgb) => {
  const colour = sideColour(t);
  c.rect(ox, oy, TILE, TILE, mix(bg, colour, 0.18));
  c.glyph(DINGS_ATLAS[figureOf(t)], ox + 2, oy, 3, colour);
  const markW = t.mark.length * 8;
  const mx = ox + TILE - markW - 1;
  const my = oy + TILE - 13;
  c.rect(mx - 1, my - 1, markW + 2, 14, C.black);
  [...t.mark].forEach((ch, i) => c.glyph(TEXT_ATLAS[ch], mx + i * 8, my, 1, C.white));
  if (t.acting) c.frame(ox, oy, TILE, TILE, 2, C.white);
  if (t.dead)
    for (let i = 4; i < TILE - 4; i++) {
      c.set(ox + i, oy + i, C.red);
      c.set(ox + i + 1, oy + i, C.red);
    }
};

/** Each tone's glyph and ground colours, for maps written in MEKMODE letters. */
const TONES: Record<Tone, { fg: Rgb; bg: Rgb }> = {
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

export const paintPainted = (map: MapView, w: Window): Canvas => {
  const c = new Canvas(w.cols * TILE, w.rows * TILE);
  const reach = reachSet(map);
  const tokens = tokenAt(map);
  for (let sy = 0; sy < w.rows; sy++)
    for (let sx = 0; sx < w.cols; sx++) {
      const x = w.x0 + sx;
      const y = w.y0 + sy;
      const ox = sx * TILE;
      const oy = sy * TILE;
      const ch = map.terrain[y]?.[x] ?? " ";
      const letter = map.dressing?.[y]?.[x];
      const dressed = letter !== undefined && letter !== " " ? LEGEND[letter] : undefined;
      const terrain = dressed ? { ding: letter!, ...TONES[dressed.tone] } : TERRAIN_DING[ch];
      if (terrain === undefined) {
        c.rect(ox, oy, TILE, TILE, C.void);
        continue;
      }
      const bg = reach.has(`${x},${y}`) ? C.reach : terrain.bg;
      const token = tokens.get(`${x},${y}`);
      if (token) {
        paintTokenTile(c, ox, oy, token, bg);
        continue;
      }
      c.rect(ox, oy, TILE, TILE, bg);
      c.glyph(DINGS_ATLAS[terrain.ding], ox + 6, oy, 3, terrain.fg);
    }
  return c;
};

// ---- Variant B, "Miniatures": a flat board with a grid, stone walls, and round bases with big marks.

export const paintMinis = (map: MapView, w: Window): Canvas => {
  const c = new Canvas(w.cols * TILE, w.rows * TILE);
  const reach = reachSet(map);
  const tokens = tokenAt(map);
  for (let sy = 0; sy < w.rows; sy++)
    for (let sx = 0; sx < w.cols; sx++) {
      const x = w.x0 + sx;
      const y = w.y0 + sy;
      const ox = sx * TILE;
      const oy = sy * TILE;
      const ch = map.terrain[y]?.[x] ?? " ";
      if (ch === " ") {
        c.rect(ox, oy, TILE, TILE, C.void);
        continue;
      }
      if (ch === "#") {
        c.rect(ox, oy, TILE, TILE, C.stone);
        c.rect(ox, oy, TILE, 3, C.stoneHi);
        c.rect(ox, oy, 3, TILE, C.stoneHi);
        c.rect(ox, oy + TILE - 3, TILE, 3, C.stoneLo);
        c.rect(ox + TILE - 3, oy, 3, TILE, C.stoneLo);
        continue;
      }
      const base = ch === "~" ? C.marsh : C.felt;
      c.rect(ox, oy, TILE, TILE, reach.has(`${x},${y}`) ? mix(base, hex("#2f8080"), 0.4) : base);
      if (ch === "~") c.glyph(DINGS_ATLAS["x"], ox + 10, oy + 6, 2, mix(base, C.difficult, 0.55));
      c.rect(ox + TILE - 1, oy, 1, TILE, C.grid);
      c.rect(ox, oy + TILE - 1, TILE, 1, C.grid);
      const t = tokens.get(`${x},${y}`);
      if (!t) continue;
      const colour = sideColour(t);
      const cx = ox + TILE / 2;
      const cy = oy + TILE / 2;
      if (t.acting) c.ring(cx, cy, 17, 2, C.white);
      c.disc(cx, cy, 15, mix(C.black, colour, 0.45));
      c.ring(cx, cy, 15, 3, colour);
      const [first, ...rest] = [...t.mark];
      c.glyph(TEXT_ATLAS[first!], cx - 8 - rest.length * 3, cy - 12, 2, C.white);
      rest.forEach((ch, i) => c.glyph(TEXT_ATLAS[ch], cx + 3 + i * 8, cy + 1, 1, C.white));
      if (t.dead)
        for (let i = -9; i <= 9; i++) {
          c.set(cx + i, cy + i, C.red);
          c.set(cx + i, cy - i, C.red);
        }
    }
  return c;
};

/** Variant C's token sprite: the painted tile alone, on the ground colour. */
export const paintSprite = (t: MapToken, reach: boolean): Canvas => {
  const c = new Canvas(TILE, TILE);
  paintTokenTile(c, 0, 0, t, reach ? C.reach : C.ground);
  return c;
};
