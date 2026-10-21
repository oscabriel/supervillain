// `supervillain relay`: players SSH in on one port, GMs' hosts dial in on another, and the relay
// carries each player's session as a channel on their room's GM link. It renders nothing and keeps
// nothing but rooms.json and its two keys. See protocol.ts for the link and ASSESSMENT §6 for why.
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import {
  addressBucket,
  type ClientLink,
  type ClientSession,
  connectClient,
  isRelayableActor,
  type Limits,
  loadHostKey,
  normalizeAddress,
  type Rate,
  type RawSession,
  rateLimiter,
  type SshError,
  serve,
  TERMINAL_RESET,
  type Timeouts,
} from "@supervillain/ssh";
import { Clock, Context, Effect, FiberSet, Layer, Schema, type Scope, Semaphore } from "effect";
import {
  closedRoomMessage,
  errLine,
  isRoomName,
  LINE_TIMEOUT_MS,
  OK_LINE,
  parseHello,
  RELAY_USERNAME,
  RELAYED_ACTOR_ENV,
  readLine,
  TABLE_CLOSED_MESSAGE,
} from "./protocol.ts";
import {
  checkRelayDir,
  type ClaimPolicy,
  claimRoom,
  judgeClaim,
  readRooms,
  type RoomsError,
  touchRoom,
} from "./rooms.ts";

export class RelayError extends Schema.TaggedError<RelayError>()("RelayError", {
  message: Schema.String,
}) {}

/**
 * Caps on the GM side: links are few and long-lived, so a flood of them is someone else. Per
 * address means per IPv4 address, or per IPv6 /64.
 */
export interface GmLimits {
  /** GMs linked at once. Default 256. */
  readonly links?: number;
  /** GM sockets still saying hello or logging in, so these can't crowd out real links. Default 64. */
  readonly pendingLinks?: number;
  /** Open GM sockets from one address, linked or not. Default 8. */
  readonly linksPerAddress?: number;
  /** How fast one address may dial in. Default a burst of 10, then one every 6 s. */
  readonly linkRate?: Rate;
  /**
   * Rooms rooms.json may hold. A claim past it drops the stalest claim with no GM linked now, or
   * is refused if every claim has one. Default 1024.
   */
  readonly maxRooms?: number;
  /** A claim no GM has linked for this many days lapses, and another key may claim it. Default 30. */
  readonly claimDays?: number;
  /**
   * How fast one address (an IPv4 address or IPv6 /64) may claim rooms nobody holds; GMs relinking
   * rooms they hold don't count. Default 3, then one an hour.
   */
  readonly claimRate?: Rate;
  /** How fast one IPv6 /48 may claim rooms, all its /64s together. Default 10, then 4 an hour. */
  readonly siteClaimRate?: Rate;
  /** How long a GM has to say its hello. Default 10 s. */
  readonly lineTimeoutMs?: number;
  /** How long the SSH handshake on a link may take. Default 20 s. */
  readonly readyTimeoutMs?: number;
  /** How often a quiet link is pinged; after `keepaliveCount` unanswered pings it is dropped. */
  readonly keepaliveMs?: number;
  readonly keepaliveCount?: number;
}

export interface RelayOptions {
  /** Holds host_key (players see it), relay_key (GMs pin it) and rooms.json. */
  readonly dir: string;
  readonly playerPort: number;
  readonly gmPort: number;
  readonly bind: string;
  /** The players' side, as packages/ssh takes them. The relay sees players' real addresses. */
  readonly limits?: Limits;
  readonly timeouts?: Timeouts;
  /** How fast one address may start sessions, each a channel on a GM's link. */
  readonly sessionRate?: Rate;
  /**
   * Sessions one room carries at once. Default 32: under a host's own cap on a relay's sessions,
   * so players who come from many addresses still can't take every seat a host has.
   */
  readonly sessionsPerRoom?: number;
  readonly gm?: GmLimits;
}

export interface RelayInfo {
  readonly playerPort: number;
  readonly gmPort: number;
  /** The key players see for the relay. */
  readonly hostKeyFingerprint: string;
  /** The key the relay logs in to GMs' hosts with: what a GM pins with `--relay-key`. */
  readonly relayKeyFingerprint: string;
  /** Rooms with a GM linked now. */
  readonly linkedRooms: () => ReadonlyArray<string>;
}

