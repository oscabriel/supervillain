// PROTOTYPE, throwaway (branch prototype/set-world). A game module that fights with set.world's
// characters and rules instead of Draw Steel's. See README.md beside this file for the question,
// the rules as adapted to our grid, and how to run it.
//
// Set (https://set.world, AGENTS.md 0.15.0) rolls seeded characters over a free HTTP API. The host
// fetches a roll and puts it in the command, so the event carries it and replay never fetches. The
// fight follows Set's turn-based mode ("dungeon-initiative-2"): initiative orders turns, an attack
// costs 20 stamina, a hit is a dodge draw, a critical draw and damage reduction. Set's turn-based
// mode has no positions; the grid rules here (speed, range) are this prototype's own.
import type { Decision, Dice, Envelope } from "@supervillain/engine";
import type { Combatant, CombatView } from "../drawSteel/view.ts";
import {
  distance,
  formatSquare,
  type MapGrid,
  parseSquare,
  type Square,
  sameSquare,
  standable,
} from "../drawSteel/map.ts";
import type { MapView } from "../drawSteel/mapView.ts";
import { cheapestPath, type Occupants, reachable } from "../drawSteel/movement.ts";
import { GM, type Module, type Refused } from "../module.ts";
import { WEAPONS } from "./weapons.ts";

/** The part of a set.world character roll the table keeps. */
export interface Birth {
  readonly seed: number;
  readonly contentVersion: string;
  readonly className: string;
  readonly flavor: string;
  readonly mainhand: string;
  readonly powerRating: number;
  readonly finalStats: Readonly<Record<string, number>>;
  readonly attributes: Readonly<Record<string, number>>;
  /** Each slot's item name, e.g. `tool: fine silver pike of the joyful`. */
  readonly equipment: Readonly<Record<string, string>>;
}

export type SetSide = "party" | "foes";

interface Fighter {
  readonly id: string;
  readonly name: string;
  readonly side: SetSide;
  readonly birth: Birth;
  readonly health: number;
  readonly stamina: number;
  readonly player?: string;
  readonly at?: Square;
  /** Initiative time of its next turn, in logical ms. */
  readonly nextAt: number;
}

interface Turn {
  readonly id: string;
  readonly moved: number;
  readonly attacked: boolean;
}

export interface SetState {
  readonly map?: MapGrid;
  readonly fighters: ReadonlyArray<Fighter>;
  readonly fighting: boolean;
  readonly clock: number;
  readonly turns: number;
  readonly turn?: Turn;
}

export type SetCommand =
  | { readonly type: "arena"; readonly id: string; readonly grid?: MapGrid }
  | {
      readonly type: "recruit";
      readonly name: string;
      readonly seed?: number;
      readonly birth?: Birth;
    }
  | { readonly type: "foe"; readonly name: string; readonly seed?: number; readonly birth?: Birth }
  | { readonly type: "take"; readonly who: string }
  | { readonly type: "put"; readonly who: string; readonly square: string }
  | { readonly type: "fight" }
  | { readonly type: "go"; readonly who: string; readonly square: string }
  | { readonly type: "hit"; readonly who: string; readonly target: string }
  | { readonly type: "next" };

// ---- The rules as numbers.

const ATTACK_STAMINA = 20;
const RECOVERY_PER_SECOND = 10;
const RULES = "set-world-0-15-0-dungeon-initiative-2, on supervillain's grid (prototype)";

/** Squares a turn's movement may cover: five, scaled by the character's walk speed. */
export const speedOf = (b: Birth) => Math.max(2, Math.round(5 * (b.attributes.walkSpeed ?? 1)));
const intervalOf = (b: Birth) => 1000 / Math.max(0.1, b.attributes.initiative ?? 1);

/** How a character's mainhand reaches on the grid: melee 1 (2 for a long reach), shots 10, magic 5. */
export function reachOf(b: Birth): {
  readonly delivery: string;
  readonly squares: number;
  readonly magic: boolean;
} {
  const weapon = WEAPONS[b.mainhand] ?? { delivery: "melee", reach: 36 };
  switch (weapon.delivery) {
    case "projectile":
      return { delivery: "projectile", squares: 10, magic: false };
    case "wave":
      return { delivery: "wave", squares: 5, magic: true };
    case "aura":
      return { delivery: "aura", squares: 3, magic: true };
    default:
      return { delivery: "melee", squares: weapon.reach > 40 ? 2 : 1, magic: false };
  }
}

