/**
 * The GM's prep panel as pure data: what the next square clicked on the map does, the lines that
 * sends, and where a group just added goes. The rules project the panel (`PrepView`) with the
 * line each item sends; this only fills in the count and the square, so the panel never changes
 * state itself: a click sends a line, as typing would, or puts one on the input line.
 */
import { formatSquare } from "../game/drawSteel/map.ts";
import type { MapView, PrepFigure, PrepItem, PrepView } from "./view.ts";

/** The panel's columns, beside the map and the feed: a third of the seat, within these. */
export const PREP_WIDTH = { least: 26, most: 34 } as const;

export const prepWidth = (cols: number): number =>
  Math.min(PREP_WIDTH.most, Math.max(PREP_WIDTH.least, Math.floor(cols / 3)));

/**
 * What the GM picked in the panel for the next square: a token off the map (any of them, else
 * the first waiting goes), or how many of a monster to add there, the monster by its item's line
 * (`/add bandit`), which names it wherever a list read again puts it.
 */
export type PrepArmed =
  | { readonly kind: "token"; readonly id: string }
  | { readonly kind: "count"; readonly line: string; readonly n: number };

/** What the next square clicked does, as the panel shows it. */
export type PrepNext =
  | {
      readonly kind: "place";
      readonly id: string;
      readonly name: string;
      readonly figure: PrepFigure;
    }
  | {
      readonly kind: "add";
      readonly name: string;
      readonly figure: PrepFigure;
      readonly n: number;
      /** The line it sends: `/add bandit x3`. */
      readonly line: string;
    };

/** The line a count item sends for `n`: `/add bandit` for one, `/add bandit x3` for more. */
export const countLine = (item: PrepItem, n: number): string =>
  n <= 1 ? item.line : `${item.line} x${n}`;

const items = (view: PrepView): ReadonlyArray<PrepItem> => view.sections.flatMap((s) => s.items);

/**
 * What the next square clicked does: what `armed` names, if the view still offers it, else place
 * the first who waits. A hero just sent for (`/hero vex`) may not wait yet; its item names it.
 */
export function prepNext(view: PrepView, armed: PrepArmed | undefined): PrepNext | undefined {
  if (armed?.kind === "count") {
    const item = items(view).find((i) => i.kind === "count" && i.line === armed.line);
    if (item?.figure !== undefined)
      return {
        kind: "add",
        name: item.label,
        figure: item.figure,
        n: armed.n,
        line: countLine(item, armed.n),
      };
  }
  if (armed?.kind === "token") {
    const waiting = view.place.find((t) => t.id === armed.id);
    if (waiting !== undefined) return { kind: "place", ...waiting };
    const joining = items(view).find((i) => i.kind === "send" && i.figure?.id === armed.id);
    if (joining?.figure !== undefined)
      return { kind: "place", id: armed.id, name: joining.label, figure: joining.figure };
  }
  const first = view.place[0];
  return first === undefined ? undefined : { kind: "place", ...first };
}

/** Whether `armed` still names something the view offers, so it is kept. */
export const armedStands = (view: PrepView, armed: PrepArmed): boolean => {
  const next = prepNext(view, armed);
  return armed.kind === "count"
    ? next?.kind === "add"
    : next?.kind === "place" && next.id === armed.id;
};

/**
 * A click on a monster's item: one more of it for the next square, up to its most, or (`by` -1)
 * one fewer, none putting it down.
 */
export function prepCount(
  armed: PrepArmed | undefined,
  item: PrepItem,
  by: 1 | -1,
): PrepArmed | undefined {
  if (item.kind !== "count") return armed;
  const same = armed?.kind === "count" && armed.line === item.line;
  const n = Math.min(item.max ?? Number.POSITIVE_INFINITY, (same ? armed.n : 0) + by);
  return n <= 0 ? undefined : { kind: "count", line: item.line, n };
}

interface Square {
  readonly x: number;
  readonly y: number;
}

/** The squares a token may be put on: floor or difficult ground, with no token on it. */
const free = (map: MapView): Square[] => {
  const taken = new Set(map.tokens.filter((t) => !t.dead).map((t) => `${t.x},${t.y}`));
  const out: Square[] = [];
  for (const [y, row] of map.terrain.entries())
    for (const [x, t] of [...row].entries())
      if ((t === "." || t === "~") && !taken.has(`${x},${y}`)) out.push({ x, y });
  return out;
};

/**
 * Where a group just added goes: the free squares nearest `at`, the clicked square first, one for
 * each of `ids`, as `/place` lines. Ids past the free squares are left waiting.
 */
export function placeNear(map: MapView, ids: ReadonlyArray<string>, at: Square): string[] {
  const d = (s: Square) => (s.x - at.x) ** 2 + (s.y - at.y) ** 2;
  const squares = free(map).toSorted((a, b) => d(a) - d(b) || a.y - b.y || a.x - b.x);
  return ids.flatMap((id, i) => {
    const s = squares[i];
    return s === undefined ? [] : [`/place ${id} ${formatSquare(s)}`];
  });
}

/** The hint row while the panel is open, longest first: what the next square sends, typed. */
export function prepHints(next: PrepNext | undefined, key: number): ReadonlyArray<string> {
  const hide = `Alt+${key} hides it`;
  if (next === undefined)
    return [
      `click to send · Up shows what was sent · ${hide} · /help`,
      `click to send · ${hide}`,
      hide,
      "",
    ];
  const typed = next.kind === "place" ? `/place ${next.id} <square>` : `${next.line} then /place`;
  const does = next.kind === "place" ? `a square places ${next.name}` : `a square adds them there`;
  return [`${does} · ${typed} · Esc puts it down · ${hide}`, `${does} · ${typed}`, typed, ""];
}

/** Quadrant blocks by which quarters are lit: upper left 1, upper right 2, lower left 4, lower right 8. */
const QUADRANTS = " ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█";

/**
 * A MEKMODE figure (8 by 12 pixels, a row a byte in hex) in four columns and two rows of quadrant
 * blocks, for a terminal without pictures: each quarter of a cell is a pixel wide and three tall,
 * lit when two of them are.
 */
export function figureText(glyph: string | undefined): [string, string] {
  const lit = (x: number, y: number) =>
    (Number.parseInt(glyph?.slice(y * 2, y * 2 + 2) || "00", 16) & (0x80 >> x)) !== 0;
  const quarter = (x: number, qy: number) => {
    let n = 0;
    for (let y = qy * 3; y < qy * 3 + 3; y++) n += +lit(x, y);
    return n >= 2;
  };
  const row = (r: number) =>
    Array.from({ length: 4 }, (_, c) => {
      const bits =
        +quarter(c * 2, r * 2) +
        2 * +quarter(c * 2 + 1, r * 2) +
        4 * +quarter(c * 2, r * 2 + 1) +
        8 * +quarter(c * 2 + 1, r * 2 + 1);
      return QUADRANTS[bits]!;
    }).join("");
  return [row(0), row(1)];
}
