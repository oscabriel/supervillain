/**
 * The text map's commands (ASSESSMENT Q7): /map, /place, /move, /dist, /push, /pull and /slide.
 * Decide works out every path, distance and slam, so the events carry them and apply only moves
 * tokens.
 */
import type { Decision, NewEvent } from "@supervillain/engine";
import { GM, type Refused } from "../module.ts";
import { quote } from "../text.ts";
import type { DsCommand, ForcedCommand } from "./commands.ts";
import { event } from "./events.ts";
import {
  checkGrid,
  distance,
  formatSquare,
  inBounds,
  parseSquare,
  type Square,
  sameSquare,
  terrainAt,
} from "./map.ts";
import { modifiedDamage } from "./math.ts";
import {
  bestPull,
  cheapestPath,
  type Forced,
  forcedLine,
  type Mover,
  type Occupants,
  slideRoute,
  toward,
} from "./movement.ts";
import { ID } from "./schema.ts";
import {
  type Board,
  byMark,
  capitalized,
  conditionsOf,
  controls,
  type DrawSteelState,
  everyone,
  heroOf,
  isDead,
  plural,
  resolve,
  sideOf,
  type Who,
} from "./state.ts";

const refuse = (refusal: string): Refused => ({ refusal });
const decided = (...events: NewEvent[]): Decision => ({ events });

export const NO_MAP = "No map is loaded; the GM loads one with /map.";

/**
 * A creature's speed now: its sheet's, 0 while grabbed or restrained (Classes, "Grabbed",
 * "Restrained"), at most 2 while slowed (Classes, "Slowed"). `why` names the condition that set it.
 */
export function speedOf(
  slice: DrawSteelState,
  who: Who,
): { readonly speed: number; readonly why?: string } {
  const base =
    who.kind === "hero" ? who.hero.sheet.speed : (slice.blocks[who.creature.block]?.speed ?? 0);
  const has = new Set(conditionsOf(who).map((c) => c.name));
  for (const why of ["restrained", "grabbed"] as const) if (has.has(why)) return { speed: 0, why };
  if (has.has("slowed") && base > 2) return { speed: 2, why: "slowed" };
  return { speed: base };
}

/** "Each creature has a stability", never below 0 (Combat, "Stability"). */
const stabilityOf = (slice: DrawSteelState, who: Who): number =>
  Math.max(
    0,
    who.kind === "hero"
      ? who.hero.sheet.stability
      : (slice.blocks[who.creature.block]?.stability ?? 0),
  );

/** The living tokens on the map, but `except`: the dead don't take up space. */
export function occupants(slice: DrawSteelState, board: Board, except?: string): Occupants {
  const at = new Map<string, Who>();
  for (const who of everyone(slice)) {
    const square = board.tokens[who.id];
    if (square !== undefined && who.id !== except && !isDead(who))
      at.set(`${square.x},${square.y}`, who);
  }
  return (square) => {
    const who = at.get(`${square.x},${square.y}`);
    return who === undefined ? undefined : { id: who.id, side: sideOf(who) };
  };
}

export const moverOf = (who: Who): Mover => ({
  side: sideOf(who),
  prone: conditionsOf(who).some((c) => c.name === "prone"),
});

/** Why a creature can't stand on `square`, if it can't. */
function cantStand(slice: DrawSteelState, board: Board, square: Square, who: Who) {
  const named = formatSquare(square);
  const terrain = terrainAt(board.terrain, square);
  if (terrain === "wall") return `${named} is a wall.`;
  if (terrain === "outside") return `${named} is outside the map.`;
  const there = occupants(slice, board, who.id)(square);
  if (there !== undefined)
    return `${named} is taken by ${everyone(slice).find((w) => w.id === there.id)?.name}.`;
  return undefined;
}

const notPlaced = (who: Who) => `${who.name} isn't on the map; /place them first.`;

export function loadMap(
  slice: DrawSteelState,
  command: Extract<DsCommand, { type: "map" }>,
): Decision {
  if (command.id === undefined)
    return slice.map === undefined
      ? refuse("No map is loaded.")
      : decided(event("ds.map-cleared", {}));
  if (!ID.test(command.id)) return refuse(`'${quote(command.id)}' isn't a map id.`);
  if (command.grid === undefined) return refuse(`No map for '${quote(command.id)}' was loaded.`);
  const grid = checkGrid(command.id, command.grid);
  if ("refusal" in grid) return grid;
  return decided(
    event("ds.map-loaded", { id: command.id, name: grid.name, terrain: [...grid.terrain] }),
  );
}

