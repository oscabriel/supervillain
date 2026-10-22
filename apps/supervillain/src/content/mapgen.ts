// Generated battlemaps, written in MEKMODE letters (game/drawSteel/mekmode.ts), for `supervillain
// map`. The same kind, seed and size always give the same map. Each kind lays out what the rules
// care about first (walls, difficult ground, a way through, room for each side to deploy), then
// dresses it: ground by noise over MEK's density ramp, woods dense in the middle and thin at the
// edge, walls in courses with arches at their gaps and pillars at their corners.
import { LEGEND } from "../game/drawSteel/mekmode.ts";

export type MapKind = "crossing" | "keep";
export const MAP_KINDS: ReadonlyArray<MapKind> = ["crossing", "keep"];

export interface GeneratedMap {
  readonly name: string;
  readonly lines: ReadonlyArray<string>;
  /** Where each side may start: the west edge for the party, the east for their foes. */
  readonly deploy: { readonly west: ReadonlyArray<Sq>; readonly east: ReadonlyArray<Sq> };
}

interface Sq {
  readonly x: number;
  readonly y: number;
}

/** mulberry32: a small seeded generator, so a map is its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p: number) => next() < p,
    pick: <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(next() * xs.length)]!,
  };
}
type Rng = ReturnType<typeof rng>;

/** Smooth value noise in [0, 1], cells `scale` squares wide. */
function noise(r: Rng, w: number, h: number, scale: number) {
  const gw = Math.ceil(w / scale) + 2;
  const gh = Math.ceil(h / scale) + 2;
  const g = Array.from({ length: gw * gh }, () => r.next());
  const at = (x: number, y: number) => g[y * gw + x]!;
  const ease = (t: number) => t * t * (3 - 2 * t);
  return (x: number, y: number) => {
    const fx = x / scale;
    const fy = y / scale;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = ease(fx - x0);
    const ty = ease(fy - y0);
    const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
    const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
    return top + (bottom - top) * ty;
  };
}

class Grid {
  readonly cells: string[][];
  constructor(
    readonly w: number,
    readonly h: number,
    fill: string,
  ) {
    this.cells = Array.from({ length: h }, () => Array.from({ length: w }, () => fill));
  }
  in(x: number, y: number) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }
  get(x: number, y: number) {
    return this.in(x, y) ? this.cells[y]![x]! : " ";
  }
  set(x: number, y: number, c: string) {
    if (this.in(x, y)) this.cells[y]![x] = c;
  }
  rules(x: number, y: number) {
    return LEGEND[this.get(x, y)]?.terrain ?? "#";
  }
  lines() {
    return this.cells.map((row) => row.join(""));
  }
}

/** Ground by noise, over MEK's ramp from bare earth to scrub. */
function ground(g: Grid, r: Rng, lush: number) {
  const n = noise(r, g.w, g.h, 4);
  const m = noise(r, g.w, g.h, 2);
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++) {
      const v = n(x, y) * 0.75 + m(x, y) * 0.25 + lush;
      g.set(x, y, v < 0.3 ? "q" : v < 0.5 ? "Q" : v < 0.72 ? "u" : v < 0.86 ? "w" : "e");
    }
}

/** A wood: trees thick in the middle, saplings and scrub at the edge. */
function wood(
  g: Grid,
  r: Rng,
  cx: number,
  cy: number,
  radius: number,
  keep: (x: number, y: number) => boolean,
) {
  const conifer = r.chance(0.5);
  for (let y = cy - radius - 1; y <= cy + radius + 1; y++)
    for (let x = cx - radius - 1; x <= cx + radius + 1; x++) {
      if (!g.in(x, y) || keep(x, y)) continue;
      const d = Math.hypot(x - cx, (y - cy) * 1.3) / radius + (r.next() - 0.5) * 0.35;
      if (d < 0.45) g.set(x, y, r.chance(0.6) ? "P" : "p");
      else if (d < 0.8) g.set(x, y, r.chance(0.6) ? (conifer ? "o" : "i") : conifer ? "O" : "I");
      else if (d < 1.1 && r.chance(0.6)) g.set(x, y, r.pick(["W", "U", "w"]));
    }
}

/** Boulders: an outcrop with loose rock around it. */
function rocks(g: Grid, r: Rng, cx: number, cy: number, keep: (x: number, y: number) => boolean) {
  if (!keep(cx, cy)) g.set(cx, cy, "T");
  for (let y = cy - 1; y <= cy + 1; y++)
    for (let x = cx - 1; x <= cx + 1; x++)
      if ((x !== cx || y !== cy) && !keep(x, y) && r.chance(0.45))
        g.set(x, y, r.pick(["t", "R", "r"]));
}

/**
 * A walled building, ruined or whole: brick courses, pillars at the corners, `doors` archways, and
 * for a ruin, stretches fallen to rubble. Its floor is flagstones with a little debris.
 */
