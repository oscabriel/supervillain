import { ActorId, Seating } from "@supervillain/domain";
import {
	Context,
	Effect,
	Function,
	Layer,
	Ref,
	Schema,
	Stream,
	SubscriptionRef,
} from "effect";
import type { Scope } from "effect";

import type { View } from "./View.ts";

interface Seated {
	readonly id: number;
	readonly actor: string;
	readonly leave: () => void;
}

const actorsOf = (seats: ReadonlyArray<Seated>): ReadonlyArray<string> => [
	...new Set(seats.map((s) => s.actor)),
];

const isActorId = Schema.is(ActorId);

export class Presence extends Context.Service<
	Presence,
	{
		readonly here: View<ReadonlyArray<string>>;
		readonly enter: (
			actor: string,
			leave?: () => void
		) => Effect.Effect<void, never, Scope.Scope>;
		readonly kick: (actor: string) => Effect.Effect<number>;
	}
>()("supervillain/host/Presence") {
	static readonly make = Effect.gen(function* () {
		const seats = yield* SubscriptionRef.make<ReadonlyArray<Seated>>([]);
		const next = yield* Ref.make(0);

		const enter = Effect.fn("Presence.enter")(function* (
			actor: string,
			leave: () => void = Function.constVoid
		) {
			yield* Effect.acquireRelease(
				Ref.getAndUpdate(next, (n) => n + 1).pipe(
					Effect.map((id): Seated => ({ id, actor, leave })),
					Effect.tap((seat) =>
						SubscriptionRef.update(seats, (xs) => [...xs, seat])
					)
				),
				(seat) =>
					SubscriptionRef.update(seats, (xs) =>
						xs.filter((s) => s.id !== seat.id)
					)
			);
		});

		const kick = Effect.fn("Presence.kick")(function* (actor: string) {
			const theirs = (yield* SubscriptionRef.get(seats)).filter(
				(s) => s.actor === actor
			);

			yield* Effect.sync(() => {
				for (const seat of theirs) {
					seat.leave();
				}
			});

			return theirs.length;
		});

		return Presence.of({
			here: {
				get: Effect.map(SubscriptionRef.get(seats), actorsOf),
				changes: Stream.map(SubscriptionRef.changes(seats), actorsOf),
			},
			enter,
			kick,
		});
	});

	static readonly layer = Layer.effect(Presence, Presence.make);
}

export const SeatingLive = Seating.toLayer(
	Effect.gen(function* () {
		const presence = yield* Presence;

		return {
			here: Effect.fn("Seating.here")(function* () {
				const seated = yield* presence.here.get;

				return seated.filter(isActorId);
			}),
		};
	})
);
