import type { Envelope, Rules } from "@supervillain/domain";
import { Schema } from "effect";

const Logged = Schema.fromJsonString(
	Schema.Array(
		Schema.Struct({
			actor: Schema.String,
			seq: Schema.Int,
			timestamp: Schema.String,
			type: Schema.String,
			payload: Schema.Record(Schema.String, Schema.Json),
		})
	)
);

const decodeLogged = Schema.decodeUnknownSync(Logged);

export const throughJson = (
	envelopes: ReadonlyArray<Envelope>
): ReadonlyArray<Envelope> => decodeLogged(JSON.stringify(envelopes));

export interface Folded<S> {
	readonly state: S;
	readonly skipped: ReadonlyArray<Envelope>;
	readonly error?: { readonly seq: number; readonly message: string };
}

export const fold = <S, C>(
	rules: Rules<S, C>,
	envelopes: ReadonlyArray<Envelope>,
	options: { readonly strict: boolean }
): Folded<S> => {
	let state = rules.initial;
	const skipped: Array<Envelope> = [];

	for (const envelope of envelopes) {
		if (!rules.knows(envelope.type)) {
			if (options.strict) {
				return {
					state,
					skipped,
					error: {
						seq: envelope.seq,
						message: `unknown event type "${envelope.type}"`,
					},
				};
			}

			skipped.push(envelope);
			state = rules.skip(state, envelope);
			continue;
		}

		try {
			state = rules.apply(state, envelope);
		} catch (error) {
			return {
				state,
				skipped,
				error: {
					seq: envelope.seq,
					message: error instanceof Error ? error.message : String(error),
				},
			};
		}
	}

	return { state, skipped };
};