function building(
  g: Grid,
  r: Rng,
  x0: number,
  y0: number,
  w: number,
  h: number,
  doors: number,
  ruin: number,
) {
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) {
      const edge = x === x0 || y === y0 || x === x0 + w - 1 || y === y0 + h - 1;
      const corner = (x === x0 || x === x0 + w - 1) && (y === y0 || y === y0 + h - 1);
      if (corner) g.set(x, y, "k");
      else if (edge) g.set(x, y, r.chance(ruin) ? r.pick(["R", "L", "r"]) : "s");
      else g.set(x, y, r.chance(ruin * 0.4) ? "R" : r.pick(["c", "C", "C", "v"]));
    }
  // Doors on the long sides, never at a corner.
  for (let i = 0; i < doors; i++) {
    const side = r.int(0, 3);
    const x = side < 2 ? r.int(x0 + 1, x0 + w - 2) : side === 2 ? x0 : x0 + w - 1;
    const y = side < 2 ? (side === 0 ? y0 : y0 + h - 1) : r.int(y0 + 1, y0 + h - 2);
    g.set(x, y, "d");
  }
}

/** Squares one can stand on in the first or last `span` columns, nearest the middle row first. */
function deployZone(g: Grid, west: boolean, span = 3): Sq[] {
  const squares: Sq[] = [];
  for (let i = 0; i < span; i++)
    for (let y = 0; y < g.h; y++) {
      const x = west ? i : g.w - 1 - i;
      if (g.rules(x, y) !== "#" && g.get(x, y) !== " ") squares.push({ x, y });
    }
  const mid = g.h / 2;
  return squares.toSorted(
    (a, b) => Math.abs(a.y - mid) - Math.abs(b.y - mid) || (west ? a.x - b.x : b.x - a.x),
  );
}

/** Whether the west edge reaches the east edge without crossing a wall: a fight can close. */
function connected(g: Grid): boolean {
  const seen = new Set<number>();
  const queue: Sq[] = [];
  for (let y = 0; y < g.h; y++) if (g.rules(0, y) !== "#") queue.push({ x: 0, y });
  while (queue.length) {
    const { x, y } = queue.pop()!;
    const k = y * g.w + x;
    if (seen.has(k) || !g.in(x, y) || g.rules(x, y) === "#") continue;
    seen.add(k);
    if (x === g.w - 1) return true;
    queue.push({ x: x + 1, y }, { x: x - 1, y }, { x, y: y + 1 }, { x, y: y - 1 });
  }
  return false;
}

const NAMES: Readonly<Record<MapKind, readonly [ReadonlyArray<string>, ReadonlyArray<string>]>> = {
  crossing: [
    ["Mill", "Heron", "Saltmarsh", "Drowned", "Old", "Weeping", "Kingsway"],
    ["Crossing", "Ford", "Wade"],
  ],
  keep: [
    ["Broken", "Grey", "Thorn", "Ashen", "Lantern"],
    ["Keep", "Hold", "Watch", "Bastion"],
  ],
};

const named = (r: Rng, kind: MapKind) => {
  const [first, second] = NAMES[kind];
  return `The ${r.pick(first)} ${r.pick(second)}`;
};

function crossing(r: Rng, w: number, h: number): Grid {
  const g = new Grid(w, h, "q");
  ground(g, r, 0);
  // The river runs north to south, wandering, two or three squares wide.
  const river = new Set<number>();
  let rx = Math.round(w / 2) + r.int(-2, 2);
  for (let y = 0; y < h; y++) {
    if (r.chance(0.35)) rx = Math.max(4, Math.min(w - 6, rx + r.pick([-1, 1])));
    const width = r.chance(0.3) ? 3 : 2;
    for (let i = 0; i < width; i++) {
      g.set(rx + i, y, i === 0 || i === width - 1 ? (r.chance(0.12) ? "x" : "Z") : "X");
      river.add(y * w + rx + i);
    }
    for (const bank of [rx - 1, rx + width]) if (r.chance(0.45)) g.set(bank, y, "U");
  }
  // The road runs west to east, two squares wide, fording the river in the shallows.
  const road = new Set<number>();
  let ry = Math.round(h / 2) + r.int(-1, 1);
  for (let x = 0; x < w; x++) {
    if (x > 2 && x < w - 3 && r.chance(0.12))
      ry = Math.max(2, Math.min(h - 4, ry + r.pick([-1, 1])));
    for (const y of [ry, ry + 1]) {
      g.set(x, y, river.has(y * w + x) ? "z" : "a");
      road.add(y * w + x);
    }
  }
  const busy = (x: number, y: number) =>
    road.has(y * w + x) || river.has(y * w + x) || x < 3 || x > w - 4;
  // A ruin on one bank, off the road.
  const bw = r.int(5, 7);
  const bh = r.int(4, 5);
  const north = r.chance(0.5);
  const east = r.chance(0.5);
  const bx = east ? Math.min(w - 4 - bw, rx + 4) : Math.max(3, rx - 3 - bw);
  const by = north ? Math.max(0, ry - 1 - bh) : Math.min(h - bh, ry + 3);
  building(g, r, bx, by, bw, bh, 2, 0.3);
  const inRuin = (x: number, y: number) => x >= bx && x < bx + bw && y >= by && y < by + bh;
  // Two or three woods, and a few outcrops, away from the road, the river and the ruin.
  const keep = (x: number, y: number) => busy(x, y) || inRuin(x, y);
  for (let i = r.int(2, 3); i > 0; i--)
    wood(
      g,
      r,
      r.int(3, w - 4),
      r.chance(0.5) ? r.int(0, ry - 2) : r.int(ry + 3, h - 1),
      r.int(2, 3),
      keep,
    );
  for (let i = r.int(2, 4); i > 0; i--) rocks(g, r, r.int(3, w - 4), r.int(0, h - 1), keep);
  return g;
}

