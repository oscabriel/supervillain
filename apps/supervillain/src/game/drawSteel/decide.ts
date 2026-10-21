import type { Decision, Dice, NewEvent } from "@supervillain/engine";
import { parseNotation } from "../dice.ts";
import { GM, type Refused } from "../module.ts";
import { cleanText, hasControls, quote } from "../text.ts";
import { type DsCommand, SQUAD_SIZE } from "./commands.ts";
import { event } from "./events.ts";
import { modifiedDamage, powerRoll } from "./math.ts";
import { decodeHeroSheet, decodeStatBlock, ID } from "./schema.ts";
import type { Characteristic, Characteristics } from "./sheets.ts";
import {
  capitalized,
  CHARACTERISTICS,
  conditionsOf,
  controls,
  type DrawSteelState,
  everyone,
  findWho,
  type Hero,
  heroHealth,
  heroOf,
  isDead,
  minionsLeft,
  nextSide,
  pick,
  plural,
  resolve,
  roundOver,
  type Who,
} from "./state.ts";

const refuse = (refusal: string): Refused => ({ refusal });
const decided = (...events: NewEvent[]): Decision => ({ events });

const NO_COMBAT = "No combat is running; /start one.";
const OWN = "You can only change your own hero.";

/** One die from the host's dice, checked: a bad face is a host bug, so it throws. */
function roll(dice: Dice, sides: number): number {
  const face = dice(sides);
  if (!Number.isInteger(face) || face < 1 || face > sides)
    throw new Error(`the dice gave ${face} for a d${sides}`);
  return face;
}

/** A target the actor may change, or why not. */
function changeable(slice: DrawSteelState, actor: string, typed: string): Who | Refused {
  const who = resolve(slice, typed);
  if ("refusal" in who) return who;
  if (!controls(actor, who)) return refuse(OWN);
  return who;
}

/** A hero the actor may change, or why not. */
function changeableHero(
  slice: DrawSteelState,
  actor: string,
  typed: string,
  what: string,
): Hero | Refused {
  const who = resolve(slice, typed);
  if ("refusal" in who) return who;
  if (who.kind !== "hero") return refuse(`Only heroes have ${what}; ${who.name} is a creature.`);
  if (!controls(actor, who)) return refuse(OWN);
  return who.hero;
}

const modifiersOf = (slice: DrawSteelState, who: Who) =>
  who.kind === "hero" ? who.hero.sheet : (slice.blocks[who.creature.block] ?? {});

const staminaOf = (who: Who) =>
  who.kind === "hero"
    ? { stamina: who.hero.stamina, max: who.hero.sheet.stamina, temp: who.hero.temp }
    : { stamina: who.creature.stamina, max: who.creature.max, temp: who.creature.temp };

/** Lowercase letters, digits and dashes from a name: "Snik the Bold" is "snik-the-bold". */
const slug = (name: string) =>
  name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

function addHero(slice: DrawSteelState, command: Extract<DsCommand, { type: "hero" }>): Decision {
  if (command.sheet === undefined)
    return refuse(`No hero sheet for '${quote(command.hero)}' was loaded.`);
  const sheet = decodeHeroSheet(command.sheet);
  if ("refusal" in sheet) return sheet;
  if (slice.creatures.some((c) => c.id === sheet.id))
    return refuse(`'${sheet.id}' is already a creature's id.`);
  return decided(event("ds.hero-joined", { sheet }));
}

