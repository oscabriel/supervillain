import { GM, type Refused } from "../module.ts";
import { orList, quote } from "../text.ts";
import type { Square } from "./map.ts";
import { marksOf } from "./marks.ts";
import type { Ability, HeroSheet, StatBlock } from "./sheets.ts";

export type Side = "heroes" | "director";

export const CONDITIONS = [
  "bleeding",
  "dazed",
  "frightened",
  "grabbed",
  "prone",
  "restrained",
  "slowed",
  "taunted",
  "weakened",
] as const;
export type ConditionName = (typeof CONDITIONS)[number];

/**
 * How long a condition lasts: to the end of the target's next turn (`eot`, which is its current
 * turn when imposed during it), until a save of 6+ on a d10 at the end of each of its turns
 * (`save`), or to the end of the encounter (`end`).
 */
export type Duration = "eot" | "save" | "end";
export const DURATIONS: ReadonlyArray<Duration> = ["eot", "save", "end"];

export interface Condition {
  readonly name: ConditionName;
  readonly duration: Duration;
}

export interface Hero {
  /** The sheet's id, which commands use. */
  readonly id: string;
  /** The sheet the hero joined with, from the `ds.hero-joined` payload. */
  readonly sheet: HeroSheet;
  readonly stamina: number;
  readonly temp: number;
  readonly recoveries: number;
  /** The heroic resource, named by the sheet. May go below 0 for classes that allow it. */
  readonly resource: number;
  readonly surges: number;
  readonly victories: number;
  /** Experience: each respite adds the Victories the hero had. */
  readonly xp: number;
  readonly conditions: ReadonlyArray<Condition>;
  /** The actor who plays this hero, if anyone has claimed it. */
  readonly player?: string;
}

export interface Creature {
  readonly id: string;
  readonly name: string;
  /** The stat block's id, a key of `blocks`. */
  readonly block: string;
  /** For a minion squad, the shared pool. */
  readonly stamina: number;
  readonly max: number;
  readonly temp: number;
  readonly conditions: ReadonlyArray<Condition>;
  /** A minion squad: how many minions it started with. One minion's Stamina is `max / squad`. */
  readonly squad?: number;
}

export interface Combat {
  readonly active: boolean;
  /** 0 outside combat. */
  readonly round: number;
  /** The d10 rolled at /start: on 6+ the players pick who goes first, else the Director. */
  readonly roll?: number;
  /** The side that goes first every round, once someone has picked. */
  readonly first?: Side;
  /** Ids that have started a turn this round, in order. */
  readonly acted: ReadonlyArray<string>;
  readonly acting?: string;
  /**
   * The movement the acting creature has spent this turn, and whether its main action went on a
   * second move (Combat, "Main Actions"). Gone when its turn ends.
   */
  readonly moved?: { readonly id: string; readonly spent: number; readonly main: boolean };
}

/** The text map (ASSESSMENT Q7): the grid the GM loaded and where each token stands. */
export interface Board {
  /** The map file's id, `maps/<id>.txt`. */
  readonly id: string;
  readonly name: string;
  /** One string per row, all the same width. */
  readonly terrain: ReadonlyArray<string>;
  /** A mekmode map's letters, one per square, for the picture map; the rules never read them. */
  readonly dressing?: ReadonlyArray<string>;
  /**
   * Where each placed hero or creature stands, by id. A token stays while its creature is at the
   * table, dead ones as dead marks, until /end clears the dead and the creatures.
   */
  readonly tokens: Readonly<Record<string, Square>>;
}

/** The Draw Steel slice: the party, the creatures in the fight, the combat, Malice and hero tokens. */
export interface DrawSteelState {
  /** In the order they joined. */
  readonly heroes: ReadonlyArray<Hero>;
  /** In the order they were added. */
  readonly creatures: ReadonlyArray<Creature>;
  /** The stat blocks the creatures came from, by id, as the latest /add carried them. */
  readonly blocks: Readonly<Record<string, StatBlock>>;
  readonly combat: Combat;
  readonly malice: number;
  /** The party's hero tokens. */
  readonly tokens: number;
  /** The text map, while one is loaded. */
  readonly map?: Board;
}

export const NO_COMBAT: Combat = { active: false, round: 0, acted: [] };

