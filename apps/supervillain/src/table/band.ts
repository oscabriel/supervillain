import type { Combatant, CombatView } from "./view.ts";

/**
 * What a piece of the band means; Band.tsx turns it into colour. Every state with a colour also has
 * a word or a symbol (`winded`, `▶`, `✓`), so nothing is said by colour alone.
 */
export type Tone =
  | "text"
  | "dim"
  | "heroes"
  | "director"
  | "acting"
  | "healthy"
  | "winded"
  | "dying"
  | "dead"
  | "temp";

export interface Segment {
  readonly text: string;
  readonly tone: Tone;
  /** The seat's own hero's name, drawn highlighted. */
  readonly mine?: boolean;
}

export type Line = ReadonlyArray<Segment>;

/** The band laid out for one size: its title, the lines inside it, and who didn't fit. */
export interface BandLayout {
  readonly title: string;
  readonly lines: ReadonlyArray<Line>;
  /** Combatants left out for lack of room, shown as `+N more`. */
  readonly more: number;
}

/** Cells in a Stamina meter: `▐████░░▌` is 14 of 21. */
const METER = 6;
/** Spaces between two combatants sharing a row. */
const GAP = 3;
/** A half-width column narrower than this holds too little to be worth sharing a row. */
const MIN_COLUMN = 30;
/** Longer names are shortened, so one long name can't push every meter off the row. */
const NAME_MAX = 20;
/** However tight the band, a name keeps this many columns. */
const NAME_MIN = 4;
const SEPARATOR: Segment = { text: " · ", tone: "dim" };

/** One combatant: the aligned head (marker, name, meter, numbers, temporary Stamina), then its details. */
interface Cell {
  readonly head: Line;
  readonly details: Line;
  /** Where the meter starts: wrapped details line up under it. */
  readonly indent: number;
}

const widthOf = (line: Line) => line.reduce((n, s) => n + Bun.stringWidth(s.text), 0);
const textWidth = (text: string) => Bun.stringWidth(text);

/** The longest start of `text` that fits in `width` columns. */
function take(text: string, width: number): string {
  let out = "";
  for (const ch of text) {
    if (textWidth(out + ch) > width) break;
    out += ch;
  }
  return out;
}

/** Cuts text to `width` columns, ending in `…` when anything was cut. */
const cut = (text: string, width: number) =>
  textWidth(text) <= width ? text : `${take(text, width - 1).trimEnd()}…`;

/** Cuts a line to `width` columns, ending in `…` when anything was cut. */
function truncate(line: Line, width: number): Line {
  if (widthOf(line) <= width) return line;
  const out: Segment[] = [];
  let left = width - 1;
  for (const s of line) {
    const w = textWidth(s.text);
    if (w > left) {
      out.push({ ...s, text: take(s.text, left) });
      break;
    }
    out.push(s);
    left -= w;
  }
  return [...out, { text: "…", tone: "dim" }];
}

const pad = (line: Line, width: number): Line => {
  const w = widthOf(line);
  return w >= width ? line : [...line, { text: " ".repeat(width - w), tone: "text" }];
};

/**
 * A name in at most `max` columns, keeping what tells it apart: a creature's number or squad
 * letter stays and its leading words go ("…Bruiser 1", "…Chief"), and a hero keeps its own name
 * before its player's ("Brann (Al…)").
 */
function shorten(name: string, max: number): string {
  if (textWidth(name) <= max) return name;
  const played = /^(.+) \((.+)\)$/.exec(name);
  if (played !== null) {
    const [, hero, player] = played as unknown as [string, string, string];
    const room = max - textWidth(hero) - 3;
    return room >= 2 ? `${hero} (${cut(player, room)})` : cut(hero, max);
  }
  // The last words tell creatures apart ("…Captain", "…Archer"), and the number or letter most.
  const [, base, suffix] = /^(.+?)((?: (?:\d+|[A-Z]))?)$/.exec(name) as unknown as [
    string,
    string,
    string,
  ];
  const words = base.split(" ");
  for (let i = 1; i < words.length; i++) {
    const rest = `…${words.slice(i).join(" ")}${suffix}`;
    if (textWidth(rest) <= max) return rest;
  }
  const left = max - textWidth(suffix);
  return suffix !== "" && left >= 2 ? `${cut(base, left)}${suffix}` : cut(name, max);
}

/** The name in `max` columns with its count; a squad's count is never cut. */
function label(c: Combatant, max: number): string {
  const count = c.count === undefined ? "" : ` x${c.count}`;
  return `${shorten(c.name, Math.max(1, max - count.length))}${count}`;
}
const numbers = (c: Combatant) => `${c.stamina}/${c.max}`;
const healthText = (c: Combatant) =>
  c.health === "dying" && c.deadAt !== undefined ? `dying (dead at ${c.deadAt})` : c.health;