function addCreatures(
  slice: DrawSteelState,
  command: Extract<DsCommand, { type: "add" }>,
): Decision {
  if (command.sheet === undefined)
    return refuse(`No stat block for '${quote(command.monster)}' was loaded.`);
  const block = decodeStatBlock(command.sheet);
  if ("refusal" in block) return block;
  let baseName = block.name;
  let baseId = block.id;
  if (command.as !== undefined) {
    const name = cleanText(command.as);
    if (name === "" || name.length > 32 || hasControls(name))
      return refuse("Pick a plain name of up to 32 characters.");
    baseName = name;
    baseId = ID.test(slug(name)) ? slug(name) : block.id;
  }
  const taken = new Set(everyone(slice).map((w) => w.id));
  const creatures: { id: string; name: string; squad?: number }[] = [];
  const claim = (id: string, name: string, squad?: number) => {
    taken.add(id);
    creatures.push(squad === undefined ? { id, name } : { id, name, squad });
  };
  if (block.organization === "minion") {
    for (let left = command.count; left > 0; left -= SQUAD_SIZE) {
      const letter = [...LETTERS].find((l) => !taken.has(`${baseId}-${l}`));
      if (letter === undefined) return refuse(`There are too many squads of ${baseName} already.`);
      claim(
        `${baseId}-${letter}`,
        `${baseName} ${letter.toUpperCase()}`,
        Math.min(left, SQUAD_SIZE),
      );
    }
  } else {
    const numberedAlready = [...taken].some(
      (id) => id.startsWith(`${baseId}-`) && /^\d+$/.test(id.slice(baseId.length + 1)),
    );
    if (command.count === 1 && !taken.has(baseId) && !numberedAlready) claim(baseId, baseName);
    else
      for (let n = 1; creatures.length < command.count; n++)
        if (!taken.has(`${baseId}-${n}`)) claim(`${baseId}-${n}`, `${baseName} ${n}`);
  }
  return decided(event("ds.creatures-added", { block, creatures }));
}

function play(
  slice: DrawSteelState,
  actor: string,
  command: Extract<DsCommand, { type: "play" }>,
): Decision {
  const who = resolve(slice, command.hero);
  if ("refusal" in who) return who;
  if (who.kind !== "hero") return refuse(`${who.name} is a creature; the GM plays it.`);
  const hero = who.hero;
  if (actor === GM) {
    if (command.player === undefined)
      return refuse("The GM plays every creature; /play <hero> <player> gives a hero to a player.");
    const label = cleanText(command.player);
    const player = command.playerActor;
    if (player === undefined || player === GM)
      return refuse(`Nobody at the table is called '${quote(command.player)}'.`);
    const theirs = heroOf(slice, player);
    if (theirs !== undefined) return refuse(`${quote(label)} already plays ${theirs.sheet.name}.`);
    if (hero.player !== undefined)
      return refuse(`${hero.sheet.name} is taken; /unplay ${hero.id} first.`);
    return decided(event("ds.hero-claimed", { hero: hero.id, player, label: quote(label, 40) }));
  }
  if (command.player !== undefined) return refuse("Only the GM can give a hero to someone else.");
  const own = heroOf(slice, actor);
  if (own !== undefined) return refuse(`You already play ${own.sheet.name}.`);
  if (hero.player !== undefined) return refuse(`${hero.sheet.name} is taken.`);
  return decided(event("ds.hero-claimed", { hero: hero.id, player: actor }));
}

function unplay(
  slice: DrawSteelState,
  actor: string,
  command: Extract<DsCommand, { type: "unplay" }>,
): Decision {
  if (actor === GM) {
    if (command.hero === undefined) return refuse("Name the hero to free: /unplay <hero>.");
    const who = resolve(slice, command.hero);
    if ("refusal" in who) return who;
    if (who.kind !== "hero" || who.hero.player === undefined)
      return refuse(`Nobody plays ${who.name}.`);
    return decided(event("ds.hero-released", { hero: who.id }));
  }
  const own = heroOf(slice, actor);
  if (own === undefined) return refuse("You don't play a hero.");
  if (command.hero !== undefined) {
    const who = resolve(slice, command.hero);
    if ("refusal" in who) return who;
    if (who.id !== own.id) return refuse("You can only stop playing your own hero.");
  }
  return decided(event("ds.hero-released", { hero: own.id }));
}

