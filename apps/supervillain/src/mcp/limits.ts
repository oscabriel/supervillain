import { rateLimiter } from "@supervillain/ssh";
import type { Rate } from "@supervillain/ssh";
import { Clock, Context, Effect, Layer, Option, Semaphore } from "effect";

import type { McpSeat } from "./seat.ts";

const AGENT_RATE: Rate = { burst: 20, perSecond: 2 };

const IN_FLIGHT_MOST = 4;

export const LINE_MOST = 2048;

export const WHO_MOST = 128;

export const TOPIC_MOST = 64;

export const PARAM_MOST = 128;

export const TOO_MANY = "Too many requests; wait a moment.";

const TOO_BUSY = "Too many requests at once; wait for one to finish first.";

export const ONE_WAIT =
	"You're already waiting with wait_for_change; one wait at a time.";

export const tooLong = (name: string, most: number): string =>
	`${name} is longer than ${most} characters.`;

export class AgentLimits extends Context.Service<
	AgentLimits,
	{ readonly allowed: (key: string) => Effect.Effect<boolean> }
>()("supervillain/mcp/AgentLimits") {
	static readonly make = (rate: Rate = AGENT_RATE) =>
		Effect.sync(() => {
			const take = rateLimiter(rate);

			return AgentLimits.of({
				allowed: (key) =>
					Effect.map(Clock.currentTimeMillis, (now) => take(key, now)),
			});
		});

	static readonly layer = (rate?: Rate): Layer.Layer<AgentLimits> =>
		Layer.effect(AgentLimits, AgentLimits.make(rate));
}

export interface Gate {
	readonly admit: <A, E, R>(
		run: Effect.Effect<A, E, R>,
		refuse: (said: string) => Effect.Effect<A, E>
	) => Effect.Effect<A, E, R>;
	readonly once: <A, E, R>(
		run: Effect.Effect<A, E, R>,
		refuse: (said: string) => Effect.Effect<A, E>
	) => Effect.Effect<A, E, R>;
}

const OPEN: Gate = {
	admit: (run) => run,
	once: (run) => run,
};

const guarded =
	(semaphore: Semaphore.Semaphore, said: string) =>
	<A, E, R>(
		run: Effect.Effect<A, E, R>,
		refuse: (said: string) => Effect.Effect<A, E>
	): Effect.Effect<A, E, R> =>
		Semaphore.withPermitsIfAvailable(
			semaphore,
			1
		)(run).pipe(
			Effect.flatMap(
				Option.match({
					onNone: () => refuse(said),
					onSome: Effect.succeed,
				})
			)
		);

export const gateOf = Effect.fn("gateOf")(function* (seat: McpSeat) {
	if (seat.role === "gm") {
		return OPEN;
	}

	const limits = yield* AgentLimits;
	const inFlight = guarded(yield* Semaphore.make(IN_FLIGHT_MOST), TOO_BUSY);
	const waiting = guarded(yield* Semaphore.make(1), ONE_WAIT);

	const gate: Gate = {
		admit: (run, refuse) =>
			Effect.flatMap(limits.allowed(seat.rateKey), (allowed) =>
				allowed ? inFlight(run, refuse) : refuse(TOO_MANY)
			),
		once: waiting,
	};

	return gate;
});