// ---- Finding fighters by what people type.

const key = (s: string) => s.trim().toLowerCase();

export function marksOf(fighters: ReadonlyArray<Fighter>): ReadonlyMap<string, string> {
  const marks = new Map<string, string>();
  const used = new Map<string, number>();
  for (const f of fighters) {
    const letter = f.name[0] ?? "?";
    const base = f.side === "party" ? letter.toUpperCase() : letter.toLowerCase();
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    marks.set(f.id, n === 1 ? base : `${base}${n}`);
  }
  return marks;
}

function find(slice: SetState, typed: string): Fighter | Refused {
  const marks = marksOf(slice.fighters);
  const byMark = slice.fighters.find((f) => marks.get(f.id) === typed.trim());
  if (byMark) return byMark;
  const k = key(typed);
  const exact = slice.fighters.find((f) => key(f.name) === k || f.id === k);
  if (exact) return exact;
  const starts = slice.fighters.filter((f) => key(f.name).startsWith(k));
  if (starts.length === 1) return starts[0]!;
  return {
    refusal:
      starts.length > 1
        ? `"${typed}" could be ${starts.map((f) => f.name).join(" or ")}.`
        : `Nobody called "${typed}" is here.`,
  };
}

const living = (slice: SetState, side?: SetSide) =>
  slice.fighters.filter((f) => f.health > 0 && (side === undefined || f.side === side));

const controls = (actor: string, f: Fighter) =>
  actor === GM || (f.side === "party" && f.player === actor);

const occupantsBut =
  (slice: SetState, id: string): Occupants =>
  (square) => {
    const f = slice.fighters.find(
      (o) => o.id !== id && o.health > 0 && o.at !== undefined && sameSquare(o.at, square),
    );
    return f === undefined
      ? undefined
      : { id: f.id, side: f.side === "party" ? "heroes" : "director" };
  };

const moverOf = (f: Fighter) => ({
  side: f.side === "party" ? ("heroes" as const) : ("director" as const),
  prone: false,
});

/** Who acts next on Set's schedule: the soonest `nextAt`, ties in fighter order. */
function nextActor(fighters: ReadonlyArray<Fighter>): Fighter | undefined {
  return fighters
    .filter((f) => f.health > 0)
    .reduce<Fighter | undefined>(
      (a, f) => (a === undefined || f.nextAt < a.nextAt ? f : a),
      undefined,
    );
}

/** The next turn's event: who, at what time, and everyone's stamina after recovering since. */
function nextTurnEvent(fighters: ReadonlyArray<Fighter>, clock: number) {
  const actor = nextActor(fighters);
  if (actor === undefined) return undefined;
  const at = actor.nextAt;
  const seconds = (at - clock) / 1000;
  const stamina: Record<string, number> = {};
  for (const f of fighters)
    if (f.health > 0)
      stamina[f.id] = Math.min(
        Math.floor(f.birth.attributes.stamina ?? 0),
        Math.floor(f.stamina + RECOVERY_PER_SECOND * seconds),
      );
  return { type: "sw.turn-began", payload: { id: actor.id, at, stamina } };
}

// ---- Decide.

const refuse = (refusal: string): Decision => ({ refusal });
const squares = (n: number) => `${n} square${n === 1 ? "" : "s"}`;
const one = (type: string, payload: unknown): Decision => ({ events: [{ type, payload }] });

