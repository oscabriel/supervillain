import type { CommandSpec, CommandSpecs, Refused } from "../module.ts";
import { cleanText, lengthOf, quote } from "../text.ts";
import { type MapGrid, parseSquare, type Square } from "./map.ts";
import { type HeroSheet, isTrait, type StatBlock } from "./sheets.ts";
import {
  type ConditionName,
  CONDITIONS,
  type Duration,
  DURATIONS,
  type DrawSteelState,
  everyone,
  heroOf,
  matching,
  orList,
  pick,
  resolve,
  type Side,
} from "./state.ts";

/** A push, pull or slide: `distance` squares, before the target's stability. */
export interface ForcedCommand<K extends "push" | "pull" | "slide"> {
  readonly type: K;
  readonly who: string;
  readonly distance: number;
  /** Who does the moving, as typed: the acting creature or the player's hero if left out. */
  readonly from?: string;
  /** Where it goes: required for a slide; for a push or pull, how far along its line. */
  readonly to?: Square;
}

export type DsCommand =
  | {
      readonly type: "hero";
      readonly hero: string;
      /** The hero's sheet, which the host loads and puts here; decide refuses without it. */
      readonly sheet?: HeroSheet;
    }
  | {
      readonly type: "add";
      readonly monster: string;
      readonly count: number;
      readonly as?: string;
      /** The stat block, which the host loads and puts here; decide refuses without it. */
      readonly sheet?: StatBlock;
    }
  | {
      readonly type: "play";
      /** Absent for a bare /play, which lists the heroes free to play. */
      readonly hero?: string;
      /** The GM's form: the label of the player who gets the hero, as typed. */
      readonly player?: string;
      /** The actor the host found for `player`. Decide refuses `player` without it. */
      readonly playerActor?: string;
      /**
       * Actors with a seat open, filled in by the host (presence isn't in the log): a hero whose
       * guest has left is free to take, since a guest never comes back as the same actor.
       */
      readonly seated?: ReadonlyArray<string>;
    }
  | { readonly type: "unplay"; readonly hero?: string }
  | { readonly type: "start" }
  | { readonly type: "first"; readonly side: Side }
  | { readonly type: "turn"; readonly who?: string }
  | { readonly type: "done" }
  | { readonly type: "round" }
  | { readonly type: "end" }
  | { readonly type: "rest" }
  | {
      readonly type: "pr";
      readonly who: string;
      /** An ability or characteristic name, as typed; absent for a flat `+N` roll. */
      readonly ability?: string;
      readonly bonus?: number;
      readonly edges: number;
      readonly banes: number;
      /** Who it's aimed at, as typed after `on`: the tier's damage goes to each. */
      readonly targets?: ReadonlyArray<string>;
    }
  | {
      readonly type: "dmg";
      readonly who: string;
      readonly amount: number;
      readonly damageType?: string;
    }
  | { readonly type: "heal"; readonly who: string; readonly amount: number }
  | { readonly type: "temp"; readonly who: string; readonly amount: number }
  | { readonly type: "recover"; readonly who: string; readonly ally: boolean }
  | {
      readonly type: "cond";
      readonly who: string;
      readonly condition: ConditionName;
      /** Defaults to the end of the encounter. */
      readonly duration?: Duration;
      readonly remove?: boolean;
    }
  | { readonly type: "save"; readonly who: string; readonly condition?: ConditionName }
  | { readonly type: "res"; readonly who: string; readonly by: number }
  | { readonly type: "malice"; readonly by: number; readonly reason?: string }
  | { readonly type: "surge"; readonly who: string; readonly by: number }
  | { readonly type: "token"; readonly change: number | "reset" }
  | { readonly type: "victory"; readonly who?: string; readonly by: number }
  | {
      readonly type: "fs";
      readonly who: string;
      readonly target: string;
      readonly damageType?: string;
      /** For a minion squad: how many of its minions strike the target together. */
      readonly minions?: number;
    }
  | {
      readonly type: "map";
      /** The map file's id; absent for /map off. */
      readonly id?: string;
      /** The grid, which the host reads from `maps/<id>.txt` and puts here; decide refuses without it. */
      readonly grid?: MapGrid;
    }
  | { readonly type: "place"; readonly who: string; readonly at: Square }
  | {
      readonly type: "move";
      readonly who: string;
      readonly to: Square;
      /** The hero's main action goes on moving too: a second speed's worth this turn. */
      readonly main?: boolean;
    }
  | { readonly type: "dist"; readonly from: string; readonly to: string }
  | ForcedCommand<"push">
  | ForcedCommand<"pull">
  | ForcedCommand<"slide">;

