// SSH-in-SSH relay (PROTOTYPE). Players SSH in here; GMs dial out to here over
// TCP and, on that socket, the GM is the SSH server and the relay the client.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import net from "node:net"
import { dirname } from "node:path"
import { Effect } from "effect"
import ssh2 from "ssh2"
import type { ClientChannel, Connection, PseudoTtyInfo, ServerChannel } from "ssh2"

const { Server: SshServer, Client: SshClient, utils } = ssh2

export interface RelayOptions {
  playerPort: number
  gmPort: number
  hostKeyPath: string // the relay's host key, shown to players
  relayKeyPath: string // the relay's client key, presented to GMs
  host?: string
}

export interface Relay {
  playerPort: number
  gmPort: number
  relayFingerprint: string // GMs trust SV_ACTOR only from this key
  rooms: () => string[]
}

export const fingerprintOf = (publicKeyBlob: Buffer): string =>
  `SHA256:${createHash("sha256").update(publicKeyBlob).digest("base64").replace(/=+$/, "")}`

// Loads an ed25519 private key, generating it on first use.
export function loadOrCreateKey(path: string): { pem: string; fingerprint: string } {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, utils.generateKeyPairSync("ed25519").private, { mode: 0o600 })
  }
  const pem = readFileSync(path, "utf8")
  const parsed = utils.parseKey(pem)
  const key = Array.isArray(parsed) ? parsed[0] : parsed
  if (!key || key instanceof Error) throw new Error(`cannot parse key ${path}`)
  return { pem, fingerprint: fingerprintOf(key.getPublicSSH()) }
}

type Pty = { term: string; cols: number; rows: number; width: number; height: number }
const FORWARDED_ENV = new Set(["COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION"])