function decide(slice: SetState, actor: string, command: SetCommand, dice: Dice): Decision {
  switch (command.type) {
    case "arena":
      if (command.grid === undefined) return refuse(`No map called ${command.id}.`);
      return one("sw.arena-set", { id: command.id, grid: command.grid });
    case "recruit":
    case "foe": {
      if (command.birth === undefined) return refuse("set.world didn't answer; try again.");
      if (slice.fighters.some((f) => key(f.name) === key(command.name)))
        return refuse(`${command.name} is already here.`);
      const side: SetSide = command.type === "recruit" ? "party" : "foes";
      let id = key(command.name).replace(/[^a-z0-9]+/g, "-");
      while (slice.fighters.some((f) => f.id === id)) id = `${id}-2`;
      return one("sw.fighter-joined", {
        id,
        name: command.name.trim(),
        side,
        birth: command.birth,
      });
    }
    case "take": {
      const f = find(slice, command.who);
      if ("refusal" in f) return f;
      if (f.side !== "party") return refuse(`${f.name} fights for the other side.`);
      if (f.player !== undefined && f.player !== actor)
        return refuse(`Someone else already plays ${f.name}.`);
      return one("sw.taken", { id: f.id, player: actor });
    }
    case "put": {
      const f = find(slice, command.who);
      if ("refusal" in f) return f;
      if (!controls(actor, f)) return refuse(`You don't play ${f.name}.`);
      if (slice.map === undefined) return refuse("Load a map first: /arena <map>.");
      if (slice.fighting && actor !== GM) return refuse("Mid-fight, move with /go.");
      const square = parseSquare(command.square);
      if (!square || !standable(slice.map.terrain, square))
        return refuse(`${command.square} isn't a square anyone can stand on.`);
      if (occupantsBut(slice, f.id)(square))
        return refuse(`Someone already stands on ${command.square}.`);
      return one("sw.placed", { id: f.id, at: square });
    }
    case "fight": {
      if (living(slice, "party").length === 0 || living(slice, "foes").length === 0)
        return refuse("A fight needs someone on each side: /recruit and /foe.");
      const reset = slice.fighters.map((f) => ({ ...f, nextAt: intervalOf(f.birth) }));
      const first = nextTurnEvent(reset, 0)!;
      return {
        events: [{ type: "sw.fight-started", payload: { rules: RULES } }, first],
      };
    }
    case "go": {
      const f = find(slice, command.who);
      if ("refusal" in f) return f;
      if (!controls(actor, f)) return refuse(`You don't play ${f.name}.`);
      if (slice.map === undefined || f.at === undefined)
        return refuse(`${f.name} isn't on the map.`);
      if (slice.fighting && slice.turn?.id !== f.id) return refuse(`It isn't ${f.name}'s turn.`);
      const to = parseSquare(command.square);
      if (!to) return refuse(`${command.square} isn't a square.`);
      const path = cheapestPath(slice.map.terrain, f.at, to, moverOf(f), occupantsBut(slice, f.id));
      if (!path) return refuse(`${f.name} can't get to ${command.square}.`);
      if (occupantsBut(slice, f.id)(to))
        return refuse(`Someone already stands on ${command.square}.`);
      const left = speedOf(f.birth) - (slice.turn?.moved ?? 0);
      if (slice.fighting && path.cost > left)
        return refuse(
          `${command.square} is ${path.cost} squares away; ${f.name} has ${left} left.`,
        );
      return one("sw.moved", { id: f.id, at: to, cost: path.cost });
    }
    case "hit": {
      const a = find(slice, command.who);
      if ("refusal" in a) return a;
      const t = find(slice, command.target);
      if ("refusal" in t) return t;
      if (!controls(actor, a)) return refuse(`You don't play ${a.name}.`);
      if (!slice.fighting) return refuse("No fight is on: /fight starts one.");
      if (slice.turn?.id !== a.id) return refuse(`It isn't ${a.name}'s turn.`);
      if (slice.turn.attacked)
        return refuse(`${a.name} has attacked this turn already; /next ends it.`);
      if (t.health <= 0) return refuse(`${t.name} is down.`);
      if (t.side === a.side) return refuse(`${t.name} is on ${a.name}'s side.`);
      if (a.stamina < ATTACK_STAMINA)
        return refuse(
          `${a.name} has ${a.stamina} stamina, short of ${ATTACK_STAMINA}: rest with /next.`,
        );
      const reach = reachOf(a.birth);
      if (a.at && t.at) {
        const d = distance(a.at, t.at);
        if (d > reach.squares)
          return refuse(
            `${t.name} is ${squares(d)} away; ${a.name}'s ${a.birth.mainhand} (${reach.delivery}) reaches ${reach.squares}.`,
          );
      }
      // Set's shared hit: a dodge draw, then a critical draw, then reduction and resistance.
      const att = a.birth.attributes;
      const def = t.birth.attributes;
      const dodgeChance = (def.dodgeRate ?? 0) * (1 - (att.clarity ?? 0));
      const dodgeRoll = dice(1000);
      const dodged = dodgeRoll <= Math.round(dodgeChance * 1000);
      const critRoll = dice(1000);
      const critical = !dodged && critRoll <= Math.round((att.criticalHitChance ?? 0) * 1000);
      const raw = reach.magic ? (att.magicalDamage ?? 0) : (att.physicalDamage ?? 0);
      const reduction = reach.magic
        ? (def.magicalDamageReduction ?? 0)
        : (def.physicalDamageReduction ?? 0);
      const landed = dodged
        ? 0
        : Math.max(
            1,
            Math.floor(
              raw * (1 - reduction) * (1 - (def.globalResistance ?? 0)) * (critical ? 2 : 1),
            ),
          );
      const damage = Math.min(t.health, landed);
      return one("sw.attacked", {
        id: a.id,
        target: t.id,
        delivery: reach.delivery,
        dodgeChance,
        dodgeRoll,
        critRoll,
        dodged,
        critical,
        raw,
        damage,
      });
    }
    case "next": {
      if (!slice.fighting || slice.turn === undefined)
        return refuse("No fight is on: /fight starts one.");
      const f = slice.fighters.find((o) => o.id === slice.turn!.id)!;
      if (!controls(actor, f)) return refuse(`It's ${f.name}'s turn, not yours to end.`);
      const ended = slice.fighters.map((o) =>
        o.id === f.id ? { ...o, nextAt: o.nextAt + intervalOf(o.birth) } : o,
      );
      const rested = !slice.turn.attacked;
      const next = nextTurnEvent(ended, slice.clock);
      return {
        events: [{ type: "sw.turn-ended", payload: { id: f.id, rested } }, ...(next ? [next] : [])],
      };
    }
  }
}