/** A relay costs bytes, not CPU, so it holds far more than a table does; per address stays tight. */
const PLAYER_LIMITS: Limits = {
  connections: 1024,
  sessions: 1024,
  connectionsPerAddress: 8,
  sessionsPerAddress: 8,
  connectRate: { burst: 20, perSecond: 1 },
};
const SESSION_RATE: Rate = { burst: 20, perSecond: 1 };
const SESSIONS_PER_ROOM = 32;
const GM_DEFAULTS = {
  links: 256,
  pendingLinks: 64,
  linksPerAddress: 8,
  linkRate: { burst: 10, perSecond: 1 / 6 },
  maxRooms: 1024,
  claimDays: 30,
  claimRate: { burst: 3, perSecond: 1 / 3600 },
  siteClaimRate: { burst: 10, perSecond: 4 / 3600 },
  lineTimeoutMs: LINE_TIMEOUT_MS,
  readyTimeoutMs: 20_000,
  keepaliveMs: 15_000,
  keepaliveCount: 3,
};
/** How long a GM's host has to open a player's channel before the player is turned away. */
const SEAT_TIMEOUT = "10 seconds";
const SHUTDOWN_NOTICE = "The relay is shutting down.";
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What a player hears for a room no GM has ever linked. A name that can't be a room isn't echoed. */
const unknownRoomMessage = (room: string): string =>
  isRoomName(room)
    ? `There's no table called ${room} here.`
    : "There's no table by that name here.";

/** What a player hears for a room that carries all the sessions it may. */
const fullRoomMessage = (room: string): string => `The table ${room} is full right now.`;

/**
 * How fast an address may claim rooms: by `perAddress` for its IPv4 address or IPv6 /64, and for
 * IPv6 by `perSite` for its /48 too, so a site with many /64s can't claim a room from each. Returns
 * the bucket over its rate, or undefined when the claim may go ahead (and is counted).
 */