function keepOf(r: Rng, w: number, h: number): Grid {
  const g = new Grid(w, h, "q");
  ground(g, r, 0.1);
  // The curtain wall: a ring of brick with towers at its corners, a gate west, a breach east.
  const x0 = 4;
  const y0 = 1;
  const x1 = w - 5;
  const y1 = h - 2;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const edge = x === x0 || x === x1 || y === y0 || y === y1;
      if (edge) g.set(x, y, "s");
      else g.set(x, y, r.chance(0.7) ? r.pick(["C", "C", "c"]) : r.pick(["u", "Q", "q"]));
    }
  for (const [x, y] of [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
  ] as const)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) g.set(x + dx, y + dy, dx === 0 && dy === 0 ? "K" : "k");
  const gate = Math.round((y0 + y1) / 2);
  g.set(x0, gate, "d");
  g.set(x0, gate + 1, "d");
  for (let x = 0; x < x0; x++) {
    g.set(x, gate, "a");
    g.set(x, gate + 1, "a");
  }
  const breach = r.int(y0 + 2, y1 - 3);
  for (let dy = 0; dy < 3; dy++) {
    g.set(x1, breach + dy, r.pick(["R", "R", "L"]));
    g.set(x1 + 1, breach + dy, r.pick(["r", "R", "t"]));
  }
  // The hall: a building in the courtyard, whole, with two doors.
  const hw = r.int(5, 7);
  const hh = r.int(3, 4);
  const hx = r.int(x0 + 3, x1 - hw - 2);
  const hy = r.chance(0.5) ? y0 + 2 : y1 - hh - 1;
  building(g, r, hx, hy, hw, hh, 2, 0);
  for (let x = hx + 1; x < hx + hw - 1; x++) g.set(x, hy + (hy === y0 + 2 ? 0 : hh - 1), "f");
  // A well, a statue and rubble about the yard.
  const free = (x: number, y: number) => ["C", "c", "u", "Q", "q"].includes(g.get(x, y));
  const spot = () => {
    for (let i = 0; i < 50; i++) {
      const x = r.int(x0 + 2, x1 - 2);
      const y = r.int(y0 + 2, y1 - 2);
      if (free(x, y) && free(x + 1, y) && free(x, y + 1)) return { x, y };
    }
    return undefined;
  };
  const well = spot();
  if (well) g.set(well.x, well.y, "F");
  const statue = spot();
  if (statue) g.set(statue.x, statue.y, "J");
  for (let i = r.int(3, 6); i > 0; i--) {
    const s = spot();
    if (s) g.set(s.x, s.y, r.pick(["R", "r", "L"]));
  }
  // Woods outside the walls.
  const outside = (x: number, y: number) =>
    (x >= x0 - 1 && x <= x1 + 1 && y >= y0 - 1 && y <= y1 + 1) || x < 2 || x > w - 3;
  for (let i = r.int(1, 2); i > 0; i--) wood(g, r, r.pick([1, w - 2]), r.int(0, h - 1), 2, outside);
  return g;
}

/** A map of `kind` from `seed`, 24 by 14 squares unless told otherwise. */
export function generateMap(kind: MapKind, seed: number, w = 24, h = 14): GeneratedMap {
  const r = rng(seed);
  for (let attempt = 0; attempt < 20; attempt++) {
    const g = kind === "crossing" ? crossing(r, w, h) : keepOf(r, w, h);
    if (!connected(g)) continue;
    return {
      name: named(r, kind),
      lines: g.lines(),
      deploy: { west: deployZone(g, true), east: deployZone(g, false) },
    };
  }
  throw new Error(`no ${kind} for seed ${seed} could be crossed from west to east`);
}

/** A generated map as a map file: `name:`, `style: mekmode`, then its rows. */
export const mapFileText = (m: GeneratedMap): string =>
  `${[`name: ${m.name}`, "style: mekmode", ...m.lines].join("\n")}\n`;
