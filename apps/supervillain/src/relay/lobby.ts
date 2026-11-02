// The lobby's screen: what a player with a key and no room sees on their terminal, drawn as one
// frame of text with ANSI colours, since the relay renders nothing and keeps no renderer. A big
// title in MEKMODE Text between a hero and a villain from MEKMODE Dings, then framed panes in the
// table's style: the open tables that know the player's key, numbered, with the pick marked, and
// who the relay takes them for. Everything shown is what the relay knows: the room's name, how many
// are seated there, the key and the terminal. server.ts redraws it on each key and resize.
import { DINGS_ATLAS } from "../table/atlas/dings.ts";
import { TEXT_ATLAS } from "../table/atlas/text.ts";
import { color } from "../table/theme.ts";

/** An open table that knows a player's key, as the lobby lists it. */
export interface LobbyTable {
  readonly room: string;
  readonly seated: number;
}

/** Everything one frame of the lobby shows. */
export interface LobbyScreen {
  readonly tables: ReadonlyArray<LobbyTable>;
  /** The table Enter sits at, by its place in `tables`. */
  readonly picked: number;
  /** A number typed at the prompt, not yet entered. */
  readonly typed: string;
  /** A line for the player above the hints: `There's no 7 on the list.` */
  readonly said?: string | undefined;
  readonly you: {
    readonly fingerprint: string;
    readonly algorithm: string;
    readonly term: string;
  };
}

interface Seg {
  readonly text: string;
  readonly fg?: string;
  readonly bg?: string;
  readonly bold?: boolean;
}
type Row = ReadonlyArray<Seg>;

const FAINT = "#3a3f4b";
const SHADOW = "#2a2d33";

const width = (s: string) => Bun.stringWidth(s);
const rowWidth = (r: Row) => r.reduce((n, s) => n + width(s.text), 0);
const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - width(s)));
const padRow = (r: Row, n: number): Row => [
  ...r,
  { text: " ".repeat(Math.max(0, n - rowWidth(r))) },
];
const centred = (r: Row, n: number): Row => [
  { text: " ".repeat(Math.max(0, Math.floor((n - rowWidth(r)) / 2))) },
  ...r,
];
const cut = (s: string, n: number) =>
  width(s) <= n ? s : `${[...s].slice(0, Math.max(0, n - 1)).join("")}…`;

// ---- The title: MEKMODE glyphs, in half blocks (square pixels) or quadrants (half as wide) ----

type Pixels = ReadonlyArray<ReadonlyArray<string | undefined>>;

/** A glyph's 8 by 12 pixels, a row a byte in hex. */
const bits = (hex: string | undefined): boolean[][] =>
  Array.from({ length: 12 }, (_, y) => {
    const byte = Number.parseInt(hex?.slice(y * 2, y * 2 + 2) || "00", 16);
    return Array.from({ length: 8 }, (_, x) => (byte & (0x80 >> x)) !== 0);
  });

/** A word in MEKMODE Text, cropped to its capitals' rows and columns, with a drop shadow. */
function wordPixels(word: string, gap: number, fg: string): Pixels {
  const letters = [...word].map((ch) =>
    bits(TEXT_ATLAS[ch])
      .slice(2, 10)
      .map((r) => r.slice(1, 7)),
  );
  const w = letters.length * 6 + (letters.length - 1) * gap;
  const grid: (string | undefined)[][] = Array.from({ length: 9 }, () =>
    Array(w + 1).fill(undefined),
  );
  letters.forEach((rows, i) =>
    rows.forEach((r, y) =>
      r.forEach((on, x) => {
        if (on) grid[y]![i * (6 + gap) + x] = fg;
      }),
    ),
  );
  for (let y = 7; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--)
      if (grid[y]![x] === fg && grid[y + 1]![x + 1] === undefined) grid[y + 1]![x + 1] = SHADOW;
  return grid;
}

const figurePixels = (ch: string, fg: string): Pixels =>
  bits(DINGS_ATLAS[ch]).map((r) => r.map((on) => (on ? fg : undefined)));

/** Each cell a pixel wide and two tall, so pixels stay square. */
function halfBlocks(p: Pixels): Row[] {
  const rows: Row[] = [];
  for (let y = 0; y < p.length; y += 2) {
    const row: Seg[] = [];
    for (let x = 0; x < p[y]!.length; x++) {
      const top = p[y]![x];
      const bottom = p[y + 1]?.[x];
      if (top === undefined && bottom === undefined) row.push({ text: " " });
      else if (bottom === undefined) row.push({ text: "▀", fg: top! });
      else if (top === undefined) row.push({ text: "▄", fg: bottom });
      else if (top === bottom) row.push({ text: "█", fg: top });
      else row.push({ text: "▀", fg: top, bg: bottom });
    }
    rows.push(row);
  }
  return rows;
}

