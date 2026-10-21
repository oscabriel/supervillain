import type { Refused } from "../module.ts";
import type { Ability, Characteristics, DamageModifier } from "./sheets.ts";
import {
  capitalized,
  CHARACTERISTICS,
  type Condition,
  creatureHealth,
  type DrawSteelState,
  everyone,
  type Hero,
  heroHealth,
  marks,
  minionsLeft,
  perMinion,
  nextSide,
  resolve,
  sideOf,
  type Who,
  windedAt,
} from "./state.ts";

/** One combatant in the band (the table re-exports it from table/view.ts), in turn order. */
export interface Combatant {
  /** The id commands use (`vex`, `goblin-2`, `goblins-a` for a squad). */
  readonly id: string;
  readonly name: string;
  readonly side: "heroes" | "director";
  /** Stamina now and max; for a minion squad, the pool, and `count` minions left. */
  readonly stamina: number;
  readonly max: number;
  readonly temp: number;
  readonly count?: number;
  /** "winded", "dying", "dead", or undefined when healthy. */
  readonly health?: "winded" | "dying" | "dead";
  /** A dying hero's Stamina at which they die (`-10`), so the band can say how close it is. */
  readonly deadAt?: number;
  /** Conditions with their duration, as short text: "slowed (EoT)", "bleeding (save)". A dying hero is "bleeding". */
  readonly conditions: ReadonlyArray<string>;
  /** Heroes: the resource and its amount ("Wrath 3"), Recoveries left, surges. */
  readonly resource?: string;
  readonly recoveries?: { readonly left: number; readonly max: number };
  readonly surges?: number;
  /** Whether it has acted this round, and whether it is acting now. */
  readonly acted: boolean;
  readonly acting: boolean;
  /** Whether this seat's player plays it. */
  readonly mine: boolean;
  /** Its token's mark while it's on the map ("b1"), which commands also take as its name. */
  readonly mark?: string;
}

/** The Draw Steel band: initiative and Stamina meters while a combat runs, else the party. */
export interface CombatView {
  readonly round: number;
  /** False outside combat, when the band shows the party. */
  readonly active: boolean;
  /** Which side acts next, when known. */
  readonly next?: "heroes" | "director";
  readonly malice: number;
  readonly heroTokens: number;
  readonly victories?: number;
  readonly combatants: ReadonlyArray<Combatant>;
}

const conditionText = (c: Condition) =>
  c.duration === "eot" ? `${c.name} (EoT)` : c.duration === "save" ? `${c.name} (save)` : c.name;

function combatant(
  slice: DrawSteelState,
  who: Who,
  actor: string,
  labelOf?: (actor: string) => string,
  marked?: ReadonlyMap<string, string>,
): Combatant {
  const { combat } = slice;
  const acting = combat.acting === who.id;
  const mark = slice.map?.tokens[who.id] === undefined ? undefined : marked?.get(who.id);
  const shared = {
    id: who.id,
    side: sideOf(who),
    acted: combat.acted.includes(who.id) && !acting,
    acting,
    ...(mark !== undefined && { mark }),
  };
  if (who.kind === "hero") {
    const h = who.hero;
    const health = heroHealth(h);
    const player = h.player !== undefined && h.player !== actor ? labelOf?.(h.player) : undefined;
    return {
      ...shared,
      name: player === undefined ? h.sheet.name : `${h.sheet.name} (${player})`,
      stamina: h.stamina,
      max: h.sheet.stamina,
      temp: h.temp,
      ...(health !== undefined && { health }),
      ...(health === "dying" && { deadAt: -windedAt(h.sheet.stamina) }),
      conditions: heroConditions(h),
      resource: `${h.sheet.resource.name} ${h.resource}`,
      recoveries: { left: h.recoveries, max: h.sheet.recoveries },
      surges: h.surges,
      mine: h.player === actor,
    };
  }
  const c = who.creature;
  const health = creatureHealth(c);
  return {
    ...shared,
    name: c.name,
    stamina: c.stamina,
    max: c.max,
    temp: c.temp,
    ...(c.squad !== undefined && { count: minionsLeft(c) }),
    ...(health !== undefined && { health }),
    conditions: c.conditions.map(conditionText),
    mine: false,
  };
}

