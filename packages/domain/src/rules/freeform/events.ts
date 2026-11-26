import { Schema } from "effect";

import { FfSheetSchema } from "./schema.ts";

const Id = Schema.String;

const Square = Schema.Struct({ x: Schema.Int, y: Schema.Int });

export const Payloads = {
	"ff.pc-joined": Schema.Struct({ sheet: FfSheetSchema }),
	"ff.figures-added": Schema.Struct({
		sheet: FfSheetSchema,
		ids: Schema.NonEmptyArray(Id),
		names: Schema.NonEmptyArray(Schema.String),
	}),
	"ff.played": Schema.Struct({ id: Id, player: Schema.String }),
	"ff.unplayed": Schema.Struct({ id: Id }),
	"ff.stat-set": Schema.Struct({
		id: Id,
		key: Schema.String,
		value: Schema.Int,
	}),
	"ff.tag-set": Schema.Struct({
		id: Id,
		tag: Schema.String,
		on: Schema.Boolean,
	}),
	"ff.checked": Schema.Struct({
		id: Id,
		stat: Schema.String,
		value: Schema.Int,
		notation: Schema.String,
		rolls: Schema.Array(Schema.Int),
		total: Schema.Int,
	}),
	"ff.map-loaded": Schema.Struct({
		id: Id,
		name: Schema.String,
		terrain: Schema.Array(Schema.String),
		dressing: Schema.optionalKey(Schema.Array(Schema.String)),
	}),
	"ff.map-cleared": Schema.Struct({}),
	"ff.placed": Schema.Struct({ id: Id, at: Square }),
	"ff.moved": Schema.Struct({ id: Id, at: Square }),
	"ff.removed": Schema.Struct({ id: Id }),
	"ff.order-started": Schema.Struct({ ids: Schema.NonEmptyArray(Id) }),
	"ff.turn-started": Schema.Struct({ id: Id }),
	"ff.round-started": Schema.Struct({ round: Schema.Int }),
	"ff.order-ended": Schema.Struct({}),
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
