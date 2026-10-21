import { columnLabel, formatSquare, parseSquare } from "../game/drawSteel/map.ts";
import { pick } from "../game/drawSteel/state.ts";
import { quote } from "../game/text.ts";
import type { MapToken, MapView } from "./view.ts";

/**
 * What a piece of the map means; MapPane.tsx turns it into colour. Terrain tones are greys and one
 * muted olive, token tones are the band's side colours and the seat's own, so the two never meet.
 * Nothing is said by colour alone: reach is also a bigger dot (a doubled wave on difficult
 * terrain), the one acting is underlined, the dead are an `x`, and what is out of view is an arrow.
 */
export type MapTone =
  | "label"
  | "floor"
  | "wall"
  | "difficult"
  | "terrain"
  | "heroes"
  | "director"
  | "mine"
  | "dead";

export interface MapSegment {
  readonly text: string;
  readonly tone: MapTone;
  /** On a square the highlighted token can reach: drawn on the reach tint. */
  readonly reach?: boolean;
  /** The acting token, or the arrow toward it: underlined and bold. */
  readonly acting?: boolean;
}

export type MapLine = ReadonlyArray<MapSegment>;

/** The map laid out for one size of pane. */
export interface MapLayout {
  readonly title: string;
  /** The tokens out of view, as arrow and mark (` ↖B ▴g `), or "" when everything shows. */
  readonly bottomTitle: string;
  readonly lines: ReadonlyArray<MapLine>;
  /** Some of the highlighted reach is out of view: the table points at `/view map`. */
  readonly reachClipped: boolean;
}

/** Border, padding and the border again: what the pane's box takes from the screen. */
export const MAP_FRAME = { width: 4, height: 2 } as const;
/** Every square is two columns wide, so squares look square. */
const CELL = 2;
/** Columns past z have two-letter names (aa, ab…). */
const ONE_LETTER = 26;
/** The fewest rows of squares worth a second row of column letters. */
const TWO_ROW_MIN = 3;

/** The rows a pane needs to show `map` whole, border to border. */
export const mapRowsWanted = (map: MapView): number =>
  map.height + (map.width > ONE_LETTER ? 2 : 1) + MAP_FRAME.height;

const TERRAIN: Readonly<Record<string, { readonly glyph: string; readonly tone: MapTone }>> = {
  ".": { glyph: "·", tone: "floor" },
  "#": { glyph: "██", tone: "wall" },
  "~": { glyph: "~", tone: "difficult" },
  " ": { glyph: " ", tone: "floor" },
};
/** A square the highlighted token can reach: a bigger dot on floor, a doubled wave on difficult. */
const REACH_GLYPH: Readonly<Record<string, string>> = { ".": "•", "~": "≈" };

/** Arrows toward a token out of view, by which side of the view it is past: [dy + 1][dx + 1]. */
const ARROWS = [
  ["↖", "▴", "↗"],
  ["◂", "", "▸"],
  ["↙", "▾", "↘"],
] as const;

/** One axis of the view: which squares show, and which edges hold a marker row or column. */
interface Axis {
  readonly origin: number;
  readonly span: number;
  /** A marker row or column before the squares (left, top), toward tokens past that edge. */
  readonly before: number;
  readonly after: number;
}

/** Below this many squares of room, a clipped view keeps them all for squares; arrows go below. */
const MARGIN_ROOM = 6;

/**
 * Fits `size` squares in `room`, centred on `centre` and kept inside the map. When they don't
 * all fit, an edge gives a square to markers only when a token in `at` is past it, and only with
 * MARGIN_ROOM to spare; otherwise the bottom border alone names what is out of view.
 */
function axis(size: number, room: number, centre: number, at: ReadonlyArray<number>): Axis {
  if (size <= room) return { origin: 0, span: size, before: 0, after: 0 };
  const scarce = room < MARGIN_ROOM;
  let before = 0;
  let after = 0;
  const place = () => {
    const span = Math.max(1, room - before - after);
    const origin = Math.min(Math.max(0, centre - Math.floor(span / 2)), size - span);
    return { origin, span };
  };
  // Each pass may only add a margin, so two passes settle it.
  for (let pass = 0; pass < 2 && !scarce; pass++) {
    const { origin, span } = place();
    if (at.some((p) => p < origin)) before = 1;
    if (at.some((p) => p >= origin + span)) after = 1;
  }
  return { ...place(), before, after };
}

/** Who a pane follows: the one acting, else the seat's own hero. Their reach is the one shown. */
export const followed = (tokens: ReadonlyArray<MapToken>) => {
  const alive = tokens.filter((t) => !t.dead);
  return alive.find((t) => t.acting) ?? alive.find((t) => t.mine);
};

/** Which of two tokens on one square, or one marker cell, is drawn: the living, acting, own, heroes. */
const rank = (t: MapToken) =>
  (t.dead ? 0 : 8) + (t.acting ? 4 : 0) + (t.mine ? 2 : 0) + (t.side === "heroes" ? 1 : 0);
const better = (a: MapToken | undefined, b: MapToken) =>
  a === undefined || rank(b) > rank(a) ? b : a;