export const initial: DrawSteelState = {
  heroes: [],
  creatures: [],
  blocks: {},
  combat: NO_COMBAT,
  malice: 0,
  tokens: 0,
};

/** A hero or a creature, as commands name them. */
export type Who =
  | { readonly kind: "hero"; readonly id: string; readonly name: string; readonly hero: Hero }
  | {
      readonly kind: "creature";
      readonly id: string;
      readonly name: string;
      readonly creature: Creature;
    };

export const everyone = (slice: DrawSteelState): ReadonlyArray<Who> => [
  ...slice.heroes.map((hero): Who => ({ kind: "hero", id: hero.id, name: hero.sheet.name, hero })),
  ...slice.creatures.map(
    (creature): Who => ({ kind: "creature", id: creature.id, name: creature.name, creature }),
  ),
];

export const findWho = (slice: DrawSteelState, id: string): Who | undefined =>
  everyone(slice).find((w) => w.id === id);

/** A hero's abilities from its sheet, a creature's from its stat block. */
export const abilitiesOf = (slice: DrawSteelState, who: Who): ReadonlyArray<Ability> =>
  who.kind === "hero"
    ? who.hero.sheet.abilities
    : (slice.blocks[who.creature.block]?.abilities ?? []);

export { CHARACTERISTICS } from "./sheets.ts";

export const capitalized = (s: string): string => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

