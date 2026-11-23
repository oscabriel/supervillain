import { Schema } from "effect";

import { DEGREES } from "./math.ts";
import { PfCreatureBlockSchema, PfHeroSheetSchema } from "./schema.ts";
import { SAVES } from "./sheets.ts";
import { CONDITIONS, COUNTERS, EXPIRIES } from "./state.ts";

const Id = Schema.String;

const Square = Schema.Struct({ x: Schema.Int, y: Schema.Int });

const Degree = Schema.Literals(DEGREES);

export const DamageSchema = Schema.Struct({
	expression: Schema.String,
	rolls: Schema.Array(Schema.Int),
	total: Schema.Int,
	damageType: Schema.optionalKey(Schema.String),
	applied: Schema.Int,
	critical: Schema.Boolean,
});

export type Damage = typeof DamageSchema.Type;

export const MANEUVERS = [
	"grapple",
	"trip",
	"shove",
	"disarm",
	"demoralize",
] as const;

export type Maneuver = (typeof MANEUVERS)[number];

export const MOVE_KINDS = ["stride", "step", "crawl", "move"] as const;

export const ConditionNameSchema = Schema.Literals([
	...CONDITIONS,
	...COUNTERS,
]);

export const ExpiresSchema = Schema.Struct({
	at: Schema.Literals(EXPIRIES),
	of: Id,
	skip: Schema.optionalKey(Schema.Boolean),
});

const CastResult = Schema.Struct({
	target: Id,
	natural: Schema.optionalKey(Schema.Int),
	bonus: Schema.optionalKey(Schema.Int),
	total: Schema.optionalKey(Schema.Int),
	dc: Schema.optionalKey(Schema.Int),
	degree: Schema.optionalKey(Degree),
	damage: Schema.optionalKey(DamageSchema),
	healed: Schema.optionalKey(Schema.Int),
});

export type CastResult = typeof CastResult.Type;

const PersistentTick = Schema.Struct({
	damageType: Schema.String,
	dice: Schema.String,
	rolls: Schema.Array(Schema.Int),
	total: Schema.Int,
	applied: Schema.Int,
	natural: Schema.Int,
	ended: Schema.Boolean,
});

export type PersistentTick = typeof PersistentTick.Type;

const Recovery = Schema.Struct({
	natural: Schema.Int,
	dc: Schema.Int,
	degree: Degree,
});

