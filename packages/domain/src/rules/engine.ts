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

export const decodePayload = <S extends Schema.Decoder<unknown>>(
	schema: S,
	envelope: Envelope
): S["Type"] => {
	const result = Schema.decodeResult(schema)(envelope.payload);

	if (Result.isFailure(result)) {
		throw new Error(
			`bad ${envelope.type} payload at seq ${envelope.seq}: ${result.failure.message}`
		);
	}

	return result.success;
};

export const payloadDecoder =
	<P extends { readonly [K in keyof P]: Schema.Decoder<unknown> }>(
		payloads: P
	) =>
	<T extends keyof P>(type: T, envelope: Envelope): P[T]["Type"] =>
		decodePayload(payloads[type], envelope);

export const bad: (envelope: Envelope, why: string) => never = (
	envelope,
	why
) => {
	throw new Error(`${envelope.type} at seq ${envelope.seq} ${why}`);
};

export const rollFace = (dice: Dice, sides: number): number => {
	const face = dice(sides);

	if (!Number.isInteger(face) || face < 1 || face > sides) {
		throw new Error(`the dice gave ${face} for a d${sides}`);
	}

	return face;
};
