import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, type Socket } from "node:net";
import { CliRenderEvents, type CliRenderer, createCliRenderer, NativeSession } from "@opentui/core";
import { Cause, Deferred, Effect, Exit, FiberSet, type Scope } from "effect";
import ssh2, { type AuthContext, type Connection, type ServerChannel } from "ssh2";
import { addressBucket, normalizeAddress } from "./address.ts";
import { fingerprintOf, KEX, loadHostKey, parseKey } from "./keys.ts";
import { rateLimiter } from "./rate.ts";
import { isRelayableActor } from "./relay.ts";
import {
  type Pty,
  rendererStreams,
  sanitizePty,
  sanitizeSize,
  TERMINAL_RESET,
  takeEnv,
} from "./terminal.ts";
import {
  type AttachOptions,
  type Identity,
  type RawExit,
  type RawRequest,
  type ServeOptions,
  type SessionInfo,
  SshError,
  type SshServer,
} from "./types.ts";

/** Sized for a table, not a service: each shell holds a renderer of 15–25 MB on the host. */
const DEFAULT_LIMITS = {
  connections: 64,
  connectionsPerAddress: 8,
  sessionsPerConnection: 2,
  sessionsPerRelay: 64,
  sessionsPerAddress: 16,
  sessions: 64,
};
const DEFAULT_TIMEOUTS = {
  loginMs: 20_000,
  sessionStartMs: 10_000,
  keepaliveMs: 15_000,
  keepaliveCount: 3,
};
/** How long a closing session waits for the renderer to restore the client's terminal. */
const RESTORE_TIMEOUT_MS = 2000;
const NO_PTY_MESSAGE = "This needs a terminal: connect with ssh -t.";

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Text a peer chose (a disconnect reason, say), quoted so no control byte reaches a log. */
const printable = (text: string) => JSON.stringify(text);

/** Line ends for a client terminal in raw mode, which a pty request puts it in. */
const crlf = (text: string) => text.replace(/\r?\n/g, "\r\n");

const guestId = () => randomBytes(12).toString("base64url");

/** One accepted socket, as the connection on it sees it. */
interface Link {
  readonly socket: Socket;
  readonly address: string;
  /** What per-address limits count it by: the address, or its /64 for IPv6. */
  readonly bucket: string;
  /** Relay keys believed on this socket only. */
  readonly extraTrust: ReadonlySet<string>;
  /** Set on a relay's link: decides keys neither list trusts, and refuses everyone else. */
  readonly admitRelay: ((fingerprint: string) => boolean) | undefined;
  /** Never cut for carrying no session. */
  readonly persistent: boolean;
  /** Called once the client has logged in. */
  readonly authenticated: () => void;
}

/** Verifies a signed publickey attempt. ssh2 hands us the signature but does not check it. */
const verifiedKey = (ctx: Extract<AuthContext, { method: "publickey" }>) => {
  if (!ctx.signature || !ctx.blob) return undefined;
  const key = parseKey(`${ctx.key.algo} ${ctx.key.data.toString("base64")}`);
  if (!key || key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) return undefined;
  return { fingerprint: fingerprintOf(ctx.key.data), algorithm: key.type };
};

/**
 * Says yes to a publickey query, naming the algorithm the client asked about, as RFC 4252 wants.
 * ssh2 1.16 has already rewritten `rsa-sha2-256`/`-512` to `ssh-rsa` and would echo that, and
 * OpenSSH, which doesn't accept `ssh-rsa`, then gives up on the whole login: so put it back.
 */
const acceptQuery = (ctx: Extract<AuthContext, { method: "publickey" }>) => {
  if (ctx.key.algo === "ssh-rsa" && ctx.hashAlgo === "sha256") ctx.key.algo = "rsa-sha2-256";
  else if (ctx.key.algo === "ssh-rsa" && ctx.hashAlgo === "sha512") ctx.key.algo = "rsa-sha2-512";
  ctx.accept();
};

/**
 * Closes a session channel that never asked for a shell or exec, and refuses anything more on it.
 * ssh2 has no public way: a session becomes a closable channel only once started. So this sends
 * the close itself, through ssh2's own internals; false if they aren't where 1.16 keeps them.
 */
