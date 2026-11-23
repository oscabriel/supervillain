import { SEED_MAX, SetWorld, SetWorldError } from "@supervillain/domain";
import { Effect, Random } from "effect";
import type { Layer } from "effect";

import type { SetWorldPort } from "../../src/host/services.ts";
import { decodeRoll } from "../../src/host/SetWorld.ts";
import type { RollBody } from "../../src/host/SetWorld.ts";

export const answering = (
	answer: (seed: number) => RollBody
): Layer.Layer<SetWorldPort> =>
	SetWorld.toLayer(
		Effect.succeed({
			roll: (input: { readonly seed?: number }) =>
				Effect.gen(function* () {
					const seed =
						input.seed ?? (yield* Random.nextIntBetween(0, SEED_MAX));

					const body = answer(seed);

					if (body === undefined) {
						return yield* new SetWorldError({
							seed,
							message: "set.world answered 404",
						});
					}

					return yield* decodeRoll(seed, body);
				}),
		})
	);

export const unreachable: Layer.Layer<SetWorldPort> = SetWorld.toLayer(
	Effect.succeed({
		roll: ({ seed }: { readonly seed?: number }) =>
			Effect.die(new Error(`fetched seed ${seed}`)),
	})
);
