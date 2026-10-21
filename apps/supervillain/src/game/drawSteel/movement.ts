/**
 * How creatures cross the grid: paths and their cost, the squares a creature can reach, and
 * forced movement's lines. Pure geometry over a terrain grid and who stands where; the rules
 * text each function follows is cited beside it.
 */
import {
  distance,
  inBounds,
  type Square,
  sameSquare,
  standable,
  terrainAt,
  widthOf,
} from "./map.ts";
import type { Side } from "./state.ts";

/** A living creature standing on a square. The dead don't take up space. */
export interface Occupant {
  readonly id: string;
  readonly side: Side;
}

/** Who stands on a square, leaving out the creature that is moving. */
export type Occupants = (square: Square) => Occupant | undefined;

export interface Mover {
  readonly side: Side;
  /** A prone creature crawls. */
  readonly prone: boolean;
}

/** The eight steps, orthogonal first, so ties settle the same way every time. */
const STEPS: ReadonlyArray<Square> = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 1, y: -1 },
  { x: 1, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: -1 },
];

const plus = (a: Square, b: Square): Square => ({ x: a.x + b.x, y: a.y + b.y });

/**
 * Whether a wall fills the corner a diagonal step passes: "A creature can't move diagonally when
 * doing so would involve passing through the corner of a wall or some other object that completely
 * fills the corner" (Combat, "Can't Cut Corners"). The table's ruling: one wall square on either
 * side of the step fills it. Creatures never do, and neither does the map's edge, which is no
 * object; whether the creature may stand where it steps is `standable`'s to say.
 */
function corner(terrain: ReadonlyArray<string>, from: Square, step: Square): boolean {
  if (step.x === 0 || step.y === 0) return false;
  return (
    terrainAt(terrain, { x: from.x + step.x, y: from.y }) === "wall" ||
    terrainAt(terrain, { x: from.x, y: from.y + step.y }) === "wall"
  );
}

/**
 * The movement it costs to enter a square: 1 for any adjacent square, diagonals too (Combat,
 * "Movement"); 1 more for difficult terrain (Combat, "Difficult Terrain"), which an enemy's space
 * is (Combat, "Movement": "You can move through an enemy's space, but that space is difficult
 * terrain"); 1 more again while crawling (Classes, "Prone"). An ally's space costs nothing extra.
 */
function entryCost(
  terrain: ReadonlyArray<string>,
  square: Square,
  mover: Mover,
  occupants: Occupants,
): number {
  const there = occupants(square);
  const difficult =
    terrainAt(terrain, square) === "difficult" ||
    (there !== undefined && there.side !== mover.side);
  return 1 + (difficult ? 1 : 0) + (mover.prone ? 1 : 0);
}

interface Explored {
  readonly cost: Float64Array;
  readonly prev: Int32Array;
}

/** The cheapest movement to every square from `from` up to `limit`: Dijkstra, in buckets by cost. */
function explore(
  terrain: ReadonlyArray<string>,
  from: Square,
  mover: Mover,
  occupants: Occupants,
  limit: number,
): Explored {
  const width = widthOf(terrain);
  const size = width * terrain.length;
  const cost = new Float64Array(size).fill(Infinity);
  const prev = new Int32Array(size).fill(-1);
  const index = (s: Square) => s.y * width + s.x;
  const buckets: number[][] = [[index(from)]];
  cost[index(from)] = 0;
  for (let c = 0; c < buckets.length; c++) {
    for (const i of buckets[c] ?? []) {
      if (cost[i] !== c) continue;
      const here = { x: i % width, y: Math.floor(i / width) };
      for (const step of STEPS) {
        const next = plus(here, step);
        if (!standable(terrain, next) || corner(terrain, here, step)) continue;
        const total = c + entryCost(terrain, next, mover, occupants);
        const j = index(next);
        if (total > limit || total >= cost[j]!) continue;
        cost[j] = total;
        prev[j] = i;
        (buckets[total] ??= []).push(j);
      }
    }
  }
  return { cost, prev };
}

/**
 * The cheapest path from `from` to `to`, the squares entered in order, and what it costs; walls
 * block, allies don't, enemies cost extra. Undefined if there is no way. Whether the mover may
 * stop on `to` is the caller's to check: no creature may end in another's space (Combat,
 * "Movement").
 */
export function cheapestPath(
  terrain: ReadonlyArray<string>,
  from: Square,
  to: Square,
  mover: Mover,
  occupants: Occupants,
): { readonly path: ReadonlyArray<Square>; readonly cost: number } | undefined {
  if (!inBounds(terrain, to)) return undefined;
  const { cost, prev } = explore(terrain, from, mover, occupants, Infinity);
  const width = widthOf(terrain);
  const end = to.y * width + to.x;
  if (cost[end] === Infinity) return undefined;
  const path: Square[] = [];
  for (let i = end; i !== from.y * width + from.x; i = prev[i]!)
    path.unshift({ x: i % width, y: Math.floor(i / width) });
  return { path, cost: cost[end]! };
}

/**
 * Every square a creature can move to with `speed` (Combat, "Can't Exceed Speed"), and stop on:
 * not its own, and nobody else's (Combat, "Movement"). In reading order.
 */
