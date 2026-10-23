/**
 * The mouse at the table, as pure data: what a click on the map or the band does, the menu a
 * selected token opens, and the panel titles a click hides. Every click that acts ends as the
 * command line typing would send (the rules project each choice's line, `TokenAction`), so the
 * log and the rules never know a mouse was there. Where on screen a click landed is the panes'
 * business (`squareAt`, `pictureSquareAt`, `whoAt`, each pane's own `boxClick`); this takes it from
 * there.
 */
import {
  type BoxRenderable,
  MouseButton,
  type MouseEvent,
  type ScrollAcceleration,
} from "@opentui/core";
import { actionLine } from "../game/actions.ts";
import type { TokenAction } from "./view.ts";

/** What a click landed on: a token (on the map or its row in the band), a square, or both. */
export interface Clicked {
  readonly token?: { readonly id: string; readonly mark: string | undefined };
  /** The square's name, `c5`; a band row has none. */
  readonly square?: string;
}

/** A token this seat may act for, selected, and the choice under way with what is clicked for it. */
export interface Selection {
  readonly id: string;
  readonly chosen?: TokenAction;
  /** The targets clicked so far for a choice that takes several, by id. */
  readonly picked: ReadonlyArray<string>;
}

export type ClickResult =
  /** Select this token: its menu opens. */
  | { readonly kind: "select"; readonly id: string }
  /** Close the menu. */
  | { readonly kind: "clear" }
  /** Send this line, as if typed, and close the menu. */
  | { readonly kind: "send"; readonly line: string }
  /** The targets clicked so far, after this click added or took one away. */
  | { readonly kind: "picked"; readonly picked: ReadonlyArray<string> }
  /** Type this at the input line's cursor. */
  | { readonly kind: "insert"; readonly text: string }
  | { readonly kind: "none" };

/**
 * What a click does. With a choice under way it gives the choice what it waits for: a square for
 * Move, a token for one target, and tokens for several, each click adding or taking back one.
 * With a menu open, a click on a token this seat may act for opens that one's menu instead, on the
 * same token closes it, and anywhere else closes it too. With nothing selected, a token this seat
 * may act for is selected; any other token's mark or a square's name is typed at the cursor.
 */
export function clickOutcome(
  selection: Selection | undefined,
  click: Clicked,
  mayAct: (id: string) => boolean,
): ClickResult {
  const { token, square } = click;
  const chosen = selection?.chosen;
  if (selection !== undefined && chosen !== undefined) {
    switch (chosen.pick) {
      case "square":
        return square === undefined
          ? { kind: "none" }
          : { kind: "send", line: actionLine(chosen, [square]) };
      case "target":
        return token === undefined
          ? { kind: "none" }
          : { kind: "send", line: actionLine(chosen, [token.id]) };
      case "targets": {
        if (token === undefined) return { kind: "none" };
        const has = selection.picked.includes(token.id);
        return {
          kind: "picked",
          picked: has
            ? selection.picked.filter((p) => p !== token.id)
            : [...selection.picked, token.id],
        };
      }
      case "none":
        return { kind: "none" };
    }
  }
  if (token !== undefined && mayAct(token.id))
    return token.id === selection?.id ? { kind: "clear" } : { kind: "select", id: token.id };
  if (selection !== undefined) return { kind: "clear" };
  const text = token === undefined ? square : (token.mark ?? token.id);
  return text === undefined ? { kind: "none" } : { kind: "insert", text };
}

/**
 * Whether a selection's menu still stands, given what the seat may do with its token now: it may
 * still act for it, and the choice under way is still offered (Move goes when the map unloads or
 * the token leaves it).
 */
export function menuStands(
  selection: Selection,
  actions: ReadonlyArray<TokenAction> | undefined,
): boolean {
  if (actions === undefined) return false;
  const chosen = selection.chosen;
  return (
    chosen === undefined ||
    actions.some(
      (a) => a.label === chosen.label && a.pick === chosen.pick && a.line === chosen.line,
    )
  );
}

/** Choosing from the menu: a choice that needs nothing clicked is sent; the others wait for it. */
export function choose(
  selection: Selection,
  action: TokenAction,
):
  | { readonly kind: "send"; readonly line: string }
  | { readonly kind: "chosen"; readonly selection: Selection } {
  return action.pick === "none"
    ? { kind: "send", line: action.line }
    : { kind: "chosen", selection: { id: selection.id, chosen: action, picked: [] } };
}

/** What the menu shows: a lead saying what is going on, and its items, Cancel last. */
export interface Menu {
  readonly lead: string;
  readonly items: ReadonlyArray<MenuItem>;
}