export function place(
  slice: DrawSteelState,
  actor: string,
  command: Extract<DsCommand, { type: "place" }>,
): Decision {
  const board = slice.map;
  if (board === undefined) return refuse(NO_MAP);
  const who = resolve(slice, command.who);
  if ("refusal" in who) return who;
  if (!controls(actor, who)) return refuse("You can only place your own hero.");
  // A player placing again mid-fight would be moving without paying for it.
  if (actor !== GM && slice.combat.active && board.tokens[who.id] !== undefined)
    return refuse(`${who.name} is on the map already; /move instead.`);
  const why = cantStand(slice, board, command.at, who);
  if (why !== undefined) return refuse(why);
  return decided(event("ds.placed", { id: who.id, at: command.at }));
}

/**
 * A move along the cheapest path (Combat, "Movement"). In combat a player moves only their hero,
 * on its turn, and its moves that turn add up to no more than its speed (Combat, "Advance",
 * "Can't Exceed Speed"), or twice that once its main action goes on moving too (`main`; Combat,
 * "Main Actions"). The GM's moves count toward the acting creature's turn but may go over it, and
 * outside combat anyone's may; the feed says how far it went.
 */
export function move(
  slice: DrawSteelState,
  actor: string,
  command: Extract<DsCommand, { type: "move" }>,
): Decision {
  const board = slice.map;
  if (board === undefined) return refuse(NO_MAP);
  const who = resolve(slice, command.who);
  if ("refusal" in who) return who;
  if (!controls(actor, who)) return refuse("You can only move your own hero.");
  const from = board.tokens[who.id];
  if (from === undefined) return refuse(notPlaced(who));
  if (isDead(who)) return refuse(`${who.name} is dead.`);
  const { combat } = slice;
  const limited = actor !== GM && combat.active;
  if (limited && combat.acting !== who.id)
    return refuse(`It isn't ${who.name}'s turn; the GM moves heroes between turns.`);
  const to = command.to;
  if (sameSquare(from, to)) return refuse(`${who.name} is at ${formatSquare(to)} already.`);
  const why = cantStand(slice, board, to, who);
  if (why !== undefined) return refuse(why);
  const { speed, why: slowed } = speedOf(slice, who);
  if (limited && speed === 0)
    return refuse(`${who.name} can't move: speed 0${slowed === undefined ? "" : ` (${slowed})`}.`);
  const route = cheapestPath(
    board.terrain,
    from,
    to,
    moverOf(who),
    occupants(slice, board, who.id),
  );
  if (route === undefined) return refuse(`${who.name} can't reach ${formatSquare(to)}.`);
  // The acting creature's turn: what it has spent, and what it may.
  const turn = combat.active && combat.acting === who.id;
  const before = combat.moved?.id === who.id ? combat.moved : { spent: 0, main: false };
  const main = before.main || command.main === true;
  const allowance = main ? 2 * speed : speed;
  const spent = before.spent + route.cost;
  if (limited && spent > allowance) {
    const takes = `${formatSquare(to)} takes ${plural(route.cost, "square")} of movement`;
    if (before.spent === 0 && !main)
      return refuse(
        `${who.name} can't move that far: ${takes}, and ${who.name}'s speed is ${speed}.`,
      );
    const left = Math.max(0, allowance - before.spent);
    const again = main ? "" : "; add main to move again with the main action";
    return refuse(
      `${who.name} can't move that far: ${takes}, and ${who.name} has ${left} of speed ${speed} left this turn${again}.`,
    );
  }
  return decided(
    event("ds.moved", {
      id: who.id,
      path: [...route.path],
      cost: route.cost,
      speed,
      ...(turn && { spent, allowance }),
      ...(turn && main && { main: true }),
    }),
  );
}

/**
 * A token or a typed square, for /dist. A placed token's mark wins over the square it spells
 * ("b1" is Bandit Bruiser 1 while it's on the map); the feed names which was measured.
 */
