import * as Schema from "effect/Schema";

const Id = Schema.String;
const Side = Schema.Literals(["party", "foes"]);
const Square = Schema.Struct({ x: Schema.Int, y: Schema.Int });
const Finite = Schema.Finite;
const Positive = Schema.Finite.check(Schema.isGreaterThan(0));
const NonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
/** A chance or a share, from 0 to 1. */
const Fraction = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

/** set.world seeds are whole numbers from 0 to 2³² − 1. */
export const SEED_MAX = 4_294_967_295;

/**
 * A rolled character as the table keeps it (state.ts `SetCharacter`): every attribute the rules
 * read must be there and in range, and the rest are kept as numbers for /sheet.
 */
export const SetCharacterSchema = Schema.Struct({
  seed: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: SEED_MAX })),
  contentVersion: Schema.String,
  className: Schema.String,
  flavor: Schema.String,
  mainhand: Schema.String,
  powerRating: Finite,
  finalStats: Schema.Record(Schema.String, Finite),
  attributes: Schema.StructWithRest(
    Schema.Struct({
      maxHealth: Positive,
      stamina: NonNegative,
      initiative: Positive,
      walkSpeed: NonNegative,
      physicalDamage: NonNegative,
      magicalDamage: NonNegative,
      physicalDamageReduction: Fraction,
      magicalDamageReduction: Fraction,
      globalResistance: Fraction,
      dodgeRate: Fraction,
      criticalHitChance: Fraction,
      clarity: Fraction,
    }),
    [Schema.Record(Schema.String, Finite)],
  ),
  gear: Schema.Array(Schema.Struct({ slot: Schema.String, name: Schema.String })),
});

/**
 * Every set.world event's payload. Each carries what decide worked out (the roll, the draws, the
 * turn's time and everyone's stamina), so apply only folds numbers in and replay never fetches.
 */
export const Payloads = {
  /** A fighter rolled at set.world joins a side, under the name the GM gave it. */
  "sw.fighter-joined": Schema.Struct({
    id: Id,
    name: Schema.String,
    side: Side,
    character: SetCharacterSchema,
  }),
  "sw.fighter-claimed": Schema.Struct({ id: Id, player: Schema.String }),
  "sw.fighter-released": Schema.Struct({ id: Id }),
  /** The grid the host read from `maps/<id>.txt`. Every fighter comes off it. */
  "sw.map-loaded": Schema.Struct({
    id: Id,
    name: Schema.String,
    terrain: Schema.Array(Schema.String),
    dressing: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  "sw.map-cleared": Schema.Struct({}),
  "sw.placed": Schema.Struct({ id: Id, at: Square }),
  /** `cost` is the movement the cheapest path took. */
  "sw.moved": Schema.Struct({ id: Id, at: Square, cost: Schema.Int }),
  /** `rules` is the stamp of the rules the fight follows. */
  "sw.fight-started": Schema.Struct({ rules: Schema.String }),
  /**
   * A turn begins at `at` on the logical clock; `stamina` is every living fighter's after
   * recovering since the turn before, with its fraction.
   */
  "sw.turn-began": Schema.Struct({
    id: Id,
    at: NonNegative,
    stamina: Schema.Record(Schema.String, Finite),
  }),
  /**
   * One attack: the d1000 against the dodge chance, the d1000 against a critical when it wasn't
   * dodged, and the damage: `landed` by Set's formula, `damage` what the target had to lose.
   */
  "sw.attacked": Schema.Struct({
    id: Id,
    target: Id,
    delivery: Schema.Literals(["melee", "projectile", "wave", "aura"]),
    magic: Schema.Boolean,
    raw: NonNegative,
    dodgeChance: Fraction,
    dodgeRoll: Schema.Int,
    dodged: Schema.Boolean,
    critRoll: Schema.optionalKey(Schema.Int),
    critical: Schema.Boolean,
    landed: Schema.Int,
    damage: Schema.Int,
    /** How far apart they stood, when both were on the map. */
    apart: Schema.optionalKey(Schema.Int),
  }),
  /** `rested` when the fighter didn't attack: Set's word for a turn without one. */
  "sw.turn-ended": Schema.Struct({ id: Id, rested: Schema.Boolean }),
  /** The side still standing, or none when the GM ended it. */
  "sw.fight-ended": Schema.Struct({ winner: Schema.optionalKey(Side) }),
} as const;

export type EventType = keyof typeof Payloads;
export type Payload<T extends EventType> = (typeof Payloads)[T]["Type"];

export const EVENTS = Object.keys(Payloads) as ReadonlyArray<EventType>;

/** A new event, typed by its payload. */
export const event = <T extends EventType>(type: T, payload: Payload<T>) => ({ type, payload });
