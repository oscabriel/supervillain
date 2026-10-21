import type { View } from "@supervillain/engine";
import { Context, Effect, Layer, type Scope, Stream, SubscriptionRef } from "effect";

interface Seated {
  readonly id: number;
  readonly actor: string;
}

/** One entry per actor, in order of their first open seat. */
const actorsOf = (seats: ReadonlyArray<Seated>): ReadonlyArray<string> => [
  ...new Set(seats.map((s) => s.actor)),
];

/**
 * Who has a seat open right now. It isn't in the log. Seats read it; only a seat's own scope
 * writes it: `enter` adds the seat and the scope's close removes it, however the session ends.
 */
export class Presence extends Context.Service<
  Presence,
  {
    /** Actors with at least one seat open, in arrival order. */
    readonly here: View<ReadonlyArray<string>>;
    /** Seats `actor` for the life of the current scope. */
    readonly enter: (actor: string) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("supervillain/host/Presence") {
  static readonly layer = Layer.effect(
    Presence,
    Effect.gen(function* () {
      const seats = yield* SubscriptionRef.make<ReadonlyArray<Seated>>([]);
      let next = 0;
      const enter = (actor: string) =>
        Effect.acquireRelease(
          Effect.sync(() => ({ id: next++, actor })).pipe(
            Effect.tap((seat) => SubscriptionRef.update(seats, (xs) => [...xs, seat])),
          ),
          (seat) => SubscriptionRef.update(seats, (xs) => xs.filter((s) => s.id !== seat.id)),
        ).pipe(Effect.asVoid);
      return Presence.of({
        here: {
          get: Effect.map(SubscriptionRef.get(seats), actorsOf),
          changes: Stream.map(SubscriptionRef.changes(seats), actorsOf),
        },
        enter,
      });
    }),
  );
}