function start(slice: DrawSteelState, dice: Dice): Decision {
  if (slice.combat.active) return refuse("A combat is already running; /end it first.");
  const face = roll(dice, 10);
  const living = slice.heroes.filter((h) => heroHealth(h) !== "dead");
  const total = living.reduce((sum, h) => sum + h.victories, 0);
  const victories = living.length === 0 ? 0 : Math.floor(total / living.length);
  const gains = Object.fromEntries(living.map((h) => [h.id, h.victories]));
  return decided(
    event("ds.combat-started", {
      roll: face,
      gains,
      malice: { victories, heroes: living.length, round: 1 },
    }),
  );
}

/** The end of the acting creature's turn: its EoT conditions end, and each save-ends one rolls. */
function turnEnd(slice: DrawSteelState, id: string, dice: Dice): NewEvent {
  const who = findWho(slice, id);
  const conditions = who === undefined ? [] : conditionsOf(who);
  return event("ds.turn-ended", {
    id,
    ended: conditions.filter((c) => c.duration === "eot").map((c) => c.name),
    saves: conditions
      .filter((c) => c.duration === "save")
      .map((c) => ({ condition: c.name, roll: roll(dice, 10) })),
  });
}

function roundStart(slice: DrawSteelState): NewEvent {
  const round = slice.combat.round + 1;
  const heroes = slice.heroes.filter((h) => heroHealth(h) !== "dead").length;
  return event("ds.round-started", { round, heroes, malice: heroes + round });
}

/** A turn's start: a hero gains its sheet's per-turn resource, rolling when it says dice. */
function turnStart(who: Who, dice: Dice): NewEvent {
  if (who.kind !== "hero") return event("ds.turn-started", { id: who.id });
  const perTurn = who.hero.sheet.resource.perTurn;
  if (typeof perTurn === "number" || /^\d+$/.test(perTurn)) {
    const gain = Number(perTurn);
    return event("ds.turn-started", gain === 0 ? { id: who.id } : { id: who.id, gain });
  }
  const notation = parseNotation(perTurn);
  if ("refusal" in notation) return event("ds.turn-started", { id: who.id });
  const rolls = Array.from({ length: notation.count }, () => roll(dice, notation.sides));
  const gain = rolls.reduce((a, b) => a + b, 0) + notation.modifier;
  return event("ds.turn-started", { id: who.id, gain, rolls });
}

function turn(
  slice: DrawSteelState,
  actor: string,
  command: Extract<DsCommand, { type: "turn" }>,
  dice: Dice,
): Decision {
  const { combat } = slice;
  if (!combat.active) return refuse(NO_COMBAT);
  const typed = command.who ?? heroOf(slice, actor)?.id;
  if (typed === undefined)
    return refuse(
      actor === GM ? "Name whose turn it is: /turn <who>." : "You don't play a hero; /play one.",
    );
  const who = resolve(slice, typed);
  if ("refusal" in who) return who;
  if (isDead(who)) return refuse(`${who.name} is dead.`);
  if (combat.acting === who.id) return refuse(`It's already ${who.name}'s turn.`);
  const over = roundOver(slice);
  if (actor !== GM) {
    if (!controls(actor, who)) return refuse("You can only start your own hero's turn.");
    if (combat.acting !== undefined)
      return refuse(`${findWho(slice, combat.acting)?.name ?? combat.acting} is still acting.`);
    if (combat.first === undefined) return refuse("Nobody has said who goes first yet (/first).");
    const side = over ? combat.first : nextSide(slice);
    if (side !== "heroes") return refuse("It's the Director's turn to pick a creature.");
  }
  if (combat.acted.includes(who.id) && !over)
    return refuse(`${who.name} has already acted this round.`);
  const events: NewEvent[] = [];
  if (combat.acting !== undefined) events.push(turnEnd(slice, combat.acting, dice));
  if (over) events.push(roundStart(slice));
  events.push(turnStart(who, dice));
  return { events };
}

