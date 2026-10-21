import { Context, Data, DateTime, Effect, Layer, Random, Semaphore, Stream, SubscriptionRef } from "effect"
import type { Envelope } from "../game/events.ts"
import * as rules from "../game/rules.ts"
import type { Command, Dice } from "../game/rules.ts"
import { initialState, type RoomState } from "../game/state.ts"
import { CampaignLog, LogError } from "./CampaignLog.ts"

export class Refusal extends Data.TaggedError("Refusal")<{ message: string }> {}

/** Read-only: only submit writes, so holders of Room can watch the state but never set it. */
export interface View<A> {
  readonly get: Effect.Effect<A>
  readonly changes: Stream.Stream<A>
}
export const viewOf = <A>(ref: SubscriptionRef.SubscriptionRef<A>): View<A> => ({
  get: SubscriptionRef.get(ref),
  changes: SubscriptionRef.changes(ref),
})

export interface Rules {
  decide: typeof rules.decide
  apply: typeof rules.apply
}

const RECENT = 20
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

const make = (r: Rules) =>
  Effect.gen(function* () {
    const log = yield* CampaignLog
    const replayed = yield* log.replay
    const start = yield* Effect.try({
      try: () => replayed.reduce(r.apply, initialState),
      catch: (e) => new LogError({ message: `Replay halted: ${message(e)}` }),
    })
    yield* Effect.logInfo(`Replayed ${replayed.length} events from ${log.path}`)

    const state = yield* SubscriptionRef.make(start)
    const recent = yield* SubscriptionRef.make<ReadonlyArray<Envelope>>(replayed.slice(-RECENT))
    const lock = yield* Semaphore.make(1)
    let halted: string | undefined

    const submit = (actor: string, command: Command): Effect.Effect<Envelope[], Refusal> =>
      Effect.gen(function* () {
        if (halted) return yield* new Refusal({ message: `The log is halted: ${halted}` })
        const current = yield* SubscriptionRef.get(state)
        const random = yield* Random.Random
        const dice: Dice = (sides) => Math.floor(random.nextDoubleUnsafe() * sides) + 1
        const timestamp = DateTime.formatIso(yield* DateTime.now)

        const result = yield* Effect.try({
          try: () => {
            const decision = r.decide(current, actor, command, dice)
            if ("refusal" in decision) return decision
            const envs: Envelope[] = decision.events.map((e, i) => ({
              actor,
              seq: current.seq + i + 1,
              timestamp,
              type: e.type,
              payload: e.payload,
            }))
            return { envs, next: envs.reduce(r.apply, current) }
          },
          catch: (e) => new Refusal({ message: `Rule error, nothing written: ${message(e)}` }),
        })
        if ("refusal" in result) return yield* new Refusal({ message: result.refusal })

        yield* log.append(result.envs).pipe(
          Effect.tapError((e) => Effect.sync(() => (halted = e.message))),
          Effect.mapError((e) => new Refusal({ message: `Log write failed, room halted: ${e.message}` })),
        )
        yield* SubscriptionRef.set(state, result.next)
        yield* SubscriptionRef.update(recent, (xs) => [...xs, ...result.envs].slice(-RECENT))
        return result.envs
        // Uninterruptible once the permit is held: a seat closing mid-submit must not
        // leave the log written but the state unset.
      }).pipe(Effect.uninterruptible, lock.withPermit)

    return Room.of({ submit, state: viewOf(state), recent: viewOf(recent) })
  })

export class Room extends Context.Service<
  Room,
  {
    readonly submit: (actor: string, command: Command) => Effect.Effect<Envelope[], Refusal>
    readonly state: View<RoomState>
    readonly recent: View<ReadonlyArray<Envelope>>
  }
>()("spike-d/host/Room") {
  static readonly layer = Layer.effect(Room, make(rules))
  static readonly layerWithRules = (r: Rules) => Layer.effect(Room, make(r))
}
