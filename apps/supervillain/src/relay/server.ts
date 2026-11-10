// `supervillain relay`: players SSH in on one port, GMs' hosts dial in on another, and the relay
// carries each player's session as a channel on their room's GM link. It renders nothing (its
// lobby is one frame of text, lobby.ts) and keeps nothing but rooms.json and its two keys. See
// protocol.ts for the link and ASSESSMENT §6 for why.
import { randomBytes } from "node:crypto";
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
  tokenBuckets,
} from "@supervillain/ssh";
import { Clock, Context, Effect, FiberSet, Layer, Schema, type Scope, Semaphore } from "effect";
import {
  closedRoomMessage,
  errLine,
  isReservedRoom,
  isRoomName,
  JOIN_HINT,
  KNOWS_NONCE_BYTES,
  KNOWS_SUBSYSTEM,
  knowsQueryLine,
  LINE_TIMEOUT_MS,
  MAX_KNOWS_ANSWER_BYTES,
  OK_LINE,
  parseHello,
  parseKnowsAnswer,
  RELAY_USERNAME,
  RELAYED_ACTOR_ENV,
  RELAYED_CLIENT_ENV,
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
import { lobbyFrame, type LobbyTable } from "./lobby.ts";

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
  /**
   * A claim no GM has linked for this many days lapses, and another key may claim it. Default 180,
   * so a group meeting monthly, or taking a season off, keeps its room.
   */
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
  /**
   * Sessions one room carries at once. Default 32: under a host's own cap on a relay's sessions,
   * so players who come from many addresses still can't take every seat a host has.
   */
  readonly sessionsPerRoom?: number;
  readonly gm?: GmLimits;
  readonly lobby?: {
    /** How long the lobby waits for linked hosts to say whether they know a player's key. Default 2 s. */
    readonly deadlineMs?: number;
    /** How long a player may sit at the lobby's prompt without typing. Default 60 s. */
    readonly idleMs?: number;
  };
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
const SESSIONS_PER_ROOM = 32;
const GM_DEFAULTS = {
  links: 256,
  pendingLinks: 64,
  linksPerAddress: 8,
  linkRate: { burst: 10, perSecond: 1 / 6 },
  maxRooms: 1024,
  claimDays: 180,
  claimRate: { burst: 3, perSecond: 1 / 3600 },
  siteClaimRate: { burst: 10, perSecond: 4 / 3600 },
  lineTimeoutMs: LINE_TIMEOUT_MS,
  readyTimeoutMs: 20_000,
  keepaliveMs: 15_000,
  keepaliveCount: 3,
};
/** How long the lobby waits for hosts' answers, all of them together. */
const LOBBY_DEADLINE_MS = 2000;
/** Hosts the lobby asks at once for one player. */
const LOBBY_CONCURRENCY = 16;
/** Lobby questions one link carries at once; past it, that table counts as not knowing the key. */
const QUESTIONS_PER_LINK = 4;
const LOBBY_IDLE_MS = 60_000;
/** How long a GM's host has to open a player's channel before the player is turned away. */
const SEAT_TIMEOUT = "10 seconds";
const SHUTDOWN_NOTICE = "The relay is shutting down.";
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * What a player hears for a room no GM has ever linked: that there's no such table, and how to
 * join one, since the name may be a typo or the local username a bare `ssh` sent. A name that
 * can't be a room isn't echoed.
 */
const unknownRoomMessage = (room: string): string =>
  isRoomName(room) && !isReservedRoom(room)
    ? `There's no table called ${room} here.\n${JOIN_HINT}`
    : JOIN_HINT;

/** What a player hears for a room that carries all the sessions it may. */
const fullRoomMessage = (room: string): string => `The table ${room} is full right now.`;

/**
 * How fast an address may claim rooms: by `perAddress` for its IPv4 address or IPv6 /64, and for
 * IPv6 by `perSite` for its /48 too, so a site with many /64s can't claim a room from each. `over`
 * returns the bucket over its rate, or undefined when a claim may go ahead, and spends nothing:
 * only `spend`, once a claim is made, counts it. So a hello whose login then fails costs nothing.
 */
export const claimLimiter = (perAddress: Rate, perSite: Rate) => {
  const byAddress = tokenBuckets(perAddress);
  const bySite = tokenBuckets(perSite);
  const site = (address: string) => {
    const s = addressBucket(address, 48);
    return s === addressBucket(address) ? undefined : s;
  };
  return {
    over: (address: string, now: number): string | undefined => {
      const bucket = addressBucket(address);
      if (!byAddress.has(bucket, now)) return bucket;
      const s = site(address);
      if (s !== undefined && !bySite.has(s, now)) return s;
      return undefined;
    },
    spend: (address: string, now: number): void => {
      byAddress.take(addressBucket(address), now);
      const s = site(address);
      if (s !== undefined) bySite.take(s, now);
    },
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
  /** Whether its host may answer the lobby's question: until it refuses one, as older hosts do. */
  knows: boolean;
  /** Lobby questions on it now. */
  asking: number;
}

const tableLabel = (table: LobbyTable) => `${table.room} (${table.seated} seated)`;

/**
 * The lobby for a session without a terminal: the tables, and how to join one, since there's
 * no prompt to answer.
 */
export const lobbyText = (tables: ReadonlyArray<LobbyTable>): string =>
  [
    `Your table${tables.length === 1 ? "" : "s"} open now: ${tables.map(tableLabel).join(", ")}.`,
    `Join one with its name before the @, as you came here: ssh ${tables[0]!.room}@…`,
  ].join("\n");

type Picked = { readonly room: string } | "left" | "idle";

/** Clears the screen and homes the cursor: the lobby's frame, put away. */
const CLEAR = "\x1b[H\x1b[2J";

/**
 * The lobby on the player's raw terminal: draws it (`draw`, with what to show), then reads keys
 * until they pick a table. ↑ and ↓ move the pick, digits type a number, backspace takes one back,
 * Enter sits at the number typed or else at the pick; Ctrl-C, Ctrl-D or EOF leave; other escape
 * sequences are dropped. It draws once for all the keys that came together, so keys sent faster
 * than the player reads cost one frame, not one each. `redraw` is handed a function that draws it
 * again, for a resize. The stream is left paused, with whatever followed Enter put back, for the
 * table to read.
 */
const pickTable = (
  session: RawSession,
  rooms: ReadonlyArray<string>,
  idleMs: number,
  draw: (state: { picked: number; typed: string; said?: string }) => void,
  redraw: (again: (() => void) | undefined) => void,
) =>
  Effect.callback<Picked>((resume) => {
    const { stream } = session;
    let typed = "";
    let picked = 0;
    let said: string | undefined;
    const show = () => draw({ picked, typed, ...(said === undefined ? {} : { said }) });
    /** Inside an escape sequence: just after ESC, or in its body until a final byte. */
    let escape: "no" | "esc" | "body" = "no";
    /** The sequence so far after ESC: `[A` is ↑. */
    let sequence = "";
    /** Whether the last byte was a CR: an LF just after it is the same Enter. */
    let afterCr = false;
    let idle = setTimeout(() => finish("idle"), idleMs);
    const stop = () => {
      clearTimeout(idle);
      redraw(undefined);
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
    };
    const finish = (result: Picked, rest?: Buffer) => {
      stop();
      stream.pause();
      if (rest !== undefined && rest.length > 0) stream.unshift(rest);
      resume(Effect.succeed(result));
    };
    const move = (by: 1 | -1) => {
      picked = (picked + by + rooms.length) % rooms.length;
      typed = "";
      said = undefined;
    };
    const onData = (chunk: Buffer) => {
      clearTimeout(idle);
      idle = setTimeout(() => finish("idle"), idleMs);
      for (let i = 0; i < chunk.length; i++) {
        const byte = chunk[i]!;
        const lfOfCrLf = byte === 0x0a && afterCr;
        afterCr = byte === 0x0d;
        // Ctrl-C and Ctrl-D leave, even in the middle of an escape sequence.
        if (byte === 0x03 || byte === 0x04) return finish("left");
        if (escape === "esc") {
          // ESC [ and ESC O start a sequence; after a lone Esc, the next key counts as itself.
          if (byte === 0x5b || byte === 0x4f) {
            escape = "body";
            sequence = String.fromCharCode(byte);
            continue;
          }
          escape = "no";
        } else if (escape === "body") {
          sequence += String.fromCharCode(byte);
          if (byte >= 0x40 && byte <= 0x7e) {
            escape = "no";
            if (sequence === "[A" || sequence === "OA") move(-1);
            if (sequence === "[B" || sequence === "OB") move(1);
          }
          continue;
        }
        if (lfOfCrLf) continue;
        if (byte === 0x1b) escape = "esc";
        else if (byte === 0x7f || byte === 0x08) typed = typed.slice(0, -1);
        else if (byte === 0x0d || byte === 0x0a) {
          const n = typed === "" ? picked + 1 : Number(typed);
          if (Number.isInteger(n) && n >= 1 && n <= rooms.length) {
            // A terminal that sends CR LF for Enter: the LF was part of it.
            const next = byte === 0x0d && chunk[i + 1] === 0x0a ? i + 2 : i + 1;
            return finish({ room: rooms[n - 1]! }, chunk.subarray(next));
          }
          said = `There's no ${typed} on the list.`;
          typed = "";
        } else if (byte >= 0x30 && byte <= 0x39 && typed.length < 3) {
          typed += String.fromCharCode(byte);
          said = undefined;
          const n = Number(typed);
          if (n >= 1 && n <= rooms.length) picked = n - 1;
        }
      }
      show();
    };
    const onEnd = () => finish("left");
    show();
    redraw(show);
    stream.on("data", onData);
    stream.once("end", onEnd);
    return Effect.sync(stop);
  });

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
    const lobbyDeadlineMs = options.lobby?.deadlineMs ?? LOBBY_DEADLINE_MS;
    const lobbyIdleMs = options.lobby?.idleMs ?? LOBBY_IDLE_MS;
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
    const claimRate = claimLimiter(gmLimits.claimRate, gmLimits.siteClaimRate);
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
        // Only a claim made counts against the address's rate, checked again here in case others
        // claimed since its hello.
        const proven = client.hostKeyFingerprint;
        const claim = yield* claims.withPermits(1)(
          Effect.gen(function* () {
            if (!accepting || client.closed()) return { gone: true } as const;
            if (linkFull()) return { linkFull: true } as const;
            const now = yield* Clock.currentTimeMillis;
            const fresh =
              judgeClaim(yield* readRooms(roomsFile), room, proven, now, claimPolicy()).kind ===
              "free";
            const over = fresh ? claimRate.over(address, now) : undefined;
            if (over !== undefined) return { tooFast: over } as const;
            const made = yield* claimRoom(roomsFile, room, proven, claimPolicy());
            if ("claimed" in made && made.claimed) claimRate.spend(address, now);
            return made;
          }),
        );
        if ("gone" in claim) return;
        if ("linkFull" in claim) return yield* Effect.logWarning(fullRefusal);
        if ("tooFast" in claim)
          return yield* Effect.logWarning(
            `room ${room}: refused: ${claim.tooFast} claims rooms too fast`,
          );
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

        const link: GmLink = { room, client, alive: true, sessions: 0, knows: true, asking: 0 };
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
     * so one address claims only so fast; a GM relinking a room it holds claims nothing. The rate
     * is only looked at here: the claim made after the login spends it. Returns the journal's
     * line and the answer's reason, or undefined to go on.
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
          const over = verdict.kind === "free" ? claimRate.over(address, now) : undefined;
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

    /** Opens the player's channel on the link, at its terminal's size now; one that comes too late is closed. */
    const seat = (
      link: GmLink,
      session: RawSession,
      env: Record<string, string>,
      size: { readonly cols: number; readonly rows: number },
    ) =>
      Effect.acquireRelease(
        Effect.callback<ClientSession, Error>((resume) => {
          let cancelled = false;
          const pty = session.pty ? { term: session.info.term, ...size } : false;
          link.client.open(session.request, env, pty).then(
            (opened) => (cancelled ? opened.close() : resume(Effect.succeed(opened))),
            (e: unknown) => resume(Effect.fail(e instanceof Error ? e : new Error(String(e)))),
          );
          return Effect.sync(() => {
            cancelled = true;
          });
        }).pipe(Effect.timeout(SEAT_TIMEOUT)),
        (opened) => Effect.sync(() => opened.close()),
        // A player who leaves while a slow host opens the channel gives their place back then.
        { interruptible: true },
      );

    // ---- The lobby: a player with a key and no room is shown the open tables that know the key.

    /**
     * Asks one linked host whether it knows `actor`, on its link: yes with how many are seated, or
     * undefined for no. A host that refuses the question is an older build: it isn't asked again
     * on that link. A link already carrying its most questions isn't asked, and counts as no.
     * A question counts against its link until it's over and its channel's open has settled, so
     * opens a frozen host never answers, given up on at the deadline, still fill the link.
     */
    const ask = (link: GmLink, actor: string) =>
      Effect.gen(function* () {
        if (!link.alive || !link.knows || link.asking >= QUESTIONS_PER_LINK) return undefined;
        link.asking++;
        let held = 2;
        const done = () => {
          if (--held === 0) link.asking--;
        };
        yield* Effect.addFinalizer(() => Effect.sync(done));
        const opened = yield* Effect.acquireRelease(
          Effect.callback<ClientSession | "refused" | undefined>((resume) => {
            let cancelled = false;
            link.client.open({ kind: "subsystem", name: KNOWS_SUBSYSTEM }, {}, false).then(
              (channel) => {
                done();
                if (cancelled) channel.close();
                else resume(Effect.succeed(channel));
              },
              (e: unknown) => {
                done();
                resume(
                  Effect.succeed(
                    messageOf(e).startsWith("Unable to start subsystem") ? "refused" : undefined,
                  ),
                );
              },
            );
            return Effect.sync(() => {
              cancelled = true;
            });
          }),
          (channel) => Effect.sync(() => typeof channel === "object" && channel.close()),
          // The deadline must cut a host that never answers the open, not wait it out.
          { interruptible: true },
        );
        if (opened === "refused") {
          if (link.knows)
            yield* Effect.logInfo(`room ${link.room}: its host doesn't answer the lobby (older)`);
          link.knows = false;
          return undefined;
        }
        if (opened === undefined) return undefined;
        opened.stderr.resume();
        opened.stream.end(knowsQueryLine(actor, randomBytes(KNOWS_NONCE_BYTES)));
        const said = yield* Effect.callback<string>((resume) => {
          let text = "";
          opened.stream.on("data", (chunk: Buffer) => {
            text += chunk.toString("latin1");
            if (text.length > MAX_KNOWS_ANSWER_BYTES) opened.close();
          });
          void opened.ended.then(() => resume(Effect.succeed(text)));
        });
        const answer = parseKnowsAnswer(said);
        return answer.known ? { room: link.room, seated: answer.seated } : undefined;
      }).pipe(Effect.scoped);

    /**
     * The open tables that know `actor`, by room name: every linked host is asked, a few at a
     * time, each with its own nonce, and whoever hasn't answered by the deadline counts as no.
     */
    const tablesFor = (actor: string) =>
      Effect.gen(function* () {
        const asked = [...links.values()].filter((l) => l.alive);
        const found: Array<LobbyTable> = [];
        if (asked.length === 0) return found;
        yield* Effect.forEach(
          asked,
          (link) =>
            ask(link, actor).pipe(
              Effect.map((table) => void (table && found.push(table))),
              Effect.catchCause(() => Effect.void),
            ),
          { concurrency: LOBBY_CONCURRENCY, discard: true },
        ).pipe(Effect.timeoutOption(lobbyDeadlineMs));
        return found.sort((a, b) => (a.room < b.room ? -1 : 1));
      });

    // ---- The players' side: our SSH server, taking each session as bytes to forward.

    const bridge = (session: RawSession) =>
      Effect.gen(function* () {
        const { info } = session;
        // Room names are lowercase; `ssh Den@relay` means den.
        const asked = info.user.toLowerCase();
        const terminal = session.request.kind === "shell" && session.pty;
        /** A line for the player: on their terminal in a shell, else on stderr. */
        const say = (text: string) => {
          if (terminal) session.stream.write(`${text.replace(/\n/g, "\r\n")}\r\n`);
          else session.stderr.write(`${text}\n`);
        };
        // The terminal's size now, from the lobby on, and where its changes go once seated.
        let size = { cols: info.cols, rows: info.rows };
        let resize: ((cols: number, rows: number) => void) | undefined;
        session.onResize((cols, rows) => {
          size = { cols, rows };
          resize?.(cols, rows);
        });
        const actor = info.identity.actor;
        let room = asked;
        if (!links.get(room)?.alive) {
          const named = isRoomName(room) && !isReservedRoom(room);
          const claimed =
            named &&
            (yield* readRooms(roomsFile).pipe(
              Effect.map((rooms) => rooms[room] !== undefined),
              Effect.catchTag("RoomsError", (e) =>
                Effect.as(Effect.logError(`can't read the room registry: ${e.message}`), true),
              ),
            ));
          if (claimed) {
            say(closedRoomMessage(room));
            return session.exit(1);
          }
          // No such room: a player with a key may have tables that know it. A guest is nobody yet.
          const tables =
            info.identity.kind === "key" && isRelayableActor(actor) ? yield* tablesFor(actor) : [];
          yield* Effect.logDebug(
            `lobby: ${actor} from ${info.remoteAddress}: ${tables.length} open tables know the key`,
          );
          if (tables.length === 0) {
            say(unknownRoomMessage(room));
            return session.exit(1);
          }
          // The list is the answer: the name asked for is most likely the local username a bare
          // `ssh` sent, not a table anyone meant.
          if (!terminal) {
            say(lobbyText(tables));
            return session.exit(1);
          }
          const id = info.identity;
          if (id.kind !== "key") return session.exit(1);
          /** The frame on the player's screen: a key that changes nothing sends nothing. */
          let drawn = "";
          const picked = yield* pickTable(
            session,
            tables.map((t) => t.room),
            lobbyIdleMs,
            (state) => {
              const frame = lobbyFrame(
                {
                  tables,
                  ...state,
                  you: { fingerprint: id.fingerprint, algorithm: id.algorithm, term: info.term },
                },
                size.cols,
                size.rows,
              );
              if (frame !== drawn) session.stream.write((drawn = frame));
            },
            (again) => {
              resize = again === undefined ? undefined : () => again();
            },
          );
          // The lobby's frame is put away, whatever comes next.
          session.stream.write(CLEAR);
          if (picked === "left") return session.exit(0);
          if (picked === "idle") {
            say("No table picked; come back any time.");
            return session.exit(1);
          }
          room = picked.room;
          say(`Joining ${room}…`);
        }
        const link = links.get(room);
        if (!link?.alive) {
          say(closedRoomMessage(room));
          return session.exit(1);
        }
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
        // The player's name and software first; then only the terminal env our server let through.
        const env: Record<string, string> = {
          [RELAYED_ACTOR_ENV]: actor,
          [RELAYED_CLIENT_ENV]: info.client,
        };
        for (const [key, value] of Object.entries(info.env))
          if (key !== RELAYED_ACTOR_ENV && key !== RELAYED_CLIENT_ENV) env[key] = value;

        const openedAt = size;
        const channel = yield* seat(link, session, env, openedAt).pipe(
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

        resize = (cols, rows) => channel.resize(cols, rows);
        // A resize while the channel was opening went nowhere: send where the terminal is now.
        if (size !== openedAt) channel.resize(size.cols, size.rows);
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
