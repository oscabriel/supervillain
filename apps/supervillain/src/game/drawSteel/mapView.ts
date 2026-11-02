import { moverOf, occupants, speedOf } from "./board.ts";
import { reachable } from "./movement.ts";
import {
  type DrawSteelState,
  everyone,
  heroOf,
  isDead,
  marks,
  resolve,
  type Side,
  sideOf,
  type Who,
} from "./state.ts";

/** One token on the map. The table's `MapToken` (table/view.ts) is this shape. */
export interface MapToken {
  /** The combatant id it stands for (`vex`, `goblins-a`). */
  readonly id: string;
  /** One or two characters drawn in the cell, e.g. "V" or "g2"; commands take it as a name. */
  readonly mark: string;
  /** The hero's or creature's name, for `/view <who>` and the band. */
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly side: Side;
  /** What its picture is picked by, when not its id: a creature's stat block, so all look alike. */
  readonly figure?: string;
  readonly mine: boolean;
  readonly acting: boolean;
  readonly dead: boolean;
}

/** The text map for one seat. The table's `MapView` (table/view.ts) is this shape. */
export interface MapView {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly terrain: ReadonlyArray<string>;
  /** A mekmode map's letters, one per square, for the picture map; absent on a plain map. */
  readonly dressing?: ReadonlyArray<string>;
  /** Dead tokens first, so the living draw over them. */
  readonly tokens: ReadonlyArray<MapToken>;
  /** In reading order. */
  readonly reach: ReadonlyArray<{ readonly x: number; readonly y: number }>;
  readonly reachLabel?: string;
}

/** Whose reach the seat sees: the acting creature in combat, else the seat's own hero. */
function reachFor(slice: DrawSteelState, actor: string): Who | undefined {
  const board = slice.map;
  if (board === undefined) return undefined;
  const placedAndAlive = (who: Who | undefined) =>
    who !== undefined && board.tokens[who.id] !== undefined && !isDead(who) ? who : undefined;
  const acting = slice.combat.active ? slice.combat.acting : undefined;
  const actingWho = acting === undefined ? undefined : resolve(slice, acting);
  const fromActing =
    actingWho === undefined || "refusal" in actingWho ? undefined : placedAndAlive(actingWho);
  if (fromActing !== undefined) return fromActing;
  const own = heroOf(slice, actor);
  if (own === undefined) return undefined;
  const ownWho = resolve(slice, own.id);
  return "refusal" in ownWho ? undefined : placedAndAlive(ownWho);
}

/**
 * The text map for one seat (ASSESSMENT Q7), undefined while none is loaded: the terrain, every
 * placed token with its mark, and where the acting creature can move with what is left of its
 * speed this turn, or the seat's own hero (a whole turn's speed) outside its turn.
 */
export function mapView(slice: DrawSteelState, actor: string): MapView | undefined {
  const board = slice.map;
  if (board === undefined) return undefined;
  const marked = marks(slice);
  const tokens = everyone(slice).flatMap((who): MapToken[] => {
    const at = board.tokens[who.id];
    if (at === undefined) return [];
    return [
      {
        id: who.id,
        mark: marked.get(who.id) ?? "??",
        name: who.name,
        x: at.x,
        y: at.y,
        side: sideOf(who),
        ...(who.kind === "creature" && { figure: who.creature.block }),
        mine: who.kind === "hero" && who.hero.player === actor,
        acting: slice.combat.acting === who.id,
        dead: isDead(who),
      },
    ];
  });
  const subject = reachFor(slice, actor);
  const from = subject === undefined ? undefined : board.tokens[subject.id];
  const speed = subject === undefined ? 0 : speedOf(slice, subject).speed;
  // What the acting creature has left this turn; anyone else's reach is a whole turn's.
  const moved =
    subject !== undefined && slice.combat.moved?.id === subject.id ? slice.combat.moved : undefined;
  const left =
    moved === undefined ? speed : Math.max(0, (moved.main ? 2 * speed : speed) - moved.spent);
  const reach =
    subject === undefined || from === undefined
      ? []
      : reachable(board.terrain, from, left, moverOf(subject), occupants(slice, board, subject.id));
  const label =
    moved === undefined
      ? `speed ${speed}`
      : `${left} of speed ${speed} left${moved.main ? ", main action spent" : ""}`;
  return {
    name: board.name,
    width: board.terrain[0]?.length ?? 0,
    height: board.terrain.length,
    terrain: board.terrain,
    ...(board.dressing === undefined ? {} : { dressing: board.dressing }),
    tokens: [...tokens.filter((t) => t.dead), ...tokens.filter((t) => !t.dead)],
    reach,
    ...(subject !== undefined && { reachLabel: `${subject.name} can reach: ${label}` }),
  };
}