export type MenuItem =
  | { readonly kind: "action"; readonly label: string; readonly action: TokenAction }
  | { readonly kind: "roll"; readonly label: string; readonly line: string }
  | { readonly kind: "cancel"; readonly label: string };

const CANCEL: MenuItem = { kind: "cancel", label: "Cancel" };

/**
 * The menu for a selection: the token's choices, or, once one is chosen, what to click for it,
 * with Roll to send a choice that takes several targets (with none, it rolls without).
 * `name` and `mark` name tokens as the seat sees them.
 */
export function menuOf(
  selection: Selection,
  actions: ReadonlyArray<TokenAction>,
  name: (id: string) => string,
  mark: (id: string) => string,
): Menu {
  const who = name(selection.id);
  const chosen = selection.chosen;
  if (chosen === undefined)
    return {
      lead: `${who}:`,
      items: [
        ...actions.map((a): MenuItem => ({ kind: "action", label: a.label, action: a })),
        CANCEL,
      ],
    };
  const head = `${who} · ${chosen.label}:`;
  switch (chosen.pick) {
    case "square":
      return { lead: `${head} click a square`, items: [CANCEL] };
    case "target":
      return { lead: `${head} click a target`, items: [CANCEL] };
    default: {
      const on = selection.picked.map(mark).join(" ");
      return {
        lead: on === "" ? `${head} click targets, then Roll` : `${head} on ${on}`,
        items: [
          { kind: "roll", label: "Roll", line: actionLine(chosen, selection.picked) },
          CANCEL,
        ],
      };
    }
  }
}

/** One piece of a menu row: the lead's text, or an item (its index in the menu's items). */
export interface MenuPiece {
  readonly text: string;
  readonly item?: number;
}

/** An item is drawn with a space either side, as a button; pieces have a space between them. */
export const itemText = (label: string): string => ` ${label} `;

/**
 * The menu laid out in rows of `width` columns: the lead, then each item where it fits, on the
 * next row where it doesn't. An item wider than a row gets one to itself, cut by the row.
 */
export function menuRows(menu: Menu, width: number): ReadonlyArray<ReadonlyArray<MenuPiece>> {
  const rows: MenuPiece[][] = [[{ text: menu.lead }]];
  let used = Bun.stringWidth(menu.lead);
  for (const [i, item] of menu.items.entries()) {
    const text = itemText(item.label);
    const w = Bun.stringWidth(text);
    if (used > 0 && used + 1 + w > width) {
      rows.push([{ text, item: i }]);
      used = w;
      continue;
    }
    const row = rows.at(-1)!;
    if (used > 0) row.push({ text: " " });
    row.push({ text, item: i });
    used += (used > 0 ? 1 : 0) + w;
  }
  return rows;
}

/** Where OpenTUI draws a box's title: after the corner and one line of border. */
const TITLE_AT = 2;

/**
 * Whether a click at `col` on a bordered box's top row (counted from the box's left edge) lands on
 * its title. OpenTUI draws a left-aligned title from the third column, and only when the box is at
 * least four columns wider, so a title too wide to be drawn can't be clicked.
 */
export function onTitle(title: string, boxWidth: number, col: number): boolean {
  const w = Bun.stringWidth(title);
  return w > 0 && w + 4 <= boxWidth && col >= TITLE_AT && col < TITLE_AT + w;
}

/**
 * A bordered pane's left click, by where it lands in its box: on the top row's `title` it calls
 * `onTitleClick` (which hides the panel), and below it `inside` gets the column and row counted
 * from the box's corner, for the pane to take off its own frame and look up what is there.
 */
export const boxClick =
  (
    box: () => BoxRenderable | undefined,
    title: () => string,
    onTitleClick: (() => void) | undefined,
    inside?: (col: number, row: number) => void,
  ) =>
  (event: MouseEvent): void => {
    const b = box();
    if (event.button !== MouseButton.LEFT || b === undefined) return;
    const col = event.x - b.x;
    const row = event.y - b.y;
    if (row === 0) {
      if (onTitle(title(), b.width, col)) onTitleClick?.();
      return;
    }
    inside?.(col, row);
  };

/**
 * Lines one wheel event scrolls the feed or a reply. OpenTUI scrolls one, slow through a long
 * feed; PgUp and PgDn still move most of a page.
 */
export const WHEEL_LINES = 3;

/** A scroll box's wheel: WHEEL_LINES an event, however fast they come. */
export const wheel: ScrollAcceleration = { tick: () => WHEEL_LINES, reset: () => {} };