function done(slice: DrawSteelState, actor: string, dice: Dice): Decision {
  if (!slice.combat.active) return refuse(NO_COMBAT);
  const acting = slice.combat.acting;
  if (acting === undefined) return refuse("Nobody is acting.");
  const who = findWho(slice, acting);
  if (actor !== GM && (who === undefined || !controls(actor, who)))
    return refuse("You can only end your own hero's turn.");
  return decided(turnEnd(slice, acting, dice));
}

function nextRound(slice: DrawSteelState, dice: Dice): Decision {
  if (!slice.combat.active) return refuse(NO_COMBAT);
  const events: NewEvent[] = [];
  if (slice.combat.acting !== undefined) events.push(turnEnd(slice, slice.combat.acting, dice));
  events.push(roundStart(slice));
  return { events };
}

const characteristicsOf = (slice: DrawSteelState, who: Who): Characteristics | undefined =>
  who.kind === "hero"
    ? who.hero.sheet.characteristics
    : slice.blocks[who.creature.block]?.characteristics;

function powerRollFor(
  slice: DrawSteelState,
  actor: string,
  command: Extract<DsCommand, { type: "pr" }>,
  dice: Dice,
): Decision {
  const who = resolve(slice, command.who);
  if ("refusal" in who) return who;
  if (!controls(actor, who)) return refuse("You can only roll for your own hero.");
  const scores = characteristicsOf(slice, who);
  let bonus = command.bonus ?? 0;
  let named: { ability: string } | { characteristic: Characteristic } | undefined;
  let cost: { readonly ability: string; readonly amount: number } | undefined;
  if (command.ability !== undefined) {
    const abilities =
      who.kind === "hero"
        ? who.hero.sheet.abilities
        : (slice.blocks[who.creature.block]?.abilities ?? []);
    type Choice =
      | { readonly kind: "ability"; readonly name: string; readonly index: number }
      | { readonly kind: "characteristic"; readonly name: Characteristic };
    const choices: Choice[] = [
      ...abilities.map((a, index): Choice => ({ kind: "ability", name: a.name, index })),
      ...CHARACTERISTICS.map((c): Choice => ({ kind: "characteristic", name: c })),
    ];
    const choice = pick(
      choices,
      (c) => [c.name],
      (c) => (c.kind === "ability" ? c.name : capitalized(c.name)),
      command.ability,
      `${who.name} has no ability or characteristic called '${quote(command.ability)}'.`,
    );
    if ("refusal" in choice) return choice;
    if (choice.kind === "characteristic") {
      bonus = scores?.[choice.name] ?? 0;
      named = { characteristic: choice.name };
    } else {
      const ability = abilities[choice.index]!;
      if (ability.bonus !== undefined) bonus = ability.bonus;
      else if (ability.characteristics !== undefined && ability.characteristics.length > 0)
        bonus = Math.max(...ability.characteristics.map((c) => scores?.[c] ?? 0));
      else return refuse(`${ability.name} has no power roll.`);
      named = { ability: ability.name };
      if (ability.cost !== undefined && ability.cost > 0)
        cost = { ability: ability.name, amount: ability.cost };
    }
  }
  const short = cost === undefined ? undefined : shortOf(slice, who, cost.amount);
  if (short !== undefined) return refuse(`${short}; ${cost?.ability} costs ${cost?.amount}.`);
  const pair = [roll(dice, 10), roll(dice, 10)] as const;
  const edges = Math.min(command.edges, 2);
  const banes = Math.min(command.banes, 2);
  const { total, tier } = powerRoll(pair, bonus, edges, banes);
  return decided(
    event("ds.power-rolled", {
      id: who.id,
      ...named,
      dice: [pair[0], pair[1]],
      bonus,
      edges,
      banes,
      total,
      tier,
      ...(cost !== undefined && { cost: cost.amount }),
    }),
  );
}

