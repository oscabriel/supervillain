// GM side of the relay (PROTOTYPE): dial out, name the room, read the relay's
// key fingerprint, then hand the raw socket to the GM's SSH server, which
// speaks SSH as the server on it.
import net from "node:net"
import { Effect } from "effect"

export interface DialOptions {
  relayHost: string
  gmPort: number
  room: string
  // Called before any SSH byte is read, with the relay's fingerprint, so trust is set before a session can start.
  onSocket: (socket: net.Socket, relayFingerprint: string) => void
}

export interface RelayLink {
  socket: net.Socket
  relayFingerprint: string // trust SV_ACTOR only from connections with this key
}

// Scoped: the socket is destroyed when the scope closes. No reconnect in this spike.
export const dialRelay = (options: DialOptions) =>
  Effect.acquireRelease(
    Effect.callback<RelayLink, Error>((resume) => {
      const socket = net.connect(options.gmPort, options.relayHost)
      let buffered = Buffer.alloc(0)
      const fail = (err: Error) => {
        socket.destroy()
        resume(Effect.fail(err))
      }
      const onData = (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk])
        const nl = buffered.indexOf(0x0a)
        if (nl === -1) return
        socket.removeListener("data", onData)
        socket.removeListener("error", fail)
        // ssh2's server pauses the socket and resumes it once its own reader is attached.
        socket.pause()
        const rest = buffered.subarray(nl + 1)
        if (rest.length > 0) socket.unshift(rest)
        const line = buffered.subarray(0, nl).toString("utf8").trim()
        const match = /^OK (SHA256:\S+)$/.exec(line)
        if (!match) return fail(new Error(`relay refused room ${options.room}: ${line}`))
        const relayFingerprint = match[1]!
        options.onSocket(socket, relayFingerprint)
        resume(Effect.succeed({ socket, relayFingerprint }))
      }
      socket.once("error", fail)
      socket.once("connect", () => {
        socket.setNoDelay(true)
        socket.on("data", onData)
        socket.write(`ROOM ${options.room}\n`)
      })
    }),
    (link) => Effect.sync(() => link.socket.destroy()),
  )
