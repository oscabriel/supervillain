import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, type Socket } from "node:net";
import { CliRenderEvents, type CliRenderer, createCliRenderer, NativeSession } from "@opentui/core";
import { Cause, Deferred, Effect, Exit, FiberSet, type Scope } from "effect";
import ssh2, { type AuthContext, type Connection, type ServerChannel } from "ssh2";
import { fingerprintOf, loadHostKey, parseKey } from "./keys.ts";
import { isRelayableActor } from "./relay.ts";
import { type Pty, rendererStreams, sanitizePty, sanitizeSize, takeEnv } from "./terminal.ts";
import {
  type AttachOptions,
  type Identity,
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
/**
 * Elliptic-curve key exchange only. ssh2 also offers finite-field groups up to 8192 bits, and one
 * such handshake costs the host's only thread seconds of CPU before anyone has logged in.
 */
const KEX: Array<ssh2.KexAlgorithm> = [
  "curve25519-sha256",
  "curve25519-sha256@libssh.org",
  "ecdh-sha2-nistp256",
  "ecdh-sha2-nistp384",
  "ecdh-sha2-nistp521",
];
/** How long a closing session waits for the renderer to restore the client's terminal. */
const RESTORE_TIMEOUT_MS = 2000;
const NO_PTY_MESSAGE = "This needs a terminal: connect with ssh -t.";

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Text a peer chose (a disconnect reason, say), quoted so no control byte reaches a log. */
const printable = (text: string) => JSON.stringify(text);

/** Line ends for a client terminal in raw mode, which a pty request puts it in. */
const crlf = (text: string) => text.replace(/\r?\n/g, "\r\n");

const guestId = () => randomBytes(12).toString("base64url");

const normalizeAddress = (address: string | undefined) =>
  !address ? "unknown" : address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;

/** One accepted socket, as the connection on it sees it. */
interface Link {
  readonly socket: Socket;
  readonly address: string;
  /** Relay keys believed on this socket only. */
  readonly extraTrust: ReadonlySet<string>;
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

/** Ends a channel after its last write, with an exit status; closes it outright if the peer stalls. */
const endChannel = (channel: ServerChannel, status: number) => {
  try {
    channel.exit(status);
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
      const counts = countsFor(remoteAddress);
      let identity: Identity | undefined;
      let user = "";
      let relay = false;
      let connectionSessions = 0;
      const live = new Set<() => void>();

      client.on("authentication", (ctx) => {
        if (ctx.method === "publickey") {
          // The first pass only asks whether the key is acceptable; any key is.
          if (!ctx.signature) return ctx.accept();
          const key = verifiedKey(ctx);
          if (!key) return ctx.reject(authMethods);
          identity = {
            kind: "key",
            actor: `key:${key.fingerprint}`,
            fingerprint: key.fingerprint,
            algorithm: key.algorithm,
          };
          relay = trusted.has(key.fingerprint) || link.extraTrust.has(key.fingerprint);
          user = ctx.username;
          return ctx.accept();
        }
        if (ctx.method === "keyboard-interactive" && options.allowGuests) {
          identity = { kind: "guest", actor: `guest:${guestId()}` };
          user = ctx.username;
          return ctx.accept();
        }
        return ctx.reject(authMethods);
      });

      client.once("ready", link.authenticated);

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
        // A session must ask for a shell or exec soon; one that idles only holds a place.
        const startDeadline = setTimeout(() => link.socket.destroy(), timeouts.sessionStartMs);
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          clearTimeout(startDeadline);
          live.delete(release);
          connectionSessions--;
          openSessions--;
          counts.sessions--;
          forget(remoteAddress);
        };
        live.add(release);

        const session = acceptSession();
        session.once("close", release);
        let pty: Pty = sanitizePty(undefined);
        let hasPty = false;
        const env: Record<string, string> = {};
        let relayedActor: string | undefined;
        let started = false;
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

        session.on("shell", (accept, reject) => {
          if (!mayStart()) return reject?.();
          started = true;
          clearTimeout(startDeadline);
          const channel = accept();
          if (!hasPty) {
            // A renderer would pour escape codes into a pipe and never notice the input ending.
            channel.stderr.write(`${options.noPtyMessage ?? NO_PTY_MESSAGE}\n`);
            return endChannel(channel, 1);
          }
          const sessionInfo = info();
          runSession(
            sessionInfo.identity.actor,
            shellSession(channel, sessionInfo, (onResize) => (resize = onResize)),
          );
        });
        session.on("exec", (accept, reject, { command }) => {
          const onExec = options.onExec;
          if (!mayStart() || !onExec) return reject?.();
          started = true;
          clearTimeout(startDeadline);
          const channel = accept();
          const sessionInfo = info();
          runSession(
            sessionInfo.identity.actor,
            execSession(channel, sessionInfo, command, onExec, hasPty ? crlf : (text) => text),
          );
        });
      });

      client.on("close", () => {
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
          options.onShell({ info, renderer: live, close: end }),
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

    // Every connection, listened or attached, arrives as a socket we hold, so closing can destroy it.
    const sockets = new Set<Socket>();
    const serveSocket = (socket: Socket, extraTrust: ReadonlySet<string>) => {
      const address = normalizeAddress(socket.remoteAddress);
      const counts = countsFor(address);
      if (
        !accepting ||
        sockets.size >= limits.connections ||
        counts.connections >= limits.connectionsPerAddress
      ) {
        forget(address);
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
        forget(address);
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
            extraTrust,
            authenticated: () => clearTimeout(login),
          }),
      );
      ssh.on("error", (e: Error) => {
        void fork(Effect.logWarning(`ssh server: ${printable(e.message)}`));
      });
      // @types/ssh2 sees @types/node 18's Socket, Bun's types see node 26's: the same object.
      ssh.injectSocket(socket as Parameters<ssh2.Server["injectSocket"]>[0]);
    };
    const noExtraTrust: ReadonlySet<string> = new Set();
    const listener = createServer((socket) => serveSocket(socket, noExtraTrust));
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
      serveSocket(socket, new Set(attachOptions?.trustedRelayKeys ?? []));

    return { port, hostKeyFingerprint: hostKey.fingerprint, attach } satisfies SshServer;
  });