const toneOf = (t: MapToken): MapTone => (t.dead ? "dead" : t.mine ? "mine" : t.side);

/** Fills a cell to two columns, the filler on the same square (and tint) as the cell. */
function cell(text: string, tone: MapTone, more: { reach?: boolean; acting?: boolean } = {}) {
  const width = Bun.stringWidth(text);
  const head: MapSegment = { text, tone, ...more };
  if (width >= CELL) return [head];
  const fill: MapSegment = { text: " ".repeat(CELL - width), tone: "floor", reach: more.reach };
  return [head, fill];
}

/** The longest start of `mark` that fits in a cell. */
function fit(mark: string): string {
  let out = "";
  for (const ch of mark) {
    if (Bun.stringWidth(out + ch) > CELL) break;
    out += ch;
  }
  return out;
}

const blank = (width: number): MapSegment => ({ text: " ".repeat(width), tone: "floor" });

/**
 * The column letters over the squares. On two rows, every column gets its letters stacked, the
 * first letter over the second ("a" over "b" is ab), and a one-letter column only the lower row.
 * On one row, each name is written only where it can't touch the one before, so past z only every
 * other column is named.
 */
function letters(origin: number, span: number, rows: number): ReadonlyArray<string> {
  if (rows === 2) {
    const names = Array.from({ length: span }, (_, i) => columnLabel(origin + i));
    const upper = names.map((n) => (n.length > 1 ? n[0]! : " ").padEnd(CELL)).join("");
    const lower = names.map((n) => n.at(-1)!.padEnd(CELL)).join("");
    return [upper, lower];
  }
  let row = "";
  for (let i = 0; i < span; i++) {
    const name = columnLabel(origin + i);
    const at = i * CELL;
    // `row` ends with the last label written: skip a label that would touch it.
    if (row !== "" && at <= row.length) continue;
    row = row.padEnd(at) + name;
  }
  return [row.padEnd(span * CELL)];
}

/** Lists the tokens out of view, arrow then mark, in `width` columns, with `+N` for the rest. */
function offscreenTitle(off: ReadonlyArray<string>, width: number): string {
  if (off.length === 0) return "";
  let title = "";
  for (const [n, item] of off.entries()) {
    const left = off.length - n - 1;
    const tail = left > 0 ? ` +${left}` : "";
    if (Bun.stringWidth(`${title} ${item}${tail} `) > width) {
      return `${title} +${off.length - n} `;
    }
    title += ` ${item}`;
  }
  return `${title} `;
}

/** A square to centre the view on. */
export interface Focus {
  readonly x: number;
  readonly y: number;
}

/**
 * Where a seat's `/view <square|who>` points, read as /dist reads it (board.ts `point`): a token
 * by its exact mark ("B", "b1", which wins over the square it spells), else a square (refused past
 * the map's edge), else a token by its id or name or a unique start of either or of a word in one.
 */
export function focusOf(
  map: MapView,
  typed: string,
): { readonly token: string } | { readonly square: Focus } | { readonly refusal: string } {
  const q = typed.trim();
  const marked = map.tokens.find((t) => t.mark === q);
  if (marked !== undefined) return { token: marked.id };
  const square = parseSquare(q);
  if (square !== undefined)
    return square.x < map.width && square.y < map.height
      ? { square }
      : { refusal: `${formatSquare(square)} is outside the map.` };
  const found = pick(
    map.tokens,
    (t) => [t.id, t.name],
    (t) => t.name,
    q,
    `No token on the map is called '${quote(q)}'; /view <square|who>, or map, feed or both`,
  );
  return "refusal" in found ? found : { token: found.id };
}

/**
 * Lays the map out in `width` columns and `height` rows (inside the pane's frame): column letters
 * on top and row numbers on the left as in `c5`, two columns a square, centred when it fits. When
 * it doesn't, the view centres on `focus` if given (a seat's `/view <square|who>`), else the
 * acting token, else the seat's own hero, else wherever the most tokens can be seen at once; the
 * edges toward tokens out of view point at them, and the bottom border names them all.
 */
