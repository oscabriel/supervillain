import {
  CampaignLog,
  type Envelope,
  type LogError,
  makeRoom,
  Refusal,
  type View,
} from "@supervillain/engine";
import { type Rate, rateLimiter } from "@supervillain/ssh";
import { Clock, Context, Effect, Layer, SubscriptionRef } from "effect";
import { type Command, GM, rules, type TableState } from "../game/index.ts";

/** How many envelopes the state pane shows. */
const RECENT = 8;

/** Faster than anyone types or rolls at a table, slow enough that nobody can flood the log. */
const PLAYER_RATE: Rate = { burst: 10, perSecond: 2 };

export interface TableRoomOptions {
  /** How fast each sender (see `submit`'s rate key) may write. The GM is never held back. */
  readonly playerRate?: Rate;
}

/**
 * The table's single writer: the engine room over this campaign, with the game's rules.
 * The campaign log is provided inside the layer, so nothing else in the app can reach it.
 */
export class TableRoom extends Context.Service<
  TableRoom,
  {
    /**
     * Decides and writes one command as `actor`. Its rate is counted against `rateKey`, the actor
     * unless the host knows better: guests from one address, say, share one.
     */
    readonly submit: (
      actor: string,
      command: Command,
      rateKey?: string,
    ) => Effect.Effect<ReadonlyArray<Envelope>, Refusal>;
    readonly state: View<TableState>;
    /** The last few envelopes in the log, oldest first, for the debug pane. */
    readonly recent: View<ReadonlyArray<Envelope>>;
    /** Everyone with an envelope in the log: who has sat at this table and done something. */
    readonly actors: Effect.Effect<ReadonlySet<string>>;
  }
>()("supervillain/host/TableRoom") {
  static readonly layer = (
    campaignDir: string,
    options: TableRoomOptions = {},
  ): Layer.Layer<TableRoom, LogError> =>
    Layer.effect(
      TableRoom,
      Effect.gen(function* () {
        const room = yield* makeRoom(rules, { recent: RECENT });
        const take = rateLimiter(options.playerRate ?? PLAYER_RATE);
        const throttle = (actor: string, rateKey: string) =>
          Effect.flatMap(Clock.currentTimeMillis, (now) =>
            actor === GM || take(rateKey, now)
              ? Effect.void
              : Effect.fail(
                  new Refusal({ message: "You're sending lines too fast; wait a moment." }),
                ),
          );
        const recent = yield* SubscriptionRef.make(room.recent);
        // Submits finish in any order, so keep the newest by seq.
        const remember = (written: ReadonlyArray<Envelope>) =>
          SubscriptionRef.update(recent, (xs) =>
            [...xs, ...written].sort((a, b) => a.seq - b.seq).slice(-RECENT),
          );
        return TableRoom.of({
          submit: (actor, command, rateKey = actor) =>
            throttle(actor, rateKey).pipe(
              Effect.andThen(room.submit(actor, command)),
              Effect.tap(remember),
            ),
          state: room.state,
          recent: { get: SubscriptionRef.get(recent), changes: SubscriptionRef.changes(recent) },
          actors: room.actors,
        });
      }),
    ).pipe(Layer.provide(CampaignLog.layer(campaignDir)));
}
