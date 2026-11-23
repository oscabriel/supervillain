import { Predicate, Result, Schema } from "effect";

export type Dice = (sides: number) => number;

export interface Envelope {
	readonly actor: string;
	readonly seq: number;
	readonly timestamp: string;
	readonly type: string;
	readonly payload: object;
}

export interface NewEvent {
	readonly type: string;
	readonly payload: object;
}

export interface Refused {
	readonly refusal: string;
}

export type Decision = { readonly events: ReadonlyArray<NewEvent> } | Refused;

export interface Rules<S, C> {
	readonly initial: S;
	readonly knows: (type: string) => boolean;
	readonly decide: (
		state: S,
		actor: string,
		command: C,
		dice: Dice,
		now: number
	) => Decision;
	readonly apply: (state: S, envelope: Envelope) => S;
	readonly skip: (state: S, envelope: Envelope) => S;
}

export const isRefused = <A>(
	value: A | Refused
): value is Extract<A | Refused, Refused> =>
	Predicate.hasProperty(value, "refusal");

export const refuse = (refusal: string): Refused => ({ refusal });

export const messageOf = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

export const decodePayload = <A>(
	schema: Schema.Decoder<A>,
	envelope: Envelope
): A => {
	const result = Schema.decodeResult(schema)(envelope.payload);

	if (Result.isFailure(result)) {
		throw new Error(
			`bad ${envelope.type} payload at seq ${envelope.seq}: ${result.failure.message}`
		);
	}

	return result.success;
};