/**
 * A hero's conditions as short text. A dying hero is bleeding, and that bleeding can't end while
 * they're dying (Combat, "Dying and Death"), so it shows without being stored.
 */
const heroConditions = (h: Hero): ReadonlyArray<string> => [
  ...(heroHealth(h) === "dying" && !h.conditions.some((c) => c.name === "bleeding")
    ? ["bleeding"]
    : []),
  ...h.conditions.map(conditionText),
];

/**
 * The Draw Steel band for one seat: every combatant in combat, the side that goes first leading,
 * or the party outside it. Undefined while there's neither. `labelOf` names a hero's player
 * beside the hero ("Vex (Alice)"); the seat's own hero is marked `mine` instead.
 */
export function combatView(
  slice: DrawSteelState,
  actor: string,
  labelOf?: (actor: string) => string,
): CombatView | undefined {
  const { combat } = slice;
  if (!combat.active && slice.heroes.length === 0) return undefined;
  const shown = combat.active ? everyone(slice) : everyone(slice).filter((w) => w.kind === "hero");
  const leading = combat.first ?? "heroes";
  const marked = slice.map === undefined ? undefined : marks(slice);
  const ordered = [
    ...shown.filter((w) => sideOf(w) === leading),
    ...shown.filter((w) => sideOf(w) !== leading),
  ];
  const next = nextSide(slice);
  const victories =
    slice.heroes.length === 0
      ? undefined
      : Math.floor(slice.heroes.reduce((s, h) => s + h.victories, 0) / slice.heroes.length);
  return {
    round: combat.round,
    active: combat.active,
    ...(next !== undefined && { next }),
    malice: slice.malice,
    heroTokens: slice.tokens,
    ...(victories !== undefined && { victories }),
    combatants: ordered.map((w) => combatant(slice, w, actor, labelOf, marked)),
  };
}

/**
 * Labels a player by their name and the hero they play ("Alice (Vex)"), for the feed and the
 * presence list (Q9). Wrap the core labeller with it when projecting.
 */
export const withHeroes =
  (slice: DrawSteelState, labelOf: (actor: string) => string) =>
  (actor: string): string => {
    const hero = slice.heroes.find((h) => h.player === actor);
    return hero === undefined ? labelOf(actor) : `${labelOf(actor)} (${hero.sheet.name})`;
  };

const signedScore = (n: number) => (n >= 0 ? `+${n}` : `${n}`);

const characteristicsLine = (scores: Characteristics) =>
  CHARACTERISTICS.map((c) => `${capitalized(c)} ${signedScore(scores[c])}`).join(" · ");

const modifiersLine = (
  immunities: ReadonlyArray<DamageModifier> | undefined,
  weaknesses: ReadonlyArray<DamageModifier> | undefined,
) => {
  const list = (ms: ReadonlyArray<DamageModifier>) =>
    ms.map((m) => `${m.type} ${m.value}`).join(", ");
  const parts = [
    ...(immunities !== undefined && immunities.length > 0 ? [`Immune: ${list(immunities)}`] : []),
    ...(weaknesses !== undefined && weaknesses.length > 0 ? [`Weak: ${list(weaknesses)}`] : []),
  ];
  return parts.length === 0 ? [] : [parts.join(" · ")];
};

