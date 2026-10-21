// What every seat shares, remote or local: who is here, and mounting the one App
// on a renderer with a RoomView backed by the Room.
import type { CliRenderer } from "@opentui/core"
import { render } from "@opentui/solid"
import { Context, Effect, FiberSet, Layer, Scope, Stream, SubscriptionRef } from "effect"
import { createComponent, createSignal } from "solid-js"
import { completeLine, parseInputLine } from "../game/input.ts"
import { App, type RoomView } from "../table/App.tsx"
import { Room, type View, viewOf } from "./Room.ts"

export class Presence extends Context.Service<
  Presence,
  {
    readonly here: SubscriptionRef.SubscriptionRef<ReadonlyArray<string>>
    readonly join: (actor: string) => Effect.Effect<void, never, Scope.Scope>
  }
>()("spike-d/host/Presence") {
  static readonly layer = Layer.effect(
    Presence,
    Effect.gen(function* () {
      const here = yield* SubscriptionRef.make<ReadonlyArray<string>>([])
      const leave = (actor: string) => (xs: ReadonlyArray<string>) => {
        const i = xs.indexOf(actor)
        return i < 0 ? xs : [...xs.slice(0, i), ...xs.slice(i + 1)]
      }
      const join = (actor: string) =>
        Effect.acquireRelease(SubscriptionRef.update(here, (xs) => [...xs, actor]), () =>
          SubscriptionRef.update(here, leave(actor)),
        )
      return Presence.of({ here, join })
    }),
  )
}

// A Solid accessor that follows a View, batched to one update per ~16ms.
const follow = <A>(view: View<A>) =>
  Effect.gen(function* () {
    const [get, set] = createSignal<A>(yield* view.get, { equals: false })
    yield* view.changes.pipe(
      Stream.groupedWithin(1024, "16 millis"),
      Stream.runForEach((batch) => Effect.sync(() => set(() => batch[batch.length - 1]!))),
      Effect.forkScoped,
    )
    return get
  })

// The line surface: parse with the registry, submit, and turn a Refusal into its message.
export const submitLine = (actor: string, line: string) =>
  Effect.gen(function* () {
    const parsed = parseInputLine(line)
    if (parsed.kind === "refusal") return parsed.message
    if (parsed.kind !== "command") return undefined
    const room = yield* Room
    return yield* room.submit(actor, parsed.command).pipe(
      Effect.as(undefined),
      Effect.catchTag("Refusal", (e) => Effect.succeed(e.message)),
    )
  })

// Mounts the App for one actor. Everything it starts lives in the caller's Scope.
export const mountTable = (renderer: CliRenderer, actor: string) =>
  Effect.gen(function* () {
    const room = yield* Room
    const presence = yield* Presence
    yield* presence.join(actor)
    const state = yield* follow(room.state)
    const recent = yield* follow(room.recent)
    const here = yield* follow(viewOf(presence.here))
    const run = yield* FiberSet.makeRuntimePromise<Room>()

    const view: RoomView = {
      state,
      complete: (line) => completeLine(state(), line),
      submit: (line) => run(submitLine(actor, line)),
      present: () => [...new Set(here())],
      envelopes: () => [...recent()],
    }
    yield* Effect.promise(() => render(() => createComponent(App, { view, actor }), renderer))
  })