export function mapLayout(map: MapView, width: number, height: number, focus?: Focus): MapLayout {
  const title = ` map · ${map.name} `;
  const numbers = String(map.height).length + 1;
  const living = map.tokens.filter((t) => !t.dead);
  const roomAcross = Math.floor((width - numbers) / CELL);
  /** The view centred on a square: both axes, and how many letter rows it needs. */
  const viewAt = (centre: Focus) => {
    const across = axis(
      map.width,
      roomAcross,
      centre.x,
      living.map((t) => t.x),
    );
    const twoLetter = across.origin + across.span > ONE_LETTER;
    const labelRows = twoLetter && height - 2 >= TWO_ROW_MIN ? 2 : 1;
    const down = axis(
      map.height,
      height - labelRows,
      centre.y,
      living.map((t) => t.y),
    );
    return { across, down, labelRows };
  };
  const inView = (v: ReturnType<typeof viewAt>, t: Focus) =>
    t.x >= v.across.origin &&
    t.x < v.across.origin + v.across.span &&
    t.y >= v.down.origin &&
    t.y < v.down.origin + v.down.span;
  const middle = { x: Math.floor(map.width / 2), y: Math.floor(map.height / 2) };
  /** With nobody to follow, the token whose view holds the most tokens, heroes first on a tie. */
  const crowded = () => {
    let best: { at: Focus; seen: number } | undefined;
    for (const t of [...living].sort((a, b) => rank(b) - rank(a))) {
      const seen = living.filter((u) => inView(viewAt(t), u)).length;
      if (best === undefined || seen > best.seen) best = { at: t, seen };
    }
    return best?.at;
  };
  const view = viewAt(focus ?? followed(map.tokens) ?? crowded() ?? middle);
  const { across, down, labelRows } = view;

  const reach = new Set(map.reach.map((r) => `${r.x},${r.y}`));
  const onSquare = new Map<string, MapToken>();
  const marker = new Map<string, MapToken>();
  const off: MapToken[] = [];
  for (const t of map.tokens) {
    const cx = t.x - across.origin;
    const cy = t.y - down.origin;
    const dx = cx < 0 ? -1 : cx >= across.span ? 1 : 0;
    const dy = cy < 0 ? -1 : cy >= down.span ? 1 : 0;
    if (dx === 0 && dy === 0) {
      const key = `${t.x},${t.y}`;
      onSquare.set(key, better(onSquare.get(key), t));
    } else if (!t.dead) {
      // A marker sits in the edge square on the token's row or column, or in the corner.
      const key = `${dx === 0 ? cx : dx < 0 ? -1 : across.span},${dy === 0 ? cy : dy < 0 ? -1 : down.span}`;
      marker.set(key, better(marker.get(key), t));
      off.push(t);
    }
  }
  const arrowOf = (t: MapToken) => {
    const cx = t.x - across.origin;
    const cy = t.y - down.origin;
    const dx = cx < 0 ? 0 : cx >= across.span ? 2 : 1;
    const dy = cy < 0 ? 0 : cy >= down.span ? 2 : 1;
    return ARROWS[dy]![dx]!;
  };

  /** One row of cells, from the left marker column to the right one; `cy` is in view coordinates. */
  const row = (cy: number): MapSegment[] => {
    const out: MapSegment[] = [];
    for (let cx = -across.before; cx < across.span + across.after; cx++) {
      const edge = cx < 0 || cx >= across.span || cy < 0 || cy >= down.span;
      if (edge) {
        const t = marker.get(`${cx},${cy}`);
        out.push(...(t ? cell(arrowOf(t), toneOf(t), { acting: t.acting }) : [blank(CELL)]));
        continue;
      }
      const x = across.origin + cx;
      const y = down.origin + cy;
      const reachable = reach.has(`${x},${y}`);
      const t = onSquare.get(`${x},${y}`);
      if (t !== undefined) {
        out.push(
          ...cell(t.dead ? "x" : fit(t.mark), toneOf(t), {
            reach: reachable,
            acting: t.acting && !t.dead,
          }),
        );
        continue;
      }
      const ch = map.terrain[y]?.[x] ?? " ";
      const terrain = TERRAIN[ch] ?? { glyph: ch, tone: "terrain" as const };
      const glyph = (reachable && REACH_GLYPH[ch]) || terrain.glyph;
      out.push(...cell(glyph, terrain.tone, { reach: reachable }));
    }
    return out;
  };

  const squaresWidth = (across.span + across.before + across.after) * CELL;
  const left = Math.max(0, Math.floor((width - numbers - squaresWidth) / 2));
  const contentRows = labelRows + down.span + down.before + down.after;
  const top = Math.max(0, Math.floor((height - contentRows) / 2));

  const lead = (label: string): MapSegment => ({
    text: " ".repeat(left) + label.padStart(numbers - 1) + " ",
    tone: "label",
  });
  const lines: MapLine[] = Array.from({ length: top }, () => [blank(1)]);
  for (const text of letters(across.origin, across.span, labelRows))
    lines.push([lead(""), blank(across.before * CELL), { text, tone: "label" }]);
  for (let cy = -down.before; cy < down.span + down.after; cy++) {
    const shown = cy >= 0 && cy < down.span;
    lines.push([lead(shown ? String(down.origin + cy + 1) : ""), ...row(cy)]);
  }
  // Rows and columns left out have no other sign when no token is past them.
  const cropped = [
    down.span < map.height
      ? `rows ${down.origin + 1}-${down.origin + down.span} of ${map.height}`
      : "",
    across.span < map.width
      ? `columns ${columnLabel(across.origin)}-${columnLabel(across.origin + across.span - 1)} of a-${columnLabel(map.width - 1)}`
      : "",
  ].filter((part) => part !== "");
  return {
    title: cropped.length === 0 ? title : `${title.trimEnd()} · ${cropped.join(", ")} `,
    reachClipped: map.reach.some((r) => !inView(view, r)),
    bottomTitle: offscreenTitle(
      off.map((t) => `${arrowOf(t)}${t.mark}`),
      width,
    ),
    lines,
  };
}