// ---- Apply.

const P = (e: Envelope) => e.payload as Record<string, unknown> & { id: string };

function apply(
  slice: SetState,
  envelope: Envelope,
): { slice: SetState; feed?: { kind: string; text: string } } {
  const p = P(envelope);
  const update = (id: string, f: (x: Fighter) => Fighter) =>
    slice.fighters.map((x) => (x.id === id ? f(x) : x));
  const named = (id: string) => slice.fighters.find((f) => f.id === id)?.name ?? id;
  switch (envelope.type) {
    case "sw.arena-set": {
      const grid = p.grid as MapGrid;
      return {
        slice: { ...slice, map: grid, fighters: slice.fighters.map(({ at: _, ...f }) => f) },
        feed: { kind: "sw", text: `The fight will be at ${grid.name}.` },
      };
    }
    case "sw.fighter-joined": {
      const birth = p.birth as Birth;
      const fighter: Fighter = {
        id: p.id,
        name: p.name as string,
        side: p.side as SetSide,
        birth,
        health: Math.floor(birth.attributes.maxHealth ?? 1),
        stamina: Math.floor(birth.attributes.stamina ?? 0),
        nextAt: intervalOf(birth),
      };
      const reach = reachOf(birth);
      return {
        slice: { ...slice, fighters: [...slice.fighters, fighter] },
        feed: {
          kind: "sw",
          text: `${fighter.name} the ${birth.className} ${fighter.side === "party" ? "joins the party" : "steps forward"}: ${fighter.health} health, ${fighter.stamina} stamina, a ${birth.mainhand} (${reach.delivery}, reach ${reach.squares}), speed ${speedOf(birth)}, power ${birth.powerRating}. Seed ${birth.seed}.`,
        },
      };
    }
    case "sw.taken":
      return {
        slice: { ...slice, fighters: update(p.id, (f) => ({ ...f, player: p.player as string })) },
        feed: { kind: "sw-claim", text: `takes ${named(p.id)}.` },
      };
    case "sw.placed":
      return {
        slice: { ...slice, fighters: update(p.id, (f) => ({ ...f, at: p.at as Square })) },
        feed: { kind: "sw", text: `${named(p.id)} is placed at ${formatSquare(p.at as Square)}.` },
      };
    case "sw.fight-started":
      return {
        slice: {
          ...slice,
          fighting: true,
          clock: 0,
          turns: 0,
          fighters: slice.fighters.map((f) => ({ ...f, nextAt: intervalOf(f.birth) })),
        },
        feed: { kind: "sw-turn", text: `The fight begins. Turns follow initiative (${p.rules}).` },
      };
    case "sw.turn-began": {
      const stamina = p.stamina as Record<string, number>;
      const fighters = slice.fighters.map((f) =>
        stamina[f.id] === undefined ? f : { ...f, stamina: stamina[f.id]! },
      );
      const f = fighters.find((x) => x.id === p.id)!;
      const short = f.stamina < ATTACK_STAMINA ? " Too tired to attack: /next rests." : "";
      return {
        slice: {
          ...slice,
          fighters,
          clock: p.at as number,
          turns: slice.turns + 1,
          turn: { id: p.id, moved: 0, attacked: false },
        },
        feed: {
          kind: "sw-turn",
          text: `${((p.at as number) / 1000).toFixed(2)} s · ${f.name}'s turn (stamina ${f.stamina}, speed ${speedOf(f.birth)}).${short}`,
        },
      };
    }
    case "sw.moved": {
      const fighters = update(p.id, (f) => ({ ...f, at: p.at as Square }));
      const turn =
        slice.turn && slice.turn.id === p.id
          ? { ...slice.turn, moved: slice.turn.moved + (p.cost as number) }
          : slice.turn;
      return {
        slice: { ...slice, fighters, ...(turn ? { turn } : {}) },
        feed: {
          kind: "sw",
          text: `${named(p.id)} moves to ${formatSquare(p.at as Square)} (${p.cost} squares).`,
        },
      };
    }
    case "sw.attacked": {
      const damage = p.damage as number;
      let fighters = update(p.id, (f) => ({ ...f, stamina: f.stamina - ATTACK_STAMINA }));
      fighters = fighters.map((f) => (f.id === p.target ? { ...f, health: f.health - damage } : f));
      const target = fighters.find((f) => f.id === p.target)!;
      const verb =
        p.delivery === "projectile"
          ? "shoots at"
          : p.delivery === "melee"
            ? "strikes at"
            : "casts at";
      const pct = Math.round((p.dodgeChance as number) * 100);
      const outcome = p.dodged
        ? `${target.name} dodges (${pct}% chance).`
        : `${p.critical ? "Critical! " : ""}${damage} damage → ${target.name} ${target.health}/${Math.floor(target.birth.attributes.maxHealth ?? 0)}${target.health <= 0 ? ", down" : ""}.`;
      const after: SetState = {
        ...slice,
        fighters,
        ...(slice.turn ? { turn: { ...slice.turn, attacked: true } } : {}),
      };
      const partyUp = after.fighters.some((f) => f.side === "party" && f.health > 0);
      const foesUp = after.fighters.some((f) => f.side === "foes" && f.health > 0);
      const over = !partyUp || !foesUp;
      const { turn: _, ...rest } = after;
      return {
        slice: over ? { ...rest, fighting: false } : after,
        feed: {
          kind: "sw",
          text: `${named(p.id)} ${verb} ${target.name}: ${outcome}${over ? ` The fight is over: ${partyUp ? "the party" : "the foes"} win.` : ""}`,
        },
      };
    }
    case "sw.turn-ended": {
      const f = slice.fighters.find((x) => x.id === p.id)!;
      const fighters = update(p.id, (x) => ({ ...x, nextAt: x.nextAt + intervalOf(x.birth) }));
      return {
        slice: { ...slice, fighters },
        feed: { kind: "sw-turn", text: `${f.name} ${p.rested ? "rests" : "is done"}.` },
      };
    }
    default:
      throw new Error(`set-world can't apply "${envelope.type}"`);
  }
}

