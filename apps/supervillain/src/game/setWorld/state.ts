/**
 * The set.world table's state: fighters rolled at set.world, the map they stand on, and the fight,
 * whose turns follow initiative on a logical clock. Pure, like every rule.
 */
import type { Square } from "../drawSteel/map.ts";
import type { Occupants } from "../drawSteel/movement.ts";
import { matching, pick } from "../drawSteel/state.ts";
import { GM, type Refused } from "../module.ts";
import { quote } from "../text.ts";

/** The rules a fight follows: Set's turn-based mode, by its own stamp, on this table's grid. */
export const RULES_STAMP = "set-world-0-15-0-dungeon-initiative-2";

/** The attributes the rules read; a roll without every one of them can't come to the table. */
export const ATTRIBUTES = [
  "maxHealth",
  "stamina",
  "initiative",
  "walkSpeed",
  "physicalDamage",
  "magicalDamage",
  "physicalDamageReduction",
  "magicalDamageReduction",
  "globalResistance",
  "dodgeRate",
  "criticalHitChance",
  "clarity",
] as const;

export type Attribute = (typeof ATTRIBUTES)[number];

/** One piece of gear: its slot (`head`, `hand`) and its name (`cotton headband of the tyrant`). */
export interface Gear {
  readonly slot: string;
  readonly name: string;
}

/**
 * The part of a set.world character roll the table keeps: what the rules read and /sheet shows.
 * The host fetches it and puts it in the command, so the event carries it and replay never fetches.
 */
export interface SetCharacter {
  readonly seed: number;
  /** set.world's content version, so a roll can be told from the same seed rolled later. */
  readonly contentVersion: string;
  readonly className: string;
  readonly flavor: string;
  /** The weapon in hand, by its kind (`targe`, `sling`): it sets reach and delivery. */
  readonly mainhand: string;
  readonly powerRating: number;
  readonly finalStats: Readonly<Record<string, number>>;
  readonly attributes: Readonly<Record<Attribute, number>> & Readonly<Record<string, number>>;
  readonly gear: ReadonlyArray<Gear>;
}

export type SetSide = "party" | "foes";

export interface Fighter {
  /** The id commands use, from the name: `ada`, `old-grub`. */
  readonly id: string;
  /** The name the GM gave it; set.world's rolls have none. */
  readonly name: string;
  readonly side: SetSide;
  readonly character: SetCharacter;
  /** A whole number, as Set keeps it. At 0 a fighter is down. */
  readonly health: number;
  /** Kept with its fraction, since recovery comes by the millisecond; shown rounded down. */
  readonly stamina: number;
  /** The actor who plays it, for a party member someone has taken. */
  readonly player?: string;
  readonly at?: Square;
}

/** The turn under way: whose, how far it has moved, and whether it has attacked. */
export interface Turn {
  readonly id: string;
  readonly moved: number;
  readonly attacked: boolean;
}

/** A fight on Set's logical clock, in milliseconds of initiative time, never wall time. */
export interface Fight {
  /** When the turn under way began (0 before the first). */
  readonly clock: number;
  /** How many turns have begun. */
  readonly turns: number;
  /** When each fighter acts next, by id. */
  readonly next: Readonly<Record<string, number>>;
  readonly turn?: Turn;
}

/** The map the fight is on, as the host read it from `maps/<id>.txt`. */
export interface SetMap {
  readonly id: string;
  readonly name: string;
  readonly terrain: ReadonlyArray<string>;
  readonly dressing?: ReadonlyArray<string>;
}

export interface SetState {
  /** In the order they came to the table, which settles ties in initiative within a side. */
  readonly fighters: ReadonlyArray<Fighter>;
  readonly map?: SetMap;
  readonly fight?: Fight;
}

export const initial: SetState = { fighters: [] };

// ---- The rules as numbers (https://set.world/skills/anima-derived-combat, part one).

/** What an attack costs, hit or miss. A fighter with less rests instead. */
export const ATTACK_STAMINA = 20;
/** What every fighter recovers per second of initiative time, up to its maximum. */
export const RECOVERY_PER_SECOND = 10;

export const maxHealth = (c: SetCharacter): number => Math.floor(c.attributes.maxHealth);
export const maxStamina = (c: SetCharacter): number => Math.floor(c.attributes.stamina);

/** A fighter's stamina as the table shows it: rounded down. */
export const shownStamina = (f: Fighter): number => Math.floor(f.stamina);

/** Milliseconds of initiative time between a fighter's turns: `1000 / initiative`. */
export const intervalOf = (c: SetCharacter): number => 1000 / c.attributes.initiative;

/** Squares a turn's movement may cover: five, scaled by the walk speed (this table's own rule). */
export const speedOf = (c: SetCharacter): number =>
  Math.max(2, Math.round(5 * c.attributes.walkSpeed));

// ---- Who is who.

