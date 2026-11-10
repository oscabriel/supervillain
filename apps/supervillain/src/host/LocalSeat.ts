import { CliRenderEvents, type CliRendererErrorEvent, createCliRenderer } from "@opentui/core";
import type { View } from "@supervillain/engine";
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
  /** Said instead of the join hint, as it changes: how the relay link is doing. */
  readonly joinNote?: View<string>;
  /** Trouble with the way in, in the header whatever is on screen: the relay link down, say. */
  readonly alert?: View<string | undefined>;
}

/**
 * The GM's own terminal: the same App, as actor `gm`. Completes when the GM leaves (Ctrl-C, /quit,
 * or their terminal going away), after restoring the terminal. Logs must not reach this terminal while it runs.
 */
export const localSeat = (options: LocalSeatOptions): Effect.Effect<void, never, TableServices> =>
  Effect.gen(function* () {
    const renderer = yield* Effect.acquireRelease(
      // The App owns Ctrl-C, and the runtime owns signals, so leaving runs the host's finalizers.
      // Clicks, drags and the wheel, never every motion of the mouse, and a click never moves the
      // keyboard from the input line (see packages/ssh).
      Effect.promise(() =>
        createCliRenderer({
          exitOnCtrlC: false,
          exitSignals: [],
          enableMouseMovement: false,
          autoFocus: false,
          // A frame that fails is said in host.log, not in a console drawn over the table.
          openConsoleOnError: false,
        }),
      ),
      (r) =>
        Effect.promise(() => {
          r.destroy();
          return r.closed.catch(() => undefined);
        }),
    );
    const left = yield* Deferred.make<void>();
    const leave = () => void Deferred.doneUnsafe(left, Exit.void);
    // A terminal that goes away takes the renderer with it: the GM has left then, as a player has.
    renderer.on(CliRenderEvents.DESTROY, leave);
    const fork = Effect.runForkWith(yield* Effect.context());
    // A table too small to lay out fails every frame the same way: said once, not for each.
    let failure = "";
    renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }: CliRendererErrorEvent) => {
      if (error.message === failure) return;
      failure = error.message;
      void fork(Effect.logError(`seat ${GM}: a frame failed: ${failure}`));
    });
    const view = yield* openSeat({
      actor: GM,
      room: options.room,
      leave,
      ...(options.helpFooter === undefined ? {} : { helpFooter: options.helpFooter }),
      ...(options.joinHint === undefined ? {} : { joinHint: options.joinHint }),
      ...(options.joinNote === undefined ? {} : { joinNote: options.joinNote }),
      ...(options.alert === undefined ? {} : { alert: options.alert }),
    });
    yield* mountTable(renderer, view);
    yield* Deferred.await(left);
  }).pipe(Effect.scoped);