export const startRelay = (options: RelayOptions) =>
  Effect.gen(function* () {
    const host = options.host ?? "127.0.0.1"
    const hostKey = loadOrCreateKey(options.hostKeyPath)
    const relayKey = loadOrCreateKey(options.relayKeyPath)
    const rooms = new Map<string, InstanceType<typeof SshClient>>()
    const players = new Set<Connection>()
    const gmSockets = new Set<net.Socket>()

    // --- GM side: TCP, one "ROOM <name>\n" line, then we are the SSH client.
    const onGmSocket = (sock: net.Socket) => {
      gmSockets.add(sock)
      sock.once("close", () => gmSockets.delete(sock))
      sock.on("error", () => sock.destroy())
      let buffered = Buffer.alloc(0)
      const onData = (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk])
        const nl = buffered.indexOf(0x0a)
        if (nl === -1) {
          if (buffered.length > 256) sock.destroy()
          return
        }
        // Stay paused: ssh2's Client resumes the socket itself once its data
        // listener is attached (after an async crypto init). Resuming here loses bytes.
        sock.removeListener("data", onData)
        sock.pause()
        const rest = buffered.subarray(nl + 1)
        if (rest.length > 0) sock.unshift(rest)
        const match = /^ROOM ([A-Za-z0-9_-]{1,64})\r?$/.exec(buffered.subarray(0, nl).toString("utf8"))
        if (!match || rooms.has(match[1]!)) {
          sock.end(match ? "ERR room taken\n" : "ERR bad ROOM line\n")
          return
        }
        // Tell the GM which key the relay will authenticate with, so it knows whose SV_ACTOR to trust.
        // It travels on the socket the GM dialed itself, before any SSH bytes.
        sock.write(`OK ${relayKey.fingerprint}\n`)
        attachGm(match[1]!, sock)
      }
      sock.on("data", onData)
    }

    const attachGm = (room: string, sock: net.Socket) => {
      const gm = new SshClient()
      gm.on("ready", () => {
        rooms.set(room, gm)
        console.log(`relay: GM up for room ${room}`)
      })
      gm.on("close", () => {
        if (rooms.get(room) === gm) rooms.delete(room)
        console.log(`relay: GM gone for room ${room}`)
        sock.destroy()
      })
      gm.on("error", (err) => console.error(`relay: GM ${room}: ${err.message}`))
      gm.connect({
        sock,
        username: "relay",
        privateKey: relayKey.pem,
        // Prototype: no GM host-key pinning. The room name is first-come.
        hostVerifier: () => true,
        debug: process.env.RELAY_DEBUG ? (m: string) => console.log("relay-dbg", m) : undefined,
      })
    }

    // --- Player side: a normal SSH server; username is the room.
    const onPlayer = (conn: Connection) => {
      players.add(conn)
      let room = ""
      let actor = ""
      const gmChannels = new Set<ClientChannel>()
      conn.on("authentication", (ctx) => {
        if (ctx.method !== "publickey") return ctx.reject(["publickey"])
        if (!ctx.signature || !ctx.blob) return ctx.accept()
        const parsed = utils.parseKey(`${ctx.key.algo} ${ctx.key.data.toString("base64")}`)
        const key = Array.isArray(parsed) ? parsed[0] : parsed
        if (!key || key instanceof Error || key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) {
          return ctx.reject(["publickey"])
        }
        room = ctx.username
        actor = `key:${fingerprintOf(ctx.key.data)}`
        ctx.accept()
      })
      conn.on("ready", () => {
        conn.on("session", (acceptSession) => {
          const session = acceptSession()
          const pty: Pty = { term: "xterm-256color", cols: 80, rows: 24, width: 0, height: 0 }
          const env: Record<string, string> = {}
          let gmChannel: ClientChannel | undefined
          session.on("pty", (accept, _reject, info: PseudoTtyInfo & { term?: string }) => {
            Object.assign(pty, { term: info.term || pty.term, cols: info.cols, rows: info.rows, width: info.width, height: info.height })
            accept?.()
          })
          session.on("env", (accept, reject, info) => {
            if (!FORWARDED_ENV.has(info.key)) return reject?.()
            env[info.key] = info.val
            accept?.()
          })
          session.on("window-change", (accept, _reject, info) => {
            accept?.()
            Object.assign(pty, { cols: info.cols, rows: info.rows, width: info.width, height: info.height })
            gmChannel?.setWindow(info.rows, info.cols, info.height, info.width)
          })
          session.on("shell", (accept) => {
            const player: ServerChannel = accept()
            const gm = rooms.get(room)
            if (!gm) {
              player.write(`No table is open for room "${room}" right now.\r\n`)
              player.exit(1)
              player.end()
              return
            }
            player.pause()
            gm.shell(pty, { env: { ...env, SV_ACTOR: actor } }, (err, channel) => {
              if (err) {
                player.write(`The table refused the seat: ${err.message}\r\n`)
                player.exit(1)
                player.end()
                return
              }
              gmChannel = channel
              gmChannels.add(channel)
              player.pipe(channel)
              channel.pipe(player, { end: false })
              channel.stderr.pipe(player.stderr, { end: false })
              let exited = false
              channel.on("exit", (code: number | null) => {
                exited = true
                player.exit(code ?? 0)
              })
              channel.on("close", () => {
                gmChannels.delete(channel)
                if (!exited) {
                  player.write("\r\nThe table went away.\r\n")
                  player.exit(1)
                }
                player.end()
              })
              player.on("close", () => channel.close())
              player.resume()
            })
          })
        })
      })
      conn.on("close", () => {
        players.delete(conn)
        for (const channel of gmChannels) channel.close()
      })
      conn.on("error", () => {})
    }

    const playerServer = new SshServer({ hostKeys: [hostKey.pem] }, onPlayer)
    const gmServer = net.createServer(onGmSocket)

    const listen = (server: { listen: (port: number, host: string, cb: () => void) => unknown; once: (event: "error", cb: (err: Error) => void) => unknown; address: () => net.AddressInfo | string | null }, port: number) =>
      Effect.callback<number, Error>((resume) => {
        server.once("error", (err) => resume(Effect.fail(err)))
        server.listen(port, host, () => {
          const address = server.address()
          resume(Effect.succeed(typeof address === "object" && address ? address.port : port))
        })
      })

    const playerPort = yield* Effect.acquireRelease(listen(playerServer, options.playerPort), () =>
      Effect.callback<void>((resume) => {
        for (const conn of players) conn.end()
        playerServer.close(() => resume(Effect.void))
      }),
    )
    const gmPort = yield* Effect.acquireRelease(listen(gmServer, options.gmPort), () =>
      Effect.callback<void>((resume) => {
        for (const gm of rooms.values()) gm.end()
        for (const sock of gmSockets) sock.destroy()
        gmServer.close(() => resume(Effect.void))
      }),
    )
    yield* Effect.logInfo(`relay: players on ${host}:${playerPort}, GMs on ${host}:${gmPort}, relay key ${relayKey.fingerprint}`)
    return {
      playerPort,
      gmPort,
      relayFingerprint: relayKey.fingerprint,
      rooms: () => [...rooms.keys()],
    } satisfies Relay
  })