export const Payloads = {
	"pf.pc-joined": Schema.Struct({ sheet: PfHeroSheetSchema }),
	"pf.creatures-added": Schema.Struct({
		block: PfCreatureBlockSchema,
		adjustment: Schema.optionalKey(Schema.Literals(["elite", "weak"])),
		creatures: Schema.Array(Schema.Struct({ id: Id, name: Schema.String })),
	}),
	"pf.pc-claimed": Schema.Struct({ id: Id, player: Schema.String }),
	"pf.pc-released": Schema.Struct({ id: Id }),
	"pf.initiative-rolled": Schema.Struct({
		id: Id,
		skill: Schema.String,
		natural: Schema.Int,
		bonus: Schema.Int,
		total: Schema.Int,
	}),
	"pf.combat-started": Schema.Struct({ order: Schema.Array(Id) }),
	"pf.turn-started": Schema.Struct({
		id: Id,
		round: Schema.Int,
		actions: Schema.Int,
		stunned: Schema.optionalKey(Schema.Int),
		recovery: Schema.optionalKey(Recovery),
	}),
	"pf.turn-ended": Schema.Struct({
		id: Id,
		persistent: Schema.Array(PersistentTick),
	}),
	"pf.delayed": Schema.Struct({ id: Id }),
	"pf.rejoined": Schema.Struct({ id: Id, after: Id }),
	"pf.combat-ended": Schema.Struct({}),
	"pf.struck": Schema.Struct({
		id: Id,
		target: Id,
		weapon: Schema.String,
		natural: Schema.Int,
		bonus: Schema.Int,
		total: Schema.Int,
		ac: Schema.Int,
		degree: Degree,
		map: Schema.Int,
		reaction: Schema.Boolean,
		notes: Schema.Array(Schema.String),
		damage: Schema.optionalKey(DamageSchema),
	}),
	"pf.moved": Schema.Struct({
		id: Id,
		to: Square,
		feet: Schema.Int,
		kind: Schema.Literals(MOVE_KINDS),
		parity: Schema.Literals([0, 1]),
	}),
	"pf.placed": Schema.Struct({ id: Id, at: Square }),
	"pf.map-loaded": Schema.Struct({
		id: Id,
		name: Schema.String,
		terrain: Schema.Array(Schema.String),
		dressing: Schema.optionalKey(Schema.Array(Schema.String)),
	}),
	"pf.map-cleared": Schema.Struct({}),
	"pf.measured": Schema.Struct({ id: Id, target: Id, feet: Schema.Int }),
	"pf.stood": Schema.Struct({ id: Id }),
	"pf.dropped-prone": Schema.Struct({ id: Id }),
	"pf.shield-raised": Schema.Struct({ id: Id }),
	"pf.shield-blocked": Schema.Struct({
		id: Id,
		damage: Schema.Int,
		prevented: Schema.Int,
		shieldTaken: Schema.Int,
	}),
	"pf.maneuvered": Schema.Struct({
		id: Id,
		target: Id,
		maneuver: Schema.Literals(MANEUVERS),
		skill: Schema.String,
		natural: Schema.Int,
		bonus: Schema.Int,
		total: Schema.Int,
		dc: Schema.Int,
		degree: Degree,
		map: Schema.Int,
		damage: Schema.optionalKey(DamageSchema),
		to: Schema.optionalKey(Square),
	}),
	"pf.checked": Schema.Struct({
		id: Id,
		skill: Schema.String,
		natural: Schema.Int,
		bonus: Schema.Int,
		total: Schema.Int,
		dc: Schema.optionalKey(Schema.Int),
		degree: Schema.optionalKey(Degree),
	}),
	"pf.saved": Schema.Struct({
		id: Id,
		save: Schema.Literals(SAVES),
		natural: Schema.Int,
		bonus: Schema.Int,
		total: Schema.Int,
		dc: Schema.Int,
		degree: Degree,
		damage: Schema.optionalKey(DamageSchema),
	}),
	"pf.flat-checked": Schema.Struct({
		id: Id,
		natural: Schema.Int,
		dc: Schema.Int,
		success: Schema.Boolean,
	}),
	"pf.cast": Schema.Struct({
		id: Id,
		spell: Schema.String,
		rank: Schema.Int,
		actions: Schema.Int,
		slot: Schema.Boolean,
		attack: Schema.Boolean,
		map: Schema.Int,
		results: Schema.Array(CastResult),
	}),
	"pf.damaged": Schema.Struct({ id: Id, damage: DamageSchema }),
	"pf.healed": Schema.Struct({
		id: Id,
		amount: Schema.Int,
		expression: Schema.optionalKey(Schema.String),
		rolls: Schema.optionalKey(Schema.Array(Schema.Int)),
	}),
	"pf.temp-set": Schema.Struct({ id: Id, temp: Schema.Int }),
	"pf.condition-set": Schema.Struct({
		id: Id,
		name: ConditionNameSchema,
		value: Schema.optionalKey(Schema.Int),
		expires: Schema.optionalKey(ExpiresSchema),
		by: Schema.optionalKey(Id),
	}),
	"pf.condition-removed": Schema.Struct({ id: Id, name: ConditionNameSchema }),
	"pf.persistent-set": Schema.Struct({
		id: Id,
		damageType: Schema.String,
		dice: Schema.String,
	}),
	"pf.persistent-removed": Schema.Struct({
		id: Id,
		damageType: Schema.String,
	}),
	"pf.hero-points-set": Schema.Struct({ id: Id, points: Schema.Int }),
	"pf.rerolled": Schema.Struct({
		id: Id,
		natural: Schema.Int,
		total: Schema.Int,
		degree: Schema.optionalKey(Degree),
		damage: Schema.optionalKey(DamageSchema),
	}),
	"pf.heroic-recovery": Schema.Struct({ id: Id, spent: Schema.Int }),
	"pf.rested": Schema.Struct({
		healed: Schema.Array(Schema.Struct({ id: Id, hp: Schema.Int })),
	}),
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
