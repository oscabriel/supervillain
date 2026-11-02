import type { TokenAction } from "../actions.ts";
import { GM, type Refused } from "../module.ts";
import {
  partyFirst,
  type PrepCatalog,
  type PrepItem,
  prepMaps,
  prepSteps,
  type PrepToken,
  type PrepView,
} from "../prep.ts";
import { ADD_MAX } from "./commands.ts";
import { type Ability, type Characteristics, type DamageModifier, isTrait } from "./sheets.ts";
import {
  capitalized,
  CHARACTERISTICS,
  type Condition,
  controls,
  creatureHealth,
  type DrawSteelState,
  everyone,
  findWho,
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
  /** The band's title, when the ruleset words its own (set.world's clock), not rounds and Malice. */
  readonly title?: string;
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
  // As /start counts them: the living heroes' Victories, on average.
  const living = slice.heroes.filter((h) => heroHealth(h) !== "dead");
  const victories =
    living.length === 0
      ? undefined
      : Math.floor(living.reduce((s, h) => s + h.victories, 0) / living.length);
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
      `${s.resource.name} ${h.resource} (+${s.resource.perTurn} a turn) · surges ${h.surges} · Victories ${h.victories} · XP ${h.xp}`,
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

/**
 * What `actor` may do with the hero or creature `id`, for the table's mouse, or undefined when they
 * may not act for it (a player for anyone but their own hero). Move while it stands on the map, and
 * Place while a map is loaded that it isn't on yet; each of its abilities but traits, as `/pr` (a
 * hero's free strike is one of them); a creature's free strike for the GM, as `/fs`; and End turn
 * while it is its turn, since `/done` ends whoever's turn it is. Nothing is checked beyond that:
 * the rules refuse what can't be done now, as they do a typed line.
 */
export function tokenActions(
  slice: DrawSteelState,
  actor: string,
  id: string,
): ReadonlyArray<TokenAction> | undefined {
  const who = findWho(slice, id);
  if (who === undefined || !controls(actor, who)) return undefined;
  const abilities =
    who.kind === "hero"
      ? who.hero.sheet.abilities
      : (slice.blocks[who.creature.block]?.abilities ?? []);
  return [
    ...(slice.map === undefined
      ? []
      : slice.map.tokens[who.id] === undefined
        ? [{ label: "Place", pick: "square" as const, line: `/place ${who.id}` }]
        : [{ label: "Move", pick: "square" as const, line: `/move ${who.id}` }]),
    ...abilities
      .filter((a) => !isTrait(a))
      .map((a) => ({ label: a.name, pick: "targets" as const, line: `/pr ${who.id} ${a.name}` })),
    ...(who.kind === "creature" && actor === GM
      ? [{ label: "Free strike", pick: "target" as const, line: `/fs ${who.id}` }]
      : []),
    ...(slice.combat.active && slice.combat.acting === who.id
      ? [{ label: "End turn", pick: "none" as const, line: "/done" }]
      : []),
  ];
}

/**
 * The prep panel at a Draw Steel table: the maps, who waits for a square, the heroes not in play
 * and every monster, and combat's start.
 */
export function drawSteelPrep(slice: DrawSteelState, catalog: PrepCatalog): PrepView {
  const inPlay = new Set(slice.heroes.map((h) => h.id));
  const added = (block: string) => slice.creatures.filter((c) => c.block === block).length;
  const board = slice.map;
  const living = everyone(slice).filter((w) => w.kind === "hero" || w.creature.stamina > 0);
  const place = living
    .filter((w) => board?.tokens[w.id] === undefined)
    .map(
      (w): PrepToken => ({
        id: w.id,
        name: w.name,
        figure:
          w.kind === "hero"
            ? { id: w.id, side: "heroes" }
            : { id: w.creature.block, side: "director" },
      }),
    );
  const joining = catalog.heroes.filter((h) => !inPlay.has(h.id));
  return {
    steps: prepSteps(
      board !== undefined,
      living.map((w) => ({ side: sideOf(w), placed: board?.tokens[w.id] !== undefined })),
    ),
    maps: prepMaps(catalog, board),
    place: board === undefined ? [] : partyFirst(place),
    sections: [
      {
        title: "heroes",
        items: joining.map(
          (h): PrepItem => ({
            kind: "send",
            label: h.name,
            line: `/hero ${h.id}`,
            figure: { id: h.id, side: "heroes" },
          }),
        ),
        ...(catalog.heroes.length === 0 && { note: "no sheets in heroes/" }),
        ...(joining.length > 1 && { all: joining.map((h) => `/hero ${h.id}`) }),
      },
      {
        title: "monsters",
        items: catalog.monsters.map((m): PrepItem => {
          const n = added(m.id);
          return {
            kind: "count",
            label: m.name,
            line: `/add ${m.id}`,
            max: ADD_MAX,
            figure: { id: m.id, side: "director" },
            ...(n > 0 && { note: `×${n}` }),
          };
        }),
        ...(catalog.monsters.length === 0 && { note: "no stat blocks in monsters/" }),
      },
    ],
    start: slice.combat.active ? { note: `round ${slice.combat.round}` } : { line: "/start" },
  };
}
