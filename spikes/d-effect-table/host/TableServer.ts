// The table over SSH: one @opentui/ssh server, one Effect Scope per session.
import { join } from "node:path"
import { createServer } from "@opentui/ssh"
import { Context, Effect, FiberSet, Layer } from "effect"
import { listenAttachable, relayActor } from "../relay/attach.ts"
import { dialRelay } from "../relay/gm-link.ts"
import { Room } from "./Room.ts"
import { mountTable, Presence } from "./Seat.ts"

export interface TableServerOptions {
  campaignDir: string
  port: number
  bind: string
  relay?: { host: string; port: number; room: string }
}

export class TableServer extends Context.Service<
  TableServer,
  { readonly port: number; readonly fingerprints: string[]; readonly relayRoom?: string }
>()("spike-d/host/TableServer") {
  static readonly layer = (options: TableServerOptions) =>
    Layer.effect(
      TableServer,
      Effect.gen(function* () {
        // Seat fibers fork from here; they inherit Room, Presence, Random and Clock.
        const runFork = yield* FiberSet.makeRuntime<Room | Presence>()
        let relayFingerprint: string | undefined

        const server = createServer({
          hostKey: { path: join(options.campaignDir, "host_key") },
          auth: { publicKey: "any" },
          startupBanner: false,
          // The relay carries every player of a room as a channel on one connection.
          limits: { session: { perConnection: 32 } },
          onError: (err) => void runFork(Effect.logWarning(`ssh: ${err instanceof Error ? err.message : String(err)}`)),
        })
          .use(relayActor(() => relayFingerprint))
          .serve((session) => {
            const { actor, via } = session.context
            const closed = new Promise<void>((resolve) => session.onClose(resolve))
            // Ctrl-C leaves the table, as it does at the GM's own seat.
            session.renderer.keyInput.on("keypress", (key) => {
              if (key.ctrl && key.name === "c") session.end()
            })
            runFork(
              Effect.gen(function* () {
                yield* Effect.logInfo(`seat open: ${actor} via ${via} (${session.cols}x${session.rows})`)
                yield* Effect.addFinalizer(() => Effect.logInfo(`seat closed: ${actor}`))
                yield* mountTable(session.renderer, actor)
                yield* Effect.promise(() => closed)
              }).pipe(
                Effect.scoped,
                Effect.ensuring(Effect.sync(() => session.end())),
              ),
            )
          })

        let port: number
        let fingerprints: string[]
        if (options.relay) {
          const relay = options.relay
          const attachable = yield* Effect.acquireRelease(
            Effect.promise(() => listenAttachable(server, options.port, options.bind)),
            () => Effect.promise(() => server.close()),
          )
          ;({ port, fingerprints } = attachable.info)
          const link = yield* dialRelay({
            relayHost: relay.host,
            gmPort: relay.port,
            room: relay.room,
            onSocket: (socket, fingerprint) => {
              relayFingerprint = fingerprint
              attachable.attach(socket)
            },
          })
          link.socket.once("close", () => runFork(Effect.logWarning(`relay link to ${relay.host}:${relay.port} closed`)))
          yield* Effect.logInfo(`relay: room "${relay.room}" open at ${relay.host}, trusting relay key ${relayFingerprint}`)
        } else {
          const info = yield* Effect.acquireRelease(
            Effect.promise(() => server.listen(options.port, options.bind)),
            () => Effect.promise(() => server.close()),
          )
          ;({ port, fingerprints } = info)
        }
        yield* Effect.logInfo(`table: ssh -p ${port} ${options.bind}  (host key ${fingerprints[0]})`)
        return TableServer.of({ port, fingerprints, relayRoom: options.relay?.room })
      }),
    )
}
