import * as Schema from "effect/Schema";
import { HeroSheetSchema, StatBlockSchema } from "./schema.ts";
import { CHARACTERISTICS } from "./sheets.ts";
import { CONDITIONS } from "./state.ts";

const Id = Schema.String;
const Condition = Schema.Literals(CONDITIONS);
const Side = Schema.Literals(["heroes", "director"]);
const Characteristic = Schema.Literals(CHARACTERISTICS);
const Square = Schema.Struct({ x: Schema.Int, y: Schema.Int });
/** A token or a bare square, as /dist measured it. */
const Point = Schema.Struct({ id: Schema.optionalKey(Id), at: Square });

/**
 * Every Draw Steel event's payload. Each carries what decide worked out, rolls and sheets
 * included, so apply only folds numbers in and replay never rolls or reads a file.
 */
export const Payloads = {
  /** A hero joins the party from this sheet, or reloads it. */
  "ds.hero-joined": Schema.Struct({ sheet: HeroSheetSchema }),
  /** `label` is the player's label as the GM typed it, for the feed. */
  "ds.hero-claimed": Schema.Struct({
    hero: Id,
    player: Schema.String,
    label: Schema.optionalKey(Schema.String),
  }),
  "ds.hero-released": Schema.Struct({ hero: Id }),
  /** Creatures from one stat block; `squad` is a minion squad's size. */
  "ds.creatures-added": Schema.Struct({
    block: StatBlockSchema,
    creatures: Schema.Array(
      Schema.Struct({ id: Id, name: Schema.String, squad: Schema.optionalKey(Schema.Int) }),
    ),
  }),
  /** The d10 for who picks first, each hero's resource from Victories, and the Malice gained. */
  "ds.combat-started": Schema.Struct({
    roll: Schema.Int,
    gains: Schema.Record(Schema.String, Schema.Int),
    malice: Schema.Struct({ victories: Schema.Int, heroes: Schema.Int, round: Schema.Int }),
  }),
  "ds.first-set": Schema.Struct({ side: Side }),
  /** `malice` is `heroes` (living) plus `round`. */
  "ds.round-started": Schema.Struct({ round: Schema.Int, heroes: Schema.Int, malice: Schema.Int }),
  /** A hero's resource gain for the turn, with the dice when the sheet rolls for it. */
  "ds.turn-started": Schema.Struct({
    id: Id,
    gain: Schema.optionalKey(Schema.Int),
    rolls: Schema.optionalKey(Schema.Array(Schema.Int)),
  }),
  /** The EoT conditions that end, and a d10 for each save-ends condition: on 6+ it `ends`. */
  "ds.turn-ended": Schema.Struct({
    id: Id,
    ended: Schema.Array(Condition),
    saves: Schema.Array(
      Schema.Struct({ condition: Condition, roll: Schema.Int, ends: Schema.Boolean }),
    ),
  }),
  /**
   * `cleared` are the tokens taken off the map, and only those: every creature's, since they
   * leave, and the dead heroes'.
   */
  "ds.combat-ended": Schema.Struct({ cleared: Schema.optionalKey(Schema.Array(Id)) }),
  /** `dead` are the heroes who were dead at the respite, and don't recover. */
  "ds.rested": Schema.Struct({ dead: Schema.optionalKey(Schema.Array(Id)) }),
  "ds.power-rolled": Schema.Struct({
    id: Id,
    ability: Schema.optionalKey(Schema.String),
    characteristic: Schema.optionalKey(Characteristic),
    dice: Schema.Tuple([Schema.Int, Schema.Int]),
    bonus: Schema.Int,
    edges: Schema.Int,
    banes: Schema.Int,
    total: Schema.Int,
    tier: Schema.Literals([1, 2, 3]),
    /** The ability's cost, spent with the roll: the hero's resource, or a creature's Malice. */
    cost: Schema.optionalKey(Schema.Int),
    /**
     * Who it was aimed at, with how far each stood when both were on the map. The tier's damage
     * follows as `ds.damaged` events in the same batch.
     */
    targets: Schema.optionalKey(
      Schema.Array(Schema.Struct({ id: Id, apart: Schema.optionalKey(Schema.Int) })),
    ),
  }),
  /** An ability with no power roll: its cost is spent, and its effect goes in the feed. */
  "ds.ability-used": Schema.Struct({
    id: Id,
    ability: Schema.String,
    cost: Schema.optionalKey(Schema.Int),
  }),
  /**
   * Bleeding's Stamina loss after a roll or action: the d6 and the creature's level, added. It
   * isn't damage, so nothing reduces it and temporary Stamina doesn't take it.
   */
  "ds.bled": Schema.Struct({ id: Id, roll: Schema.Int, level: Schema.Int }),
  /** `dealt` is after weakness and immunity; temporary Stamina takes it first. */
  "ds.damaged": Schema.Struct({
    id: Id,
    amount: Schema.Int,
    type: Schema.optionalKey(Schema.String),
    weakness: Schema.optionalKey(Schema.Int),
    immunity: Schema.optionalKey(Schema.Int),
    dealt: Schema.Int,
    /** The creature whose free strike it was. */
    source: Schema.optionalKey(Id),
    /** How far the striker stood from the target, when both were on the map. */
    apart: Schema.optionalKey(Schema.Int),
    /** For a squad's free strike, how many minions struck together. */
    minions: Schema.optionalKey(Schema.Int),
  }),
  /** `amount` is what was regained, after the cap at max. */
  "ds.healed": Schema.Struct({ id: Id, amount: Schema.Int }),
  "ds.temp-set": Schema.Struct({ id: Id, temp: Schema.Int }),
  "ds.recovered": Schema.Struct({ id: Id, amount: Schema.Int, ally: Schema.Boolean }),
  "ds.condition-set": Schema.Struct({
    id: Id,
    condition: Condition,
    duration: Schema.Literals(["eot", "save", "end"]),
  }),
  "ds.condition-removed": Schema.Struct({ id: Id, condition: Condition }),
  /** A d10 against a save-ends condition: on 6+ it `ends`. */
  "ds.saved": Schema.Struct({
    id: Id,
    condition: Condition,
    roll: Schema.Int,
    ends: Schema.Boolean,
  }),
  "ds.resource-changed": Schema.Struct({ id: Id, by: Schema.Int }),
  "ds.surges-changed": Schema.Struct({ id: Id, by: Schema.Int }),
  /** `reason` is what the GM said it was for, as typed. */
  "ds.malice-changed": Schema.Struct({ by: Schema.Int, reason: Schema.optionalKey(Schema.String) }),
  "ds.tokens-changed": Schema.Struct({ by: Schema.Int }),
  "ds.tokens-reset": Schema.Struct({ tokens: Schema.Int }),
  "ds.victories-changed": Schema.Struct({ ids: Schema.Array(Id), by: Schema.Int }),
  /** The grid the host read from `maps/<id>.txt`. Every token comes off. */
  "ds.map-loaded": Schema.Struct({
    id: Id,
    name: Schema.String,
    terrain: Schema.Array(Schema.String),
  }),
  "ds.map-cleared": Schema.Struct({}),
  "ds.placed": Schema.Struct({ id: Id, at: Square }),
  /**
   * `path` is every square entered, the last where it stops; `cost` the movement it took. For the
   * acting creature in combat, `spent` is its movement this turn with this move, of `allowance`
   * (its speed, or twice that once its main action went on moving: `main`).
   */
  "ds.moved": Schema.Struct({
    id: Id,
    path: Schema.Array(Square),
    cost: Schema.Int,
    speed: Schema.Int,
    spent: Schema.optionalKey(Schema.Int),
    allowance: Schema.optionalKey(Schema.Int),
    main: Schema.optionalKey(Schema.Boolean),
  }),
  /**
   * A push, pull or slide of `distance`, less the target's `stability`, along `path`. A slam's
   * damage follows as `ds.damaged` events in the same batch.
   */
  "ds.force-moved": Schema.Struct({
    id: Id,
    kind: Schema.Literals(["push", "pull", "slide"]),
    source: Schema.optionalKey(Id),
    /**
     * Where the target stood. A later change that stood on it (a slam that went nowhere) then
     * won't fold from anywhere else, so undo refuses to take the move it stood on back first.
     */
    from: Schema.optionalKey(Square),
    distance: Schema.Int,
    stability: Schema.Int,
    path: Schema.Array(Square),
    slam: Schema.optionalKey(Schema.Struct({ into: Schema.String, remaining: Schema.Int })),
    /** The map's edge stopped it. */
    edge: Schema.optionalKey(Schema.Boolean),
    /** How far the source stood from the target, when both were on the map. */
    apart: Schema.optionalKey(Schema.Int),
  }),
  /** For the whole table to see; it changes nothing, so it's never undone. */
  "ds.measured": Schema.Struct({ from: Point, to: Point, distance: Schema.Int }),
} as const;

export type EventType = keyof typeof Payloads;
export type Payload<T extends EventType> = (typeof Payloads)[T]["Type"];

export const EVENTS = Object.keys(Payloads) as ReadonlyArray<EventType>;

/** A new event, typed by its payload. */
export const event = <T extends EventType>(type: T, payload: Payload<T>) => ({ type, payload });
