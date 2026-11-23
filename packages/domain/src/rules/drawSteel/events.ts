import { Schema } from "effect";

import { HeroSheetSchema, StatBlockSchema } from "./schema.ts";
import { CHARACTERISTICS } from "./sheets.ts";
import { CONDITIONS } from "./state.ts";

const Id = Schema.String;

const Condition = Schema.Literals(CONDITIONS);

const Side = Schema.Literals(["heroes", "director"]);

const Characteristic = Schema.Literals(CHARACTERISTICS);

const Square = Schema.Struct({ x: Schema.Int, y: Schema.Int });

const Point = Schema.Struct({ id: Schema.optionalKey(Id), at: Square });

const Action = Schema.Literals(["main", "maneuver", "move", "triggered"]);

const Modifier = Schema.Struct({
	id: Id,
	condition: Condition,
	edges: Schema.Int,
	banes: Schema.Int,
});

export const Payloads = {
	"ds.hero-joined": Schema.Struct({ sheet: HeroSheetSchema }),
	"ds.hero-claimed": Schema.Struct({
		hero: Id,
		player: Schema.String,
		label: Schema.optionalKey(Schema.String),
	}),
	"ds.hero-released": Schema.Struct({ hero: Id }),
	"ds.creatures-added": Schema.Struct({
		block: StatBlockSchema,
		creatures: Schema.Array(
			Schema.Struct({
				id: Id,
				name: Schema.String,
				squad: Schema.optionalKey(Schema.Int),
			})
		),
	}),
	"ds.combat-started": Schema.Struct({
		roll: Schema.Int,
		gains: Schema.Record(Schema.String, Schema.Int),
		malice: Schema.Struct({
			victories: Schema.Int,
			heroes: Schema.Int,
			round: Schema.Int,
		}),
	}),
	"ds.first-set": Schema.Struct({ side: Side }),
	"ds.round-started": Schema.Struct({
		round: Schema.Int,
		heroes: Schema.Int,
		malice: Schema.Int,
	}),
	"ds.turn-started": Schema.Struct({
		id: Id,
		gain: Schema.optionalKey(Schema.Int),
		rolls: Schema.optionalKey(Schema.Array(Schema.Int)),
	}),
	"ds.turn-ended": Schema.Struct({
		id: Id,
		ended: Schema.Array(Condition),
		saves: Schema.Array(
			Schema.Struct({
				condition: Condition,
				roll: Schema.Int,
				ends: Schema.Boolean,
			})
		),
	}),
	"ds.combat-ended": Schema.Struct({
		cleared: Schema.optionalKey(Schema.Array(Id)),
	}),
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
		cost: Schema.optionalKey(Schema.Int),
		targets: Schema.optionalKey(
			Schema.Array(
				Schema.Struct({ id: Id, apart: Schema.optionalKey(Schema.Int) })
			)
		),
		action: Schema.optionalKey(Action),
		conditions: Schema.optionalKey(Schema.Array(Modifier)),
	}),
	"ds.ability-used": Schema.Struct({
		id: Id,
		ability: Schema.String,
		cost: Schema.optionalKey(Schema.Int),
		action: Schema.optionalKey(Action),
	}),
	"ds.bled": Schema.Struct({ id: Id, roll: Schema.Int, level: Schema.Int }),
	"ds.damaged": Schema.Struct({
		id: Id,
		amount: Schema.Int,
		type: Schema.optionalKey(Schema.String),
		weakness: Schema.optionalKey(Schema.Int),
		immunity: Schema.optionalKey(Schema.Int),
		dealt: Schema.Int,
		source: Schema.optionalKey(Id),
		apart: Schema.optionalKey(Schema.Int),
		minions: Schema.optionalKey(Schema.Int),
	}),
	"ds.healed": Schema.Struct({ id: Id, amount: Schema.Int }),
	"ds.temp-set": Schema.Struct({ id: Id, temp: Schema.Int }),
	"ds.recovered": Schema.Struct({
		id: Id,
		amount: Schema.Int,
		ally: Schema.Boolean,
	}),
	"ds.condition-set": Schema.Struct({
		id: Id,
		condition: Condition,
		duration: Schema.Literals(["eot", "save", "end"]),
		by: Schema.optionalKey(Id),
	}),
	"ds.condition-removed": Schema.Struct({ id: Id, condition: Condition }),
	"ds.saved": Schema.Struct({
		id: Id,
		condition: Condition,
		roll: Schema.Int,
		ends: Schema.Boolean,
	}),
	"ds.resource-changed": Schema.Struct({ id: Id, by: Schema.Int }),
	"ds.surges-changed": Schema.Struct({ id: Id, by: Schema.Int }),
	"ds.malice-changed": Schema.Struct({
		by: Schema.Int,
		reason: Schema.optionalKey(Schema.String),
	}),
	"ds.tokens-changed": Schema.Struct({ by: Schema.Int }),
	"ds.tokens-reset": Schema.Struct({ tokens: Schema.Int }),
	"ds.victories-changed": Schema.Struct({
		ids: Schema.Array(Id),
		by: Schema.Int,
	}),
	"ds.map-loaded": Schema.Struct({
		id: Id,
		name: Schema.String,
		terrain: Schema.Array(Schema.String),
		dressing: Schema.optional(Schema.Array(Schema.String)),
	}),
	"ds.map-cleared": Schema.Struct({}),
	"ds.placed": Schema.Struct({ id: Id, at: Square }),
	"ds.moved": Schema.Struct({
		id: Id,
		path: Schema.Array(Square),
		cost: Schema.Int,
		speed: Schema.Int,
		spent: Schema.optionalKey(Schema.Int),
		allowance: Schema.optionalKey(Schema.Int),
		main: Schema.optionalKey(Schema.Boolean),
	}),
	"ds.force-moved": Schema.Struct({
		id: Id,
		kind: Schema.Literals(["push", "pull", "slide"]),
		source: Schema.optionalKey(Id),
		from: Schema.optionalKey(Square),
		distance: Schema.Int,
		stability: Schema.Int,
		path: Schema.Array(Square),
		slam: Schema.optionalKey(
			Schema.Struct({ into: Schema.String, remaining: Schema.Int })
		),
		edge: Schema.optionalKey(Schema.Boolean),
		apart: Schema.optionalKey(Schema.Int),
	}),
	"ds.measured": Schema.Struct({
		from: Point,
		to: Point,
		distance: Schema.Int,
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