/** Why `who` can't pay `cost`, a hero from its resource and a creature from Malice, if it can't. */
function shortOf(slice: DrawSteelState, who: Who, cost: number): string | undefined {
  if (who.kind === "creature")
    return slice.malice < cost ? `The Director has only ${slice.malice} Malice` : undefined;
  const { resource, sheet } = who.hero;
  return resource - cost < (sheet.resource.min ?? 0)
    ? `${sheet.name} has ${resource} ${sheet.resource.name}`
    : undefined;
}

function damage(
  slice: DrawSteelState,
  who: Who,
  amount: number,
  type: string | undefined,
  source?: { readonly id: string; readonly minions?: number },
): Decision {
  if (isDead(who)) return refuse(`${who.name} is dead.`);
  const { dealt, weakness, immunity } = modifiedDamage(amount, type, modifiersOf(slice, who));
  return decided(
    event("ds.damaged", {
      id: who.id,
      amount,
      ...(type !== undefined && { type }),
      ...(weakness > 0 && { weakness }),
      ...(immunity > 0 && { immunity }),
      dealt,
      ...(source !== undefined && { source: source.id }),
      ...(source?.minions !== undefined && { minions: source.minions }),
    }),
  );
}

function freeStrike(slice: DrawSteelState, command: Extract<DsCommand, { type: "fs" }>): Decision {
  const striker = resolve(slice, command.who);
  if ("refusal" in striker) return striker;
  if (striker.kind !== "creature")
    return refuse(`Only a creature has a free strike to make; ${striker.name} is a hero.`);
  if (isDead(striker)) return refuse(`${striker.name} is dead.`);
  const target = resolve(slice, command.target);
  if ("refusal" in target) return target;
  const strike = slice.blocks[striker.creature.block]?.freeStrike ?? 0;
  const { minions } = command;
  if (minions === undefined)
    return damage(slice, target, strike, command.damageType, { id: striker.id });
  if (striker.creature.squad === undefined)
    return refuse(`Only a minion squad strikes together; ${striker.name} is one creature.`);
  const left = minionsLeft(striker.creature);
  if (minions > left) return refuse(`${striker.name} has only ${plural(left, "minion")}.`);
  // Free strikes together add up and count as one strike, so weakness and immunity apply once.
  return damage(slice, target, strike * minions, command.damageType, { id: striker.id, minions });
}

function heal(
  slice: DrawSteelState,
  actor: string,
  command: Extract<DsCommand, { type: "heal" }>,
): Decision {
  const who = changeable(slice, actor, command.who);
  if ("refusal" in who) return who;
  if (who.kind === "creature" && who.creature.squad !== undefined)
    return refuse("Minions can't regain Stamina.");
  // The GM may raise the dead: until undo arrives, it's how a slip gets fixed.
  if (isDead(who) && actor !== GM) return refuse(`${who.name} is dead.`);
  const { stamina, max } = staminaOf(who);
  if (stamina >= max) return refuse(`${who.name} is already at full Stamina.`);
  return decided(
    event("ds.healed", { id: who.id, amount: Math.min(command.amount, max - stamina) }),
  );
}

function temp(
  slice: DrawSteelState,
  actor: string,
  command: Extract<DsCommand, { type: "temp" }>,
): Decision {
  const who = changeable(slice, actor, command.who);
  if ("refusal" in who) return who;
  if (who.kind === "creature" && who.creature.squad !== undefined)
    return refuse("Minions can't gain temporary Stamina.");
  if (isDead(who)) return refuse(`${who.name} is dead.`);
  const now = staminaOf(who).temp;
  if (command.amount <= now)
    return refuse(`${who.name} already has ${now} temporary Stamina, and it doesn't stack.`);
  return decided(event("ds.temp-set", { id: who.id, temp: command.amount }));
}