// ---- Commands.

const usage = (u: string): Refused => ({ refusal: `Usage: ${u}` });
const namesOf = (slice: SetState, partial: string) =>
  slice.fighters.map((f) => f.name).filter((n) => key(n).startsWith(key(partial)));

function spawnParse<T extends "recruit" | "foe">(type: T) {
  return (args: string): Extract<SetCommand, { type: T }> | Refused => {
    const parts = args.trim().split(/\s+/);
    const last = parts.at(-1);
    const seed =
      last !== undefined && /^\d+$/.test(last) && parts.length > 1 ? Number(last) : undefined;
    const name = (seed === undefined ? parts : parts.slice(0, -1)).join(" ");
    if (name === "") return usage(`/${type} <name> [seed]`);
    return { type, name, ...(seed === undefined ? {} : { seed }) } as Extract<
      SetCommand,
      { type: T }
    >;
  };
}

const whoAndSquare = (args: string) => {
  const [who, square] = args.trim().split(/\s+/);
  return who && square ? { who, square } : undefined;
};

export const setWorld: Module<"sw", SetState, SetCommand> = {
  key: "sw",
  initial: { fighters: [], fighting: false, clock: 0, turns: 0 },
  events: [
    "sw.arena-set",
    "sw.fighter-joined",
    "sw.taken",
    "sw.placed",
    "sw.fight-started",
    "sw.turn-began",
    "sw.moved",
    "sw.attacked",
    "sw.turn-ended",
  ],
  formats: {
    sw: { speaker: false, separator: "" },
    "sw-turn": { speaker: false, separator: "" },
    "sw-claim": { speaker: true, separator: " ", plainLabel: true },
  },
  commands: {
    arena: {
      usage: "/arena <map id>",
      summary: "Set: load the map the Set fight is on.",
      gmOnly: true,
      parse: (args) =>
        args.trim() ? { type: "arena", id: args.trim() } : usage("/arena <map id>"),
    },
    recruit: {
      usage: "/recruit <name> [seed]",
      summary: "Set: roll a party member from set.world, by seed or at random.",
      gmOnly: true,
      parse: spawnParse("recruit"),
    },
    foe: {
      usage: "/foe <name> [seed]",
      summary: "Set: roll a foe from set.world, by seed or at random.",
      gmOnly: true,
      parse: spawnParse("foe"),
    },
    take: {
      usage: "/take <name>",
      summary: "Set: play a party member.",
      gmOnly: false,
      parse: (args) => (args.trim() ? { type: "take", who: args.trim() } : usage("/take <name>")),
      complete: (slice, partial) => namesOf(slice, partial),
    },
    put: {
      usage: "/put <who> <square>",
      summary: "Set: place a fighter on the map.",
      gmOnly: false,
      parse: (args) => {
        const w = whoAndSquare(args);
        return w ? { type: "put", ...w } : usage("/put <who> <square>");
      },
      complete: (slice, partial) => namesOf(slice, partial),
    },
    fight: {
      usage: "/fight",
      summary: "Set: start the fight; turns follow initiative.",
      gmOnly: true,
      parse: () => ({ type: "fight" }),
    },
    go: {
      usage: "/go <who> <square>",
      summary: "Set: move on your turn, up to your speed.",
      gmOnly: false,
      parse: (args) => {
        const w = whoAndSquare(args);
        return w ? { type: "go", ...w } : usage("/go <who> <square>");
      },
      complete: (slice, partial) => namesOf(slice, partial),
    },
    hit: {
      usage: "/hit <who> <target>",
      summary: "Set: attack once on your turn (20 stamina), if your weapon reaches.",
      gmOnly: false,
      parse: (args) => {
        const [who, target] = args.trim().split(/\s+/);
        return who && target ? { type: "hit", who, target } : usage("/hit <who> <target>");
      },
      complete: (slice, partial) => namesOf(slice, partial),
    },
    next: {
      usage: "/next",
      summary: "Set: end the turn (resting if you didn't attack); the next by initiative goes.",
      gmOnly: false,
      parse: () => ({ type: "next" }),
    },
  },
  decide: (slice, _shared, actor, command, dice) => decide(slice, actor, command, dice),
  apply,
};

