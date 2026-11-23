import { Schema } from "effect";

const TypeHead = Schema.Struct({ type: Schema.String }).pipe(
	Schema.encodeKeys({ type: "_tag" })
);

const EventHead = Schema.Struct({
	type: Schema.String,
	actor: Schema.String,
}).pipe(Schema.encodeKeys({ type: "_tag" }));

export const commandHead = Schema.encodeSync(TypeHead);

export const eventHead = Schema.encodeSync(EventHead);