/** The most a single /dmg, /heal or /temp may move. */
const AMOUNT_MAX = 999;
/** The most creatures one /add may bring. */
const ADD_MAX = 40;
/** The most minions in one squad. */
export const SQUAD_SIZE = 8;
const BONUS_MAX = 30;
const STEP_MAX = 99;

const words = (args: string) =>
  args
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "");

const amount = (s: string | undefined): number | undefined =>
  s !== undefined && /^\d+$/.test(s) && Number(s) >= 1 && Number(s) <= AMOUNT_MAX
    ? Number(s)
    : undefined;

const signedStep = (s: string | undefined): number | undefined =>
  s !== undefined && /^[+-]\d+$/.test(s) && Number(s) !== 0 && Math.abs(Number(s)) <= STEP_MAX
    ? Number(s)
    : undefined;

const usage = (spec: { usage: string }): Refused => ({ refusal: `Usage: ${spec.usage}` });

/** A condition by name or unique prefix, or why it isn't one. */
const conditionNamed = (typed: string): ConditionName | Refused =>
  pick(
    CONDITIONS,
    (c) => [c],
    (c) => c,
    typed,
    `'${quote(typed)}' isn't a condition: ${orList([...CONDITIONS])}.`,
  );

const MODIFIERS: Readonly<Record<string, { edges: number; banes: number }>> = {
  edge: { edges: 1, banes: 0 },
  edge2: { edges: 2, banes: 0 },
  bane: { edges: 0, banes: 1 },
  bane2: { edges: 0, banes: 2 },
};

/**
 * Hero and creature ids that begin with what was typed, else whose id or name has a word it
 * begins, the actor's own hero first. The host's /sheet completes with this too.
 */
export function completeWho(slice: DrawSteelState, partial: string, actor: string): string[] {
  const own = heroOf(slice, actor)?.id;
  const all = everyone(slice);
  const ordered = [...all.filter((w) => w.id === own), ...all.filter((w) => w.id !== own)];
  return matching(
    ordered,
    (w) => w.id,
    (w) => [w.id, w.name],
    partial,
  );
}

/** Completes the first argument as a target, and the rest with `rest` once a target is typed. */
const targetThen =
  (rest?: (slice: DrawSteelState, who: string, typed: string, actor: string) => string[]) =>
  (slice: DrawSteelState, partial: string, actor: string): string[] => {
    const space = partial.search(/\s/);
    if (space === -1) return completeWho(slice, partial, actor);
    const who = partial.slice(0, space);
    const typed = partial.slice(space + 1).trimStart();
    return (rest?.(slice, who, typed, actor) ?? []).map((r) => `${who} ${r}`);
  };

const startingWith = (options: ReadonlyArray<string>, typed: string) =>
  options.filter((o) => o.toLowerCase().startsWith(typed.toLowerCase()));

const heroIds = (slice: DrawSteelState, partial: string) =>
  startingWith(
    slice.heroes.map((h) => h.id),
    partial.trim(),
  );

type Spec<T extends DsCommand["type"]> = CommandSpec<
  Extract<DsCommand, { readonly type: T }>,
  DrawSteelState
>;

/** One target and a signed step: /res, /surge. */
const stepFor = <T extends "res" | "surge">(type: T, summary: string): Spec<T> => {
  const spec: Spec<T> = {
    usage: `/${type} <hero> <+N|-N>`,
    summary,
    gmOnly: false,
    parse: (args) => {
      const [who, step, extra] = words(args);
      const by = signedStep(step);
      if (who === undefined || by === undefined || extra !== undefined) return usage(spec);
      return { type, who, by } as Extract<DsCommand, { readonly type: T }>;
    },
    complete: targetThen(),
  };
  return spec;
};