// ---- Projections for the table: the band, the map and /sheet.

export const setActive = (slice: SetState) => slice.fighters.length > 0 || slice.map !== undefined;

export function setBand(slice: SetState, actor: string): CombatView | undefined {
  if (slice.fighters.length === 0) return undefined;
  const marks = marksOf(slice.fighters);
  const order = slice.fighting
    ? slice.fighters.toSorted(
        (a, b) => Number(b.health > 0) - Number(a.health > 0) || a.nextAt - b.nextAt,
      )
    : slice.fighters;
  const combatants: Combatant[] = order.map((f) => {
    const max = Math.floor(f.birth.attributes.maxHealth ?? 1);
    const mark = f.at !== undefined ? marks.get(f.id) : undefined;
    return {
      id: f.id,
      name: `${f.name} (${f.birth.className})`,
      side: f.side === "party" ? "heroes" : "director",
      stamina: Math.max(0, f.health),
      max,
      temp: 0,
      ...(f.health <= 0
        ? { health: "dead" as const }
        : f.health <= max / 2
          ? { health: "winded" as const }
          : {}),
      conditions: [],
      resource: `stamina ${f.stamina}/${Math.floor(f.birth.attributes.stamina ?? 0)} · ${f.birth.mainhand}`,
      acted: false,
      acting: slice.turn?.id === f.id,
      mine: f.player === actor,
      ...(mark ? { mark } : {}),
    };
  });
  return {
    round: slice.turns,
    active: slice.fighting,
    malice: 0,
    heroTokens: 0,
    combatants,
  };
}

