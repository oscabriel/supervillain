// The GM's own terminal: same App, actor "gm". Completes when the GM presses Ctrl-C.
import { createCliRenderer, type KeyEvent } from "@opentui/core"
import { Effect } from "effect"
import { mountTable } from "./Seat.ts"

export const localSeat = Effect.gen(function* () {
  const renderer = yield* Effect.acquireRelease(
    // We own Ctrl-C and signals so quitting runs the host's finalizers instead of exiting.
    Effect.promise(() => createCliRenderer({ exitOnCtrlC: false, exitSignals: [] })),
    (r) =>
      Effect.promise(() => {
        r.destroy()
        return r.closed.catch(() => undefined)
      }),
  )
  yield* mountTable(renderer, "gm")
  yield* Effect.callback<void>((resume) => {
    const onKey = (key: KeyEvent) => {
      if (key.ctrl && key.name === "c") resume(Effect.void)
    }
    renderer.keyInput.on("keypress", onKey)
    return Effect.sync(() => renderer.keyInput.off("keypress", onKey))
  })
}).pipe(Effect.scoped)
