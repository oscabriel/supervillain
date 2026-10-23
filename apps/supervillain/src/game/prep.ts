/**
 * The GM's prep panel, as the rules see it: what a game is prepared from (the campaign's heroes,
 * monsters and maps, which the host lists) and what the table already holds, laid out in sections
 * per ruleset, each item with the command line it sends. The table only shows these and fills in
 * what is clicked (a count, a square), so a click sends exactly what typing would, and whatever the
 * rules refuse is refused the same way. Nothing here changes state. Each ruleset lays out its own
 * sections (drawSteel/view.ts, setWorld/view.ts) from these shapes, and table.ts picks one.
 */
import { MAP_KINDS } from "./drawSteel/map.ts";

/** One file of the campaign's, as the prep panel lists it: its id and the name in it. */
export interface PrepEntry {
  readonly id: string;
  /** The sheet's or the map's own name, or the id when the file doesn't read. */
  readonly name: string;
}

/** What the campaign folder has to prepare a game from, as the host read it when the panel opened. */
export interface PrepCatalog {
  readonly heroes: ReadonlyArray<PrepEntry>;
  readonly monsters: ReadonlyArray<PrepEntry>;
  readonly maps: ReadonlyArray<PrepEntry>;
}

/**
 * What a click on an item does with its `line`: sends it (`send`), puts it on the input line for
 * the GM to finish (`fill`, for free text such as a fighter's name), opens a count to send it with
 * ` xN` (`count`, up to `max`), or waits for a square on the map to send it with (`place`, whose
 * `id` is the token's, as the mouse's Place choice).
 */
export type PrepKind = "send" | "fill" | "count" | "place";

export interface PrepItem {
  readonly kind: PrepKind;
  /** What the panel calls it: a hero's name, `New keep`, `Start combat`. */
  readonly label: string;
  /** The line it sends or fills: `/hero vex`, `/add bandit` (before its count), `/recruit `. */
  readonly line: string;
  /** Said beside it: `in play`, `loaded`, `2 in play`. */
  readonly note?: string;
  /** A `place` item's token id. */
  readonly id?: string;
  /** A `count` item's most at a time. */
  readonly max?: number;
}

export interface PrepSection {
  readonly title: string;
  readonly items: ReadonlyArray<PrepItem>;
  /** Said when there are no items, or after them: `load a map first`, `round 2`. */
  readonly note?: string;
}

/** The prep panel's sections, top to bottom. */
export interface PrepView {
  readonly sections: ReadonlyArray<PrepSection>;
}

/** The Maps section, either ruleset's: load one, put it away, or generate one. */
export function mapsSection(catalog: PrepCatalog, loaded: string | undefined): PrepSection {
  return {
    title: "Maps",
    items: [
      ...catalog.maps.map(
        (m): PrepItem => ({
          kind: "send",
          label: m.name,
          line: `/map ${m.id}`,
          ...(m.id === loaded && { note: "loaded" }),
        }),
      ),
      ...(loaded === undefined
        ? []
        : [{ kind: "send" as const, label: "Put away", line: "/map off" }]),
      ...MAP_KINDS.map(
        (k): PrepItem => ({ kind: "send", label: `New ${k}`, line: `/map new ${k}` }),
      ),
      { kind: "fill", label: "New, by seed", line: "/map new " },
    ],
  };
}

/** The Place section: who is not on the loaded map yet, each waiting for a square. */
export function placeSection(
  mapLoaded: boolean,
  unplaced: ReadonlyArray<{ readonly id: string; readonly name: string }>,
): PrepSection {
  if (!mapLoaded) return { title: "Place", items: [], note: "load a map first" };
  return {
    title: "Place",
    items: unplaced.map(
      (w): PrepItem => ({ kind: "place", label: w.name, line: `/place ${w.id}`, id: w.id }),
    ),
    ...(unplaced.length === 0 && { note: "everyone is on the map" }),
  };
}