export function setMap(slice: SetState, actor: string): MapView | undefined {
  if (slice.map === undefined) return undefined;
  const marks = marksOf(slice.fighters);
  const acting = slice.turn ? slice.fighters.find((f) => f.id === slice.turn!.id) : undefined;
  const reach =
    acting?.at && slice.fighting && slice.map
      ? reachable(
          slice.map.terrain,
          acting.at,
          speedOf(acting.birth) - (slice.turn?.moved ?? 0),
          moverOf(acting),
          occupantsBut(slice, acting.id),
        )
      : [];
  return {
    name: slice.map.name,
    width: slice.map.terrain[0]?.length ?? 0,
    height: slice.map.terrain.length,
    terrain: slice.map.terrain,
    tokens: slice.fighters
      .filter((f) => f.at !== undefined)
      .map((f) => ({
        id: f.id,
        mark: marks.get(f.id) ?? "?",
        name: f.name,
        x: f.at!.x,
        y: f.at!.y,
        side: f.side === "party" ? ("heroes" as const) : ("director" as const),
        mine: f.player === actor,
        acting: slice.turn?.id === f.id,
        dead: f.health <= 0,
      })),
    reach,
    ...(acting && reach.length > 0
      ? {
          reachLabel: `${acting.name} can reach: ${speedOf(acting.birth) - (slice.turn?.moved ?? 0)} squares`,
        }
      : {}),
  };
}

export function setSheet(slice: SetState, typed: string): string | Refused {
  const f = find(slice, typed);
  if ("refusal" in f) return f;
  const b = f.birth;
  const a = b.attributes;
  const reach = reachOf(b);
  const pct = (n: number | undefined) => `${Math.round((n ?? 0) * 100)}%`;
  return [
    `${f.name} the ${b.className} (set.world seed ${b.seed}, power ${b.powerRating})`,
    b.flavor,
    `Health ${f.health}/${Math.floor(a.maxHealth ?? 0)} · stamina ${f.stamina}/${Math.floor(a.stamina ?? 0)} · speed ${speedOf(b)} · initiative ${(a.initiative ?? 0).toFixed(2)}`,
    `Weapon: ${b.mainhand} (${reach.delivery}, reaches ${reach.squares}) · ${reach.magic ? `magic ${a.magicalDamage}` : `physical ${a.physicalDamage}`} damage`,
    `Dodge ${pct(a.dodgeRate)} · critical ${pct(a.criticalHitChance)} · clarity ${pct(a.clarity)} · armor ${pct(a.physicalDamageReduction)} physical, ${pct(a.magicalDamageReduction)} magic · resist ${pct(a.globalResistance)}`,
    `Stats: ${Object.entries(b.finalStats)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`,
    `Gear: ${Object.values(b.equipment).join("; ")}`,
  ].join("\n");
}

/** Turns a set.world `/api/roll/character` response into the part the table keeps. */
export function birthOf(response: Record<string, unknown>): Birth {
  const cls = response.class as { name: string; flavor: string; mainhand: string };
  const equipment: Record<string, string> = {};
  for (const [slot, item] of Object.entries(
    (response.equipment ?? {}) as Record<string, { name?: string }>,
  ))
    if (item?.name) equipment[slot] = item.name;
  return {
    seed: response.seed as number,
    contentVersion: response.contentVersion as string,
    className: cls.name,
    flavor: cls.flavor,
    mainhand: cls.mainhand,
    powerRating: response.powerRating as number,
    finalStats: response.finalStats as Record<string, number>,
    attributes: response.attributes as Record<string, number>,
    equipment,
  };
}