const QUADRANTS = " ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█";
/** Each cell two pixels by two, for a narrower terminal; the shadow is left out. */
function quadrants(p: Pixels): Row[] {
  const rows: Row[] = [];
  for (let y = 0; y < p.length; y += 2) {
    const row: Seg[] = [];
    for (let x = 0; x < p[y]!.length; x += 2) {
      const px = [p[y]![x], p[y]![x + 1], p[y + 1]?.[x], p[y + 1]?.[x + 1]];
      const lit = px.map((c) => c !== undefined && c !== SHADOW);
      const index = lit.reduce((n, on, i) => n + (on ? 1 << i : 0), 0);
      const fg = px.find((c) => c !== undefined && c !== SHADOW);
      row.push(fg === undefined ? { text: QUADRANTS[index]! } : { text: QUADRANTS[index]!, fg });
    }
    rows.push(row);
  }
  return rows;
}

/** Blocks side by side, their bottoms aligned. */
function beside(blocks: ReadonlyArray<Row[]>, gap: number): Row[] {
  const h = Math.max(...blocks.map((b) => b.length));
  const widths = blocks.map((b) => Math.max(...b.map(rowWidth)));
  return Array.from({ length: h }, (_, y) =>
    blocks.flatMap((b, i) => [
      ...padRow(b[y - (h - b.length)] ?? [], widths[i]!),
      ...(i < blocks.length - 1 ? [{ text: " ".repeat(gap) }] : []),
    ]),
  );
}

/** The title for `w` columns: the word between a hero and a villain, the word alone, or smaller. */
function title(w: number): Row[] {
  const word = wordPixels("SUPERVILLAIN", 2, color.bright);
  if (w >= 118)
    return beside(
      [
        halfBlocks(figurePixels("&", color.heroes)),
        halfBlocks(word),
        halfBlocks(figurePixels('"', color.director)),
      ],
      4,
    );
  if (w >= 96) return halfBlocks(word);
  if (w >= 50) return quadrants(word);
  return [[{ text: "supervillain", fg: color.brand, bold: true }]];
}

// ---- The panes, as the table frames its panels: a numbered title in the top border ----

function framed(head: Row, body: ReadonlyArray<Row>, w: number, h: number): Row[] {
  const inner = w - 2;
  const rows: Row[] = [
    [
      { text: "┌─ ", fg: color.border },
      ...head,
      { text: ` ${"─".repeat(Math.max(0, inner - rowWidth(head) - 3))}┐`, fg: color.border },
    ],
  ];
  for (let i = 0; i < h - 2; i++)
    rows.push([
      { text: "│", fg: color.border },
      ...padRow([{ text: " " }, ...(body[i] ?? [])], inner),
      { text: "│", fg: color.border },
    ]);
  rows.push([{ text: `└${"─".repeat(inner)}┘`, fg: color.border }]);
  return rows;
}

const paneTitle = (mark: string, label: string): Row => [
  { text: `${mark} `, fg: color.dim },
  { text: label, fg: color.bright },
];

function tableRows(screen: LobbyScreen, w: number): Row[] {
  const digits = String(screen.tables.length).length;
  return screen.tables.map((t, i): Row => {
    const on = i === screen.picked;
    const seated = `${t.seated > 0 ? "●" : "○"} ${t.seated}`;
    return [
      { text: on ? "▌" : " ", fg: color.brand },
      { text: ` ${String(i + 1).padStart(digits)}  `, fg: color.dim },
      {
        text: pad(cut(t.room, w - digits - 5 - width(seated)), w - digits - 4 - width(seated)),
        fg: on ? color.bright : color.text,
        bold: on,
      },
      { text: seated, fg: t.seated > 0 ? color.healthy : FAINT },
    ];
  });
}

function youRows(screen: LobbyScreen, w: number): Row[] {
  const label = (s: string): Seg => ({ text: pad(s, 10), fg: color.dim });
  const words = (text: string, fg: string): Row[] => {
    const lines: Row[] = [];
    let line = "";
    for (const word of text.split(" ")) {
      if (line !== "" && width(line) + 1 + width(word) > w) {
        lines.push([{ text: line, fg }]);
        line = word;
      } else line = line === "" ? word : `${line} ${word}`;
    }
    if (line !== "") lines.push([{ text: line, fg }]);
    return lines;
  };
  return [
    ...words("There's no account: your ssh key is who you are.", color.text),
    [],
    [label("key"), { text: cut(screen.you.algorithm, w - 10), fg: color.dim }],
    [{ text: cut(screen.you.fingerprint, w), fg: color.bright }],
    [label("terminal"), { text: cut(screen.you.term, w - 10), fg: color.dim }],
    [],
    ...words(
      "These tables know your key: the relay asked each open one, without telling it who you are.",
      color.dim,
    ),
  ];
}

