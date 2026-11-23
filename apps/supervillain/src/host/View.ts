import type { Effect, Stream } from "effect";

export interface View<A> {
	readonly get: Effect.Effect<A>;
	readonly changes: Stream.Stream<A>;
}
