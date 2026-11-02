/**
 * The GM's prep panel, as the rules see it: what a game is prepared from (the campaign's heroes,
 * monsters and maps, which the host lists) and what the table already holds, laid out per ruleset,
 * each item with the command line it sends. The table only shows these and fills in what is
 * clicked (a count, a square), so a click sends exactly what typing would, and whatever the rules
 * refuse is refused the same way. Nothing here changes state. Each ruleset lays out its own view
 * (drawSteel/view.ts, setWorld/view.ts) from these shapes, and table.ts picks one.
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

export type PrepSide = "heroes" | "director";

/**
 * The figure the panel draws for something, as the picture map draws its token: picked by `id`
 * (a hero's or fighter's id, a creature's stat block) in its side's colour.
 */
export interface PrepFigure {
  readonly id: string;
  readonly side: PrepSide;
}

/**
 * What a click on an item does with its `line`: sends it (`send`), puts it on the input line for
 * the GM to finish (`fill`, for free text such as a fighter's name), or counts how many to add
 * with the next square clicked, to send it with ` xN` and place them there (`count`, up to `max`).
 */
export type PrepKind = "send" | "fill" | "count";

export interface PrepItem {
  readonly kind: PrepKind;
  /** What the panel calls it: a hero's name, `New keep`, `Recruit`. */
  readonly label: string;
  /** The line it sends or fills: `/hero vex`, `/add bandit` (before its count), `/recruit `. */
  readonly line: string;
  /** Said beside it: `×2` in play. */
  readonly note?: string;
  /** A `count` item's most at a time. */
  readonly max?: number;
  /** Drawn beside it: the hero or the creature it brings in. */
  readonly figure?: PrepFigure;
}

export interface PrepSection {
  readonly title: string;
  readonly items: ReadonlyArray<PrepItem>;
  /** Said when there are no items: `no sheets in heroes/`. */
  readonly note?: string;
  /** Every item's line, sent one after another by the section's "all": every hero joins. */
  readonly all?: ReadonlyArray<string>;
}

/** Someone in play and off the map, waiting for a square. */
export interface PrepToken {
  /** The token's own id, which `/place` takes. */
  readonly id: string;
  readonly name: string;
  /** What its picture is picked by: a creature's stat block, else its id. */
  readonly figure: PrepFigure;
}

/** One step of getting a fight ready, done or not yet. */
export interface PrepStep {
  readonly label: string;
  readonly done: boolean;
}

/** The maps: the one loaded, and what loads, puts away or makes one. */
export interface PrepMaps {
  /** The loaded map's name, and for a generated one the line that makes another of its kind. */
  readonly loaded?: { readonly name: string; readonly again?: string };
  /** The campaign's other maps, Put away while one is loaded, and a new map of each kind. */
  readonly items: ReadonlyArray<PrepItem>;
}

/** The prep panel, top to bottom. */
export interface PrepView {
  /** The steps to a fight, left to right: `map`, `party`, `foes`. */
  readonly steps: ReadonlyArray<PrepStep>;
  readonly maps: PrepMaps;
  /** Who is in play and off the map, the party first: the next square clicked places the first. */
  readonly place: ReadonlyArray<PrepToken>;
  /** What comes in: the heroes not in play and the monsters, or set.world's Recruit and Foe. */
  readonly sections: ReadonlyArray<PrepSection>;
  /** The line that starts the fight, or while one is on what is said instead (`round 2`). */
  readonly start: { readonly line: string } | { readonly note: string };
}

/** A generated map's id, `<kind>-<seed>`, as `/map new` names one. */
const GENERATED = new RegExp(`^(${MAP_KINDS.join("|")})-\\d+$`);

/** Either ruleset's maps: the loaded one, the campaign's others, Put away, and a new one. */
export function prepMaps(
  catalog: PrepCatalog,
  loaded: { readonly id: string; readonly name: string } | undefined,
): PrepMaps {
  const kind = loaded === undefined ? undefined : GENERATED.exec(loaded.id)?.[1];
  return {
    ...(loaded !== undefined && {
      loaded: {
        name: loaded.name,
        ...(kind !== undefined && { again: `/map new ${kind}` }),
      },
    }),
    items: [
      ...catalog.maps
        .filter((m) => m.id !== loaded?.id)
        .map((m): PrepItem => ({ kind: "send", label: m.name, line: `/map ${m.id}` })),
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

/**
 * The steps to a fight: a map loaded, the party all on it, and foes all on it, where neither side
 * is done while it has nobody. `people` are the living in play, on the map or not.
 */
export function prepSteps(
  mapLoaded: boolean,
  people: ReadonlyArray<{ readonly side: PrepSide; readonly placed: boolean }>,
): ReadonlyArray<PrepStep> {
  const side = (s: PrepSide) => {
    const of = people.filter((p) => p.side === s);
    return of.length > 0 && of.every((p) => p.placed);
  };
  return [
    { label: "map", done: mapLoaded },
    { label: "party", done: side("heroes") },
    { label: "foes", done: side("director") },
  ];
}

/** Off the map, the party first: who the next squares clicked place, in order. */
export const partyFirst = (tokens: ReadonlyArray<PrepToken>): ReadonlyArray<PrepToken> => [
  ...tokens.filter((t) => t.figure.side === "heroes"),
  ...tokens.filter((t) => t.figure.side !== "heroes"),
];
