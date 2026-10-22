import type { Envelope } from "@supervillain/engine";
import * as Schema from "effect/Schema";
import { signed } from "../dice.ts";
import type { FeedNote } from "../module.ts";
import { hasTerminalControls } from "../text.ts";
import { type EventType, type Payload, Payloads } from "./events.ts";
import { distance, formatSquare, misshapen, sameSquare, type Square, standable } from "./map.ts";

import { safeSheet } from "./schema.ts";
import {
  type Ability,
  characteristicOfLetter,
  type HeroSheet,
  isTrait,
  reachOf,
} from "./sheets.ts";
import {
  andList,
  type Board,
  capitalized,
  type Condition,
  type Creature,
  creatureHealth,
  type DrawSteelState,
  findWho,
  type Health,
  type Hero,
  heroHealth,
  minionsLeft,
  NO_COMBAT,
  plural,
  type Who,
} from "./state.ts";

type Applied = { readonly slice: DrawSteelState; readonly feed?: FeedNote };

/** The feed kinds Draw Steel writes. Each line names its subject, so none needs a speaker but `ds-act` and `ds-claim`. */
export const formats = {
  /** A change to a hero or creature: "Vex takes 7 damage → 14/21 · winded". */
  ds: { speaker: false, separator: "" },
  /** A power roll or a save: "Vex uses Spinning Strike: [7, 5] +2 = 14 · tier 2 — 5 damage". */
  "ds-roll": { speaker: false, separator: "" },
  /** Combat, rounds and turns: "Round 2. Malice +4 (2 heroes, round 2) → 9." */
  "ds-turn": { speaker: false, separator: "" },
  /** Something a person does at the table, not a creature in it: "Alice (Vex) spends 1 hero token → 2." */
  "ds-act": { speaker: true, separator: " " },
  /** A player taking a hero, by their name alone: "Alice takes Brann.", whoever gave it to them. */
  "ds-claim": { speaker: true, separator: " ", plainLabel: true },
} as const;