/** Filled cells: none at 0 or below, at least one while any Stamina is left. */
function filled(c: Combatant): number {
  if (c.stamina <= 0 || c.max <= 0) return 0;
  return Math.min(METER, Math.max(1, Math.round((c.stamina / c.max) * METER)));
}

function marker(c: Combatant): Segment {
  if (c.acting) return { text: "▶ ", tone: "acting" };
  return c.acted ? { text: "✓ ", tone: "dim" } : { text: "· ", tone: "dim" };
}

/** The head carries the health word, so no cut ever leaves winded or dying to colour alone. */
function cellOf(c: Combatant, combat: boolean, nameWidth: number, numberWidth: number): Cell {
  const health: Tone = c.health ?? "healthy";
  const name = label(c, nameWidth);
  const n = filled(c);
  const said = healthText(c);
  const head: Segment[] = [
    ...(combat ? [marker(c)] : []),
    { text: name, tone: c.health === "dead" ? "dead" : c.side, ...(c.mine ? { mine: true } : {}) },
    { text: " ".repeat(Math.max(0, nameWidth - textWidth(name)) + 1), tone: "text" },
    { text: `▐${"█".repeat(n)}${"░".repeat(METER - n)}▌`, tone: health },
    { text: ` ${numbers(c).padStart(numberWidth)}`, tone: "text" },
    ...(c.temp > 0 ? [{ text: ` +${c.temp}`, tone: "temp" as const }] : []),
    ...(said ? [SEPARATOR, { text: said, tone: health }] : []),
  ];
  const details: Segment[] = [
    ...c.conditions.map((text) => ({ text, tone: "text" as const })),
    ...(c.resource ? [{ text: c.resource, tone: c.side }] : []),
    ...(c.recoveries
      ? [{ text: `recoveries ${c.recoveries.left}/${c.recoveries.max}`, tone: "text" as const }]
      : []),
    ...(c.surges
      ? [{ text: `${c.surges} surge${c.surges === 1 ? "" : "s"}`, tone: "text" as const }]
      : []),
  ];
  return { head, details, indent: (combat ? 2 : 0) + nameWidth + 1 };
}

/** The cell on one line: head, then the details after ` · `. */
function flat(cell: Cell): Line {
  return [...cell.head, ...cell.details.flatMap((d) => [SEPARATOR, d])];
}

/** The cell on one line of `width`: the head whole, then the details that fit, then `…` if any didn't. */
function fit(cell: Cell, width: number): Line {
  const whole = flat(cell);
  if (widthOf(whole) <= width) return whole;
  const line: Segment[] = [...cell.head];
  for (const d of cell.details) {
    if (widthOf(line) + widthOf([SEPARATOR, d]) + 2 > width) break;
    line.push(SEPARATOR, d);
  }
  return truncate([...line, { text: " …", tone: "dim" }], width);
}

/**
 * The cell in as many lines of `width` as it needs: details that don't fit move to the next line,
 * indented under the meter, so a long row wraps instead of losing its tail.
 */
function wrap(cell: Cell, width: number): ReadonlyArray<Line> {
  const lines: Segment[][] = [[...cell.head]];
  for (const d of cell.details) {
    const current = lines.at(-1) ?? [];
    if (widthOf(current) + widthOf([SEPARATOR, d]) <= width) current.push(SEPARATOR, d);
    else lines.push([{ text: " ".repeat(cell.indent), tone: "text" }, d]);
  }
  return lines.map((l) => truncate(l, width));
}

/**
 * Rows in turn order, left to right: two cells share a row when both fit half the width, and any
 * other cell takes the whole row, as the lines `whole` gives it.
 */
function pack(
  lines: ReadonlyArray<Line>,
  column: number,
  whole: (i: number) => ReadonlyArray<Line>,
): ReadonlyArray<Line> {
  const half = (i: number) =>
    column >= MIN_COLUMN && i < lines.length && widthOf(lines[i]!) <= column;
  const rows: Line[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (half(i) && half(i + 1)) rows.push([...pad(lines[i]!, column + GAP), ...lines[++i]!]);
    else rows.push(...whole(i));
  }
  return rows;
}

/** Who stays when not everyone fits: the one acting, then the seat's own, then the living. */
function keep(combatants: ReadonlyArray<Combatant>, room: number): ReadonlyArray<number> {
  const rank = (c: Combatant) => (c.acting ? 0 : c.mine ? 1 : c.health === "dead" ? 3 : 2);
  return combatants
    .map((c, i) => i)
    .sort((a, b) => rank(combatants[a]!) - rank(combatants[b]!) || a - b)
    .slice(0, room)
    .sort((a, b) => a - b);
}