function recover(
  slice: DrawSteelState,
  actor: string,
  command: Extract<DsCommand, { type: "recover" }>,
): Decision {
  const hero = changeableHero(slice, actor, command.who, "Recoveries");
  if ("refusal" in hero) return hero;
  const name = hero.sheet.name;
  const health = heroHealth(hero);
  if (health === "dead") return refuse(`${name} is dead.`);
  // Catch Breath is a combat maneuver; out of combat a dying hero spends Recoveries as usual.
  if (health === "dying" && !command.ally && slice.combat.active)
    return refuse(
      `${name} is dying and can't Catch Breath; /recover ${hero.id} ally if an ally's ability lets them spend one.`,
    );
  if (hero.recoveries <= 0) return refuse(`${name} has no Recoveries left.`);
  const max = hero.sheet.stamina;
  if (hero.stamina >= max) return refuse(`${name} is already at full Stamina.`);
  const value = hero.sheet.recoveryValue ?? Math.floor(max / 3);
  return decided(
    event("ds.recovered", {
      id: hero.id,
      amount: Math.min(value, max - hero.stamina),
      ally: command.ally,
    }),
  );
}

function condition(
  slice: DrawSteelState,
  actor: string,
  command: Extract<DsCommand, { type: "cond" }>,
): Decision {
  const who = changeable(slice, actor, command.who);
  if ("refusal" in who) return who;
  const has = conditionsOf(who).find((c) => c.name === command.condition);
  if (command.remove) {
    if (has === undefined) return refuse(`${who.name} isn't ${command.condition}.`);
    return decided(event("ds.condition-removed", { id: who.id, condition: command.condition }));
  }
  if (isDead(who)) return refuse(`${who.name} is dead.`);
  const duration = command.duration ?? "end";
  if (has?.duration === duration)
    return refuse(`${who.name} is already ${command.condition} (${duration}).`);
  return decided(event("ds.condition-set", { id: who.id, condition: command.condition, duration }));
}

function save(
  slice: DrawSteelState,
  actor: string,
  command: Extract<DsCommand, { type: "save" }>,
  dice: Dice,
): Decision {
  const who = changeable(slice, actor, command.who);
  if ("refusal" in who) return who;
  const saves = conditionsOf(who).filter((c) => c.duration === "save");
  if (saves.length === 0) return refuse(`${who.name} has nothing a save ends.`);
  const chosen =
    command.condition === undefined ? saves : saves.filter((c) => c.name === command.condition);
  if (chosen.length === 0)
    return refuse(`${who.name} isn't ${command.condition} with a save to end it.`);
  return {
    events: chosen.map((c) =>
      event("ds.saved", { id: who.id, condition: c.name, roll: roll(dice, 10) }),
    ),
  };
}

function resource(
  slice: DrawSteelState,
  actor: string,
  command: Extract<DsCommand, { type: "res" }>,
): Decision {
  const hero = changeableHero(slice, actor, command.who, "a heroic resource");
  if ("refusal" in hero) return hero;
  const { name, min = 0 } = hero.sheet.resource;
  if (hero.resource + command.by < min)
    return refuse(
      min === 0
        ? `${hero.sheet.name} has only ${hero.resource} ${name}.`
        : `${hero.sheet.name} can't go below ${min} ${name}.`,
    );
  return decided(event("ds.resource-changed", { id: hero.id, by: command.by }));
}

function surge(
  slice: DrawSteelState,
  actor: string,
  command: Extract<DsCommand, { type: "surge" }>,
): Decision {
  const hero = changeableHero(slice, actor, command.who, "surges");
  if ("refusal" in hero) return hero;
  if (hero.surges + command.by < 0)
    return refuse(`${hero.sheet.name} has only ${plural(hero.surges, "surge")}.`);
  return decided(event("ds.surges-changed", { id: hero.id, by: command.by }));
}

function malice(slice: DrawSteelState, command: Extract<DsCommand, { type: "malice" }>): Decision {
  const { by, reason } = command;
  if (slice.malice + by < 0) return refuse(`The Director has only ${slice.malice} Malice.`);
  return decided(event("ds.malice-changed", reason === undefined ? { by } : { by, reason }));
}