function point(
  slice: DrawSteelState,
  board: Board,
  typed: string,
): { readonly id?: string; readonly at: Square } | Refused {
  const marked = byMark(slice, typed);
  const placed = marked === undefined ? undefined : board.tokens[marked.id];
  if (marked !== undefined && placed !== undefined) return { id: marked.id, at: placed };
  const square = parseSquare(typed);
  if (square !== undefined)
    return inBounds(board.terrain, square)
      ? { at: square }
      : refuse(`${formatSquare(square)} is outside the map.`);
  const who = resolve(slice, typed);
  if ("refusal" in who) return who;
  const at = board.tokens[who.id];
  return at === undefined ? refuse(notPlaced(who)) : { id: who.id, at };
}

/** Squares between two tokens or squares, counted as movement counts them (map.ts `distance`). */
export function measure(
  slice: DrawSteelState,
  command: Extract<DsCommand, { type: "dist" }>,
): Decision {
  const board = slice.map;
  if (board === undefined) return refuse(NO_MAP);
  const from = point(slice, board, command.from);
  if ("refusal" in from) return from;
  const to = point(slice, board, command.to);
  if ("refusal" in to) return to;
  return decided(event("ds.measured", { from, to, distance: distance(from.at, to.at) }));
}

/** Who does the moving: as typed, else the acting creature (for the GM) or the player's hero. */
function sourceOf(
  slice: DrawSteelState,
  actor: string,
  command: ForcedCommand<"push" | "pull" | "slide">,
  target: Who,
): Who | Refused | undefined {
  if (command.from !== undefined) {
    const who = resolve(slice, command.from);
    if ("refusal" in who) return who;
    return actor === GM || controls(actor, who)
      ? who
      : refuse("You can only force move with your own hero.");
  }
  if (actor !== GM) {
    const own = heroOf(slice, actor);
    if (own === undefined) return refuse("You can only force move with your own hero.");
    return resolve(slice, own.id);
  }
  const acting = slice.combat.acting;
  if (acting === undefined || acting === target.id) return undefined;
  const who = resolve(slice, acting);
  return "refusal" in who ? undefined : who;
}

/**
 * The damage a slam deals, untyped, as `ds.damaged` events: into a wall, 2 plus 1 for each square
 * left (Combat, "Slamming Into Objects"); into a creature, 1 for each square left to both (Combat,
 * "Slamming into Creatures"). The dead take none, though one force moved after dying still hits
 * the creature it slams into.
 */
function slamDamage(slice: DrawSteelState, target: Who, slam: Forced["slam"]): NewEvent[] {
  if (slam === undefined) return [];
  const hurt = (who: Who, amount: number): NewEvent[] => {
    if (isDead(who)) return [];
    const sheet = who.kind === "hero" ? who.hero.sheet : (slice.blocks[who.creature.block] ?? {});
    const { dealt, weakness, immunity } = modifiedDamage(amount, undefined, sheet);
    return [
      event("ds.damaged", {
        id: who.id,
        amount,
        ...(weakness > 0 && { weakness }),
        ...(immunity > 0 && { immunity }),
        dealt,
      }),
    ];
  };
  if (slam.into === "wall") return hurt(target, 2 + slam.remaining);
  const other = everyone(slice).find((w) => w.id === slam.into);
  return [
    ...hurt(target, slam.remaining),
    ...(other === undefined ? [] : hurt(other, slam.remaining)),
  ];
}

/**
 * Push, pull or slide (Combat, "Forced Movement"): the distance less the target's stability
 * (Combat, "Stability"), never vertical, ignoring difficult terrain. A restrained creature can't
 * be force moved (Classes, "Restrained"). Nobody force moves themselves: their own movement is a
 * /move. Range isn't checked, since an ability's distance varies, but the event says how far the
 * source stood. Not modelled: who has a grabbed creature (only they may force move it, Classes,
 * "Grabbed"), and size (Combat, "Big Versus Little").
 *
 * A `to` on an empty square is how far along the line to go, so a slam there carries what is left
 * of that; a `to` on a wall or a creature (a pull's own source included) slams with everything
 * left, as a slide's does.
 */
