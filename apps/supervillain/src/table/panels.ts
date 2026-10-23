/**
 * The table's panels, which each seat shows or hides for itself, btop style: Alt+1 to Alt+4 in
 * screen order, and Alt+5 for the GM's prep panel, each panel's title leading with its number.
 * `/view` words are presets over the same state. Pure data, nothing logged and nothing kept past
 * the seat: the App holds it in a signal, a key goes through `togglePanel` and a `/view` word
 * through `viewPreset`.
 */
import type { Layout } from "./input.ts";

/**
 * The panels in screen order, top to bottom: the band, the map, the feed, the reply pane, and the
 * prep panel, which only the GM's seat has.
 */
export const PANELS = ["band", "map", "feed", "reply", "prep"] as const;

export type Panel = (typeof PANELS)[number];

/** What a seat shows. `mapFirst` is `/view map`: the band folds so the map gets the rows. */
export interface Panels {
  readonly band: boolean;
  readonly map: boolean;
  readonly feed: boolean;
  /** The reply pane (a `/sheet`, `/help`): hidden, an open reply waits on one line instead. */
  readonly reply: boolean;
  /** The GM's prep panel: hidden until Alt+5 or `/prep` opens it. */
  readonly prep: boolean;
  readonly mapFirst: boolean;
}

/**
 * Every panel shown, sharing the screen: how a seat starts, and `/view both`. The prep panel is
 * the GM's to open, and no layout word opens or closes it.
 */
export const ALL_SHOWN: Panels = {
  band: true,
  map: true,
  feed: true,
  reply: true,
  prep: false,
  mapFirst: false,
};

/** A panel's key number, 1 for the band through 5 for the prep panel. */
export const panelNumber = (panel: Panel): number => PANELS.indexOf(panel) + 1;

/** Alt+N's panel, or undefined for a number no panel has. */
export const panelOf = (n: number): Panel | undefined => PANELS[n - 1];

/** The panels a seat has: every one on the GM's (`prep`), all but the prep panel on a player's. */
export const panelsOf = (prep: boolean): ReadonlyArray<Panel> =>
  prep ? PANELS : PANELS.filter((p) => p !== "prep");

/** The keys, as the hint row and the all-hidden line say them: `Alt+1-4`, or the GM's `Alt+1-5`. */
export const panelKeys = (prep: boolean): string => `Alt+1-${panelsOf(prep).length}`;

/** Superscript digits, as btop marks its boxes: one column each, and never mistaken for a count. */
const SUPERSCRIPT = ["⁰", "¹", "²", "³", "⁴", "⁵", "⁶", "⁷", "⁸", "⁹"];

/** A panel's mark in its border title: `³` for the feed. */
export const panelMark = (panel: Panel): string => SUPERSCRIPT[panelNumber(panel)]!;

/** A border title with the panel's mark leading it: ` feed ` becomes ` ³ feed `. */
export const marked = (title: string, mark: string | undefined): string =>
  mark === undefined || mark === "" ? title : ` ${mark} ${title.trimStart()}`;

/**
 * A marked border title that the border can draw in `width` columns: the first of `titles`
 * (longest first) that fits, marked. OpenTUI draws a title only when it is at least four columns
 * narrower than its box, else none at all, so the mark must not push a title that fit out of view.
 */
export function fittedTitle(
  titles: ReadonlyArray<string>,
  mark: string | undefined,
  width: number,
): string {
  const all = titles.map((t) => marked(t, mark));
  return all.find((t) => Bun.stringWidth(t) + 4 <= width) ?? all.at(-1)!;
}

/**
 * Alt+N shows or hides one panel, by what the seat sees. The map and an open reply take turns (a
 * reply pane puts the map away while it's open), so showing the map hides an open reply, which
 * Alt+4 brings back, and showing the reply hides the map until it closes.
 */
export function togglePanel(p: Panels, panel: Panel, replyOpen: boolean): Panels {
  switch (panel) {
    case "map": {
      const shown = p.map && !(replyOpen && p.reply);
      return shown ? { ...p, map: false } : { ...p, map: true, reply: replyOpen ? false : p.reply };
    }
    default:
      return { ...p, [panel]: !p[panel] };
  }
}

/**
 * `/view` as a preset. `both`, `map` and `feed` set every panel but the prep panel: all shown,
 * `map` with the map first, `feed` with the map hidden. Plain `/view` only shows or hides the map,
 * sharing the rows when it shows it.
 */
export function viewPreset(p: Panels, layout: Layout | "toggle"): Panels {
  switch (layout) {
    case "toggle":
      return p.map ? { ...p, map: false } : { ...p, map: true, mapFirst: false };
    case "both":
      return { ...ALL_SHOWN, prep: p.prep };
    case "map":
      return { ...ALL_SHOWN, prep: p.prep, mapFirst: true };
    case "feed":
      return { ...ALL_SHOWN, prep: p.prep, map: false };
  }
}

/** A piece of a line that may show a panel when clicked. */
export interface PanelPiece {
  readonly text: string;
  readonly panel?: Panel;
}

/**
 * The one line said when every panel is hidden: the keys for those that would show something
 * (`available`), longest first that fits `width` columns, so the way back is always on screen.
 * In pieces: each panel's own key (`Alt+2 map`) is one, which a click shows.
 */
export function allHiddenParts(
  available: ReadonlyArray<Panel>,
  width: number,
  keysSaid: string = panelKeys(false),
): ReadonlyArray<PanelPiece> {
  const keys = available.flatMap((p, i): PanelPiece[] => [
    ...(i > 0 ? [{ text: " · " }] : []),
    { text: `Alt+${panelNumber(p)} ${p}`, panel: p },
  ]);
  const lines: ReadonlyArray<ReadonlyArray<PanelPiece>> = [
    [{ text: "every panel is hidden · " }, ...keys, { text: " · /view both shows them all" }],
    [{ text: "every panel is hidden · " }, ...keys],
    [{ text: `every panel is hidden · ${keysSaid} or /view both` }],
    [{ text: `panels hidden · ${keysSaid}` }],
  ];
  const widthOf = (line: ReadonlyArray<PanelPiece>) =>
    Bun.stringWidth(line.map((p) => p.text).join(""));
  return lines.find((l) => widthOf(l) <= width) ?? lines.at(-1)!;
}

/**
 * The panels a seat has hidden that would show something now (`available`), in screen order: what
 * the hint row offers to show again, with the mouse. A map put away by an open reply isn't hidden.
 */
export const hiddenPanels = (p: Panels, available: ReadonlyArray<Panel>): ReadonlyArray<Panel> =>
  PANELS.filter((panel) => available.includes(panel) && !p[panel]);

/** How the hint row offers a hidden panel: its mark and name, `² map`. */
export const shownAgainText = (panel: Panel): string => `${panelMark(panel)} ${panel}`;
