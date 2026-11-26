import {
	cleanText,
	SEED_MAX,
	SetCharacterSchema,
	SetWorld,
	SetWorldError,
} from "@supervillain/domain";
import type { SetCharacter } from "@supervillain/domain";
import { Effect, Option, Predicate, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import { HttpClient, HttpClientResponse } from "effect/http";

const ROLL_URL = "https://set.world/api/roll/character";

const TIMEOUT = "10 seconds";

const RollResponse = Schema.Struct({
	seed: Schema.Int,
	contentVersion: Schema.String,
	class: Schema.Struct({
		name: Schema.String,
		flavor: Schema.String,
		mainhand: Schema.String,
	}),
	powerRating: Schema.Finite,
	finalStats: Schema.Record(Schema.String, Schema.Finite),
	attributes: Schema.Record(Schema.String, Schema.Json),
	equipment: Schema.Record(Schema.String, Schema.Json),
});

type RollResponse = typeof RollResponse.Type;

const Named = Schema.Struct({ name: Schema.String });

const ErrorBody = Schema.Struct({
	error: Schema.Struct({ message: Schema.String }),
});

const decodeNamed = Schema.decodeUnknownOption(Named);

const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);

const decodeCharacter = Schema.decodeUnknownEffect(SetCharacterSchema);

const decodeResponse = Schema.decodeUnknownEffect(RollResponse);

export type RollBody = Parameters<typeof decodeResponse>[0];

const oneLine = (why: string) => why.replaceAll(/\s*\n\s*/gu, " ");

const unreadableMessage = (why: string) =>
	`set.world's answer isn't a character the table can read: ${oneLine(why)}`;

const unreadable = (seed: number, why: string, cause: unknown) =>
	new SetWorldError({ seed, message: unreadableMessage(why), cause });

const gearOf = (equipment: RollResponse["equipment"]): SetCharacter["gear"] =>
	Object.entries(equipment).flatMap(([slot, held]) =>
		(Array.isArray(held) ? held : [held]).flatMap((item) =>
			Option.match(decodeNamed(item), {
				onNone: () => [],
				onSome: ({ name }) =>
					cleanText(name) === ""
						? []
						: [{ slot: cleanText(slot), name: cleanText(name) }],
			})
		)
	);

const isFiniteNumber = (value: Schema.Json): value is number =>
	Predicate.isNumber(value) && Number.isFinite(value);

const characterOf = Effect.fn("SetWorld.characterOf")(function* (
	seed: number,
	roll: RollResponse
) {
	if (roll.seed !== seed) {
		return yield* new SetWorldError({
			seed,
			message: unreadableMessage(`it rolled seed ${roll.seed}, not ${seed}`),
		});
	}

	const attributes = Object.fromEntries(
		Object.entries(roll.attributes).flatMap(([key, value]) =>
			isFiniteNumber(value) ? [[key, value]] : []
		)
	);

	return yield* decodeCharacter({
		seed: roll.seed,
		contentVersion: cleanText(roll.contentVersion),
		className: cleanText(roll.class.name),
		flavor: cleanText(roll.class.flavor),
		mainhand: cleanText(roll.class.mainhand).toLowerCase(),
		powerRating: roll.powerRating,
		finalStats: roll.finalStats,
		attributes,
		gear: gearOf(roll.equipment),
	}).pipe(Effect.mapError((issue) => unreadable(seed, issue.message, issue)));
});

export const decodeRoll = Effect.fn("SetWorld.decodeRoll")(function* (
	seed: number,
	body: RollBody
) {
	const roll = yield* decodeResponse(body).pipe(
		Effect.mapError((issue) => unreadable(seed, issue.message, issue))
	);

	return yield* characterOf(seed, roll);
});

const errorOf = (body: Schema.Json): string =>
	Option.match(decodeErrorBody(body), {
		onNone: () => "",
		onSome: ({ error }) => `: ${cleanText(error.message)}`,
	});

export const SetWorldLive = SetWorld.toLayer(
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient;
		const random = yield* SecureRandom.SecureRandom;

		const ask = Effect.fn("SetWorld.ask")(function* (seed: number) {
			const response = yield* client
				.get(`${ROLL_URL}?seed=${seed}`, { acceptJson: true })
				.pipe(
					Effect.mapError(
						(cause) =>
							new SetWorldError({
								seed,
								message: `couldn't reach set.world: ${cause.message}`,
								cause,
							})
					)
				);

			if (response.status < 200 || response.status >= 300) {
				const body = yield* response.json.pipe(
					Effect.orElseSucceed((): Schema.Json => null)
				);

				return yield* new SetWorldError({
					seed,
					message: `set.world answered ${response.status}${errorOf(body)}`,
				});
			}

			const roll = yield* HttpClientResponse.schemaBodyJson(RollResponse)(
				response
			).pipe(
				Effect.mapError((cause) => unreadable(seed, cause.message, cause))
			);

			return yield* characterOf(seed, roll);
		});

		const roll = Effect.fn("SetWorld.roll")(function* (input: {
			readonly seed?: number;
		}) {
			const seed = input.seed ?? (yield* random.intBetween(0, SEED_MAX));

			const character = yield* ask(seed).pipe(
				Effect.timeout(TIMEOUT),
				Effect.catchTag("TimeoutError", (cause) =>
					Effect.fail(
						new SetWorldError({
							seed,
							message: `set.world didn't answer in ${TIMEOUT}`,
							cause,
						})
					)
				)
			);

			yield* Effect.logInfo(`rolled set.world seed ${seed}`);

			return character;
		});

		return { roll };
	})
);
