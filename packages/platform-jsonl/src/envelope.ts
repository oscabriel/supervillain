import { Schema } from "effect";

export const Line = Schema.Struct({
	actor: Schema.String,
	seq: Schema.Int,
	timestamp: Schema.String,
	type: Schema.String,
	payload: Schema.Unknown,
});

export type Line = typeof Line.Type;

export type Envelope = Line;

export const LineJson = Schema.fromJsonString(Line);
