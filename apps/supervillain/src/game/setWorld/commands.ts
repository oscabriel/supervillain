import {
  completeMapArgs,
  MAP_USAGE,
  type MapGeneration,
  type MapGrid,
  parseMapArgs,
  parseSquare,
  type Square,
} from "../drawSteel/map.ts";
import type { CommandSpec, CommandSpecs, Refused } from "../module.ts";
import { quote } from "../text.ts";
import { SEED_MAX } from "./events.ts";
import { completeFighters, isDown, type SetCharacter, type SetState } from "./state.ts";

/**
 * set.world's commands. Where the act is Draw Steel's too, the word is: /map, /play, /unplay,
 * /place, /start, /move, /done and /end, typed the same and told apart by their types (`set-*`),
 * since a table offers one ruleset's. Rolling a fighter (/recruit, /foe) and /attack are Set's own.
 */
export type SetCommand =
  | {
      readonly type: "set-map";
      /** The map file's id; absent for /map off. */
      readonly id?: string;
      /** The grid, which the host reads from `maps/<id>.txt` and puts here; decide refuses without it. */
      readonly grid?: MapGrid;
      /** `/map new`, as Draw Steel's: the host generates it and puts its id here in its place. */
      readonly generate?: MapGeneration;
    }
  | RollCommand<"set-recruit">
  | RollCommand<"set-foe">
  | { readonly type: "set-play"; readonly who: string }
  | { readonly type: "set-unplay"; readonly who?: string }
  | { readonly type: "set-place"; readonly who: string; readonly at: Square }
  | { readonly type: "set-start" }
  | { readonly type: "set-move"; readonly who: string; readonly to: Square }
  | { readonly type: "set-attack"; readonly who: string; readonly target: string }
  | { readonly type: "set-done" }
  | { readonly type: "set-end" };

/** A fighter rolled at set.world: /recruit for the party, /foe for its enemies. */
export interface RollCommand<T extends "set-recruit" | "set-foe"> {
  readonly type: T;
  readonly name: string;
  /** The seed as typed; the host picks one when it's left out. */
  readonly seed?: number;
  /** The roll, which the host fetches and puts here; decide refuses without it. */
  readonly character?: SetCharacter;
}

type Spec<T extends SetCommand["type"]> = CommandSpec<
  Extract<SetCommand, { readonly type: T }>,
  SetState
>;

const words = (args: string) =>
  args
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "");

const usage = (spec: { usage: string }): Refused => ({ refusal: `Usage: ${spec.usage}` });

const notASquare = (typed: string): Refused => ({
  refusal: `'${quote(typed)}' isn't a square like c5.`,
});

/** Completes the first argument as a fighter, and the second with `then` once one is typed. */
const fighterThen =
  (then?: (slice: SetState, typed: string, actor: string) => string[]) =>
  (slice: SetState, partial: string, actor: string): string[] => {
    const space = partial.search(/\s/);
    if (space === -1) return completeFighters(slice, partial, actor);
    const who = partial.slice(0, space);
    const typed = partial.slice(space + 1).trimStart();
    return (then?.(slice, typed, actor) ?? []).map((r) => `${who} ${r}`);
  };

const map: Spec<"set-map"> = {
  name: "map",
  usage: MAP_USAGE,
  summary:
    "Load the fight's map from the campaign's maps folder, generate one there, or put it away.",
  gmOnly: true,
  parse: (args) => {
    const parsed = parseMapArgs(args);
    if ("refusal" in parsed) return parsed;
    if (parsed.generate !== undefined) return { type: "set-map", generate: parsed.generate };
    return parsed.id === undefined ? { type: "set-map" } : { type: "set-map", id: parsed.id };
  },
  complete: (_slice, partial) => completeMapArgs(partial),
};

const roll = <T extends "set-recruit" | "set-foe">(
  type: T,
  name: string,
  summary: string,
): Spec<T> => {
  const spec: Spec<T> = {
    name,
    usage: `/${name} <name> [seed]`,
    summary,
    gmOnly: true,
    parse: (args) => {
      const parts = words(args);
      const last = parts.at(-1);
      const seeded = parts.length > 1 && last !== undefined && /^\d+$/.test(last);
      const seed = seeded ? Number(last) : undefined;
      if (seed !== undefined && seed > SEED_MAX)
        return { refusal: `A set.world seed is a whole number from 0 to ${SEED_MAX}.` };
      const named = (seeded ? parts.slice(0, -1) : parts).join(" ");
      if (named === "") return usage(spec);
      return { type, name: named, ...(seed !== undefined && { seed }) } as Extract<
        SetCommand,
        { readonly type: T }
      >;
    },
  };
  return spec;
};

const play: Spec<"set-play"> = {
  name: "play",
  usage: "/play <who>",
  summary: "Play a party member nobody else plays.",
  gmOnly: false,
  parse: (args) => {
    const [who, extra] = words(args);
    return who === undefined || extra !== undefined ? usage(play) : { type: "set-play", who };
  },
  complete: (slice, partial, actor) =>
    completeFighters(
      slice,
      partial,
      actor,
      (f) => f.side === "party" && f.player === undefined && !isDown(f),
    ),
};

