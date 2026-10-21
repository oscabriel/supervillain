import {
  CampaignLog,
  type Envelope,
  type LogError,
  makeRoom,
  Refusal,
  type View,
} from "@supervillain/engine";
import { Clock, Context, Effect, Layer, SubscriptionRef } from "effect";
import { type Command, GM, rules, type TableState } from "../game/index.ts";
import { type Rate, rateLimiter } from "./rate.ts";

/** How many envelopes the state pane shows. */
export const RECENT = 8;

/** Faster than anyone types or rolls at a table, slow enough that nobody can flood the log. */
const PLAYER_RATE: Rate = { burst: 10, perSecond: 2 };

export interface TableRoomOptions {
  /** How fast each player may write. The GM is never held back. */
  readonly playerRate?: Rate;
}

/**
 * The table's single writer: the engine room over this campaign, with the game's rules.
 * The campaign log is provided inside the layer, so nothing else in the app can reach it.
 */
export class TableRoom extends Context.Service<
  TableRoom,
  {
    readonly submit: (
      actor: string,
      command: Command,
    ) => Effect.Effect<ReadonlyArray<Envelope>, Refusal>;
    readonly state: View<TableState>;
    /** The last few envelopes in the log, oldest first, for the debug pane. */
    readonly recent: View<ReadonlyArray<Envelope>>;
  }
>()("supervillain/host/TableRoom") {
  static readonly layer = (
    campaignDir: string,
    options: TableRoomOptions = {},
  ): Layer.Layer<TableRoom, LogError> =>
    Layer.effect(
      TableRoom,
      Effect.gen(function* () {
        const log = yield* CampaignLog;
        const room = yield* makeRoom(rules);
        const take = rateLimiter(options.playerRate ?? PLAYER_RATE);
        const throttle = (actor: string) =>
          Effect.flatMap(Clock.currentTimeMillis, (now) =>
            actor === GM || take(actor, now)
              ? Effect.void
              : Effect.fail(
                  new Refusal({ message: "You're sending lines too fast; wait a moment." }),
                ),
          );
        const recent = yield* SubscriptionRef.make(log.envelopes.slice(-RECENT));
        // Submits finish in any order, so keep the newest by seq.
        const remember = (written: ReadonlyArray<Envelope>) =>
          SubscriptionRef.update(recent, (xs) =>
            [...xs, ...written].sort((a, b) => a.seq - b.seq).slice(-RECENT),
          );
        return TableRoom.of({
          submit: (actor, command) =>
            throttle(actor).pipe(Effect.andThen(room.submit(actor, command)), Effect.tap(remember)),
          state: room.state,
          recent: { get: SubscriptionRef.get(recent), changes: SubscriptionRef.changes(recent) },
        });
      }),
    ).pipe(Layer.provide(CampaignLog.layer(campaignDir)));
}