/** One target and an amount: /heal, /temp. */
const amountFor = <T extends "heal" | "temp">(type: T, summary: string): Spec<T> => {
  const spec: Spec<T> = {
    usage: `/${type} <who> <n>`,
    summary,
    gmOnly: false,
    parse: (args) => {
      const [who, n, extra] = words(args);
      const value = amount(n);
      if (who === undefined || value === undefined || extra !== undefined) return usage(spec);
      return { type, who, amount: value } as Extract<DsCommand, { readonly type: T }>;
    },
    complete: targetThen(),
  };
  return spec;
};

const bare = <T extends "start" | "done" | "round" | "end" | "rest">(
  type: T,
  summary: string,
  gmOnly: boolean,
): Spec<T> => ({
  usage: `/${type}`,
  summary,
  gmOnly,
  parse: () => ({ type }) as Extract<DsCommand, { readonly type: T }>,
});

const hero: Spec<"hero"> = {
  usage: "/hero <hero id>",
  summary: "Bring a hero into the party from its sheet, or reload the sheet.",
  gmOnly: true,
  parse: (args) => {
    const [id, extra] = words(args);
    return id === undefined || extra !== undefined
      ? usage(hero)
      : { type: "hero", hero: id.toLowerCase() };
  },
  complete: heroIds,
};

const add: Spec<"add"> = {
  usage: "/add <monster id> [xN] [as <name>]",
  summary: "Add creatures from a stat block; minions form squads of up to 8.",
  gmOnly: true,
  parse: (args) => {
    const match = /^(\S+)(?:\s+[x×](\d+))?(?:\s+as\s+(.+))?$/i.exec(args.trim());
    if (!match) return usage(add);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count < 1 || count > ADD_MAX) return { refusal: `Add 1 to ${ADD_MAX} at a time.` };
    const as = match[3]?.trim();
    return {
      type: "add",
      monster: match[1]!.toLowerCase(),
      count,
      ...(as !== undefined && as !== "" && { as }),
    };
  },
  complete: (slice, partial) => startingWith(Object.keys(slice.blocks), partial.trim()),
};

const play: Spec<"play"> = {
  usage: "/play <hero> [player]",
  summary: "Play a hero. The GM names a player to give them one.",
  gmOnly: false,
  parse: (args) => {
    const [id, ...rest] = words(args);
    if (id === undefined) return { type: "play" };
    const player = rest.join(" ");
    return player === "" ? { type: "play", hero: id } : { type: "play", hero: id, player };
  },
  complete: (slice, partial) =>
    startingWith(
      slice.heroes.filter((h) => h.player === undefined).map((h) => h.id),
      partial.trim(),
    ),
};

const unplay: Spec<"unplay"> = {
  usage: "/unplay [hero]",
  summary: "Stop playing your hero. The GM names any hero to free it.",
  gmOnly: false,
  parse: (args) => {
    const [id, extra] = words(args);
    if (extra !== undefined) return usage(unplay);
    return id === undefined ? { type: "unplay" } : { type: "unplay", hero: id };
  },
  complete: (slice, partial) =>
    startingWith(
      slice.heroes.filter((h) => h.player !== undefined).map((h) => h.id),
      partial.trim(),
    ),
};

const first: Spec<"first"> = {
  usage: "/first heroes|director",
  summary: "Say which side goes first, every round.",
  gmOnly: true,
  parse: (args) => {
    const typed = args.trim().toLowerCase();
    if (typed === "") return usage(first);
    if ("heroes".startsWith(typed) || "players".startsWith(typed))
      return { type: "first", side: "heroes" };
    if ("director".startsWith(typed)) return { type: "first", side: "director" };
    return usage(first);
  },
  complete: (_slice, partial) => startingWith(["heroes", "director"], partial.trim()),
};

const turn: Spec<"turn"> = {
  usage: "/turn [who]",
  summary: "Start a turn (your hero's, by default); the turn before ends.",
  gmOnly: false,
  parse: (args) => {
    const [who, extra] = words(args);
    if (extra !== undefined) return usage(turn);
    return who === undefined ? { type: "turn" } : { type: "turn", who };
  },
  complete: (slice, partial, actor) =>
    completeWho(slice, partial, actor).filter((id) => !slice.combat.acted.includes(id)),
};