const unplay: Spec<"set-unplay"> = {
  name: "unplay",
  usage: "/unplay [who]",
  summary: "Stop playing your fighter. The GM names any fighter to free it.",
  gmOnly: false,
  parse: (args) => {
    const [who, extra] = words(args);
    if (extra !== undefined) return usage(unplay);
    return who === undefined ? { type: "set-unplay" } : { type: "set-unplay", who };
  },
  complete: (slice, partial, actor) =>
    completeFighters(slice, partial, actor, (f) => f.player !== undefined),
};

const place: Spec<"set-place"> = {
  name: "place",
  usage: "/place <who> <square>",
  summary: "Put a fighter on the map at a square like c5.",
  gmOnly: false,
  parse: (args) => {
    const [who, typed, extra] = words(args);
    if (who === undefined || typed === undefined || extra !== undefined) return usage(place);
    const at = parseSquare(typed);
    return at === undefined ? notASquare(typed) : { type: "set-place", who, at };
  },
  complete: fighterThen(),
};

const move: Spec<"set-move"> = {
  name: "move",
  usage: "/move <who> <square>",
  summary: "Move by the shortest path; in the fight, on its turn and up to its speed.",
  gmOnly: false,
  parse: (args) => {
    const [who, typed, extra] = words(args);
    if (who === undefined || typed === undefined || extra !== undefined) return usage(move);
    const to = parseSquare(typed);
    return to === undefined ? notASquare(typed) : { type: "set-move", who, to };
  },
  complete: fighterThen(),
};

const attack: Spec<"set-attack"> = {
  name: "attack",
  usage: "/attack <who> <target>",
  summary: "Attack once on its turn, for 20 stamina, if its weapon reaches.",
  gmOnly: false,
  parse: (args) => {
    const [who, target, extra] = words(args);
    return who === undefined || target === undefined || extra !== undefined
      ? usage(attack)
      : { type: "set-attack", who, target };
  },
  complete: fighterThen((slice, typed, actor) =>
    completeFighters(slice, typed, actor, (f) => !isDown(f)),
  ),
};

const bare = <T extends "set-start" | "set-done" | "set-end">(
  type: T,
  name: string,
  summary: string,
  gmOnly: boolean,
): Spec<T> => ({
  name,
  usage: `/${name}`,
  summary,
  gmOnly,
  parse: (args) =>
    args.trim() === ""
      ? ({ type } as Extract<SetCommand, { readonly type: T }>)
      : { refusal: `Usage: /${name}` },
});

export const commands: CommandSpecs<SetCommand, SetState> = {
  "set-map": map,
  "set-recruit": roll(
    "set-recruit",
    "recruit",
    "Roll a party member at set.world, by seed or at random.",
  ),
  "set-foe": roll("set-foe", "foe", "Roll a foe at set.world, by seed or at random."),
  "set-play": play,
  "set-unplay": unplay,
  "set-place": place,
  "set-start": bare("set-start", "start", "Start the fight: turns follow initiative.", true),
  "set-move": move,
  "set-attack": attack,
  "set-done": bare(
    "set-done",
    "done",
    "End the turn (a rest, without an attack); the next by initiative begins.",
    false,
  ),
  "set-end": bare("set-end", "end", "End the fight now.", true),
};

/** What the host must find before a set.world command reaches the room. */
export type SetNeed =
  | { readonly kind: "map"; readonly id: string }
  | { readonly kind: "character"; readonly seed?: number };

/**
 * Which file or roll a command needs the host to find: the map a /map loads, or the character a
 * /recruit or /foe rolls at set.world (by its seed, or one the host picks).
 */
export function setNeed<C extends { readonly type: string }>(command: C): SetNeed | undefined {
  const c = command as unknown as SetCommand;
  switch (c.type) {
    case "set-map":
      return c.id !== undefined && c.grid === undefined && c.generate === undefined
        ? { kind: "map", id: c.id }
        : undefined;
    case "set-recruit":
    case "set-foe":
      return c.character === undefined
        ? { kind: "character", ...(c.seed !== undefined && { seed: c.seed }) }
        : undefined;
    default:
      return undefined;
  }
}

/** What the host found for a `SetNeed`. */
export type SetFact =
  | { readonly kind: "map"; readonly id: string; readonly grid: MapGrid }
  | { readonly kind: "character"; readonly character: SetCharacter };

/** Puts what the host found into the command that needed it, so the host never names a field. */
export function withSetFact<C extends { readonly type: string }>(command: C, fact: SetFact): C {
  const c = command as unknown as SetCommand;
  const filled: SetCommand =
    fact.kind === "map" && c.type === "set-map"
      ? { ...c, id: fact.id, grid: fact.grid }
      : fact.kind === "character" && (c.type === "set-recruit" || c.type === "set-foe")
        ? { ...c, seed: fact.character.seed, character: fact.character }
        : c;
  return filled as unknown as C;
}