function titleOf(view: CombatView): string {
  const victories = view.victories === undefined ? "" : ` · victories ${view.victories}`;
  if (!view.active) return ` party · hero tokens ${view.heroTokens}${victories} `;
  const next = view.next === undefined ? "" : ` · ${view.next} next`;
  return ` round ${view.round}${next} · Malice ${view.malice} · hero tokens ${view.heroTokens}${victories} `;
}

/**
 * Cells for `shown` with one name width, so every meter starts in the same column. The width is
 * the longest name (up to NAME_MAX), narrowed until each head fits the columns `room` gives its
 * cell, leaving space for a ` …` when it has details that may be cut.
 */
function cellsOf(
  shown: ReadonlyArray<Combatant>,
  combat: boolean,
  room: (c: Combatant) => number,
): ReadonlyArray<Cell> {
  const numberWidth = Math.max(0, ...shown.map((c) => numbers(c).length));
  const natural = Math.max(0, ...shown.map((c) => textWidth(label(c, NAME_MAX))));
  const bare = shown.map((c) => cellOf(c, combat, 0, numberWidth));
  const fits = shown.map(
    (c, i) => room(c) - (bare[i]!.details.length > 0 ? 2 : 0) - (widthOf(bare[i]!.head) - 1),
  );
  const nameWidth = Math.max(NAME_MIN, Math.min(natural, ...fits));
  return shown.map((c) => cellOf(c, combat, nameWidth, numberWidth));
}

/** The dead creatures, folded into one line: "dead: Bandit Cutpurse A, Bandit Slinger A". */
const fallenLine = (fallen: ReadonlyArray<Combatant>, width: number): Line =>
  truncate(
    [
      { text: "dead: ", tone: "dim" },
      { text: fallen.map((c) => c.name).join(", "), tone: "dead" },
    ],
    width,
  );

/**
 * Lays the band out in `width` columns and at most `rows` lines, giving up the least first: short
 * rows always pair up and long ones wrap; then creatures' names shorten so they pair up too while
 * heroes keep whole rows; then long rows drop their last details for `…`; and when even that
 * overflows, every cell is fitted to half the width and whoever still doesn't fit is counted in
 * `more`. Dead creatures fold into one `dead:` line at the end, the first thing to go. Outside
 * combat only the heroes show, without turn markers.
 */
export function bandLayout(view: CombatView, width: number, rows: number): BandLayout {
  const title = titleOf(view);
  const all = view.active ? view.combatants : view.combatants.filter((c) => c.side === "heroes");
  const fallen = all.filter((c) => c.side === "director" && c.health === "dead");
  const shown = all.filter((c) => !fallen.includes(c));
  const room = Math.max(1, rows);
  const column = Math.floor((width - GAP) / 2);
  const halves = column >= MIN_COLUMN;
  const tail = fallen.length === 0 ? [] : [fallenLine(fallen, width)];

  const full = cellsOf(shown, view.active, () => width);
  const mixed = cellsOf(shown, view.active, (c) =>
    halves && c.side === "director" ? column : width,
  );
  const attempts: ReadonlyArray<() => ReadonlyArray<Line>> = [
    () => pack(full.map(flat), column, (i) => wrap(full[i]!, width)),
    () =>
      pack(
        mixed.map((cell, i) => (shown[i]!.side === "director" ? fit(cell, column) : flat(cell))),
        column,
        (i) => wrap(mixed[i]!, width),
      ),
    () => pack(full.map(flat), column, (i) => [fit(full[i]!, width)]),
    () =>
      pack(
        mixed.map((cell, i) => (shown[i]!.side === "director" ? fit(cell, column) : flat(cell))),
        column,
        (i) => [fit(mixed[i]!, width)],
      ),
  ];
  for (const attempt of attempts) {
    const lines = [...attempt(), ...tail];
    if (lines.length <= room) return { title, lines, more: 0 };
  }

  const fitTo = halves ? column : width;
  const narrow = cellsOf(shown, view.active, () => fitTo);
  const kept = keep(shown, halves ? room * 2 : room).map((i) => fit(narrow[i]!, fitTo));
  const lines = pack(kept, column, (i) => [kept[i]!]);
  if (lines.length < room && tail.length > 0)
    return { title, lines: [...lines, ...tail], more: shown.length - kept.length };
  return { title, lines, more: shown.length - kept.length + fallen.length };
}