/** Takes edge, bane, edge2 and bane2 off the end of `rest`, adding them up. */
function modifiersOff(rest: string[], into: { edges: number; banes: number }): void {
  while (rest.length > 0 && MODIFIERS[rest.at(-1)!.toLowerCase()] !== undefined) {
    const modifier = MODIFIERS[rest.pop()!.toLowerCase()]!;
    into.edges += modifier.edges;
    into.banes += modifier.banes;
  }
}

const pr: Spec<"pr"> = {
  usage: "/pr <who> <ability|+N> [edge|bane|edge2|bane2] [on <target>…]",
  summary: "Power roll with the tier's result and its damage to each target, or use an ability.",
  gmOnly: false,
  parse: (args) => {
    const [who, ...rest] = words(args);
    const modifiers = { edges: 0, banes: 0 };
    modifiersOff(rest, modifiers);
    const on = rest.findLastIndex((w) => w.toLowerCase() === "on");
    const targets = on === -1 ? [] : rest.splice(on).slice(1);
    if (on !== -1 && targets.length === 0) return usage(pr);
    modifiersOff(rest, modifiers);
    const { edges, banes } = modifiers;
    const aimed = targets.length === 0 ? {} : { targets };
    const roll = rest.join(" ");
    if (who === undefined || roll === "") return usage(pr);
    if (/^[+-]\d+$/.test(roll)) {
      const bonus = Number(roll);
      if (Math.abs(bonus) > BONUS_MAX)
        return { refusal: `Keep the bonus within ${BONUS_MAX} either way.` };
      return { type: "pr", who, bonus, edges, banes, ...aimed };
    }
    return { type: "pr", who, ability: roll, edges, banes, ...aimed };
  },
  complete: targetThen((slice, who, typed) => {
    const found = resolve(slice, who);
    if ("refusal" in found) return [];
    const abilities =
      found.kind === "hero"
        ? found.hero.sheet.abilities
        : (slice.blocks[found.creature.block]?.abilities ?? []);
    return matching(
      abilities.filter((a) => !isTrait(a)),
      (a) => a.name,
      (a) => [a.name],
      typed,
    );
  }),
};

const dmg: Spec<"dmg"> = {
  usage: "/dmg <who> <n> [type]",
  summary: "Deal damage: temporary Stamina first, after weakness and immunity.",
  gmOnly: false,
  parse: (args) => {
    const [who, n, type, extra] = words(args);
    const value = amount(n);
    if (who === undefined || value === undefined || extra !== undefined) return usage(dmg);
    if (type !== undefined && !/^[a-z]{1,20}$/i.test(type)) return usage(dmg);
    return type === undefined
      ? { type: "dmg", who, amount: value }
      : { type: "dmg", who, amount: value, damageType: type.toLowerCase() };
  },
  complete: targetThen(),
};

const recover: Spec<"recover"> = {
  usage: "/recover <hero> [ally]",
  summary: "Spend a Recovery to regain a third of max Stamina; 'ally' while dying.",
  gmOnly: false,
  parse: (args) => {
    const [who, ally, extra] = words(args);
    if (who === undefined || extra !== undefined) return usage(recover);
    if (ally !== undefined && ally.toLowerCase() !== "ally") return usage(recover);
    return { type: "recover", who, ally: ally !== undefined };
  },
  complete: targetThen((_slice, _who, typed) => startingWith(["ally"], typed)),
};

const cond: Spec<"cond"> = {
  usage: "/cond <who> [-]<condition> [eot|save|end]",
  summary: "Set a condition (to end of encounter unless EoT or save ends), or remove it with -.",
  gmOnly: false,
  parse: (args) => {
    const [who, name, duration, extra] = words(args);
    if (who === undefined || name === undefined || extra !== undefined) return usage(cond);
    const remove = name.startsWith("-");
    const condition = conditionNamed(remove ? name.slice(1) : name);
    if (typeof condition !== "string") return condition;
    if (remove)
      return duration === undefined ? { type: "cond", who, condition, remove } : usage(cond);
    if (duration === undefined) return { type: "cond", who, condition };
    const typed = duration.toLowerCase();
    const found = DURATIONS.find((d) => d === typed);
    return found === undefined ? usage(cond) : { type: "cond", who, condition, duration: found };
  },
  complete: targetThen((_slice, _who, typed) => {
    const space = typed.search(/\s/);
    if (space === -1) {
      const minus = typed.startsWith("-") ? "-" : "";
      return startingWith(CONDITIONS, typed.slice(minus.length)).map((c) => `${minus}${c}`);
    }
    const name = typed.slice(0, space);
    return startingWith(DURATIONS, typed.slice(space + 1).trim()).map((d) => `${name} ${d}`);
  }),
};