/** "1 surge", "2 surges". */
export const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${Math.abs(n) === 1 ? one : many}`;

/** "A and B", "A, B and C". */
export const andList = (items: ReadonlyArray<string>): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** Whether `typed` begins `key` at its start or just after a space or dash: "bru" and "bruiser-1" begin "bandit-bruiser-1". */
const beginsWord = (key: string, typed: string): boolean => {
  const k = key.toLowerCase();
  for (let i = 0; i < k.length; i++)
    if ((i === 0 || k[i - 1] === " " || k[i - 1] === "-") && k.startsWith(typed, i)) return true;
  return false;
};

/**
 * Picks one of `items` by what was typed: an exact key (case-insensitive) first, then a unique
 * start of any key, then a unique start of any word in one ("chief" for Bandit Chief,
 * "bruiser-1" for bandit-bruiser-1). An ambiguous start is refused with the candidates.
 */
export function pick<T>(
  items: ReadonlyArray<T>,
  keys: (item: T) => ReadonlyArray<string>,
  label: (item: T) => string,
  typed: string,
  none: string,
): T | Refused {
  const q = typed.trim().toLowerCase();
  const exact = items.find((item) => keys(item).some((k) => k.toLowerCase() === q));
  if (exact !== undefined) return exact;
  if (q === "") return { refusal: none };
  for (const matches of [
    (k: string) => k.toLowerCase().startsWith(q),
    (k: string) => beginsWord(k, q),
  ]) {
    const begun = items.filter((item) => keys(item).some(matches));
    if (begun.length === 1) return begun[0]!;
    if (begun.length > 1)
      return { refusal: `'${quote(typed)}' could be ${orList(begun.map(label))}.` };
  }
  return { refusal: none };
}

/** The ids of `items` that `typed` begins, else those it begins a word of: what Tab offers. */
export function matching<T>(
  items: ReadonlyArray<T>,
  id: (item: T) => string,
  keys: (item: T) => ReadonlyArray<string>,
  typed: string,
): string[] {
  const q = typed.trim().toLowerCase();
  const begun = items.filter((item) => id(item).toLowerCase().startsWith(q));
  if (begun.length > 0 || q === "") return begun.map(id);
  return items.filter((item) => keys(item).some((k) => beginsWord(k, q))).map(id);
}

/** Every hero's and creature's mark on the map (marks.ts), by id. */
export const marks = (slice: DrawSteelState): ReadonlyMap<string, string> =>
  marksOf(everyone(slice));

/** The hero or creature whose mark is exactly `typed`, case and all ("B" is Brann, "b" a bandit). */
export function byMark(slice: DrawSteelState, typed: string): Who | undefined {
  const q = typed.trim();
  for (const [id, mark] of marks(slice)) if (mark === q) return findWho(slice, id);
  return undefined;
}

/**
 * Resolves a typed name to a hero or creature: an exact id or name first, then an exact mark
 * ("b1"), then a unique start of an id, name or word (see `pick`).
 */
export function resolve(slice: DrawSteelState, typed: string): Who | Refused {
  const all = everyone(slice);
  const q = typed.trim().toLowerCase();
  const exact = all.find((w) => w.id.toLowerCase() === q || w.name.toLowerCase() === q);
  if (exact !== undefined) return exact;
  return (
    byMark(slice, typed) ??
    pick(
      all,
      (w) => [w.id, w.name],
      (w) => w.name,
      typed,
      `Nobody at the table is called '${quote(typed)}'.`,
    )
  );
}

/** The Stamina at or below which a creature is winded: half its max, rounded down. */
export const windedAt = (max: number): number => Math.floor(max / 2);

export type Health = "winded" | "dying" | "dead";

export function heroHealth(hero: Hero): Health | undefined {
  const max = hero.sheet.stamina;
  if (hero.stamina <= -windedAt(max)) return "dead";
  if (hero.stamina <= 0) return "dying";
  if (hero.stamina <= windedAt(max)) return "winded";
  return undefined;
}

/**
 * One minion's Stamina in a squad, as it was added: a later /add of an edited stat block
 * replaces the block, but never the squad's pool.
 */
export const perMinion = (creature: Creature): number => creature.max / (creature.squad ?? 1);

/** How many minions a squad has left: one dies for each full minion's worth of the pool lost. */
export function minionsLeft(creature: Creature): number {
  if (creature.squad === undefined) return creature.stamina > 0 ? 1 : 0;
  if (creature.stamina <= 0) return 0;
  return creature.squad - Math.floor((creature.max - creature.stamina) / perMinion(creature));
}

export function creatureHealth(creature: Creature): Health | undefined {
  if (creature.stamina <= 0) return "dead";
  if (creature.squad === undefined && creature.stamina <= windedAt(creature.max)) return "winded";
  return undefined;
}

const healthOf = (who: Who): Health | undefined =>
  who.kind === "hero" ? heroHealth(who.hero) : creatureHealth(who.creature);

export const isDead = (who: Who): boolean => healthOf(who) === "dead";

export const sideOf = (who: Who): Side => (who.kind === "hero" ? "heroes" : "director");

export const conditionsOf = (who: Who): ReadonlyArray<Condition> =>
  who.kind === "hero" ? who.hero.conditions : who.creature.conditions;

export const other = (side: Side): Side => (side === "heroes" ? "director" : "heroes");

/** Whether `actor` may change this hero or creature: the GM anyone, a player only their own hero. */
export const controls = (actor: string, who: Who): boolean =>
  actor === GM || (who.kind === "hero" && who.hero.player === actor);

export const heroOf = (slice: DrawSteelState, actor: string): Hero | undefined =>
  slice.heroes.find((h) => h.player === actor);

/** The living creatures and heroes on a side that haven't started a turn this round. */
export const waiting = (slice: DrawSteelState, side: Side): ReadonlyArray<Who> =>
  everyone(slice).filter(
    (w) => sideOf(w) === side && !isDead(w) && !slice.combat.acted.includes(w.id),
  );

/**
 * Which side acts next, counting whoever is acting as done: the side that goes first when nobody
 * has acted this round (or everyone has), else the other side from the last to act. A side with
 * nobody left to act is skipped, so the same side goes again.
 */
export function nextSide(slice: DrawSteelState): Side | undefined {
  const { combat } = slice;
  if (!combat.active) return undefined;
  const last = combat.acted.at(-1);
  const lastWho = last === undefined ? undefined : findWho(slice, last);
  if (lastWho === undefined || roundOver(slice)) {
    const { first } = combat;
    const alive = (side: Side) => everyone(slice).some((w) => sideOf(w) === side && !isDead(w));
    return first !== undefined && !alive(first) ? other(first) : first;
  }
  const side = sideOf(lastWho);
  return waiting(slice, other(side)).length > 0 ? other(side) : side;
}

/** Whether every living creature and hero has started a turn this round. */
export const roundOver = (slice: DrawSteelState): boolean =>
  waiting(slice, "heroes").length === 0 && waiting(slice, "director").length === 0;