export function reachable(
  terrain: ReadonlyArray<string>,
  from: Square,
  speed: number,
  mover: Mover,
  occupants: Occupants,
): ReadonlyArray<Square> {
  const { cost } = explore(terrain, from, mover, occupants, speed);
  const width = widthOf(terrain);
  const squares: Square[] = [];
  cost.forEach((c, i) => {
    const square = { x: i % width, y: Math.floor(i / width) };
    if (c > 0 && c <= speed && occupants(square) === undefined) squares.push(square);
  });
  return squares;
}

/** Where a forced move ended: the squares entered, and what it slammed into with how many squares left. */
export interface Forced {
  readonly path: ReadonlyArray<Square>;
  /** `into` is "wall" or the id of the creature hit. */
  readonly slam?: { readonly into: string; readonly remaining: number };
  /** The map's edge stopped it short. */
  readonly edge?: boolean;
}

export const sign = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0);

/** The step from one square toward another, diagonals included. */
export const toward = (from: Square, to: Square): Square => ({
  x: sign(to.x - from.x),
  y: sign(to.y - from.y),
});

/**
 * A push or a pull: up to `steps` squares in a straight line (Combat, "Forced Movement"), each one
 * farther from the source (push) or closer to it (pull); the move ends where that stops being so,
 * and a pull ends beside the source rather than in it, unless `intoSource`, when it slams into the
 * source ("You can force move another creature into yourself with a pull or a slide", Combat,
 * "Slamming into Creatures"). Difficult terrain is ignored. A wall ends it with a slam (Combat,
 * "Slamming Into Objects"), and so does a creature; the edge of the map just ends it.
 */
export function forcedLine(
  terrain: ReadonlyArray<string>,
  start: Square,
  step: Square,
  steps: number,
  occupants: Occupants,
  source: { readonly at: Square; readonly away: boolean; readonly intoSource?: boolean },
): Forced {
  const path: Square[] = [];
  let here = start;
  for (let moved = 0; moved < steps; moved++) {
    const next = plus(here, step);
    const before = distance(here, source.at);
    const after = distance(next, source.at);
    const atSource = sameSquare(next, source.at);
    if ((atSource && !source.intoSource) || (source.away ? after <= before : after >= before))
      break;
    const remaining = steps - moved;
    const there = terrainAt(terrain, next);
    if (there === "wall" || corner(terrain, here, step))
      return { path, slam: { into: "wall", remaining } };
    if (there === "outside") return { path, edge: true };
    const hit = occupants(next);
    if (hit !== undefined) return { path, slam: { into: hit.id, remaining } };
    path.push(next);
    here = next;
  }
  return { path };
}

/**
 * A pull with no square named: of the eight straight lines from the target, the one that leaves
 * it closest to the source, then the one that moves it furthest; the line straight toward the
 * source wins a tie, then the orthogonal ones (Combat, "Forced Movement": "Pull X", "moved
 * directly toward").
 */
export function bestPull(
  terrain: ReadonlyArray<string>,
  start: Square,
  steps: number,
  occupants: Occupants,
  from: Square,
): Forced {
  const direct = toward(start, from);
  const lines = [direct, ...STEPS.filter((s) => !sameSquare(s, direct))];
  let best: { forced: Forced; gap: number } | undefined;
  for (const step of lines) {
    const forced = forcedLine(terrain, start, step, steps, occupants, { at: from, away: false });
    const end = forced.path.at(-1) ?? start;
    const gap = distance(end, from);
    if (
      best === undefined ||
      gap < best.gap ||
      (gap === best.gap && forced.path.length > best.forced.path.length)
    )
      best = { forced, gap };
  }
  return best!.forced;
}

/**
 * A slide's route to a square: any way at all, but never vertical (Combat, "Forced Movement");
 * difficult terrain is ignored, so every square is 1. Through empty squares only, since entering a
 * creature's or a wall's would end the slide in a slam. If `to` is a wall or a creature, the route
 * ends beside it and `into` names what it slams into. Undefined if there is no way.
 */
export function slideRoute(
  terrain: ReadonlyArray<string>,
  start: Square,
  to: Square,
  occupants: Occupants,
): { readonly path: ReadonlyArray<Square>; readonly into?: string } | undefined {
  const target = terrainAt(terrain, to);
  const hit = occupants(to);
  const into = target === "wall" ? "wall" : hit?.id;
  if (target === "outside") return undefined;
  const width = widthOf(terrain);
  const index = (s: Square) => s.y * width + s.x;
  const prev = new Map<number, number>([[index(start), -1]]);
  const queue: Square[] = [start];
  let found: Square | undefined;
  for (let q = 0; q < queue.length && found === undefined; q++) {
    const here = queue[q]!;
    for (const step of STEPS) {
      const next = plus(here, step);
      if (into !== undefined && sameSquare(next, to)) {
        if (corner(terrain, here, step)) continue;
        found = here;
        break;
      }
      if (prev.has(index(next)) || !standable(terrain, next)) continue;
      if (occupants(next) !== undefined || corner(terrain, here, step)) continue;
      prev.set(index(next), index(here));
      if (sameSquare(next, to)) {
        found = next;
        break;
      }
      queue.push(next);
    }
  }
  if (found === undefined) return undefined;
  const path: Square[] = [];
  for (let i = index(found); i !== index(start); i = prev.get(i)!)
    path.unshift({ x: i % width, y: Math.floor(i / width) });
  return into === undefined ? { path } : { path, into };
}
