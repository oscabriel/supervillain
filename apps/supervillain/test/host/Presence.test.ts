import { describe, expect } from "bun:test";

import { Effect, Exit, Layer, Scope } from "effect";

import { Presence } from "../../src/host/Presence.ts";
import { effect } from "./effect.ts";

const using = <ROut, E1, RIn, A, E2, R2>(
	layer: Layer.Layer<ROut, E1, RIn>,
	body: Effect.Effect<A, E2, R2>
) =>
	Effect.scoped(
		Effect.flatMap(Layer.build(layer), (context) =>
			Effect.provideContext(body, context)
		)
	);

const here = Effect.flatMap(Presence, (p) => p.here.get);

const seat = (actor: string) =>
	Effect.gen(function* () {
		const presence = yield* Presence;
		const scope = yield* Scope.make();
		yield* presence.enter(actor).pipe(Scope.provide(scope));

		return { leave: Scope.close(scope, Exit.void) };
	});

describe("Presence", () => {
	effect(
		"lists who has a seat open, in arrival order, until each seat's scope closes",
		() =>
			using(
				Presence.layer,
				Effect.gen(function* () {
					expect(yield* here).toEqual([]);
					const alice = yield* seat("key:alice");
					const gm = yield* seat("gm");
					expect(yield* here).toEqual(["key:alice", "gm"]);
					yield* alice.leave;
					expect(yield* here).toEqual(["gm"]);
					yield* gm.leave;
				})
			)
	);

	effect(
		"lists an actor with two seats once, and keeps them until both close",
		() =>
			using(
				Presence.layer,
				Effect.gen(function* () {
					const first = yield* seat("key:alice");
					const second = yield* seat("key:alice");
					expect(yield* here).toEqual(["key:alice"]);
					yield* first.leave;
					expect(yield* here).toEqual(["key:alice"]);
					yield* second.leave;
					expect(yield* here).toEqual([]);
				})
			)
	);
});