export const claimLimiter = (perAddress: Rate, perSite: Rate) => {
  const byAddress = rateLimiter(perAddress);
  const bySite = rateLimiter(perSite);
  return (address: string, now: number): string | undefined => {
    const bucket = addressBucket(address);
    if (!byAddress(bucket, now)) return bucket;
    const site = addressBucket(address, 48);
    if (site !== bucket && !bySite(site, now)) return site;
    return undefined;
  };
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** One GM's live link: the relay is the SSH client on it. */
interface GmLink {
  readonly room: string;
  readonly client: ClientLink;
  alive: boolean;
  /** Players' sessions on it now. */
  sessions: number;
}

const listen = (server: Server, port: number, host: string) =>
  Effect.callback<number, RelayError>((resume) => {
    // Two @types/node versions in one program leave net.Server without its EventEmitter methods.
    const events = server as unknown as NodeJS.EventEmitter;
    const onError = (e: Error) =>
      resume(Effect.fail(new RelayError({ message: `listen on ${host}:${port}: ${e.message}` })));
    events.once("error", onError);
    server.listen(port, host, () => {
      events.removeListener("error", onError);
      const address = server.address();
      resume(Effect.succeed(typeof address === "object" && address ? address.port : port));
    });
  });

const make = (
  options: RelayOptions,
): Effect.Effect<RelayInfo, RelayError | RoomsError | SshError, Scope.Scope> =>
  Effect.gen(function* () {
    const roomsFile = join(options.dir, "rooms.json");
    const gmLimits = { ...GM_DEFAULTS, ...options.gm };
    const sessionsPerRoom = options.sessionsPerRoom ?? SESSIONS_PER_ROOM;
    // Whoever can write to the folder can swap rooms.json, and take every room.
    yield* checkRelayDir(options.dir);
    // A damaged registry stops the relay here, before it could hand a claimed room to anyone.
    yield* readRooms(roomsFile);
    const relayKey = yield* Effect.tryPromise({
      try: () => loadHostKey(join(options.dir, "relay_key")),
      catch: (e) => new RelayError({ message: `relay key: ${messageOf(e)}` }),
    });
    // Links and log lines from socket callbacks run here, with this fiber's services (the logger).
    const fibers = yield* FiberSet.make();
    const fork = yield* FiberSet.runtime(fibers)<never>();
    const run = yield* FiberSet.runtimePromise(fibers)<never>();
    // Socket callbacks read the time from the same clock the Effect code does.
    const clock = yield* Clock.Clock;
    const claims = yield* Semaphore.make(1);
    const claimOver = claimLimiter(gmLimits.claimRate, gmLimits.siteClaimRate);
    /** The claim rules now: rooms with a GM linked keep their claims however old. */
    const claimPolicy = (): ClaimPolicy => ({
      maxRooms: gmLimits.maxRooms,
      expireMs: gmLimits.claimDays * DAY_MS,
      linked: new Set([...links.values()].filter((l) => l.alive).map((l) => l.room)),
    });
    const fullRooms = (room: string) =>
      `room ${room}: refused: the relay holds its most rooms (${gmLimits.maxRooms}), each with a GM linked now`;
    const links = new Map<string, GmLink>();
    /** GM sockets that haven't linked yet: saying hello, or logging in. */
    const pending = new Set<Socket>();
    let accepting = true;

    // ---- The GM side: a hello, an answer, then SSH with the GM as the server and us the client.

    /** One link, from its hello's answer until it closes. Closing its scope closes the socket. */
    const runLink = (socket: Socket, address: string, room: string) =>
      Effect.gen(function* () {
        /** Whether one more GM may link: a room already linked is only relinked. */
        const linkFull = () => !links.has(room) && links.size >= gmLimits.links;
        const fullRefusal = `room ${room}: refused: the relay has its most GMs linked (${gmLimits.links})`;
        let refusal: string | undefined;
        const client = yield* connectClient({
          socket,
          username: RELAY_USERNAME,
          privateKey: relayKey.pem,
          readyTimeoutMs: gmLimits.readyTimeoutMs,
          keepaliveMs: gmLimits.keepaliveMs,
          keepaliveCount: gmLimits.keepaliveCount,
          // A claimed room only takes the host key that claimed it. Read fresh, so a `forget`
          // takes effect on a running relay.
          verifyHostKey: async (offered) => {
            const verdict = await run(
              Effect.gen(function* () {
                const rooms = yield* readRooms(roomsFile);
                const now = yield* Clock.currentTimeMillis;
                return judgeClaim(rooms, room, offered, now, claimPolicy());
              }).pipe(Effect.result),
            );
            if (verdict._tag === "Failure") {
              refusal = `room ${room}: can't read the room registry: ${verdict.failure.message}`;
              return false;
            }
            if (linkFull()) {
              refusal = fullRefusal;
              return false;
            }
            const { success } = verdict;
            if (success.kind === "full") refusal = fullRooms(room);
            else if (success.kind === "held")
              refusal = `room ${room}: refused a GM with host key ${offered} from ${address}; ${success.holder} holds it (supervillain relay forget ${room} releases it)`;
            return refusal === undefined;
          },
        }).pipe(
          Effect.tapError((e) =>
            refusal !== undefined
              ? Effect.logWarning(refusal)
              : e.message.includes("refused this client's key")
                ? Effect.logWarning(
                    `room ${room}: the GM's host at ${address} refused this relay's key ${relayKey.fingerprint}; the GM pins it with --relay-key or in its relay_known`,
                  )
                : Effect.logInfo(`room ${room}: GM link from ${address} failed: ${e.message}`),
          ),
        );
        // The host key is proven now. Claims are serialized, so two first links can't both win,
        // and a link that can't be kept (the relay stopping, or at its most links) claims nothing.
        const proven = client.hostKeyFingerprint;
        const claim = yield* claims.withPermits(1)(
          Effect.gen(function* () {
            if (!accepting || client.closed()) return { gone: true } as const;
            if (linkFull()) return { linkFull: true } as const;
            return yield* claimRoom(roomsFile, room, proven, claimPolicy());
          }),
        );
        if ("gone" in claim) return;
        if ("linkFull" in claim) return yield* Effect.logWarning(fullRefusal);
        if ("full" in claim) return yield* Effect.logWarning(fullRooms(room));
        const { holder, claimed, dropped } = claim;
        for (const old of dropped)
          yield* Effect.logInfo(
            `room ${old.room}: dropped the claim of GM host key ${old.key}, last linked ${new Date(old.linked).toISOString()}${old.room === room ? "" : `, to make room for ${room}`}`,
          );
        if (holder !== proven)
          return yield* Effect.logWarning(
            `room ${room}: refused a GM with host key ${proven} from ${address}; ${holder} holds it (supervillain relay forget ${room} releases it)`,
          );
        if (claimed) yield* Effect.logInfo(`room ${room}: claimed by GM host key ${proven}`);

        const link: GmLink = { room, client, alive: true, sessions: 0 };
        const old = links.get(room);
        links.set(room, link);
        pending.delete(socket);
        yield* Effect.addFinalizer(() =>
          Effect.suspend(() => {
            link.alive = false;
            // Its claim's time is when a GM was last linked: now, as this link ends.
            const renew = touchRoom(roomsFile, room, proven).pipe(
              Effect.catchTag("RoomsError", (e) =>
                Effect.logError(`room ${room}: can't write the room registry: ${e.message}`),
              ),
            );
            if (links.get(room) !== link) return renew;
            links.delete(room);
            return Effect.andThen(renew, Effect.logInfo(`room ${room}: GM link closed`));
          }),
        );
        if (old) {
          // The same host key, so the same GM: its host redials only when it thinks the old link
          // is dead, and its players shouldn't wait out our keepalives to find out it is.
          old.alive = false;
          old.client.close();
          yield* Effect.logInfo(`room ${room}: GM relinked from ${address}; dropped the old link`);
        } else {
          yield* Effect.logInfo(`room ${room}: GM linked from ${address}`);
        }
        yield* Effect.callback<void>((resume) => client.onClose(() => resume(Effect.void)));
      }).pipe(
        Effect.scoped,
        Effect.catchTag("RoomsError", (e) =>
          Effect.logError(`room ${room}: can't read or write the room registry: ${e.message}`),
        ),
        Effect.catchTag("SshError", () => Effect.void),
        Effect.ensuring(Effect.sync(() => socket.destroy())),
      );

    /**
     * Whether a hello for `room` from `address` may go on to log in, judged before SSH so the GM's
     * host hears why on the answer line: for a reason that is about the relay or the address, not
     * the host key, which only the login proves. Claiming a room nobody holds costs a GM nothing,
     * so one address claims only so fast; a GM relinking a room it holds claims nothing. Returns
     * the journal's line and the answer's reason, or undefined to go on.
     */
    const judgeHello = (room: string, address: string) =>
      claims.withPermits(1)(
        Effect.gen(function* () {
          if (!links.has(room) && links.size >= gmLimits.links)
            return {
              journal: `room ${room}: refused: the relay has its most GMs linked (${gmLimits.links})`,
              reason: "the relay has its most GMs linked; try again later",
            };
          const now = yield* Clock.currentTimeMillis;
          // Judged for no key, "held" means some key holds the room: only its GM will log in.
          const verdict = judgeClaim(yield* readRooms(roomsFile), room, "", now, claimPolicy());
          if (verdict.kind === "full")
            return {
              journal: fullRooms(room),
              reason: "the relay holds its most rooms, each with a GM linked now",
            };
          const over = verdict.kind === "free" ? claimOver(address, now) : undefined;
          if (over !== undefined)
            return {
              journal: `room ${room}: refused: ${over} claims rooms too fast`,
              reason: "this address claims rooms too fast; try again later",
            };
          return undefined;
        }),
      );

    const gmSockets = new Set<Socket>();
    const linksByAddress = new Map<string, number>();
    const linkAllowed = rateLimiter(gmLimits.linkRate);

    const onGmSocket = (socket: Socket) => {
      const address = normalizeAddress(socket.remoteAddress);
      const bucket = addressBucket(address);
      socket.on("error", () => socket.destroy());
      const fromHere = linksByAddress.get(bucket) ?? 0;
      if (
        !accepting ||
        pending.size >= gmLimits.pendingLinks ||
        fromHere >= gmLimits.linksPerAddress ||
        !linkAllowed(bucket, clock.currentTimeMillisUnsafe())
      ) {
        return void socket.destroy();
      }
      gmSockets.add(socket);
      pending.add(socket);
      linksByAddress.set(bucket, fromHere + 1);
      socket.once("close", () => {
        gmSockets.delete(socket);
        pending.delete(socket);
        const left = (linksByAddress.get(bucket) ?? 1) - 1;
        if (left <= 0) linksByAddress.delete(bucket);
        else linksByAddress.set(bucket, left);
      });
      socket.setNoDelay(true);
      /** Answers ERR and closes; a peer that won't finish closing is cut. */
      const refuse = (line: string) => {
        socket.end(line);
        setTimeout(() => socket.destroy(), 1000).unref();
      };
      readLine(socket, gmLimits.lineTimeoutMs).then(
        (line) => {
          const hello = parseHello(line);
          if (!hello.ok) {
            void fork(Effect.logInfo(`GM link from ${address} refused: ${hello.reason}`));
            return refuse(errLine(hello.reason));
          }
          if (!accepting) return refuse(errLine("the relay is shutting down"));
          void fork(
            judgeHello(hello.room, address).pipe(
              Effect.flatMap((refused) => {
                if (refused !== undefined)
                  return Effect.andThen(
                    Effect.logWarning(refused.journal),
                    Effect.sync(() => refuse(errLine(refused.reason))),
                  );
                if (socket.destroyed) return Effect.void;
                socket.write(OK_LINE);
                return runLink(socket, address, hello.room);
              }),
              Effect.catchTag("RoomsError", (e) =>
                Effect.andThen(
                  Effect.logError(`room ${hello.room}: can't read the room registry: ${e.message}`),
                  Effect.sync(() => refuse(errLine("the relay can't read its room registry"))),
                ),
              ),
            ),
          );
        },
        (e: unknown) => {
          void fork(
            Effect.logDebug(`GM link from ${address} gone before its hello: ${messageOf(e)}`),
          );
          socket.destroy();
        },
      );
    };

    const gmServer = createServer(onGmSocket);
    const gmPort = yield* Effect.acquireRelease(
      listen(gmServer, options.gmPort, options.bind),
      () =>
        Effect.promise(async () => {
          accepting = false;
          for (const link of links.values()) {
            link.alive = false;
            link.client.close();
          }
          await Promise.race([
            Promise.all(
              [...gmSockets].map(
                (socket) => new Promise<void>((resolve) => socket.once("close", () => resolve())),
              ),
            ),
            Bun.sleep(300),
          ]);
          for (const socket of gmSockets) socket.destroy();
          await new Promise<void>((resolve) => gmServer.close(() => resolve()));
        }),
    );

    // ---- The players' side: our SSH server, taking each session as bytes to forward.

    const sessionAllowed = rateLimiter(options.sessionRate ?? SESSION_RATE);

    /** Opens the player's channel on the link; one that comes too late is closed. */
    const seat = (link: GmLink, session: RawSession, env: Record<string, string>) =>
      Effect.acquireRelease(
        Effect.callback<ClientSession, Error>((resume) => {
          let cancelled = false;
          const { info } = session;
          const pty = session.pty ? { term: info.term, cols: info.cols, rows: info.rows } : false;
          link.client.open(session.request, env, pty).then(
            (opened) => (cancelled ? opened.close() : resume(Effect.succeed(opened))),
            (e: unknown) => resume(Effect.fail(e instanceof Error ? e : new Error(String(e)))),
          );
          return Effect.sync(() => {
            cancelled = true;
          });
        }).pipe(Effect.timeout(SEAT_TIMEOUT)),
        (opened) => Effect.sync(() => opened.close()),
      );

    const bridge = (session: RawSession) =>
      Effect.gen(function* () {
        const { info } = session;
        // Room names are lowercase; `ssh Den@relay` means den.
        const room = info.user.toLowerCase();
        const terminal = session.request.kind === "shell" && session.pty;
        /** A line for the player: on their terminal in a shell, else on stderr. */
        const say = (text: string) => {
          if (terminal) session.stream.write(`${text}\r\n`);
          else session.stderr.write(`${text}\n`);
        };
        if (!sessionAllowed(addressBucket(info.remoteAddress), yield* Clock.currentTimeMillis)) {
          say("Too many sessions from your address; wait a moment.");
          return session.exit(1);
        }
        const link = links.get(room);
        if (!link?.alive) {
          const known =
            isRoomName(room) &&
            (yield* readRooms(roomsFile).pipe(
              Effect.map((rooms) => rooms[room] !== undefined),
              Effect.catchTag("RoomsError", (e) =>
                Effect.as(Effect.logError(`can't read the room registry: ${e.message}`), true),
              ),
            ));
          say(known ? closedRoomMessage(room) : unknownRoomMessage(room));
          return session.exit(1);
        }
        const actor = info.identity.actor;
        if (!isRelayableActor(actor)) {
          say("The relay can't seat you.");
          return session.exit(1);
        }
        if (link.sessions >= sessionsPerRoom) {
          yield* Effect.logInfo(
            `room ${room}: full (${sessionsPerRoom} sessions); turned ${actor} away`,
          );
          say(fullRoomMessage(room));
          return session.exit(1);
        }
        link.sessions++;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            link.sessions--;
          }),
        );
        // The player's name first; then only the terminal env our server let through.
        const env: Record<string, string> = { [RELAYED_ACTOR_ENV]: actor };
        for (const [key, value] of Object.entries(info.env))
          if (key !== RELAYED_ACTOR_ENV) env[key] = value;

        const channel = yield* seat(link, session, env).pipe(
          Effect.map((opened): ClientSession | undefined => opened),
          Effect.catch((e) =>
            Effect.as(
              Effect.logInfo(`room ${room}: couldn't seat ${actor}: ${messageOf(e)}`),
              undefined,
            ),
          ),
        );
        if (channel === undefined) {
          say(link.alive ? "The table couldn't seat you right now." : TABLE_CLOSED_MESSAGE);
          return session.exit(1);
        }
        yield* Effect.logDebug(`room ${room}: seated ${actor} from ${info.remoteAddress}`);

        session.onResize((cols, rows) => channel.resize(cols, rows));
        // Player to GM: bytes, then EOF. GM to player: bytes; its EOF rides with its exit and
        // close, since ssh2 can't send an exit status after EOF.
        session.stream.pipe(channel.stream);
        channel.stream.pipe(session.stream, { end: false });
        channel.stderr.pipe(session.stderr, { end: false });
        const ending = yield* Effect.promise(() => channel.ended);
        session.stream.unpipe(channel.stream);
        if (ending !== undefined) return session.exit(ending);
        // A GM that closes a channel says how it ended; one that didn't, went.
        if (link.alive && !link.client.closed()) return session.exit(1);
        if (terminal) session.stream.write(`${TERMINAL_RESET}\r\n${TABLE_CLOSED_MESSAGE}\r\n`);
        else session.stderr.write(`${TABLE_CLOSED_MESSAGE}\n`);
        return session.exit(1);
      });

    const players = yield* serve({
      hostKeyPath: join(options.dir, "host_key"),
      port: options.playerPort,
      host: options.bind,
      allowGuests: true,
      limits: { ...PLAYER_LIMITS, ...options.limits },
      ...(options.timeouts ? { timeouts: options.timeouts } : {}),
      shutdownNotice: SHUTDOWN_NOTICE,
      onRaw: bridge,
    });

    return {
      playerPort: players.port,
      gmPort,
      hostKeyFingerprint: players.hostKeyFingerprint,
      relayKeyFingerprint: relayKey.fingerprint,
      linkedRooms: () => [...links.values()].filter((l) => l.alive).map((l) => l.room),
    } satisfies RelayInfo;
  });

/** The relay, for the life of its layer: both listeners, every link and every bridged session. */
export class Relay extends Context.Service<Relay, RelayInfo>()("supervillain/relay/Relay") {
  static readonly make = make;
  static readonly layer = (
    options: RelayOptions,
  ): Layer.Layer<Relay, RelayError | RoomsError | SshError> => Layer.effect(Relay, make(options));
}
