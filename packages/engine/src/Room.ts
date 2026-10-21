import { DateTime, Effect, Random, Schema, Semaphore, Stream, SubscriptionRef } from "effect";
import { CampaignLog, LogError } from "./CampaignLog.ts";
import type { Envelope } from "./envelope.ts";
import { fold } from "./fold.ts";
import type { Dice, Rules } from "./rules.ts";

export class Refusal extends Schema.TaggedError<Refusal>()("Refusal", {
  message: Schema.String,
}) {}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A value you can read and watch but not set. */
export interface View<A> {
  readonly get: Effect.Effect<A>;
  readonly changes: Stream.Stream<A>;
}

/** The single writer for one campaign: the only way state changes is `submit`. */
export interface Room<S, C> {
  readonly submit: (actor: string, command: C) => Effect.Effect<ReadonlyArray<Envelope>, Refusal>;
  readonly state: View<S>;
}

/**
 * Opens a room over the campaign log: replays it strictly, then accepts commands one at a time.
 * The app wraps the result in its own service, so nothing else can reach the log.
 */
export const makeRoom = <S, C>(
  rules: Rules<S, C>,
): Effect.Effect<Room<S, C>, LogError, CampaignLog> =>
  Effect.gen(function* () {
    const log = yield* CampaignLog;
    const replayed = fold(rules, log.envelopes, { strict: true });
    if (replayed.error) {
      return yield* new LogError({
        message: `Replay halted at seq ${replayed.error.seq}: ${replayed.error.message}`,
      });
    }
    const state = yield* SubscriptionRef.make(replayed.state);
    let seq = log.envelopes.length;
    const writer = yield* Semaphore.make(1);
    // A failed write may have left part of a line on disk, so the room stops writing until it is reopened.
    let halted: string | undefined;

    const submit = (actor: string, command: C) =>
      Effect.gen(function* () {
        if (halted !== undefined)
          return yield* new Refusal({ message: `The room is halted: ${halted}` });
        const current = yield* SubscriptionRef.get(state);
        const random = yield* Random.Random;
        const dice: Dice = (sides) => Math.floor(random.nextDoubleUnsafe() * sides) + 1;
        const timestamp = DateTime.formatIso(yield* DateTime.now);
        // Decide and apply before writing: a rule that throws leaves the log and the state untouched.
        const result = yield* Effect.try({
          try: () => {
            const decision = rules.decide(current, actor, command, dice);
            if ("refusal" in decision) return decision;
            const envelopes: Envelope[] = decision.events.map((e, i) => ({
              actor,
              seq: seq + i + 1,
              timestamp,
              type: e.type,
              payload: e.payload,
            }));
            return { envelopes, next: envelopes.reduce(rules.apply, current) };
          },
          catch: (e) => new Refusal({ message: `Rule error, nothing written: ${messageOf(e)}` }),
        });
        if ("refusal" in result) return yield* new Refusal({ message: result.refusal });
        const { envelopes, next } = result;
        yield* log.append(envelopes).pipe(
          Effect.tapError((e) => Effect.sync(() => (halted = e.message))),
          Effect.mapError(
            (e) => new Refusal({ message: `Log write failed, room halted: ${e.message}` }),
          ),
        );
        seq += envelopes.length;
        yield* SubscriptionRef.set(state, next);
        return envelopes;
        // Once it holds the permit, a submit runs to the end: a caller leaving mid-write
        // must not leave the log written and the state unset.
      }).pipe(Effect.uninterruptible, writer.withPermit);

    return {
      submit,
      state: { get: SubscriptionRef.get(state), changes: SubscriptionRef.changes(state) },
    };
  });