export function forceMove(
  slice: DrawSteelState,
  actor: string,
  command: ForcedCommand<"push" | "pull" | "slide">,
): Decision {
  const board = slice.map;
  if (board === undefined) return refuse(NO_MAP);
  const kind = command.type;
  const target = resolve(slice, command.who);
  if ("refusal" in target) return target;
  const start = board.tokens[target.id];
  if (start === undefined) return refuse(notPlaced(target));
  if (conditionsOf(target).some((c) => c.name === "restrained"))
    return refuse(`${target.name} is restrained and can't be force moved.`);
  const source = sourceOf(slice, actor, command, target);
  if (source !== undefined && "refusal" in source) return source;
  if (source?.id === target.id)
    return refuse(
      kind === "slide"
        ? `${target.name} can't slide themselves; /move instead.`
        : `${target.name} can't ${kind} themselves.`,
    );
  const stability = stabilityOf(slice, target);
  const steps = Math.max(0, command.distance - stability);
  const after = stability > 0 ? ` after stability ${stability}` : "";
  const blocked = occupants(slice, board, target.id);
  const sourceAt = source === undefined ? undefined : board.tokens[source.id];
  let forced: Forced;
  if (kind === "slide") {
    const to = command.to;
    if (to === undefined)
      return refuse(`Say where: /slide ${command.who} ${command.distance} to <square>.`);
    if (sameSquare(start, to)) return refuse(`${target.name} is at ${formatSquare(to)} already.`);
    const route = slideRoute(board.terrain, start, to, blocked);
    if (route === undefined) return refuse(`${target.name} can't be slid to ${formatSquare(to)}.`);
    const needed = route.path.length + (route.into === undefined ? 0 : 1);
    if (needed > steps)
      return refuse(
        `${formatSquare(to)} is ${plural(needed, "square")} away, and the slide is ${steps}${after}.`,
      );
    forced =
      route.into === undefined
        ? { path: route.path }
        : { path: route.path, slam: { into: route.into, remaining: steps - route.path.length } };
  } else {
    if (source === undefined)
      return refuse(
        `${capitalized(kind)} from where? /${kind} ${command.who} ${command.distance} from <who>.`,
      );
    const from = sourceAt;
    if (from === undefined) return refuse(notPlaced(source));
    const away = kind === "push";
    const to = command.to;
    if (to === undefined) {
      forced = away
        ? forcedLine(board.terrain, start, toward(from, start), steps, blocked, { at: from, away })
        : bestPull(board.terrain, start, steps, blocked, from);
    } else {
      const dx = to.x - start.x;
      const dy = to.y - start.y;
      if (dx === 0 && dy === 0) return refuse(`${target.name} is at ${formatSquare(to)} already.`);
      if (dx !== 0 && dy !== 0 && Math.abs(dx) !== Math.abs(dy))
        return refuse(`${formatSquare(to)} isn't in a straight line from ${formatSquare(start)}.`);
      const line = toward(start, to);
      const length = distance(start, to);
      const intoSource = !away && sameSquare(to, from);
      for (let i = 1, here = start; i <= length; i++) {
        const next = { x: here.x + line.x, y: here.y + line.y };
        const [was, now] = [distance(here, from), distance(next, from)];
        const wrongWay = away ? now <= was : now >= was || (sameSquare(next, from) && !intoSource);
        if (wrongWay)
          return refuse(
            `A ${kind} moves ${target.name} ${away ? "away from" : "toward"} ${source.name}, and ${formatSquare(to)} isn't.`,
          );
        here = next;
      }
      if (length > steps)
        return refuse(
          `${formatSquare(to)} is ${plural(length, "square")} away, and the ${kind} is ${steps}${after}.`,
        );
      // Into a wall or a creature, everything left goes into the slam; else only so far.
      const slams =
        terrainAt(board.terrain, to) === "wall" || blocked(to) !== undefined || intoSource;
      forced = forcedLine(board.terrain, start, line, slams ? steps : length, blocked, {
        at: from,
        away,
        intoSource,
      });
    }
  }
  return decided(
    event("ds.force-moved", {
      id: target.id,
      kind,
      ...(source !== undefined && { source: source.id }),
      distance: command.distance,
      stability,
      path: [...forced.path],
      ...(forced.slam !== undefined && { slam: forced.slam }),
      ...(forced.edge === true && { edge: true }),
      ...(sourceAt !== undefined && { apart: distance(sourceAt, start) }),
    }),
    ...slamDamage(slice, target, forced.slam),
  );
}

/** The tokens /end takes off: every creature's, since they leave, and the dead heroes'. */
export function clearedAtEnd(slice: DrawSteelState): ReadonlyArray<string> {
  const board = slice.map;
  if (board === undefined) return [];
  return everyone(slice)
    .filter((w) => board.tokens[w.id] !== undefined && (w.kind === "creature" || isDead(w)))
    .map((w) => w.id);
}
