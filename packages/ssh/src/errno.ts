import { Predicate } from "effect";

export const errnoOf = (cause: unknown): string | undefined =>
	Predicate.hasProperty(cause, "code") && Predicate.isString(cause.code)
		? cause.code
		: undefined;