const closeUnstarted = (client: Connection, session: ssh2.Session): boolean => {
  const protocol = (client as unknown as { _protocol?: { channelClose?: (id: number) => void } })
    ._protocol;
  const internals = session as unknown as {
    _ending?: boolean;
    _chanInfo?: { outgoing?: { id?: unknown } };
  };
  const id = internals._chanInfo?.outgoing?.id;
  if (typeof protocol?.channelClose !== "function" || typeof id !== "number") return false;
  try {
    internals._ending = true;
    protocol.channelClose(id);
  } catch {
    // The connection is already gone.
  }
  return true;
};

/** Ends a channel after its last write, with an exit status; closes it outright if the peer stalls. */
const endChannel = (channel: ServerChannel, how: RawExit) => {
  try {
    if (typeof how === "number") channel.exit(how);
    else channel.exit(how.signal, how.coreDumped ?? false, how.message ?? "");
    channel.end();
    setTimeout(() => {
      try {
        channel.close();
      } catch {
        // Already gone.
      }
    }, RESTORE_TIMEOUT_MS).unref();
  } catch {
    // The channel or connection is already gone.
  }
};

/**
 * Starts an SSH server for the life of the scope. Each shell or exec channel runs its handler in its
 * own fiber with its own scope; closing the server's scope ends every session and stops listening.
 */