// ---- The frame ----

const PANE_ROWS = 12;

/** The rows and where the cursor goes: the prompt's end. */
function layout(screen: LobbyScreen, cols: number, rows: number) {
  const w = Math.max(20, Math.min(cols - 2, 124));
  const n = screen.tables.length;
  const out: Row[] = [];
  const art = title(w);
  const tag: Row = [
    { text: "a virtual tabletop you reach with ssh", fg: color.text },
    { text: "  ·  ", fg: FAINT },
    {
      text: `${n} open table${n === 1 ? "" : "s"} know${n === 1 ? "s" : ""} your key`,
      fg: color.dim,
    },
  ];
  const listH = Math.max(PANE_ROWS, n + 2);
  // The rows below the title: a gap, the tagline, a gap, the panes, the said line, hints, prompt.
  const below = 3 + listH + 3;
  const showArt = art.length + below <= rows;
  for (const r of showArt ? art : title(0)) out.push(centred(r, w));
  out.push([]);
  out.push(rowWidth(tag) <= w ? centred(tag, w) : centred(tag.slice(0, 1), w));
  out.push([]);

  const leftW = w >= 76 ? 34 : w;
  const left = framed(paneTitle("¹", "tables"), tableRows(screen, leftW - 4), leftW, listH);
  if (leftW === w) out.push(...left);
  else {
    const rightW = w - leftW - 1;
    const right = framed(paneTitle("²", "you"), youRows(screen, rightW - 4), rightW, listH);
    for (let i = 0; i < listH; i++) out.push([...left[i]!, { text: " " }, ...right[i]!]);
  }
  out.push(screen.said === undefined ? [] : [{ text: ` › ${screen.said}`, fg: color.notice }]);
  const key = (k: string, what: string, last = false): Seg[] => [
    { text: k, fg: color.bright },
    { text: ` ${what}`, fg: color.dim },
    ...(last ? [] : [{ text: " · ", fg: FAINT }]),
  ];
  const hints: Row = [
    { text: " " },
    ...key("↑↓", "pick"),
    ...(n > 1 ? key(`1-${n}`, "by number") : []),
    ...key("Enter", "sits you down"),
    ...key("Ctrl-C", "leaves", true),
  ];
  out.push(rowWidth(hints) <= w ? hints : [{ text: " Enter sits you down", fg: color.dim }]);
  const prompt: Row = [{ text: " > ", fg: color.brand, bold: true }];
  out.push(
    screen.typed === ""
      ? [
          ...prompt,
          {
            text: cut(`Enter sits you at ${screen.tables[screen.picked]?.room ?? ""}`, w - 4),
            fg: color.dim,
          },
        ]
      : [...prompt, { text: screen.typed, fg: color.bright }],
  );
  const left0 = Math.max(0, Math.floor((cols - w) / 2));
  return {
    rows: out,
    left: left0,
    cursor: { row: out.length, col: left0 + 3 + width(screen.typed) },
  };
}

const rgb = (hex: string) =>
  [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(";");

/** A row as ANSI: each segment in its colours, bold where it is, then reset. */
const ansi = (r: Row): string =>
  r
    .map((s) => {
      const codes = [
        ...(s.bold ? ["1"] : []),
        ...(s.fg === undefined ? [] : [`38;2;${rgb(s.fg)}`]),
        ...(s.bg === undefined ? [] : [`48;2;${rgb(s.bg)}`]),
      ];
      return codes.length === 0 ? s.text : `\x1b[${codes.join(";")}m${s.text}\x1b[0m`;
    })
    .join("");

/**
 * The lobby as one frame for a `cols` by `rows` terminal: the screen cleared, every row from the
 * top, centred, and the cursor left at the prompt. The title gives way to a line when the rows
 * are too few for it.
 */
export function lobbyFrame(screen: LobbyScreen, cols: number, rows: number): string {
  const { rows: lines, left, cursor } = layout(screen, cols, rows);
  const margin = " ".repeat(left);
  return `\x1b[H\x1b[2J${lines.map((r) => margin + ansi(r)).join("\r\n")}\x1b[${cursor.row};${cursor.col + 1}H`;
}
