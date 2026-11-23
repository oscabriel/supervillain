import { Schema } from "effect";

const Id = Schema.String;

const Side = Schema.Literals(["party", "foes"]);

const Square = Schema.Struct({ x: Schema.Int, y: Schema.Int });

const { Finite } = Schema;

const Positive = Schema.Finite.check(Schema.isGreaterThan(0));

const NonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

const Fraction = Schema.Finite.check(
	Schema.isBetween({ minimum: 0, maximum: 1 })
);

export const SEED_MAX = 4_294_967_295;

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
		[Schema.Record(Schema.String, Finite)]
	),
	gear: Schema.Array(
		Schema.Struct({ slot: Schema.String, name: Schema.String })
	),
});

export const Payloads = {
	"sw.fighter-joined": Schema.Struct({
		id: Id,
		name: Schema.String,
		side: Side,
		character: SetCharacterSchema,
	}),
	"sw.fighter-claimed": Schema.Struct({ id: Id, player: Schema.String }),
	"sw.fighter-released": Schema.Struct({ id: Id }),
	"sw.map-loaded": Schema.Struct({
		id: Id,
		name: Schema.String,
		terrain: Schema.Array(Schema.String),
		dressing: Schema.optionalKey(Schema.Array(Schema.String)),
	}),
	"sw.map-cleared": Schema.Struct({}),
	"sw.placed": Schema.Struct({ id: Id, at: Square }),
	"sw.moved": Schema.Struct({ id: Id, at: Square, cost: Schema.Int }),
	"sw.fight-started": Schema.Struct({ rules: Schema.String }),
	"sw.turn-began": Schema.Struct({
		id: Id,
		at: NonNegative,
		stamina: Schema.Record(Schema.String, Finite),
	}),
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
		apart: Schema.optionalKey(Schema.Int),
	}),
	"sw.turn-ended": Schema.Struct({ id: Id, rested: Schema.Boolean }),
	"sw.fight-ended": Schema.Struct({ winner: Schema.optionalKey(Side) }),
} as const;

export type EventType = keyof typeof Payloads;

export type Payload<T extends EventType> = (typeof Payloads)[T]["Type"];

export const isEventType = (type: string): type is EventType =>
	Object.hasOwn(Payloads, type);

export const EVENTS: ReadonlyArray<EventType> =
	Object.keys(Payloads).filter(isEventType);

export const event = <T extends EventType>(type: T, payload: Payload<T>) => ({
	type,
	payload,
});