const save: Spec<"save"> = {
  usage: "/save <who> [condition]",
  summary: "Roll a save (d10, 6+) against save-ends conditions.",
  gmOnly: false,
  parse: (args) => {
    const [who, name, extra] = words(args);
    if (who === undefined || extra !== undefined) return usage(save);
    if (name === undefined) return { type: "save", who };
    const condition = conditionNamed(name);
    return typeof condition === "string" ? { type: "save", who, condition } : condition;
  },
  complete: targetThen((slice, who, typed) => {
    const found = resolve(slice, who);
    if ("refusal" in found) return [];
    const conditions = found.kind === "hero" ? found.hero.conditions : found.creature.conditions;
    return startingWith(
      conditions.filter((c) => c.duration === "save").map((c) => c.name),
      typed,
    );
  }),
};

/** The most a /malice reason may say. */
const REASON_MAX = 40;

const malice: Spec<"malice"> = {
  usage: "/malice <+N|-N> [reason]",
  summary: "Gain or spend Malice, saying what for if you like.",
  gmOnly: true,
  parse: (args) => {
    const [step, ...rest] = words(args);
    const by = signedStep(step);
    if (by === undefined) return usage(malice);
    const reason = cleanText(rest.join(" "));
    if (lengthOf(reason) > REASON_MAX)
      return { refusal: `Keep the reason to ${REASON_MAX} characters.` };
    return reason === "" ? { type: "malice", by } : { type: "malice", by, reason };
  },
};

const token: Spec<"token"> = {
  usage: "/token <+N|-N|reset>",
  summary: "Spend hero tokens. The GM adds them, or resets to one per hero.",
  gmOnly: false,
  parse: (args) => {
    const [step, extra] = words(args);
    if (extra !== undefined) return usage(token);
    if (step?.toLowerCase() === "reset") return { type: "token", change: "reset" };
    const by = signedStep(step);
    return by === undefined ? usage(token) : { type: "token", change: by };
  },
  complete: (_slice, partial) => startingWith(["-1", "reset"], partial.trim()),
};

const victory: Spec<"victory"> = {
  usage: "/victory [hero] <+N|-N>",
  summary: "Award Victories to one hero or all of them; they feed the next /start.",
  gmOnly: true,
  parse: (args) => {
    const parts = words(args);
    const by = signedStep(parts.at(-1));
    if (by === undefined || parts.length > 2) return usage(victory);
    const who = parts.length === 2 ? parts[0] : undefined;
    return who === undefined || who.toLowerCase() === "all"
      ? { type: "victory", by }
      : { type: "victory", who, by };
  },
  complete: (slice, partial) =>
    startingWith(["all", ...slice.heroes.map((h) => h.id)], partial.trim()),
};

const fs: Spec<"fs"> = {
  usage: "/fs <creature> <target> [type] [xN]",
  summary:
    "A free strike: fixed damage, of a type if named; xN minions of a squad strike together.",
  gmOnly: true,
  parse: (args) => {
    const [who, target, ...rest] = words(args);
    if (who === undefined || target === undefined || rest.length > 2) return usage(fs);
    let damageType: string | undefined;
    let minions: number | undefined;
    for (const word of rest) {
      const count = /^[x×](\d+)$/i.exec(word);
      if (count !== null && minions === undefined && Number(count[1]) >= 1)
        minions = Math.min(Number(count[1]), SQUAD_SIZE);
      else if (/^[a-z]{1,20}$/i.test(word) && damageType === undefined)
        damageType = word.toLowerCase();
      else return usage(fs);
    }
    return {
      type: "fs",
      who,
      target,
      ...(damageType !== undefined && { damageType }),
      ...(minions !== undefined && { minions }),
    };
  },
  complete: targetThen((slice, _who, typed, actor) => completeWho(slice, typed, actor)),
};

