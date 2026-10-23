/**
 * The GM's prep panel as pure data: its sections laid out in rows of pieces, each item with the
 * command it sends said dim beside it (it teaches typing), and the count a monster opens. The rules
 * project the items and their lines (`PrepView`); this lays them out and turns a click into what it
 * does. The panel never changes state itself: a click sends a line, as typing would, or puts one on
 * the input line for the GM to finish.
 */
import type { PrepItem, PrepView } from "./view.ts";

/** An item by where it is: its section and its place in it. */
export interface PrepAt {
  readonly section: number;
  readonly index: number;
}

/** A monster clicked, and how many of it the GM is about to add. */
export interface PrepCount extends PrepAt {
  readonly n: number;
}

/** What a piece of the panel does when clicked. */
export type PrepAction =
  | ({ readonly kind: "item" } & PrepAt)
  | { readonly kind: "less" }
  | { readonly kind: "more" }
  | { readonly kind: "add" }
  | { readonly kind: "cancel" };

/** How a piece is drawn. */
export type PrepTone = "title" | "item" | "active" | "button" | "note" | "plain";

/** One piece of a row: a section's title, an item, a button of the count, or words. */
export interface PrepPiece {
  readonly text: string;
  readonly tone: PrepTone;
  /** Dim, after the text: the command line a click sends or fills. */
  readonly command?: string;
  /** After that and ` · `, in the note colour: `in play`, `loaded`. */
  readonly note?: string;
  readonly action?: PrepAction;
}

/** The line a count item sends for `n`: `/add bandit` for one, `/add bandit x3` for more. */
export const countLine = (item: PrepItem, n: number): string =>
  n <= 1 ? item.line : `${item.line} x${n}`;

/**
 * What an item shows it sends: its line, `/add bandit xN` for a count, `/place vex <square>` for a
 * place, and a fill's line with `…` where the GM goes on typing.
 */
export function itemCommand(item: PrepItem): string {
  switch (item.kind) {
    case "send":
      return item.line;
    case "fill":
      return `${item.line.trimEnd()} …`;
    case "count":
      return `${item.line} xN`;
    case "place":
      return `${item.line} <square>`;
  }
}

/** The columns a piece takes: its text, its command after a space, and its note after ` · `. */
export const pieceWidth = (p: PrepPiece): number =>
  Bun.stringWidth(p.text) +
  (p.command === undefined ? 0 : 1 + Bun.stringWidth(p.command)) +
  (p.note === undefined ? 0 : 3 + Bun.stringWidth(p.note));

/** Between two items on a row. */
const GAP = "  ";

/** An item's label is drawn as a button, a space either side. */
const button = (label: string) => ` ${label} `;

/**
 * The panel's rows in `width` columns: each section's title in a column of its own, its items
 * after it, wrapping under the first where a row is full, then its note. A clicked monster's count
 * gets a row under its section: `−`, the count, `+`, Add (with the line it sends) and Cancel. The
 * item a Place is waiting on (`placing`, by token id) or that a count is for is drawn active.
 */
export function prepRows(
  view: PrepView,
  width: number,
  count?: PrepCount,
  placing?: string,
): ReadonlyArray<ReadonlyArray<PrepPiece>> {
  const titleWidth = Math.max(0, ...view.sections.map((s) => Bun.stringWidth(s.title))) + 1;
  const indent: PrepPiece = { text: " ".repeat(titleWidth), tone: "plain" };
  const rows: PrepPiece[][] = [];
  for (const [section, s] of view.sections.entries()) {
    let row: PrepPiece[] = [{ text: s.title.padEnd(titleWidth), tone: "title" }];
    let used = titleWidth;
    let first = true;
    const put = (piece: PrepPiece) => {
      const w = pieceWidth(piece);
      if (!first && used + GAP.length + w > width) {
        rows.push(row);
        row = [indent];
        used = titleWidth;
        first = true;
      }
      if (!first) row.push({ text: GAP, tone: "plain" });
      row.push(piece);
      used += (first ? 0 : GAP.length) + w;
      first = false;
    };
    for (const [index, item] of s.items.entries()) {
      const active =
        (count?.section === section && count.index === index) ||
        (placing !== undefined && item.kind === "place" && item.id === placing);
      put({
        text: button(item.label),
        tone: active ? "active" : "item",
        command: itemCommand(item),
        ...(item.note !== undefined && { note: item.note }),
        action: { kind: "item", section, index },
      });
    }
    if (s.note !== undefined) put({ text: s.note, tone: "note" });
    rows.push(row);
    const counted = count?.section === section ? s.items[count.index] : undefined;
    if (counted !== undefined && count !== undefined)
      rows.push([
        indent,
        // Under the items' labels, which their buttons' first space puts a column in.
        { text: ` ${counted.label}:`, tone: "plain" },
        { text: " ", tone: "plain" },
        { text: button("−"), tone: "button", action: { kind: "less" } },
        { text: ` ${count.n} `, tone: "plain" },
        { text: button("+"), tone: "button", action: { kind: "more" } },
        { text: GAP, tone: "plain" },
        {
          text: button("Add"),
          tone: "button",
          command: countLine(counted, count.n),
          action: { kind: "add" },
        },
        { text: GAP, tone: "plain" },
        { text: button("Cancel"), tone: "button", action: { kind: "cancel" } },
      ]);
  }
  return rows;
}

/** The item at `at`, if the view still has it. */
export const itemAt = (view: PrepView | undefined, at: PrepAt): PrepItem | undefined =>
  view?.sections[at.section]?.items[at.index];

/** What a click on a piece comes to, given the count open: a line to send, one to fill, a count. */
export type PrepOutcome =
  | { readonly kind: "send"; readonly line: string }
  | { readonly kind: "fill"; readonly line: string }
  /** Open, change or close the count (undefined closes it). */
  | { readonly kind: "count"; readonly count: PrepCount | undefined }
  /** Wait for a square for this token, with the line its Place sends. */
  | { readonly kind: "place"; readonly id: string; readonly line: string }
  | { readonly kind: "none" };

/**
 * What clicking `action` does. An item sends its line, fills it, opens its count (clicked again,
 * closes it) or waits for a square; the count's buttons step it between 1 and the item's most, Add
 * sends it, Cancel closes it.
 */
export function prepClick(
  view: PrepView | undefined,
  action: PrepAction,
  count: PrepCount | undefined,
): PrepOutcome {
  if (action.kind === "item") {
    const item = itemAt(view, action);
    if (item === undefined) return { kind: "none" };
    switch (item.kind) {
      case "send":
        return { kind: "send", line: item.line };
      case "fill":
        return { kind: "fill", line: item.line };
      case "place":
        return item.id === undefined
          ? { kind: "none" }
          : { kind: "place", id: item.id, line: item.line };
      case "count": {
        const same = count?.section === action.section && count.index === action.index;
        return {
          kind: "count",
          count: same ? undefined : { section: action.section, index: action.index, n: 1 },
        };
      }
    }
  }
  if (action.kind === "cancel") return { kind: "count", count: undefined };
  if (count === undefined) return { kind: "none" };
  const item = itemAt(view, count);
  if (item === undefined) return { kind: "count", count: undefined };
  const max = item.max ?? Number.POSITIVE_INFINITY;
  switch (action.kind) {
    case "less":
      return { kind: "count", count: { ...count, n: Math.max(1, count.n - 1) } };
    case "more":
      return { kind: "count", count: { ...count, n: Math.min(max, count.n + 1) } };
    case "add":
      return { kind: "send", line: countLine(item, count.n) };
  }
}
