import { createCliRenderer } from "@opentui/core";
import { Deferred, Effect, Exit } from "effect";
import { GM } from "../game/index.ts";
import { mountTable, openSeat } from "./Seat.ts";
import type { TableServices } from "./services.ts";

export interface LocalSeatOptions {
  readonly room: string;
  /** Appended to the GM's /help: how players join. */
  readonly helpFooter?: string;
  /** How players join, shown while the GM sits alone. */
  readonly joinHint?: string;
}

/**
 * The GM's own terminal: the same App, as actor `gm`. Completes when the GM leaves (Ctrl-C or
 * /quit), after restoring the terminal. Logs must not reach this terminal while it runs.
 */
export const localSeat = (options: LocalSeatOptions): Effect.Effect<void, never, TableServices> =>
  Effect.gen(function* () {
    const renderer = yield* Effect.acquireRelease(
      // The App owns Ctrl-C, and the runtime owns signals, so leaving runs the host's finalizers.
      Effect.promise(() => createCliRenderer({ exitOnCtrlC: false, exitSignals: [] })),
      (r) =>
        Effect.promise(() => {
          r.destroy();
          return r.closed.catch(() => undefined);
        }),
    );
    const left = yield* Deferred.make<void>();
    const view = yield* openSeat({
      actor: GM,
      room: options.room,
      leave: () => void Deferred.doneUnsafe(left, Exit.void),
      ...(options.helpFooter === undefined ? {} : { helpFooter: options.helpFooter }),
      ...(options.joinHint === undefined ? {} : { joinHint: options.joinHint }),
    });
    yield* mountTable(renderer, view);
    yield* Deferred.await(left);
  }).pipe(Effect.scoped);
