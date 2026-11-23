import { Schema } from "effect";

export const Frontmatter = Schema.Struct({
	title: Schema.String.check(Schema.isNonEmpty()),
	summary: Schema.String.check(Schema.isNonEmpty()),
	order: Schema.optionalKey(Schema.FiniteFromString),
	date: Schema.optionalKey(Schema.String),
});
