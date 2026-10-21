// Lets an @opentui/ssh 0.6.6 server (a) accept sockets the GM dialed out to the
// relay, and (b) learn the relayed player's actor from `env SV_ACTOR`, without
// patching the package. It relies on four internals, all checked against v0.6.6:
//
// 1. @opentui/ssh builds a plain `ssh2.Server` and calls its prototype `listen`
//    from `Server.listen()`. We wrap `ssh2.Server.prototype.listen` for that one
//    call to capture the instance, then use ssh2's public `injectSocket`.
// 2. ssh2 emits `session` on the Connection with an `accept` that returns the
//    Session. We wrap `emit` per connection so we see that Session too.
// 3. connection.ts rejects env keys outside its allowlist, but every `env`
//    listener still runs, so ours records SV_ACTOR first.
// 4. On `shell`, connection.ts accepts, builds the bridge and calls runSession,
//    which invokes the first middleware synchronously. We set a module variable
//    around the `shell` emit, so `relayActor` must be the FIRST `.use()`.
//
// The server needs `limits.session.perConnection` above 1: the relay carries
// every player of a room as a separate channel on one connection.
import type net from "node:net"
import type { Identity, ListenInfo, Middleware, Server } from "@opentui/ssh"
import ssh2 from "ssh2"
import type { Connection, Session as SshSession } from "ssh2"

let relayedActor: string | undefined // set only during a `shell` emit

export interface Attachable {
  info: ListenInfo
  attach: (socket: net.Socket) => void
}

type Emit = (event: string | symbol, ...args: unknown[]) => boolean

// Use instead of `server.listen(port, host)`.
export async function listenAttachable(server: Server, port?: number, host?: string): Promise<Attachable> {
  const proto = ssh2.Server.prototype as unknown as { listen: (...args: unknown[]) => unknown }
  const original = proto.listen
  let captured: ssh2.Server | undefined
  proto.listen = function (this: ssh2.Server, ...args: unknown[]) {
    proto.listen = original
    captured = this
    this.prependListener("connection", hookConnection)
    return original.apply(this, args)
  }
  let info: ListenInfo
  try {
    info = await server.listen(port, host)
  } finally {
    proto.listen = original
  }
  const ssh = captured
  if (!ssh) throw new Error("attach: could not capture the ssh2 Server inside @opentui/ssh")
  return { info, attach: (socket) => ssh.injectSocket(socket) }
}

function hookConnection(client: Connection) {
  const target = client as unknown as { emit: Emit }
  const emit = target.emit
  target.emit = function (event, ...args) {
    if (event !== "session") return emit.call(this, event, ...args)
    const [accept, reject] = args as [() => SshSession | undefined, unknown]
    const wrapped = () => {
      const session = accept()
      if (session) hookSession(session)
      return session
    }
    return emit.call(this, event, wrapped, reject)
  }
}

function hookSession(session: SshSession) {
  let actor: string | undefined
  session.on("env", (_accept, _reject, info) => {
    if (info.key === "SV_ACTOR") actor = info.val
  })
  const target = session as unknown as { emit: Emit }
  const emit = target.emit
  target.emit = function (event, ...args) {
    if (event !== "shell") return emit.call(this, event, ...args)
    relayedActor = actor
    try {
      return emit.call(this, event, ...args)
    } finally {
      relayedActor = undefined
    }
  }
}

export interface ActorContext {
  actor: string
  via: "relay" | "direct"
}

// A relayed actor can only ever be a player key, never "gm" or anything else.
const RELAYED_ACTOR = /^key:SHA256:[A-Za-z0-9+/]{43}$/

// First middleware. SV_ACTOR is trusted only on a connection that proved the relay's key.
// Pass a getter when the fingerprint is learned after the server starts (see gm-link.ts).
export const relayActor =
  (relayFingerprint: string | undefined | (() => string | undefined)): Middleware<Identity, ActorContext> =>
  (session, next) => {
    const relayed = relayedActor
    const identity = session.identity
    const trusted = typeof relayFingerprint === "function" ? relayFingerprint() : relayFingerprint
    if (identity.method !== "publickey") return session.deny("A public key is required.")
    if (trusted && identity.fingerprint === trusted) {
      if (!relayed) return session.deny("Relay session without SV_ACTOR.")
      if (!RELAYED_ACTOR.test(relayed)) return session.deny("Relay sent an SV_ACTOR that is not a player key.")
      return next({ actor: relayed, via: "relay" as const })
    }
    return next({ actor: `key:${identity.fingerprint}`, via: "direct" as const })
  }