export const isDown = (f: Fighter): boolean => f.health <= 0;

export const living = (slice: SetState, side?: SetSide): ReadonlyArray<Fighter> =>
  slice.fighters.filter((f) => !isDown(f) && (side === undefined || f.side === side));

export const fighterOf = (slice: SetState, actor: string): Fighter | undefined =>
  slice.fighters.find((f) => f.player === actor);

export const findFighter = (slice: SetState, id: string): Fighter | undefined =>
  slice.fighters.find((f) => f.id === id);

/** Whether `actor` may act for this fighter: the GM for anyone, a player for the one they play. */
export const controls = (actor: string, f: Fighter): boolean =>
  actor === GM || (f.player !== undefined && f.player === actor);

/** The map's side for a fighter: the party is drawn as heroes, foes as the director's. */
export const mapSide = (f: Fighter): "heroes" | "director" =>
  f.side === "party" ? "heroes" : "director";

/** The id a name gives: lower case, words joined by `-`; `fighter` when nothing is left. */
export function idFor(slice: SetState, name: string): string {
  const base =
    name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "fighter";
  let id = base;
  for (let n = 2; slice.fighters.some((f) => f.id === id); n++) id = `${base}-${n}`;
  return id;
}

/**
 * Every fighter's mark on the map, unique and at most two characters, in the order they came:
 * the party by its initial in upper case, foes in lower case, then the initial and a later letter
 * of the name, then the initial and a digit, then any free pair.
 */
export function marksOf(fighters: ReadonlyArray<Fighter>): ReadonlyMap<string, string> {
  const taken = new Set<string>();
  const marks = new Map<string, string>();
  const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (const f of fighters) {
    const letters = f.name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    const first = letters[0] ?? "x";
    const initial = f.side === "party" ? first.toUpperCase() : first;
    const candidates = [
      initial,
      ...letters
        .slice(1)
        .split("")
        .map((c) => `${initial}${c}`),
      ..."23456789".split("").map((d) => `${initial}${d}`),
      ...[...ALNUM].flatMap((a) => [...ALNUM].map((b) => `${a}${b}`)),
    ];
    const mark = candidates.find((m) => !taken.has(m)) ?? "??";
    taken.add(mark);
    marks.set(f.id, mark);
  }
  return marks;
}

/**
 * The fighter a typed name means: an exact id or name, then an exact mark ("A", "g2"), then a
 * unique start of an id, name or word.
 */
export function resolveFighter(slice: SetState, typed: string): Fighter | Refused {
  const q = typed.trim().toLowerCase();
  const exact = slice.fighters.find((f) => f.id === q || f.name.toLowerCase() === q);
  if (exact !== undefined) return exact;
  for (const [id, mark] of marksOf(slice.fighters))
    if (mark === typed.trim()) return findFighter(slice, id)!;
  return pick(
    slice.fighters,
    (f) => [f.id, f.name],
    (f) => f.name,
    typed,
    `Nobody at the table is called '${quote(typed)}'.`,
  );
}

/** Fighter ids that begin with what was typed, else whose name has a word it begins; the actor's own first. */
export function completeFighters(
  slice: SetState,
  partial: string,
  actor: string,
  keep: (f: Fighter) => boolean = () => true,
): string[] {
  const own = fighterOf(slice, actor)?.id;
  const shown = slice.fighters.filter(keep);
  const ordered = [...shown.filter((f) => f.id === own), ...shown.filter((f) => f.id !== own)];
  return matching(
    ordered,
    (f) => f.id,
    (f) => [f.id, f.name],
    partial,
  );
}

/** Who stands on a square, but `except`: the down take up no space. */
export function occupants(slice: SetState, except?: string): Occupants {
  return (square) => {
    const there = slice.fighters.find(
      (f) =>
        f.id !== except &&
        !isDown(f) &&
        f.at !== undefined &&
        f.at.x === square.x &&
        f.at.y === square.y,
    );
    return there === undefined ? undefined : { id: there.id, side: mapSide(there) };
  };
}

/**
 * When a fighter acts next, or undefined for one with no turn coming (down when the fight began).
 * By its own entry: an id may be a word every object answers to (`constructor`).
 */
export const nextOf = (fight: Fight, id: string): number | undefined =>
  Object.hasOwn(fight.next, id) ? fight.next[id] : undefined;

/**
 * Who acts next on Set's schedule: the soonest turn. Exact ties keep Set's participant order, the
 * party and then the foes, each in the order they came to the table.
 */
export function soonest(slice: SetState, fight: Fight): Fighter | undefined {
  let best: Fighter | undefined;
  for (const f of [...living(slice, "party"), ...living(slice, "foes")]) {
    const at = nextOf(fight, f.id);
    if (at !== undefined && (best === undefined || at < fight.next[best.id]!)) best = f;
  }
  return best;
}
