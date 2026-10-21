import * as Schema from "effect/Schema";
import { HeroSheetSchema, StatBlockSchema } from "./schema.ts";
import { CONDITIONS } from "./state.ts";

const Id = Schema.String;
const Condition = Schema.Literals(CONDITIONS);
const Side = Schema.Literals(["heroes", "director"]);
const Characteristic = Schema.Literals(["might", "agility", "reason", "intuition", "presence"]);

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
  /** The EoT conditions that end, and a d10 for each save-ends condition. */
  "ds.turn-ended": Schema.Struct({
    id: Id,
    ended: Schema.Array(Condition),
    saves: Schema.Array(Schema.Struct({ condition: Condition, roll: Schema.Int })),
  }),
  "ds.combat-ended": Schema.Struct({}),
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
  }),
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
  "ds.saved": Schema.Struct({ id: Id, condition: Condition, roll: Schema.Int }),
  "ds.resource-changed": Schema.Struct({ id: Id, by: Schema.Int }),
  "ds.surges-changed": Schema.Struct({ id: Id, by: Schema.Int }),
  /** `reason` is what the GM said it was for, as typed. */
  "ds.malice-changed": Schema.Struct({ by: Schema.Int, reason: Schema.optionalKey(Schema.String) }),
  "ds.tokens-changed": Schema.Struct({ by: Schema.Int }),
  "ds.tokens-reset": Schema.Struct({ tokens: Schema.Int }),
  "ds.victories-changed": Schema.Struct({ ids: Schema.Array(Id), by: Schema.Int }),
} as const;

export type EventType = keyof typeof Payloads;
export type Payload<T extends EventType> = (typeof Payloads)[T]["Type"];

export const EVENTS = Object.keys(Payloads) as ReadonlyArray<EventType>;

/** A new event, typed by its payload. */
export const event = <T extends EventType>(type: T, payload: Payload<T>) => ({ type, payload });