/** The most squares one push, pull or slide may name. */
const FORCED_MAX = 20;

const notASquare = (typed: string): Refused => ({
  refusal: `'${quote(typed)}' isn't a square like c5.`,
});

const map: Spec<"map"> = {
  usage: "/map <map id>|off",
  summary: "Load a map from the campaign's maps folder, or put it away.",
  gmOnly: true,
  parse: (args) => {
    const [id, extra] = words(args);
    if (id === undefined || extra !== undefined) return usage(map);
    return id.toLowerCase() === "off" ? { type: "map" } : { type: "map", id: id.toLowerCase() };
  },
  complete: (_slice, partial) => startingWith(["off"], partial.trim()),
};

const place: Spec<"place"> = {
  usage: "/place <who> <square>",
  summary: "Put a token on the map at a square like c5.",
  gmOnly: false,
  parse: (args) => {
    const [who, typed, extra] = words(args);
    if (who === undefined || typed === undefined || extra !== undefined) return usage(place);
    const square = parseSquare(typed);
    return square === undefined ? notASquare(typed) : { type: "place", who, at: square };
  },
  complete: targetThen(),
};

const move: Spec<"move"> = {
  usage: "/move <who> <square> [main]",
  summary:
    "Move by the shortest path, up to speed a turn; main to move again with the main action.",
  gmOnly: false,
  parse: (args) => {
    const [who, typed, extra, more] = words(args);
    if (who === undefined || typed === undefined || more !== undefined) return usage(move);
    if (extra !== undefined && extra.toLowerCase() !== "main") return usage(move);
    const square = parseSquare(typed);
    if (square === undefined) return notASquare(typed);
    return extra === undefined
      ? { type: "move", who, to: square }
      : { type: "move", who, to: square, main: true };
  },
  complete: targetThen((_slice, _who, typed) => {
    const word = /^(\S+\s+)(\S*)$/.exec(typed);
    return word === null ? [] : startingWith(["main"], word[2]!).map((m) => `${word[1]}${m}`);
  }),
};

const dist: Spec<"dist"> = {
  usage: "/dist <who|square> <who|square>",
  summary: "Count the squares between tokens or squares.",
  gmOnly: false,
  parse: (args) => {
    const [from, to, extra] = words(args);
    if (from === undefined || to === undefined || extra !== undefined) return usage(dist);
    return { type: "dist", from, to };
  },
  complete: targetThen((slice, _who, typed, actor) => completeWho(slice, typed, actor)),
};

const forced = <K extends "push" | "pull" | "slide">(type: K, summary: string): Spec<K> => {
  const spec: Spec<K> = {
    usage:
      type === "slide"
        ? `/slide <who> <n> to <square> [from <who>]`
        : `/${type} <who> <n> [from <who>] [to <square>]`,
    summary,
    gmOnly: false,
    parse: (args) => {
      const [who, n, ...rest] = words(args);
      if (who === undefined || n === undefined || !/^\d+$/.test(n)) return usage(spec);
      const distance = Number(n);
      if (distance < 1 || distance > FORCED_MAX)
        return { refusal: `Force move 1 to ${FORCED_MAX} squares at a time.` };
      let from: string | undefined;
      let to: Square | undefined;
      for (let i = 0; i < rest.length; i += 2) {
        const word = rest[i]!.toLowerCase();
        const value = rest[i + 1];
        if (value === undefined) return usage(spec);
        if (word === "from" && from === undefined) from = value;
        else if (word === "to" && to === undefined) {
          to = parseSquare(value);
          if (to === undefined) return notASquare(value);
        } else return usage(spec);
      }
      if (type === "slide" && to === undefined)
        return { refusal: `Say where: /slide ${who} ${n} to <square>.` };
      return {
        type,
        who,
        distance,
        ...(from !== undefined && { from }),
        ...(to !== undefined && { to }),
      } as Extract<DsCommand, { readonly type: K }>;
    },
    complete: targetThen((slice, _who, typed, actor) => {
      const source = /^(\d+\s+(?:.*\s)?from\s+)(\S*)$/i.exec(typed);
      if (source !== null)
        return completeWho(slice, source[2]!, actor).map((id) => `${source[1]}${id}`);
      const word = /^(\d+\s+(?:.*\s)?)(\S*)$/.exec(typed);
      return word === null
        ? []
        : startingWith(["from", "to"], word[2]!).map((w) => `${word[1]}${w}`);
    }),
  };
  return spec;
};

