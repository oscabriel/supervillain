import { decideAutoFoeStep, GM } from "@supervillain/domain";
import type { TableState } from "@supervillain/domain";
import {
	Context,
	Effect,
	Layer,
	Ref,
	Result,
	Scope,
	Semaphore,
	Stream,
	SubscriptionRef,
} from "effect";
import type { Duration } from "effect";

import { TableRoom } from "./TableRoom.ts";

const AUTO_STEPS = 64;

const AUTO_PAUSE: Duration.Input = "150 millis";

export interface AutoFoesOptions {
	readonly pause?: Duration.Input;
	readonly steps?: number;
}

export class AutoFoes extends Context.Service<
	AutoFoes,
	{
		readonly on: Effect.Effect<boolean>;
		readonly changes: Stream.Stream<boolean>;
		readonly set: (on: boolean) => Effect.Effect<void>;
	}
>()("supervillain/host/AutoFoes") {
	static readonly make = (options: AutoFoesOptions = {}) =>
		Effect.gen(function* () {
			const room = yield* TableRoom;
			const scope = yield* Scope.Scope;
			const on = yield* SubscriptionRef.make(false);
			const driven = yield* Ref.make(-1);
			const one = yield* Semaphore.make(1);
			const pause = options.pause ?? AUTO_PAUSE;
			const steps = options.steps ?? AUTO_STEPS;

			const step = Effect.gen(function* () {
				if (!(yield* SubscriptionRef.get(on))) {
					return false;
				}

				const state = yield* room.state;
				yield* Ref.set(driven, state.seq);
				const command = decideAutoFoeStep(state.sw);

				if (command === undefined) {
					return false;
				}

				const sent = yield* Effect.result(room.submit(GM, command));

				if (Result.isFailure(sent)) {
					yield* Effect.logWarning(
						`/auto foes stopped: ${sent.failure.message}`
					);

					return false;
				}

				yield* Effect.sleep(pause);

				return true;
			});

			const drive = one.withPermits(1)(
				Effect.gen(function* () {
					for (let taken = 0; taken < steps; taken += 1) {
						if (!(yield* step)) {
							return;
						}
					}

					const state = yield* room.state;
					yield* Ref.set(driven, state.seq);
				})
			);

			const redoDepth = yield* Ref.make(0);

			const changed = (state: TableState) =>
				Effect.gen(function* () {
					const previousRedo = yield* Ref.getAndSet(
						redoDepth,
						state.redo.length
					);

					if (state.redo.length > previousRedo) {
						yield* Ref.set(driven, state.seq);

						return;
					}

					const seq = yield* Ref.get(driven);

					if (state.seq > seq) {
						yield* drive;
					}
				});

			yield* room.changes.pipe(Stream.runForEach(changed), Effect.forkScoped);

			const set = Effect.fn("AutoFoes.set")(function* (value: boolean) {
				yield* SubscriptionRef.set(on, value);

				if (value) {
					yield* Effect.forkIn(drive, scope);
				}
			});

			return AutoFoes.of({
				on: SubscriptionRef.get(on),
				changes: SubscriptionRef.changes(on),
				set,
			});
		});

	static readonly layer = (
		options: AutoFoesOptions = {}
	): Layer.Layer<AutoFoes, never, TableRoom> =>
		Layer.effect(AutoFoes, AutoFoes.make(options));
}
