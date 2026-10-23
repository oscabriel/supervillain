/**
 * The table's panels, which each seat shows or hides for itself, btop style: Alt+1 to Alt+4 in
 * screen order, each panel's title leading with its number. `/view` words are presets over the
 * same state. Pure data, nothing logged and nothing kept past the seat: the App holds it in a
 * signal, a key goes through `togglePanel` and a `/view` word through `viewPreset`.
 */
import type { Layout } from "./input.ts";

/** The panels in screen order, top to bottom: the band, the map, the feed, the reply pane. */
export const PANELS = ["band", "map", "feed", "reply"] as const;

export type Panel = (typeof PANELS)[number];

/** What a seat shows. `mapFirst` is `/view map`: the band folds so the map gets the rows. */
export interface Panels {
  readonly band: boolean;
  readonly map: boolean;
  readonly feed: boolean;
  /** The reply pane (a `/sheet`, `/help`): hidden, an open reply waits on one line instead. */
  readonly reply: boolean;
  readonly mapFirst: boolean;
}

/** Every panel shown, sharing the screen: how a seat starts, and `/view both`. */
export const ALL_SHOWN: Panels = {
  band: true,
  map: true,
  feed: true,
  reply: true,
  mapFirst: false,
};

/** A panel's key number, 1 for the band through 4 for the reply pane. */
export const panelNumber = (panel: Panel): number => PANELS.indexOf(panel) + 1;

/** Alt+N's panel, or undefined for a number no panel has. */
export const panelOf = (n: number): Panel | undefined => PANELS[n - 1];

/** The keys, as the hint row and the all-hidden line say them. */
export const PANEL_KEYS = `Alt+1-${PANELS.length}`;

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
 * `/view` as a preset. `both`, `map` and `feed` set every panel: all shown, `map` with the map
 * first, `feed` with the map hidden. Plain `/view` only shows or hides the map, sharing the rows
 * when it shows it.
 */
export function viewPreset(p: Panels, layout: Layout | "toggle"): Panels {
  switch (layout) {
    case "toggle":
      return p.map ? { ...p, map: false } : { ...p, map: true, mapFirst: false };
    case "both":
      return ALL_SHOWN;
    case "map":
      return { ...ALL_SHOWN, mapFirst: true };
    case "feed":
      return { ...ALL_SHOWN, map: false };
  }
}

/**
 * The one line said when every panel is hidden: the keys for those that would show something
 * (`available`), longest first that fits `width` columns, so the way back is always on screen.
 */
export function allHiddenLine(available: ReadonlyArray<Panel>, width: number): string {
  const keys = available.map((p) => `Alt+${panelNumber(p)} ${p}`).join(" · ");
  const lines = [
    `every panel is hidden · ${keys} · /view both shows them all`,
    `every panel is hidden · ${keys}`,
    `every panel is hidden · ${PANEL_KEYS} or /view both`,
    `panels hidden · ${PANEL_KEYS}`,
  ];
  return lines.find((l) => Bun.stringWidth(l) <= width) ?? lines.at(-1)!;
}