export const commands: CommandSpecs<DsCommand, DrawSteelState> = {
  hero,
  play,
  unplay,
  add,
  start: bare("start", "Start a combat: who picks first, then resources and Malice.", true),
  first,
  turn,
  done: bare("done", "End the current turn: EoT conditions end, save-ends roll a save.", false),
  round: bare("round", "Start the next round now.", true),
  end: bare("end", "End the combat: resources, surges and Malice are lost, conditions end.", true),
  rest: bare("rest", "A respite: Stamina and Recoveries back to full, Victories to XP.", true),
  pr,
  dmg,
  heal: amountFor("heal", "Regain Stamina, up to max."),
  temp: amountFor("temp", "Gain temporary Stamina; it doesn't stack, the larger stays."),
  recover,
  cond,
  save,
  res: stepFor("res", "Gain or spend heroic resource."),
  surge: stepFor("surge", "Gain or spend surges."),
  malice,
  token,
  victory,
  fs,
  map,
  place,
  move,
  dist,
  push: forced("push", "Push straight away from the source, less stability."),
  pull: forced("pull", "Pull straight toward the source, less stability."),
  slide: forced("slide", "Slide any way to a square, less stability."),
};

/** The map file a /map needs the host to read, `maps/<id>.txt`, if it hasn't been read yet. */
export function mapNeed<C extends { readonly type: string }>(command: C): string | undefined {
  const c = command as unknown as DsCommand;
  return c.type === "map" && c.id !== undefined && c.grid === undefined ? c.id : undefined;
}

/**
 * Puts the grid the host read (see `readMapText`) into the /map that needed it, with the id of
 * the file it came from when the host found it by a start of its id.
 */
export function withMapGrid<C extends { readonly type: string }>(
  command: C,
  grid: MapGrid,
  id?: string,
): C {
  const c = command as unknown as DsCommand;
  return (c.type === "map" ? { ...c, grid, ...(id !== undefined && { id }) } : c) as unknown as C;
}

/** What the host must look up before a command reaches the room. */
export type HostNeed =
  | { readonly kind: "hero"; readonly id: string }
  | { readonly kind: "monster"; readonly id: string }
  | { readonly kind: "player"; readonly label: string };

/**
 * Which file or player a command needs the host to find: a hero sheet for /hero (put it in
 * `sheet`), a stat block for /add (in `sheet`), or the actor a GM's /play names (in `playerActor`).
 */
export function hostNeeds<C extends { readonly type: string }>(command: C): HostNeed | undefined {
  const c = command as DsCommand;
  switch (c.type) {
    case "hero":
      return c.sheet === undefined ? { kind: "hero", id: c.hero } : undefined;
    case "add":
      return c.sheet === undefined ? { kind: "monster", id: c.monster } : undefined;
    case "play":
      return c.player !== undefined && c.playerActor === undefined
        ? { kind: "player", label: c.player }
        : undefined;
    default:
      return undefined;
  }
}

/** What the host found for a `HostNeed`. */
export type HostFact =
  | { readonly kind: "hero"; readonly sheet: HeroSheet }
  | { readonly kind: "monster"; readonly sheet: StatBlock }
  | { readonly kind: "player"; readonly actor: string };

/** Puts what the host found into the command that needed it, so the host never names a field. */
export function withHostFact<C extends { readonly type: string }>(command: C, fact: HostFact): C {
  const c = command as unknown as DsCommand;
  const filled: DsCommand =
    fact.kind === "hero" && c.type === "hero"
      ? { ...c, sheet: fact.sheet }
      : fact.kind === "monster" && c.type === "add"
        ? { ...c, sheet: fact.sheet }
        : fact.kind === "player" && c.type === "play"
          ? { ...c, playerActor: fact.actor }
          : c;
  return filled as unknown as C;
}