/** An ability as the sheet prints it: its header, its roll and each tier. */
function abilityLines(ability: Ability): string[] {
  const facts = [
    ability.kind,
    ability.cost === undefined ? undefined : `cost ${ability.cost}`,
    ability.keywords !== undefined && ability.keywords.length > 0
      ? ability.keywords.join(", ")
      : undefined,
    ability.distance,
    ability.target,
  ].filter((f): f is string => f !== undefined && f !== "");
  const roll =
    ability.bonus !== undefined
      ? `2d10 ${signedScore(ability.bonus).replace(/^([+-])/, "$1 ")}`
      : ability.characteristics !== undefined && ability.characteristics.length > 0
        ? `2d10 + ${ability.characteristics.map(capitalized).join(" or ")}`
        : undefined;
  const head = `${ability.name}${facts.length > 0 ? ` (${facts.join("; ")})` : ""}${roll !== undefined ? `: ${roll}` : ""}`;
  return [
    head,
    ...(ability.tier1 !== undefined ? [`  ≤11: ${ability.tier1}`] : []),
    ...(ability.tier2 !== undefined ? [`  12-16: ${ability.tier2}`] : []),
    ...(ability.tier3 !== undefined ? [`  17+: ${ability.tier3}`] : []),
    ...(ability.effect !== undefined ? [`  Effect: ${ability.effect}`] : []),
  ];
}

const conditionsLine = (conditions: ReadonlyArray<Condition>) =>
  conditions.length === 0 ? [] : [`Conditions: ${conditions.map(conditionText).join(", ")}`];

/** The /sheet text for a hero or creature, named as commands name them, or why it can't be found. */
export function sheetText(slice: DrawSteelState, typed: string): string | Refused {
  const who = resolve(slice, typed);
  if ("refusal" in who) return who;
  if (who.kind === "hero") {
    const h = who.hero;
    const s = h.sheet;
    const health = heroHealth(h);
    const winded = windedAt(s.stamina);
    const value = s.recoveryValue ?? Math.floor(s.stamina / 3);
    return [
      `${s.name}: ${s.class} ${s.level}`,
      [
        `Stamina ${h.stamina}/${s.stamina}`,
        ...(h.temp > 0 ? [`temp ${h.temp}`] : []),
        `${health === "dying" ? "dying and bleeding" : (health ?? "healthy")} (winded at ${winded}, dead at -${winded})`,
        `Recoveries ${h.recoveries}/${s.recoveries}, ${value} each`,
      ].join(" · "),
      `${s.resource.name} ${h.resource} (+${s.resource.perTurn} a turn) · surges ${h.surges} · Victories ${h.victories}`,
      characteristicsLine(s.characteristics),
      `Speed ${s.speed} · Stability ${s.stability}`,
      ...modifiersLine(s.immunities, s.weaknesses),
      ...conditionsLine(h.conditions),
      "",
      ...s.abilities.flatMap(abilityLines),
    ].join("\n");
  }
  const c = who.creature;
  const b = slice.blocks[c.block];
  if (b === undefined) return `${c.name}: Stamina ${c.stamina}/${c.max}`;
  const what = [`level ${b.level} ${b.organization}`, b.role?.toLowerCase()]
    .filter((x) => x !== undefined)
    .join(" ");
  const health = creatureHealth(c);
  return [
    `${c.name}: ${c.name === b.name ? "" : `${b.name}, `}${what}`,
    [
      `Stamina ${c.stamina}/${c.max}`,
      ...(c.temp > 0 ? [`temp ${c.temp}`] : []),
      ...(c.squad !== undefined
        ? [`${minionsLeft(c)} of ${c.squad} minions, ${perMinion(c)} each`]
        : health !== undefined
          ? [health]
          : []),
      `Free strike ${b.freeStrike}`,
    ].join(" · "),
    characteristicsLine(b.characteristics),
    `Speed ${b.speed} · Stability ${b.stability}`,
    ...modifiersLine(b.immunities, b.weaknesses),
    ...(c.squad !== undefined && b.withCaptain !== undefined
      ? [`With a captain: ${b.withCaptain}`]
      : []),
    ...conditionsLine(c.conditions),
    ...(b.abilities.length > 0 ? ["", ...b.abilities.flatMap(abilityLines)] : []),
  ].join("\n");
}