function decode<T extends EventType>(type: T, envelope: Envelope): Payload<T> {
  try {
    return Schema.decodeUnknownSync(Payloads[type])(envelope.payload) as Payload<T>;
  } catch (e) {
    throw new Error(
      `bad ${envelope.type} payload at seq ${envelope.seq}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** A failed check on an event: the writer halts on it. */
function bad(envelope: Envelope, why: string): never {
  throw new Error(`${envelope.type} at seq ${envelope.seq} ${why}`);
}

function who(slice: DrawSteelState, envelope: Envelope, id: string): Who {
  return findWho(slice, id) ?? bad(envelope, `names '${id}', who isn't at the table`);
}

function hero(slice: DrawSteelState, envelope: Envelope, id: string): Hero {
  const found = who(slice, envelope, id);
  return found.kind === "hero" ? found.hero : bad(envelope, `names '${id}', who isn't a hero`);
}

const withHero = (slice: DrawSteelState, id: string, f: (h: Hero) => Hero): DrawSteelState => ({
  ...slice,
  heroes: slice.heroes.map((h) => (h.id === id ? f(h) : h)),
});

const withCreature = (
  slice: DrawSteelState,
  id: string,
  f: (c: Creature) => Creature,
): DrawSteelState => ({
  ...slice,
  creatures: slice.creatures.map((c) => (c.id === id ? f(c) : c)),
});

/** Changes whichever hero or creature `id` names, through the fields they share. */
function withWho(
  slice: DrawSteelState,
  envelope: Envelope,
  id: string,
  f: <T extends Hero | Creature>(x: T) => T,
): DrawSteelState {
  return who(slice, envelope, id).kind === "hero"
    ? withHero(slice, id, f)
    : withCreature(slice, id, f);
}

/** A hero this change killed has no conditions left: the dead aren't slowed or bleeding. */
function buried(before: DrawSteelState, after: DrawSteelState, id: string): DrawSteelState {
  const [was, now] = [findWho(before, id), findWho(after, id)];
  if (was?.kind !== "hero" || now?.kind !== "hero") return after;
  if (heroHealth(was.hero) === "dead" || heroHealth(now.hero) !== "dead") return after;
  return now.hero.conditions.length === 0
    ? after
    : withHero(after, id, (h) => ({ ...h, conditions: [] }));
}

const healthSuffix = (health: Health | undefined) => (health === undefined ? "" : ` · ${health}`);

/** "14/21 · winded", read from the state after the change. */
function meter(slice: DrawSteelState, id: string): string {
  const found = findWho(slice, id);
  if (found === undefined) return "";
  if (found.kind === "hero")
    return `${found.hero.stamina}/${found.hero.sheet.stamina}${healthSuffix(heroHealth(found.hero))}`;
  const c = found.creature;
  return `${c.stamina}/${c.max}${c.squad === undefined ? healthSuffix(creatureHealth(c)) : ""}`;
}

const nameOf = (slice: DrawSteelState, id: string) => findWho(slice, id)?.name ?? id;

function durationText(condition: Condition): string {
  switch (condition.duration) {
    case "eot":
      return " (EoT)";
    case "save":
      return " (save ends)";
    case "end":
      return " until the end of the encounter";
  }
}

const isSafe = (text: string) => !hasTerminalControls(text);

function heroJoined(slice: DrawSteelState, envelope: Envelope): Applied {
  const { sheet } = decode("ds.hero-joined", envelope);
  if (!safeSheet(sheet)) bad(envelope, "holds control characters");
  if (slice.creatures.some((c) => c.id === sheet.id)) bad(envelope, `reuses the id '${sheet.id}'`);
  const summary = `${sheet.class} ${sheet.level}, ${sheet.stamina} Stamina.`;
  const existing = slice.heroes.find((h) => h.id === sheet.id);
  if (existing !== undefined) {
    const next = withHero(slice, sheet.id, (h) => ({
      ...h,
      sheet,
      stamina: Math.min(h.stamina, sheet.stamina),
      recoveries: Math.min(h.recoveries, sheet.recoveries),
    }));
    return {
      slice: next,
      feed: { kind: "ds", text: `${sheet.name}'s sheet is reloaded: ${summary}` },
    };
  }
  const joined: Hero = {
    id: sheet.id,
    sheet,
    stamina: sheet.stamina,
    temp: 0,
    recoveries: sheet.recoveries,
    resource: 0,
    surges: 0,
    victories: sheet.victories,
    xp: 0,
    conditions: [],
  };
  return {
    slice: { ...slice, heroes: [...slice.heroes, joined] },
    feed: { kind: "ds", text: `${sheet.name} joins the party: ${summary}` },
  };
}

function creaturesAdded(slice: DrawSteelState, envelope: Envelope): Applied {
  const { block, creatures } = decode("ds.creatures-added", envelope);
  if (!safeSheet(block) || !creatures.every((c) => isSafe(c.name)))
    bad(envelope, "holds control characters");
  const taken = new Set([...slice.heroes.map((h) => h.id), ...slice.creatures.map((c) => c.id)]);
  const added = creatures.map((c): Creature => {
    if (taken.has(c.id)) bad(envelope, `reuses the id '${c.id}'`);
    if (c.squad !== undefined && (c.squad < 1 || block.organization !== "minion"))
      bad(envelope, `has a bad squad for '${c.id}'`);
    taken.add(c.id);
    const max = block.stamina * (c.squad ?? 1);
    const creature = {
      id: c.id,
      name: c.name,
      block: block.id,
      stamina: max,
      max,
      temp: 0,
      conditions: [],
    };
    return c.squad === undefined ? creature : { ...creature, squad: c.squad };
  });
  const names = creatures.map((c) =>
    c.squad === undefined ? c.name : `${c.name} (${plural(c.squad, "minion")})`,
  );
  return {
    slice: {
      ...slice,
      creatures: [...slice.creatures, ...added],
      blocks: { ...slice.blocks, [block.id]: block },
    },
    feed: {
      kind: "ds",
      text: `${andList(names)} ${names.length === 1 ? "joins" : "join"} the fight.`,
    },
  };
}

/** "Alice takes Brann.", by the player's name alone, whoever gave it to them. */
function heroClaimed(slice: DrawSteelState, envelope: Envelope): Applied {
  const { hero: id, player, label } = decode("ds.hero-claimed", envelope);
  const claimed = hero(slice, envelope, id);
  if (label !== undefined && !isSafe(label)) bad(envelope, "holds control characters");
  if (slice.heroes.some((h) => h.player === player && h.id !== id))
    bad(envelope, "gives a player a second hero");
  const next = withHero(slice, id, (h) => ({ ...h, player }));
  return {
    slice: next,
    feed: { kind: "ds-claim", text: `takes ${claimed.sheet.name}.`, speaker: player },
  };
}

function heroReleased(slice: DrawSteelState, envelope: Envelope): Applied {
  const { hero: id } = decode("ds.hero-released", envelope);
  const released = hero(slice, envelope, id);
  const next = withHero(slice, id, ({ player: _player, ...h }) => h);
  const name = released.sheet.name;
  return {
    slice: next,
    feed:
      released.player === envelope.actor
        ? { kind: "ds-act", text: `stops playing ${name}.` }
        : { kind: "ds", text: `Nobody plays ${name} now.` },
  };
}

function combatStarted(slice: DrawSteelState, envelope: Envelope): Applied {
  const { roll, gains, malice } = decode("ds.combat-started", envelope);
  if (slice.combat.active) bad(envelope, "starts a combat while one runs");
  if (roll < 1 || roll > 10) bad(envelope, `has a d10 of ${roll}`);
  let next: DrawSteelState = slice;
  const gained: string[] = [];
  for (const [id, gain] of Object.entries(gains)) {
    const h = hero(slice, envelope, id);
    next = withHero(next, id, (x) => ({ ...x, resource: x.resource + gain }));
    if (gain !== 0) gained.push(`${h.sheet.name} ${signed(gain)} ${h.sheet.resource.name}`);
  }
  const added = malice.victories + malice.heroes + malice.round;
  const total = slice.malice + added;
  next = { ...next, malice: total, combat: { active: true, round: 1, roll, acted: [] } };
  const picker = roll >= 6 ? "the players pick" : "the Director picks";
  const text = [
    `Combat begins, round 1. d10: ${roll}, so ${picker} who goes first, and the GM types /first heroes or /first director.`,
    `Malice ${signed(added) || "+0"} (${malice.victories} for Victories, ${plural(malice.heroes, "hero", "heroes")}, round ${malice.round}) → ${total}.`,
    ...(gained.length > 0 ? [`${gained.join(", ")}.`] : []),
    // A session starts with one token per hero, which nothing else on screen reminds a GM of.
    ...(slice.tokens === 0 && slice.heroes.length > 0
      ? ["The party has no hero tokens; /token reset gives one per hero."]
      : []),
  ].join(" ");
  return { slice: next, feed: { kind: "ds-turn", text } };
}

function firstSet(slice: DrawSteelState, envelope: Envelope): Applied {
  const { side } = decode("ds.first-set", envelope);
  if (!slice.combat.active) bad(envelope, "comes outside combat");
  return {
    slice: { ...slice, combat: { ...slice.combat, first: side } },
    feed: {
      kind: "ds-turn",
      text:
        side === "heroes"
          ? "The heroes go first each round."
          : "The Director goes first each round.",
    },
  };
}

function roundStarted(slice: DrawSteelState, envelope: Envelope): Applied {
  const { round, heroes, malice } = decode("ds.round-started", envelope);
  if (!slice.combat.active) bad(envelope, "comes outside combat");
  if (round !== slice.combat.round + 1) bad(envelope, `skips from round ${slice.combat.round}`);
  const { acting: _acting, ...combat } = slice.combat;
  const total = slice.malice + malice;
  return {
    slice: { ...slice, malice: total, combat: { ...combat, round, acted: [] } },
    feed: {
      kind: "ds-turn",
      text: `Round ${round}. Malice +${malice} (${plural(heroes, "hero", "heroes")}, round ${round}) → ${total}.`,
    },
  };
}

function turnStarted(slice: DrawSteelState, envelope: Envelope): Applied {
  const { id, gain, rolls } = decode("ds.turn-started", envelope);
  if (!slice.combat.active) bad(envelope, "comes outside combat");
  if (slice.combat.acting !== undefined) bad(envelope, "starts a turn during another");
  const found = who(slice, envelope, id);
  const acted = slice.combat.acted.includes(id) ? slice.combat.acted : [...slice.combat.acted, id];
  const { moved: _moved, ...combat } = slice.combat;
  let next: DrawSteelState = { ...slice, combat: { ...combat, acted, acting: id } };
  let text = `${found.name}'s turn.`;
  if (gain !== undefined) {
    const h = hero(slice, envelope, id);
    next = withHero(next, id, (x) => ({ ...x, resource: x.resource + gain }));
    const dice = rolls === undefined ? "" : ` (${h.sheet.resource.perTurn}: ${rolls.join(", ")})`;
    text += ` ${h.sheet.resource.name} ${signed(gain) || "+0"}${dice} → ${h.resource + gain}.`;
  }
  return { slice: next, feed: { kind: "ds-turn", text } };
}

function turnEnded(slice: DrawSteelState, envelope: Envelope): Applied {
  const { id, ended, saves } = decode("ds.turn-ended", envelope);
  if (slice.combat.acting !== id) bad(envelope, `ends a turn '${id}' isn't taking`);
  if (saves.some((s) => s.roll < 1 || s.roll > 10)) bad(envelope, "has a save that isn't a d10");
  const gone = new Set([...ended, ...saves.filter((s) => s.ends).map((s) => s.condition)]);
  const { acting: _acting, moved: _moved, ...combat } = slice.combat;
  const next = withWho({ ...slice, combat }, envelope, id, (x) => ({
    ...x,
    conditions: x.conditions.filter((c) => !gone.has(c.name)),
  }));
  const parts = [
    `${nameOf(slice, id)}'s turn ends.`,
    ...ended.map((c) => `${capitalized(c)} ends.`),
    ...saves.map(
      (s) => `Save against ${s.condition}: ${s.roll}, ${s.ends ? "it ends" : "it goes on"}.`,
    ),
  ];
  return { slice: next, feed: { kind: "ds-turn", text: parts.join(" ") } };
}

/**
 * The end of an encounter: unspent heroic resources and Malice are lost (Classes; Monster Basics,
 * "Earning Malice"), as are surges; temporary Stamina disappears and every condition from the
 * fight ends (Combat, "Temporary Stamina", "End of Combat"). Winded and dying are Stamina, so stay.
 */
function combatEnded(slice: DrawSteelState, envelope: Envelope): Applied {
  const { cleared = [] } = decode("ds.combat-ended", envelope);
  if (!slice.combat.active) bad(envelope, "comes outside combat");
  // The creatures leave the table, so a creature's token left off the list can't stay behind.
  const gone = new Set(cleared);
  const left = slice.creatures.find(
    (c) => slice.map?.tokens[c.id] !== undefined && !gone.has(c.id),
  );
  if (left !== undefined) bad(envelope, `leaves '${left.id}' on the map`);
  const map =
    slice.map === undefined
      ? undefined
      : {
          ...slice.map,
          tokens: Object.fromEntries(
            Object.entries(slice.map.tokens).filter(([id]) => !gone.has(id)),
          ),
        };
  return {
    slice: {
      ...slice,
      ...(map !== undefined && { map }),
      combat: NO_COMBAT,
      creatures: [],
      blocks: {},
      malice: 0,
      heroes: slice.heroes.map((h) => ({
        ...h,
        resource: 0,
        surges: 0,
        temp: 0,
        conditions: [],
      })),
    },
    feed: {
      kind: "ds-turn",
      text: "Combat ends. Heroic resources, surges and Malice are lost; temporary Stamina and conditions end.",
    },
  };
}

/**
 * A respite: Stamina and Recoveries back to full, and Victories become XP and reset to 0 (The
 * Basics, "Respite"). The heroes decide found dead stay as they are.
 */
function rested(slice: DrawSteelState, envelope: Envelope): Applied {
  const { dead = [] } = decode("ds.rested", envelope);
  const resting = slice.heroes.filter((h) => !dead.includes(h.id));
  const xp = resting.filter((h) => h.victories > 0).map((h) => `${h.sheet.name} ${h.victories}`);
  const named = dead.map((id) => hero(slice, envelope, id).sheet.name);
  const text = [
    "The party rests: Stamina and Recoveries are back to full.",
    ...(xp.length > 0 ? [`Victories become XP: ${xp.join(", ")}.`] : []),
    ...(named.length > 0
      ? [
          `${andList(named)} ${named.length === 1 ? "is dead and doesn't" : "are dead and don't"} recover.`,
        ]
      : []),
  ].join(" ");
  return {
    slice: {
      ...slice,
      heroes: slice.heroes.map((h) =>
        dead.includes(h.id)
          ? h
          : {
              ...h,
              stamina: h.sheet.stamina,
              recoveries: h.sheet.recoveries,
              temp: 0,
              victories: 0,
              xp: h.xp + h.victories,
            },
      ),
    },
    feed: { kind: "ds", text },
  };
}

/** "8 + M damage" read with the hero's Might of 2: "8 + M (2) = 10 damage". */
const withScores = (text: string, sheet: HeroSheet) =>
  text.replace(/\b(\d+) \+ ([MARIP])\b/g, (_match, n: string, letter: string) => {
    const score = sheet.characteristics[characteristicOfLetter(letter)!];
    return `${n} + ${letter} (${score}) = ${Number(n) + score}`;
  });

const abilitiesOf = (slice: DrawSteelState, found: Who): ReadonlyArray<Ability> =>
  found.kind === "hero"
    ? found.hero.sheet.abilities
    : (slice.blocks[found.creature.block]?.abilities ?? []);

/** A cost off the hero's resource or the Malice pool, and how the feed says it: " (3 Wrath → 1)". */
function spend(
  slice: DrawSteelState,
  envelope: Envelope,
  found: Who,
  cost: number | undefined,
): { readonly next: DrawSteelState; readonly paid: string } {
  if (cost !== undefined && cost < 0) bad(envelope, "has a negative cost");
  if (found.kind === "creature" && slice.malice - (cost ?? 0) < 0)
    bad(envelope, "spends Malice the Director doesn't have");
  if (cost === undefined || cost === 0) return { next: slice, paid: "" };
  if (found.kind === "hero") {
    const after = found.hero.resource - cost;
    return {
      next: withHero(slice, found.id, (h) => ({ ...h, resource: after })),
      paid: ` (${cost} ${found.hero.sheet.resource.name} → ${after})`,
    };
  }
  const malice = slice.malice - cost;
  return { next: { ...slice, malice }, paid: ` (${cost} Malice → ${malice})` };
}

/** Sentences run together with one full stop between: "6 damage. Effect: …". */
const sentences = (parts: ReadonlyArray<string | undefined>) =>
  parts
    .filter((p): p is string => p !== undefined && p !== "")
    .map((p) => p.replace(/\.$/, ""))
    .join(". ");

/**
 * A power roll as decide scored it: the stored total and tier are trusted, so a later change to
 * the scoring never halts an old log. A cost comes off the hero's resource or the Malice pool.
 * The line names its targets, the tier's text and the ability's effect, and any target that
 * stood past the ability's reach; the damage follows in its own events.
 */
function powerRolled(slice: DrawSteelState, envelope: Envelope): Applied {
  const p = decode("ds.power-rolled", envelope);
  const found = who(slice, envelope, p.id);
  if (p.dice.some((d) => d < 1 || d > 10)) bad(envelope, "has dice that aren't d10s");
  const targets = (p.targets ?? []).map((t) => ({ ...t, name: who(slice, envelope, t.id).name }));
  const ability = abilitiesOf(slice, found).find((a) => a.name === p.ability);
  const printed = ability?.[`tier${p.tier}`];
  const tierText =
    printed !== undefined && found.kind === "hero"
      ? withScores(printed, found.hero.sheet)
      : printed;
  const { next, paid } = spend(slice, envelope, found, p.cost);
  const at = targets.length === 0 ? "" : ` on ${andList(targets.map((t) => t.name))}`;
  const head =
    p.ability !== undefined
      ? `${found.name} uses ${p.ability}${at}${paid}:`
      : p.characteristic !== undefined
        ? `${found.name} rolls ${capitalized(p.characteristic)}${at}:`
        : `${found.name} rolls${at}:`;
  const net = Math.min(p.edges, 2) - Math.min(p.banes, 2);
  const natural = p.dice[0] + p.dice[1] >= 19;
  const notes = [
    ...(net === 2 ? ["double edge"] : net === -2 ? ["double bane"] : []),
    ...(natural ? [`natural ${p.dice[0] + p.dice[1]}`] : []),
  ];
  const said = sentences([tierText, ability?.effect && `Effect: ${ability.effect}`]);
  const reach = ability === undefined ? undefined : reachOf(ability);
  const far = targets
    .filter((t) => reach !== undefined && t.apart !== undefined && t.apart > reach)
    .map((t) => `${t.name} is ${plural(t.apart!, "square")} away`);
  const text = [
    head,
    `[${p.dice[0]}, ${p.dice[1]}]`,
    ...(p.bonus !== 0 ? [signed(p.bonus)] : []),
    ...(net === 1 ? ["+2 edge"] : net === -1 ? ["-2 bane"] : []),
    `= ${p.total}${notes.length > 0 ? `, ${notes.join(", ")}` : ""}`,
    `· tier ${p.tier}${said !== "" ? ` — ${said}${ability?.effect !== undefined ? "." : ""}` : ""}`,
    ...(far.length > 0 ? [`(${far.join("; ")}; ${ability?.distance})`] : []),
  ].join(" ");
  return { slice: next, feed: { kind: "ds-roll", text } };
}

/** An ability with no power roll: its cost spent, and its effect for the table to read. */
function abilityUsed(slice: DrawSteelState, envelope: Envelope): Applied {
  const p = decode("ds.ability-used", envelope);
  const found = who(slice, envelope, p.id);
  if (!isSafe(p.ability)) bad(envelope, "holds control characters");
  const effect = abilitiesOf(slice, found).find((a) => a.name === p.ability)?.effect;
  const { next, paid } = spend(slice, envelope, found, p.cost);
  const text = `${found.name} uses ${p.ability}${paid}${effect === undefined ? "." : `: ${effect}`}`;
  return { slice: next, feed: { kind: "ds-roll", text } };
}

/** Bleeding's Stamina loss: not damage, so temporary Stamina doesn't take it (Classes, "Bleeding"). */
function bled(slice: DrawSteelState, envelope: Envelope): Applied {
  const { id, roll, level } = decode("ds.bled", envelope);
  const found = who(slice, envelope, id);
  if (roll < 1 || roll > 6) bad(envelope, `has a d6 of ${roll}`);
  if (level < 0) bad(envelope, "has a negative level");
  const loss = roll + level;
  const lost = withWho(slice, envelope, id, (x) => ({
    ...x,
    stamina: "sheet" in x ? x.stamina - loss : Math.max(0, x.stamina - loss),
  }));
  const next = buried(slice, lost, id);
  return {
    slice: next,
    feed: {
      kind: "ds",
      text: `${found.name} bleeds and loses ${loss} Stamina (1d6: ${roll}, + level ${level}) → ${meter(next, id)}`,
    },
  };
}

/**
 * A creature's traits that start at half Stamina, as " · Name: effect", when this change took
 * it there: the Director has them in front of them as it happens.
 */
function windedTraits(before: Who, after: Who | undefined, slice: DrawSteelState): string {
  if (before.kind !== "creature" || after?.kind !== "creature") return "";
  if (creatureHealth(before.creature) !== undefined) return "";
  if (creatureHealth(after.creature) !== "winded") return "";
  return (slice.blocks[after.creature.block]?.abilities ?? [])
    .filter((a) => isTrait(a) && /half (its |their )?stamina|winded/i.test(a.effect ?? ""))
    .map((a) => ` · ${a.name}: ${a.effect}`)
    .join("");
}

function damaged(slice: DrawSteelState, envelope: Envelope): Applied {
  const p = decode("ds.damaged", envelope);
  const target = who(slice, envelope, p.id);
  if (p.dealt < 0 || p.amount < 0) bad(envelope, "deals negative damage");
  if (p.type !== undefined && !isSafe(p.type)) bad(envelope, "holds control characters");
  const temp = target.kind === "hero" ? target.hero.temp : target.creature.temp;
  const fromTemp = Math.min(temp, p.dealt);
  const before = target.kind === "creature" ? minionsLeft(target.creature) : 0;
  const hit = withWho(slice, envelope, p.id, (x) => ({
    ...x,
    temp: x.temp - fromTemp,
    stamina:
      "sheet" in x
        ? x.stamina - (p.dealt - fromTemp)
        : Math.max(0, x.stamina - (p.dealt - fromTemp)),
  }));
  const next = buried(slice, hit, p.id);
  const details: string[] = [];
  if (p.weakness !== undefined || p.immunity !== undefined)
    details.push(
      `${p.amount}${p.weakness !== undefined ? ` +${p.weakness} weakness` : ""}${p.immunity !== undefined ? ` -${p.immunity} immunity` : ""}`,
    );
  if (fromTemp > 0) details.push(`${fromTemp} to temporary Stamina`);
  let squad = "";
  const after = findWho(next, p.id);
  if (after?.kind === "creature" && after.creature.squad !== undefined) {
    const left = minionsLeft(after.creature);
    const died = before - left;
    if (left === 0) squad = " · the squad is dead";
    else if (died > 0)
      squad = ` · ${plural(died, "minion")} ${died === 1 ? "dies" : "die"}, ${left} left`;
  }
  if (p.minions !== undefined && p.minions < 1) bad(envelope, "has a squad strike of no minions");
  const together = p.minions === undefined ? "" : ` (${plural(p.minions, "minion")})`;
  const far = p.apart !== undefined && p.apart > 1 ? ` from ${plural(p.apart, "square")} away` : "";
  const source =
    p.source === undefined ? "" : `${nameOf(slice, p.source)} free strikes${together}${far}: `;
  const text = `${source}${target.name} takes ${p.dealt}${p.type !== undefined ? ` ${p.type}` : ""} damage${details.length > 0 ? ` (${details.join("; ")})` : ""} → ${meter(next, p.id)}${squad}${windedTraits(target, after, next)}`;
  return { slice: next, feed: { kind: "ds", text } };
}

function healed(slice: DrawSteelState, envelope: Envelope): Applied {
  const { id, amount } = decode("ds.healed", envelope);
  const target = who(slice, envelope, id);
  if (amount < 0) bad(envelope, "heals a negative amount");
  if (target.kind === "creature" && target.creature.squad !== undefined)
    bad(envelope, "heals minions");
  const [stamina, max] =
    target.kind === "hero"
      ? [target.hero.stamina, target.hero.sheet.stamina]
      : [target.creature.stamina, target.creature.max];
  if (stamina + amount > max) bad(envelope, `heals '${id}' past full Stamina`);
  const next = withWho(slice, envelope, id, (x) => ({ ...x, stamina: x.stamina + amount }));
  return {
    slice: next,
    feed: { kind: "ds", text: `${target.name} regains ${amount} Stamina → ${meter(next, id)}` },
  };
}

function tempSet(slice: DrawSteelState, envelope: Envelope): Applied {
  const { id, temp } = decode("ds.temp-set", envelope);
  const target = who(slice, envelope, id);
  if (temp < 0) bad(envelope, "sets negative temporary Stamina");
  const next = withWho(slice, envelope, id, (x) => ({ ...x, temp }));
  return {
    slice: next,
    feed: { kind: "ds", text: `${target.name} has ${temp} temporary Stamina.` },
  };
}

function recovered(slice: DrawSteelState, envelope: Envelope): Applied {
  const { id, amount, ally } = decode("ds.recovered", envelope);
  const h = hero(slice, envelope, id);
  if (h.recoveries < 1) bad(envelope, "spends a Recovery the hero doesn't have");
  if (amount < 0) bad(envelope, "heals a negative amount");
  const next = withHero(slice, id, (x) => ({
    ...x,
    stamina: x.stamina + amount,
    recoveries: x.recoveries - 1,
  }));
  const how = ally ? " through an ally" : "";
  return {
    slice: next,
    feed: {
      kind: "ds",
      text: `${h.sheet.name} spends a Recovery${how} and regains ${amount} Stamina → ${meter(next, id)} (${h.recoveries - 1}/${h.sheet.recoveries} left)`,
    },
  };
}

function conditionSet(slice: DrawSteelState, envelope: Envelope): Applied {
  const { id, condition, duration } = decode("ds.condition-set", envelope);
  const target = who(slice, envelope, id);
  const set: Condition = { name: condition, duration };
  const next = withWho(slice, envelope, id, (x) => ({
    ...x,
    conditions: x.conditions.some((c) => c.name === condition)
      ? x.conditions.map((c) => (c.name === condition ? set : c))
      : [...x.conditions, set],
  }));
  return {
    slice: next,
    feed: { kind: "ds", text: `${target.name} is ${condition}${durationText(set)}.` },
  };
}

function conditionRemoved(slice: DrawSteelState, envelope: Envelope): Applied {
  const { id, condition } = decode("ds.condition-removed", envelope);
  const target = who(slice, envelope, id);
  const next = withWho(slice, envelope, id, (x) => ({
    ...x,
    conditions: x.conditions.filter((c) => c.name !== condition),
  }));
  return { slice: next, feed: { kind: "ds", text: `${target.name} is no longer ${condition}.` } };
}

function saved(slice: DrawSteelState, envelope: Envelope): Applied {
  const { id, condition, roll, ends } = decode("ds.saved", envelope);
  const target = who(slice, envelope, id);
  if (roll < 1 || roll > 10) bad(envelope, `has a d10 of ${roll}`);
  const next = ends
    ? withWho(slice, envelope, id, (x) => ({
        ...x,
        conditions: x.conditions.filter((c) => c.name !== condition),
      }))
    : slice;
  const text = ends
    ? `${target.name} saves against ${condition}: ${roll}, it ends.`
    : `${target.name} fails a save against ${condition}: ${roll}.`;
  return { slice: next, feed: { kind: "ds-roll", text } };
}

/** "Vex gains 2 Wrath → 4." or "Vex spends 1 Wrath → 3." */
const gainOrSpend = (name: string, by: number, what: string, after: number) =>
  `${name} ${by > 0 ? "gains" : "spends"} ${what} → ${after}.`;

function resourceChanged(slice: DrawSteelState, envelope: Envelope): Applied {
  const { id, by } = decode("ds.resource-changed", envelope);
  const h = hero(slice, envelope, id);
  const next = withHero(slice, id, (x) => ({ ...x, resource: x.resource + by }));
  return {
    slice: next,
    feed: {
      kind: "ds",
      text: gainOrSpend(
        h.sheet.name,
        by,
        `${Math.abs(by)} ${h.sheet.resource.name}`,
        h.resource + by,
      ),
    },
  };
}

function surgesChanged(slice: DrawSteelState, envelope: Envelope): Applied {
  const { id, by } = decode("ds.surges-changed", envelope);
  const h = hero(slice, envelope, id);
  if (h.surges + by < 0) bad(envelope, "spends surges the hero doesn't have");
  const next = withHero(slice, id, (x) => ({ ...x, surges: x.surges + by }));
  return {
    slice: next,
    feed: {
      kind: "ds",
      text: gainOrSpend(h.sheet.name, by, plural(Math.abs(by), "surge"), h.surges + by),
    },
  };
}

function maliceChanged(slice: DrawSteelState, envelope: Envelope): Applied {
  const { by, reason } = decode("ds.malice-changed", envelope);
  if (slice.malice + by < 0) bad(envelope, "spends Malice the Director doesn't have");
  if (reason !== undefined && !isSafe(reason)) bad(envelope, "holds control characters");
  const malice = slice.malice + by;
  const why = reason === undefined ? "" : ` (${reason})`;
  return {
    slice: { ...slice, malice },
    feed: { kind: "ds", text: `Malice ${signed(by)}${why} → ${malice}.` },
  };
}

function tokensChanged(slice: DrawSteelState, envelope: Envelope): Applied {
  const { by } = decode("ds.tokens-changed", envelope);
  if (slice.tokens + by < 0) bad(envelope, "spends hero tokens the party doesn't have");
  const tokens = slice.tokens + by;
  const text =
    by < 0
      ? `spends ${plural(-by, "hero token")} → ${tokens}.`
      : `gives the party ${plural(by, "hero token")} → ${tokens}.`;
  return { slice: { ...slice, tokens }, feed: { kind: "ds-act", text } };
}

function tokensReset(slice: DrawSteelState, envelope: Envelope): Applied {
  const { tokens } = decode("ds.tokens-reset", envelope);
  if (tokens < 0) bad(envelope, "sets negative hero tokens");
  return {
    slice: { ...slice, tokens },
    feed: { kind: "ds", text: `Hero tokens reset to ${tokens}, one per hero.` },
  };
}

function victoriesChanged(slice: DrawSteelState, envelope: Envelope): Applied {
  const { ids, by } = decode("ds.victories-changed", envelope);
  let next = slice;
  for (const id of ids) {
    const h = hero(slice, envelope, id);
    if (h.victories + by < 0) bad(envelope, "takes Victories below 0");
    next = withHero(next, id, (x) => ({ ...x, victories: x.victories + by }));
  }
  const list = ids.map((id) => {
    const h = hero(next, envelope, id);
    return `${h.sheet.name} ${h.victories}`;
  });
  return {
    slice: next,
    feed: { kind: "ds", text: `Victories ${signed(by)}: ${list.join(", ")}.` },
  };
}

/** The loaded map, or a halt: a map event without one can't be applied. */
const boardOf = (slice: DrawSteelState, envelope: Envelope): Board =>
  slice.map ?? bad(envelope, "comes with no map loaded");

const withToken = (
  slice: DrawSteelState,
  board: Board,
  id: string,
  at: Square,
): DrawSteelState => ({
  ...slice,
  map: { ...board, tokens: { ...board.tokens, [id]: at } },
});

/** Checks a decided path: each square next to the one before and one a creature can stand on. */
function checkPath(
  envelope: Envelope,
  board: Board,
  from: Square,
  path: ReadonlyArray<Square>,
): void {
  let here = from;
  for (const square of path) {
    if (distance(here, square) !== 1 || !standable(board.terrain, square))
      bad(envelope, `has a path that can't go to ${formatSquare(square)}`);
    here = square;
  }
}

/**
 * A map the event carries. Replay checks only what drawing it needs (rows of one width, in
 * printable ASCII, a plain name), never today's size limits, so tightening those later never
 * stops an old log.
 */
function mapLoaded(slice: DrawSteelState, envelope: Envelope): Applied {
  const { id, name, terrain, dressing } = decode("ds.map-loaded", envelope);
  const why = misshapen({ name, terrain });
  if (why !== undefined) bad(envelope, `has a bad grid: ${why}`);
  const width = terrain[0]!.length;
  return {
    slice: {
      ...slice,
      map: {
        id,
        name,
        terrain: [...terrain],
        ...(dressing ? { dressing: [...dressing] } : {}),
        tokens: {},
      },
    },
    feed: { kind: "ds", text: `The map is ${name}, ${width} by ${terrain.length}.` },
  };
}

function mapCleared(slice: DrawSteelState, envelope: Envelope): Applied {
  decode("ds.map-cleared", envelope);
  boardOf(slice, envelope);
  const { map: _map, ...rest } = slice;
  return { slice: rest, feed: { kind: "ds", text: "The map is put away." } };
}

function placed(slice: DrawSteelState, envelope: Envelope): Applied {
  const { id, at } = decode("ds.placed", envelope);
  const board = boardOf(slice, envelope);
  const found = who(slice, envelope, id);
  if (!standable(board.terrain, at)) bad(envelope, `places '${id}' where nobody can stand`);
  return {
    slice: withToken(slice, board, id, at),
    feed: { kind: "ds", text: `${found.name} is placed at ${formatSquare(at)}.` },
  };
}

function moved(slice: DrawSteelState, envelope: Envelope): Applied {
  const { id, path, cost, speed, spent, allowance, main } = decode("ds.moved", envelope);
  const board = boardOf(slice, envelope);
  const found = who(slice, envelope, id);
  const from = board.tokens[id] ?? bad(envelope, `moves '${id}', who isn't on the map`);
  const to = path.at(-1) ?? bad(envelope, "has an empty path");
  checkPath(envelope, board, from, path);
  if (cost < path.length) bad(envelope, "costs less than its squares");
  let next = withToken(slice, board, id, to);
  let turn = "";
  let over = cost > speed ? `, over speed ${speed}` : "";
  if (spent !== undefined || allowance !== undefined) {
    if (spent === undefined || allowance === undefined) bad(envelope, "has half a turn's movement");
    if (slice.combat.acting !== id) bad(envelope, `counts a turn '${id}' isn't taking`);
    if (spent < cost) bad(envelope, "spends less than it moves");
    next = { ...next, combat: { ...next.combat, moved: { id, spent, main: main === true } } };
    if (spent > cost || main === true)
      turn = `, ${spent} of ${allowance} this turn${main === true ? " with the main action" : ""}`;
    over = spent > allowance ? `, over speed ${speed}` : "";
  }
  return {
    slice: next,
    feed: {
      kind: "ds",
      text: `${found.name} moves to ${formatSquare(to)} (${plural(cost, "square")} of movement${turn}${over}).`,
    },
  };
}

const FORCED_VERBS = { push: "pushed", pull: "pulled", slide: "slid" } as const;

/** " (a; b)" from the parts that say something, or nothing. */
const parenthesis = (parts: ReadonlyArray<string>) => {
  const said = parts.filter((p) => p !== "");
  return said.length === 0 ? "" : ` (${said.join("; ")})`;
};

function forceMoved(slice: DrawSteelState, envelope: Envelope): Applied {
  const p = decode("ds.force-moved", envelope);
  const board = boardOf(slice, envelope);
  const found = who(slice, envelope, p.id);
  const from = board.tokens[p.id] ?? bad(envelope, `moves '${p.id}', who isn't on the map`);
  if (p.from !== undefined && !sameSquare(p.from, from))
    bad(
      envelope,
      `moves '${p.id}' from ${formatSquare(p.from)}, but they stand at ${formatSquare(from)}`,
    );
  checkPath(envelope, board, from, p.path);
  if (p.slam !== undefined && p.slam.remaining < 1) bad(envelope, "slams with nothing left");
  const into =
    p.slam === undefined
      ? undefined
      : p.slam.into === "wall"
        ? "a wall"
        : who(slice, envelope, p.slam.into).name;
  const to = p.path.at(-1);
  const verb = FORCED_VERBS[p.kind];
  const text = [
    `${found.name} is ${verb}`,
    to === undefined
      ? " but doesn't move"
      : ` ${plural(p.path.length, "square")} to ${formatSquare(to)}`,
    p.slam === undefined
      ? ""
      : ` and slams into ${into} with ${plural(p.slam.remaining, "square")} to go`,
    p.edge === true ? ", stopped by the map's edge" : "",
    parenthesis([
      p.stability > 0 ? `${p.kind} ${p.distance}, stability ${p.stability}` : "",
      p.apart !== undefined && p.apart > 1 && p.source !== undefined
        ? `${nameOf(slice, p.source)} is ${plural(p.apart, "square")} away`
        : "",
    ]),
    ".",
  ].join("");
  return {
    slice: to === undefined ? slice : withToken(slice, board, p.id, to),
    feed: { kind: "ds", text },
  };
}

function measured(slice: DrawSteelState, envelope: Envelope): Applied {
  const { from, to, distance: squares } = decode("ds.measured", envelope);
  if (squares < 0) bad(envelope, "measures a negative distance");
  const label = (point: { readonly id?: string; readonly at: Square }) =>
    point.id === undefined
      ? formatSquare(point.at)
      : `${who(slice, envelope, point.id).name} (${formatSquare(point.at)})`;
  return {
    slice,
    feed: {
      kind: "ds-act",
      text: `measures ${label(from)} to ${label(to)}: ${plural(squares, "square")}.`,
    },
  };
}

const appliers: Readonly<
  Record<EventType, (slice: DrawSteelState, envelope: Envelope) => Applied>
> = {
  "ds.hero-joined": heroJoined,
  "ds.hero-claimed": heroClaimed,
  "ds.hero-released": heroReleased,
  "ds.creatures-added": creaturesAdded,
  "ds.combat-started": combatStarted,
  "ds.first-set": firstSet,
  "ds.round-started": roundStarted,
  "ds.turn-started": turnStarted,
  "ds.turn-ended": turnEnded,
  "ds.combat-ended": combatEnded,
  "ds.rested": rested,
  "ds.power-rolled": powerRolled,
  "ds.ability-used": abilityUsed,
  "ds.bled": bled,
  "ds.damaged": damaged,
  "ds.healed": healed,
  "ds.temp-set": tempSet,
  "ds.recovered": recovered,
  "ds.condition-set": conditionSet,
  "ds.condition-removed": conditionRemoved,
  "ds.saved": saved,
  "ds.resource-changed": resourceChanged,
  "ds.surges-changed": surgesChanged,
  "ds.malice-changed": maliceChanged,
  "ds.tokens-changed": tokensChanged,
  "ds.tokens-reset": tokensReset,
  "ds.victories-changed": victoriesChanged,
  "ds.map-loaded": mapLoaded,
  "ds.map-cleared": mapCleared,
  "ds.placed": placed,
  "ds.moved": moved,
  "ds.force-moved": forceMoved,
  "ds.measured": measured,
};

/** Folds one Draw Steel event. Throws on one it can't apply, so the writer halts. */
export function apply(slice: DrawSteelState, envelope: Envelope): Applied {
  const applier = appliers[envelope.type as EventType];
  if (applier === undefined) throw new Error(`ds can't apply "${envelope.type}"`);
  return applier(slice, envelope);
}