export const serve = (options: ServeOptions): Effect.Effect<SshServer, SshError, Scope.Scope> =>
  Effect.gen(function* () {
    const hostKey = yield* Effect.tryPromise({
      try: () => loadHostKey(options.hostKeyPath),
      catch: (e) => new SshError({ message: `host key: ${messageOf(e)}` }),
    });
    const limits = { ...DEFAULT_LIMITS, ...options.limits };
    const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    // Every renderer listens on one emitter OpenTUI shares across the process, so the eleventh
    // shell would print a leak warning to stderr, which is the GM's screen. A seat each is no leak.
    EventEmitter.defaultMaxListeners = Math.max(
      EventEmitter.defaultMaxListeners,
      limits.sessions + 16,
    );
    const trusted = new Set(options.trustedRelayKeys ?? []);
    const authMethods: Array<"publickey" | "keyboard-interactive"> = options.allowGuests
      ? ["publickey", "keyboard-interactive"]
      : ["publickey"];

    // Session fibers inherit this fiber's services (logger, clock) and die with the set.
    const sessions = yield* FiberSet.make();
    const fork = yield* FiberSet.runtime(sessions)<never>();
    const connections = new Set<Connection>();
    let accepting = true;
    let openSessions = 0;
    /** Open connections and sessions by remote address. */
    const byAddress = new Map<string, { connections: number; sessions: number }>();
    const countsFor = (address: string) => {
      let counts = byAddress.get(address);
      if (!counts) byAddress.set(address, (counts = { connections: 0, sessions: 0 }));
      return counts;
    };
    const forget = (address: string) => {
      const counts = byAddress.get(address);
      if (counts && counts.connections === 0 && counts.sessions === 0) byAddress.delete(address);
    };

    const runSession = (label: string, body: Effect.Effect<void, never, Scope.Scope>) =>
      fork(
        body.pipe(
          Effect.scoped,
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError(`ssh session ${label} failed`, Cause.pretty(cause)),
          ),
        ),
      );

    const onConnection = (client: Connection, link: Link) => {
      if (!accepting) {
        client.end();
        return;
      }
      connections.add(client);
      const remoteAddress = link.address;
      const counts = countsFor(link.bucket);
      let identity: Identity | undefined;
      let user = "";
      let relay = false;
      let connectionSessions = 0;
      /** Sessions that asked for a shell or exec and haven't closed. */
      let startedSessions = 0;
      let closed = false;
      const live = new Set<() => void>();

      // A logged-in connection must keep a session going: one that never starts one, or whose last
      // one ended, only holds a place. ssh2 answers keepalives itself, so nothing else would end it.
      let idle: ReturnType<typeof setTimeout> | undefined;
      const stopIdle = () => {
        clearTimeout(idle);
        idle = undefined;
      };
      const startIdle = () => {
        stopIdle();
        if (!closed && startedSessions === 0 && !link.persistent)
          idle = setTimeout(() => link.socket.destroy(), timeouts.sessionStartMs);
      };

      client.on("authentication", (ctx) => {
        if (ctx.method === "publickey") {
          // The first pass only asks whether the key is acceptable; any key is.
          if (!ctx.signature) return acceptQuery(ctx);
          const key = verifiedKey(ctx);
          if (!key) return ctx.reject(authMethods);
          identity = {
            kind: "key",
            actor: `key:${key.fingerprint}`,
            fingerprint: key.fingerprint,
            algorithm: key.algorithm,
          };
          relay = trusted.has(key.fingerprint) || link.extraTrust.has(key.fingerprint);
          if (!relay && link.admitRelay) {
            relay = link.admitRelay(key.fingerprint);
            if (!relay) {
              identity = undefined;
              return ctx.reject(authMethods);
            }
          }
          user = ctx.username;
          return ctx.accept();
        }
        if (ctx.method === "keyboard-interactive" && options.allowGuests && !link.admitRelay) {
          identity = { kind: "guest", actor: `guest:${guestId()}` };
          user = ctx.username;
          return ctx.accept();
        }
        return ctx.reject(authMethods);
      });

      client.once("ready", () => {
        link.authenticated();
        startIdle();
      });

      client.on("session", (acceptSession, rejectSession) => {
        const limit = relay ? limits.sessionsPerRelay : limits.sessionsPerConnection;
        if (
          !identity ||
          !accepting ||
          connectionSessions >= limit ||
          openSessions >= limits.sessions ||
          // A relay carries every player through one address, so only its own limit applies.
          (!relay && counts.sessions >= limits.sessionsPerAddress)
        ) {
          return rejectSession();
        }
        const who = identity;
        connectionSessions++;
        openSessions++;
        counts.sessions++;
        let started = false;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          clearTimeout(startDeadline);
          live.delete(release);
          connectionSessions--;
          openSessions--;
          counts.sessions--;
          forget(link.bucket);
          if (started && --startedSessions === 0) startIdle();
        };
        live.add(release);
        const start = () => {
          started = true;
          clearTimeout(startDeadline);
          startedSessions++;
          stopIdle();
        };

        const session = acceptSession();
        session.once("close", release);
        // A session must ask for a shell or exec soon; one that idles only holds a place. Only it
        // goes: on a relay, the connection carries every other player. A connection left with no
        // started session goes too, unless it's a relay's, which the idle rule above looks after.
        const startDeadline = setTimeout(() => {
          const closedAlone = closeUnstarted(client, session);
          release();
          if (!closedAlone || (startedSessions === 0 && !relay && !link.persistent))
            link.socket.destroy();
        }, timeouts.sessionStartMs);
        let pty: Pty = sanitizePty(undefined);
        let hasPty = false;
        const env: Record<string, string> = {};
        let relayedActor: string | undefined;
        let resize: ((cols: number, rows: number) => void) | undefined;

        session.on("pty", (accept, reject, info) => {
          if (started) return reject?.();
          pty = sanitizePty(info);
          hasPty = true;
          accept?.();
        });
        session.on("env", (accept, reject, { key, val }) => {
          if (started) return reject?.();
          if (key === "SV_ACTOR") {
            // Only a trusted relay names the player, and only as a player.
            if (!relay || !isRelayableActor(val)) return reject?.();
            relayedActor = val;
            return accept?.();
          }
          return takeEnv(env, key, val) ? accept?.() : reject?.();
        });
        session.on("window-change", (accept, _reject, info) => {
          accept?.();
          const size = sanitizeSize(info.cols, info.rows, pty);
          pty = { ...pty, ...size };
          resize?.(size.cols, size.rows);
        });

        const info = (): SessionInfo => ({
          identity: who,
          user,
          term: pty.term,
          cols: pty.cols,
          rows: pty.rows,
          env: { ...env },
          remoteAddress,
          ...(relayedActor === undefined ? {} : { relayedActor }),
        });

        /** Whether this channel may start. A relay's channel must name its player. */
        const mayStart = () => !started && (!relay || relayedActor !== undefined);

        const onResize = (onResize: (cols: number, rows: number) => void) => (resize = onResize);

        session.on("shell", (accept, reject) => {
          const { onRaw, onShell } = options;
          if (!mayStart() || (!onRaw && !onShell)) return reject?.();
          start();
          const channel = accept();
          if (onRaw) {
            const sessionInfo = info();
            const request: RawRequest = { kind: "shell" };
            return void runSession(
              sessionInfo.identity.actor,
              rawSession(client, channel, sessionInfo, request, hasPty, onRaw, onResize),
            );
          }
          if (!hasPty || !onShell) {
            // A renderer would pour escape codes into a pipe and never notice the input ending.
            channel.stderr.write(`${options.noPtyMessage ?? NO_PTY_MESSAGE}\n`);
            return endChannel(channel, 1);
          }
          const sessionInfo = info();
          runSession(
            sessionInfo.identity.actor,
            shellSession(channel, sessionInfo, onShell, onResize),
          );
        });
        session.on("exec", (accept, reject, { command }) => {
          const { onRaw, onExec } = options;
          if (!mayStart() || (!onRaw && !onExec)) return reject?.();
          start();
          const channel = accept();
          const sessionInfo = info();
          if (onRaw) {
            const request: RawRequest = { kind: "exec", command };
            return void runSession(
              sessionInfo.identity.actor,
              rawSession(client, channel, sessionInfo, request, hasPty, onRaw, onResize),
            );
          }
          if (!onExec) return;
          runSession(
            sessionInfo.identity.actor,
            execSession(channel, sessionInfo, command, onExec, hasPty ? crlf : (text) => text),
          );
        });
      });

      client.on("close", () => {
        closed = true;
        stopIdle();
        connections.delete(client);
        for (const release of live) release();
      });
      client.on("error", (e: Error & { level?: string }) => {
        // A peer that stops answering keepalives may not read either, so a polite end could
        // wait on it for minutes: cut it.
        if (e.level === "client-timeout") link.socket.destroy();
        void fork(Effect.logDebug(`ssh connection from ${remoteAddress}: ${printable(e.message)}`));
      });
    };

    /** Resolves when the channel goes away, from either side. */
    const watchChannel = (channel: ServerChannel) =>
      Effect.gen(function* () {
        const ended = yield* Deferred.make<void>();
        const state = { gone: false };
        const end = () => void Deferred.doneUnsafe(ended, Exit.void);
        const onGone = () => {
          state.gone = true;
          end();
        };
        channel.once("close", onGone);
        channel.on("error", onGone);
        return { ended, end, state };
      });

    const shellSession = (
      channel: ServerChannel,
      info: SessionInfo,
      onShell: NonNullable<ServeOptions["onShell"]>,
      onResize: (resize: (cols: number, rows: number) => void) => void,
    ): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function* () {
        const { ended, end, state } = yield* watchChannel(channel);
        const streams = rendererStreams(channel, info.cols, info.rows);
        const nativeSession = new NativeSession(channel);
        // Runs last, after the renderer has restored the client's terminal.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            streams.detach();
            if (state.gone) return;
            if (!accepting && options.shutdownNotice !== undefined)
              channel.write(crlf(`${options.shutdownNotice}\n`));
            endChannel(channel, 0);
          }),
        );
        // A client that leaves while the renderer is being set up must not leave setup waiting on it.
        let renderer: CliRenderer | undefined;
        channel.once("close", () => {
          if (!renderer) nativeSession.dispose();
        });
        const created = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () =>
              createCliRenderer({
                stdin: streams.stdin,
                stdout: streams.stdout,
                width: info.cols,
                height: info.rows,
                nativeSession,
                environment: { TERM: info.term, ...info.env },
                exitOnCtrlC: false,
                exitSignals: [],
                consoleMode: "disabled",
                externalOutputMode: "passthrough",
                targetFps: 30,
              }),
            catch: (e) => new SshError({ message: `renderer: ${messageOf(e)}` }),
          }),
          (created) =>
            Effect.promise(async () => {
              created.destroy();
              if (state.gone) nativeSession.dispose();
              const restored = await Promise.race([
                created.closed.then(
                  () => true,
                  () => true,
                ),
                Bun.sleep(RESTORE_TIMEOUT_MS).then(() => false),
              ]);
              if (!restored) nativeSession.dispose();
            }),
        ).pipe(
          // A client that leaves during setup is an ordinary goodbye, not a failure.
          Effect.catchTag("SshError", (e) =>
            state.gone
              ? Effect.as(
                  Effect.logDebug(`ssh shell for ${info.identity.actor}: ${e.message}`),
                  undefined,
                )
              : Effect.die(e),
          ),
        );
        if (created === undefined) return;
        renderer = created;
        const live = created;
        live.on(CliRenderEvents.DESTROY, end);
        onResize((cols, rows) => {
          streams.stdout.columns = cols;
          streams.stdout.rows = rows;
          live.requestResize(cols, rows);
        });
        if (state.gone) return;
        yield* Effect.raceFirst(
          onShell({ info, renderer: live, close: end }),
          Deferred.await(ended),
        );
      });

    const execSession = (
      channel: ServerChannel,
      info: SessionInfo,
      command: string,
      onExec: NonNullable<ServeOptions["onExec"]>,
      lineEnds: (text: string) => string,
    ): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function* () {
        const { ended, state } = yield* watchChannel(channel);
        // Exec takes no input; reading it lets ssh2 close the channel when the time comes.
        channel.resume();
        // A handler that dies or is cut off reports failure.
        let status = 1;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (!state.gone) endChannel(channel, status);
          }),
        );
        const write = (text: string) => {
          if (!state.gone) channel.write(lineEnds(text));
        };
        const writeError = (text: string) => {
          if (!state.gone) channel.stderr.write(lineEnds(text));
        };
        yield* Effect.raceFirst(
          onExec({ info, command, write, writeError }).pipe(
            Effect.map((code) => {
              status = code;
            }),
          ),
          Deferred.await(ended),
        );
      });

    /** A session handed over as bytes: the handler forwards it, the server only guards and ends it. */
    const rawSession = (
      client: Connection,
      channel: ServerChannel,
      info: SessionInfo,
      request: RawRequest,
      pty: boolean,
      onRaw: NonNullable<ServeOptions["onRaw"]>,
      onResize: (resize: (cols: number, rows: number) => void) => void,
    ): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function* () {
        const { ended, end, state } = yield* watchChannel(channel);
        // ssh2 holds a closed channel's "close" until its input is read, which a handler that hasn't
        // started forwarding yet doesn't do: a connection that goes ends the session all the same.
        const onConnectionGone = () => {
          state.gone = true;
          end();
        };
        client.once("close", onConnectionGone);
        let exited = false;
        // A handler that dies or is cut off reports failure.
        let status: RawExit = 1;
        yield* Effect.addFinalizer(() =>
          Effect.suspend(() => {
            if (state.gone || exited) {
              client.removeListener("close", onConnectionGone);
              return Effect.void;
            }
            exited = true;
            // What was forwarded may have left the client's terminal in any mode: a pty gets it
            // put back, and the notice on a line of its own, not inside the old frame.
            if (!accepting && options.shutdownNotice !== undefined && request.kind === "shell")
              channel.write(
                pty
                  ? `${TERMINAL_RESET}\r\n${crlf(`${options.shutdownNotice}\n`)}`
                  : `${options.shutdownNotice}\n`,
              );
            endChannel(channel, status);
            // Wait for the close to go out, so a server that's shutting down doesn't cut the
            // connection ahead of it.
            return Deferred.await(ended).pipe(
              Effect.timeout(RESTORE_TIMEOUT_MS),
              Effect.ignore,
              Effect.ensuring(Effect.sync(() => client.removeListener("close", onConnectionGone))),
            );
          }),
        );
        const listeners = new Set<(cols: number, rows: number) => void>();
        onResize((cols, rows) => {
          for (const listener of listeners) listener(cols, rows);
        });
        const exit = (how: RawExit) => {
          if (exited || state.gone) return;
          exited = true;
          endChannel(channel, how);
          end();
        };
        yield* Effect.raceFirst(
          onRaw({
            info,
            request,
            pty,
            stream: channel,
            stderr: channel.stderr,
            onResize: (listener) => void listeners.add(listener),
            exit,
          }).pipe(
            Effect.map(() => {
              status = 0;
            }),
          ),
          Deferred.await(ended),
        );
      });

    // Every connection, listened or attached, arrives as a socket we hold, so closing can destroy it.
    const sockets = new Set<Socket>();
    const connectAllowed = options.limits?.connectRate
      ? rateLimiter(options.limits.connectRate)
      : () => true;
    /** A refused socket is said in the log, at most a few times a minute for one address. */
    const refusalLogged = rateLimiter({ burst: 3, perSecond: 1 / 60 });
    const serveSocket = (socket: Socket, attachOptions: AttachOptions = {}) => {
      const extraTrust = new Set(attachOptions.trustedRelayKeys ?? []);
      const address = normalizeAddress(socket.remoteAddress);
      const bucket = addressBucket(address);
      const counts = countsFor(bucket);
      const refusal = !accepting
        ? undefined
        : sockets.size >= limits.connections
          ? `the server holds its most connections (${limits.connections})`
          : counts.connections >= limits.connectionsPerAddress
            ? `${bucket} has its most connections open (${limits.connectionsPerAddress})`
            : !connectAllowed(bucket, Date.now())
              ? `${bucket} connects too fast`
              : null;
      if (refusal !== null) {
        forget(bucket);
        if (refusal !== undefined && refusalLogged(bucket, Date.now()))
          void fork(Effect.logInfo(`ssh: refused a connection from ${address}: ${refusal}`));
        return void socket.destroy();
      }
      sockets.add(socket);
      counts.connections++;
      // Whoever hasn't logged in by now is only holding a socket open.
      const login = setTimeout(() => socket.destroy(), timeouts.loginMs);
      socket.once("close", () => {
        clearTimeout(login);
        sockets.delete(socket);
        counts.connections--;
        forget(bucket);
      });
      socket.setNoDelay(true);
      // One ssh2 server per socket, so the connection handler knows its socket, through public API only.
      const ssh = new ssh2.Server(
        {
          hostKeys: [hostKey.pem],
          algorithms: { kex: KEX },
          keepaliveInterval: timeouts.keepaliveMs,
          keepaliveCountMax: timeouts.keepaliveCount,
        },
        (client) =>
          onConnection(client, {
            socket,
            address,
            bucket,
            extraTrust,
            admitRelay: attachOptions.admitRelay,
            persistent: attachOptions.persistent === true,
            authenticated: () => clearTimeout(login),
          }),
      );
      ssh.on("error", (e: Error) => {
        void fork(Effect.logWarning(`ssh server: ${printable(e.message)}`));
      });
      // @types/ssh2 sees @types/node 18's Socket, Bun's types see node 26's: the same object.
      ssh.injectSocket(socket as Parameters<ssh2.Server["injectSocket"]>[0]);
    };
    const listener = createServer((socket) => serveSocket(socket));
    // Two @types/node versions in one program leave net.Server without its EventEmitter methods.
    const listenerEvents = listener as unknown as EventEmitter;

    const port = yield* Effect.acquireRelease(
      Effect.callback<number, SshError>((resume) => {
        const onError = (e: Error) =>
          resume(Effect.fail(new SshError({ message: `listen: ${e.message}` })));
        listenerEvents.once("error", onError);
        listener.listen(options.port, options.host, () => {
          listenerEvents.removeListener("error", onError);
          listenerEvents.on("error", (e: Error) => {
            void fork(Effect.logWarning(`ssh listener: ${e.message}`));
          });
          const address = listener.address();
          resume(
            Effect.succeed(typeof address === "object" && address ? address.port : options.port),
          );
        });
      }),
      () =>
        Effect.promise(async () => {
          accepting = false;
          for (const client of connections) {
            try {
              client.end();
            } catch {
              // Already gone.
            }
          }
          // Give the disconnect a moment to reach clients, then cut whatever is left.
          const closing = [...sockets].map(
            (socket) => new Promise<void>((resolve) => socket.once("close", () => resolve())),
          );
          await Promise.race([Promise.all(closing), Bun.sleep(250)]);
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((resolve) => listener.close(() => resolve()));
        }),
    );
    // Runs before the listener closes: stop taking sessions, then end the live ones.
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        accepting = false;
        return FiberSet.clear(sessions);
      }),
    );

    const attach = (socket: Socket, attachOptions?: AttachOptions) =>
      serveSocket(socket, attachOptions);

    return { port, hostKeyFingerprint: hostKey.fingerprint, attach } satisfies SshServer;
  });