function token(slice: DrawSteelState, actor: string, change: number | "reset"): Decision {
  if (change === "reset") {
    if (actor !== GM) return refuse("Only the GM can reset hero tokens.");
    return decided(event("ds.tokens-reset", { tokens: slice.heroes.length }));
  }
  if (change > 0 && actor !== GM) return refuse("Only the GM can add hero tokens.");
  // The tokens are the heroes' pool: a seat with no hero has none to spend.
  if (actor !== GM && heroOf(slice, actor) === undefined)
    return refuse("Only a player with a hero spends hero tokens; /play one.");
  if (slice.tokens + change < 0)
    return refuse(`The party has only ${plural(slice.tokens, "hero token")}.`);
  return decided(event("ds.tokens-changed", { by: change }));
}

function victory(
  slice: DrawSteelState,
  command: Extract<DsCommand, { type: "victory" }>,
): Decision {
  let heroes: ReadonlyArray<Hero> = slice.heroes;
  if (command.who !== undefined) {
    const who = resolve(slice, command.who);
    if ("refusal" in who) return who;
    if (who.kind !== "hero")
      return refuse(`Only heroes earn Victories; ${who.name} is a creature.`);
    heroes = [who.hero];
  }
  if (heroes.length === 0) return refuse("There's no party yet; /hero brings one in.");
  const short = heroes.find((h) => h.victories + command.by < 0);
  if (short !== undefined)
    return refuse(
      `${short.sheet.name} has only ${plural(short.victories, "Victory", "Victories")}.`,
    );
  return decided(event("ds.victories-changed", { ids: heroes.map((h) => h.id), by: command.by }));
}

/** A respite. The dead don't recover: raising one is a deliberate GM /heal. */
function rest(slice: DrawSteelState): NewEvent {
  const dead = slice.heroes.filter((h) => heroHealth(h) === "dead").map((h) => h.id);
  return event("ds.rested", dead.length === 0 ? {} : { dead });
}

/** Turns a Draw Steel command into events or a refusal. The GM-only check has already run. */
export function decide(
  slice: DrawSteelState,
  actor: string,
  command: DsCommand,
  dice: Dice,
): Decision {
  switch (command.type) {
    case "hero":
      return addHero(slice, command);
    case "add":
      return addCreatures(slice, command);
    case "play":
      return play(slice, actor, command);
    case "unplay":
      return unplay(slice, actor, command);
    case "start":
      return start(slice, dice);
    case "first":
      return slice.combat.active
        ? decided(event("ds.first-set", { side: command.side }))
        : refuse(NO_COMBAT);
    case "turn":
      return turn(slice, actor, command, dice);
    case "done":
      return done(slice, actor, dice);
    case "round":
      return nextRound(slice, dice);
    case "end":
      return slice.combat.active ? decided(event("ds.combat-ended", {})) : refuse(NO_COMBAT);
    case "rest":
      if (slice.combat.active) return refuse("Finish the combat first (/end).");
      if (slice.heroes.length === 0) return refuse("There's no party to rest.");
      return decided(rest(slice));
    case "pr":
      return powerRollFor(slice, actor, command, dice);
    case "dmg": {
      const who = changeable(slice, actor, command.who);
      return "refusal" in who ? who : damage(slice, who, command.amount, command.damageType);
    }
    case "fs":
      return freeStrike(slice, command);
    case "heal":
      return heal(slice, actor, command);
    case "temp":
      return temp(slice, actor, command);
    case "recover":
      return recover(slice, actor, command);
    case "cond":
      return condition(slice, actor, command);
    case "save":
      return save(slice, actor, command, dice);
    case "res":
      return resource(slice, actor, command);
    case "surge":
      return surge(slice, actor, command);
    case "malice":
      return malice(slice, command);
    case "token":
      return token(slice, actor, command.change);
    case "victory":
      return victory(slice, command);
  }
}
