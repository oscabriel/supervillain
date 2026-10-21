import { readFileSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import type { View } from "@supervillain/engine";
import type { AttachOptions } from "@supervillain/ssh";
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Random,
  type Scope,
  SubscriptionRef,
} from "effect";
import {
  type Answer,
  DEFAULT_GM_PORT,
  DEFAULT_PLAYER_PORT,
  helloLine,
  MAX_LINE_BYTES,
  parseAnswer,
} from "../relay/protocol.ts";

/** In the campaign folder: the relay key fingerprint this GM trusts, pinned on first use. */
export const RELAY_KNOWN_FILE = "relay_known";

/** An OpenSSH SHA256 key fingerprint, as `ssh-keygen -lf` prints it and `--relay-key` takes it. */
export const isFingerprint = (text: string): boolean => /^SHA256:[A-Za-z0-9+/]{43}$/.test(text);

/** How the GM's link to the relay is doing, for the GM's screen and the host log. */
export type RelayStatus =
  | {
      readonly state: "connecting";
      /** Why the last try didn't hold, if one has been made. */
      readonly lastError?: string;
    }
  | {
      readonly state: "connected";
      /** The relay key fingerprint the link was trusted on. */
      readonly relayKey: string;
      /** Whether that key was trusted on first use, and pinned in relay_known just now. */
      readonly firstUse: boolean;
    }
  | {
      readonly state: "refused";
      readonly reason: string;
      /**
       * Whether the host keeps redialing: yes after the relay's `ERR`, no after a relay key that
       * isn't the pinned one, until the GM fixes relay_known.
       */
      readonly retrying: boolean;
    };

export interface RelayLinkOptions {
  /** The relay's GM port. */
  readonly host: string;
  readonly port: number;
  /** The room to link, which players type as the ssh username. */
  readonly room: string;
  /**
   * The relay's player port, for the join command only: the protocol doesn't carry it.
   * Default 2222, the relay's own default.
   */
  readonly playerPort?: number;
  /** Where relay_known lives. */
  readonly campaignDir: string;
  /** The relay key fingerprint to trust (`--relay-key`). Without it, relay_known pins one on first use. */
  readonly relayKey?: string;
  /** Serves SSH on the linked socket: the table's SSH server's `attach`. */
  readonly attach: (socket: Socket, options: AttachOptions) => void;
  readonly timeouts?: {
    /** How long a dial may take. Default 10 s. */
    readonly connectMs?: number;
    /** How long the relay has to answer the hello. Default 10 s. */
    readonly replyMs?: number;
  };
}

export interface RelayLinkService {
  readonly status: View<RelayStatus>;
  /** How players join through the relay: `ssh -p 2222 den@relay.example`. */
  readonly joinCommand: string;
}

const FIRST_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
/** Each delay is scaled by up to this much either way, so hosts that dropped together don't redial together. */
const JITTER = 0.2;
/** How often a host that refused the relay's key looks at relay_known for the GM's fix. */
const FIX_POLL = "5 seconds";
const DEFAULT_CONNECT_MS = 10_000;
const DEFAULT_REPLY_MS = 10_000;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** How long to wait before redial number `attempt` (from 0): 1 s doubling to 30 s, jittered. */
export const redialDelay = (attempt: number): Effect.Effect<Duration.Duration> =>
  Effect.map(Random.nextBetween(1 - JITTER, 1 + JITTER), (jitter) =>
    Duration.millis(Math.round(Math.min(MAX_DELAY_MS, FIRST_DELAY_MS * 2 ** attempt) * jitter)),
  );

/** `--relay`'s value: `host:port`, a bare host (port 7022), or `[v6 address]:port`. */
export const parseRelayAddress = (
  text: string,
): { readonly host: string; readonly port: number } | undefined => {
  const match = /^(?:\[([0-9A-Fa-f:.]+)\]|([^\s:[\]]+))(?::(\d{1,5}))?$/.exec(text);
  if (!match) return undefined;
  const port = match[3] === undefined ? DEFAULT_GM_PORT : Number(match[3]);
  if (port < 1 || port > 65_535) return undefined;
  return { host: (match[1] ?? match[2])!, port };
};

/** A room name players can type, from a campaign folder's name: `The Iron Den` → `the-iron-den`. */
export const roomSlug = (name: string): string => {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return slug === "" ? "table" : slug;
};

/** How players join through a relay: `ssh -p 2222 den@relay.example`, without `-p` on port 22. */
export const relayJoinCommand = (
  room: string,
  host: string,
  playerPort: number = DEFAULT_PLAYER_PORT,
): string => `ssh ${playerPort === 22 ? "" : `-p ${playerPort} `}${room}@${host}`;

/** What the GM's band says, in place of the plain join hint, while the table goes through a relay. */
export const joinNote = (status: RelayStatus, joinCommand: string): string => {
  switch (status.state) {
    case "connected":
      return status.firstUse
        ? `players join with: ${joinCommand} · relay key ${status.relayKey} trusted on first use`
        : `players join with: ${joinCommand}`;
    case "connecting":
      return status.lastError === undefined
        ? "relay: connecting…"
        : `relay: connecting… (${status.lastError})`;
    case "refused":
      return `relay refused: ${status.reason}`;
  }
};

/**
 * What the GM's header says while the link isn't up, short enough to sit beside the room at 80
 * columns whatever the band shows; nothing while it is. The band and host.log say why.
 */
export const linkAlert = (status: RelayStatus): string | undefined => {
  switch (status.state) {
    case "connected":
      return undefined;
    case "connecting":
      return status.lastError === undefined ? "relay: connecting…" : "relay: down, redialing";
    case "refused":
      return status.retrying ? "relay: refused, redialing" : "relay: refused, see host.log";
  }
};

/** How one link ended, or why it never came up. */
type Outcome =
  | { readonly _tag: "dropped" }
  | { readonly _tag: "failed"; readonly error: string }
  | { readonly _tag: "answered"; readonly reason: string }
  | { readonly _tag: "keyRefused"; readonly reason: string; readonly final: boolean };

type Decision =
  | { readonly admit: true; readonly firstUse: boolean }
  | { readonly admit: false; readonly reason: string; readonly final: boolean };

/** relay_known as it stands: its raw text, or undefined if there is none. */
const readKnownText = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
};

/** Resolves when the socket closes. */
const closedSignal = (socket: Socket) =>
  Effect.gen(function* () {
    const closed = yield* Deferred.make<void>();
    socket.once("close", () => Deferred.doneUnsafe(closed, Exit.void));
    return closed;
  });

const awaitConnect = (socket: Socket, lastError: () => string | undefined) =>
  Effect.callback<void, string>((resume) => {
    if (!socket.connecting && !socket.destroyed) return resume(Effect.void);
    const onConnect = () => resume(Effect.void);
    const onClose = () => resume(Effect.fail(lastError() ?? "the connection closed"));
    socket.once("connect", onConnect);
    socket.once("close", onClose);
    return Effect.sync(() => {
      socket.removeListener("connect", onConnect);
      socket.removeListener("close", onClose);
    });
  });

/**
 * Reads the relay's one-line answer. Whatever follows it is SSH: it is put back, and the socket
 * left paused, for the SSH server to read.
 */
const readReply = (socket: Socket) =>
  Effect.callback<Answer, string>((resume) => {
    let buffer = Buffer.alloc(0);
    const stop = () => {
      socket.removeListener("data", onData);
      socket.removeListener("close", onClose);
    };
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(0x0a);
      if (end === -1 && buffer.length < MAX_LINE_BYTES) return;
      socket.pause();
      stop();
      if (end === -1 || end + 1 > MAX_LINE_BYTES)
        return resume(Effect.fail("the relay's answer was too long"));
      const rest = buffer.subarray(end + 1);
      if (rest.length > 0) socket.unshift(rest);
      resume(Effect.succeed(parseAnswer(buffer.subarray(0, end).toString("utf8"))));
    };
    const onClose = () => {
      stop();
      resume(Effect.fail("the relay closed the link before answering"));
    };
    socket.on("data", onData);
    socket.once("close", onClose);
    return Effect.sync(stop);
  });

/**
 * The GM's side of the relay: dials the relay's GM port, names the room, and serves SSH on the
 * link with the relay as the only client it lets in, trusting the relay's key only if it is the
 * pinned one (`--relay-key`, else relay_known, which the first link fills). A link that drops is
 * redialed with backoff; a relay key that isn't the pinned one is refused and not redialed until
 * the GM fixes relay_known. Nothing said in plaintext is trusted.
 */
export class RelayLink extends Context.Service<RelayLink, RelayLinkService>()(
  "supervillain/host/RelayLink",
) {
  static readonly make = (
    options: RelayLinkOptions,
  ): Effect.Effect<RelayLinkService, never, Scope.Scope> =>
    Effect.gen(function* () {
      const where = `${options.host}:${options.port}`;
      const knownPath = join(options.campaignDir, RELAY_KNOWN_FILE);
      const connectMs = options.timeouts?.connectMs ?? DEFAULT_CONNECT_MS;
      const replyMs = options.timeouts?.replyMs ?? DEFAULT_REPLY_MS;
      const status = yield* SubscriptionRef.make<RelayStatus>({ state: "connecting" });

      /** Sets the status, and logs it if it changed. */
      const setStatus = (next: RelayStatus) =>
        Effect.gen(function* () {
          const previous = yield* SubscriptionRef.getAndSet(status, next);
          if (JSON.stringify(previous) === JSON.stringify(next)) return;
          switch (next.state) {
            case "connecting":
              return yield* next.lastError === undefined
                ? Effect.logInfo(`relay ${where}: connecting`)
                : Effect.logWarning(`relay ${where}: connecting (${next.lastError})`);
            case "connected":
              yield* Effect.logInfo(
                `relay ${where}: linked as room "${options.room}", relay key ${next.relayKey}`,
              );
              if (next.firstUse)
                yield* Effect.logWarning(
                  `relay ${where}: trusted relay key ${next.relayKey} on first use; pinned in ${knownPath}`,
                );
              return;
            case "refused":
              return yield* next.retrying
                ? Effect.logWarning(`relay ${where} refused the link: ${next.reason}`)
                : Effect.logError(
                    `relay ${where}: refused the relay: ${next.reason}. Not redialing until that's fixed.`,
                  );
          }
        });

      /** Whether a key that logged in on the link is the relay's. Pins it on first use. */
      const decide = (fingerprint: string): Decision => {
        if (options.relayKey !== undefined)
          return fingerprint === options.relayKey
            ? { admit: true, firstUse: false }
            : {
                admit: false,
                final: true,
                reason: `its key ${fingerprint} doesn't match --relay-key ${options.relayKey}`,
              };
        let text: string | undefined;
        try {
          text = readKnownText(knownPath);
        } catch (e) {
          return { admit: false, final: true, reason: `can't read ${knownPath}: ${messageOf(e)}` };
        }
        if (text === undefined) {
          try {
            writeFileSync(knownPath, `${fingerprint}\n`, { mode: 0o600, flag: "wx" });
            return { admit: true, firstUse: true };
          } catch (e) {
            // Unpinned, the next link would trust whatever key it met.
            return {
              admit: false,
              final: false,
              reason: `can't pin its key in ${knownPath}: ${messageOf(e)}`,
            };
          }
        }
        const pinned = text
          .split("\n")
          .map((line) => line.trim().split(/\s+/)[0] ?? "")
          .find((token) => token !== "" && !token.startsWith("#"));
        if (pinned === undefined || !isFingerprint(pinned))
          return {
            admit: false,
            final: true,
            reason: `${knownPath} doesn't hold a relay key fingerprint (SHA256:…)`,
          };
        return fingerprint === pinned
          ? { admit: true, firstUse: false }
          : {
              admit: false,
              final: true,
              reason: `its key ${fingerprint} doesn't match ${pinned} in ${knownPath}; if the relay's key really changed, put the new one there`,
            };
      };

      /** One link, from the dial until it drops or is refused. */
      const linkOnce: Effect.Effect<Outcome, string> = Effect.gen(function* () {
        let lastError: string | undefined;
        // Once attached, the socket is the SSH server's: it closes it, politely, when the host stops.
        let attached = false;
        const socket = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const socket = connect({ host: options.host, port: options.port });
            socket.on("error", (e) => (lastError = e.message));
            return socket;
          }),
          (socket) => Effect.sync(() => attached || socket.destroy()),
        );
        const closed = yield* closedSignal(socket);
        yield* awaitConnect(socket, () => lastError).pipe(
          Effect.timeoutOrElse({
            duration: connectMs,
            orElse: () => Effect.fail(`no answer from ${where}`),
          }),
          Effect.mapError((e) => `can't reach ${where}: ${e}`),
        );
        socket.setNoDelay(true);
        socket.write(helloLine(options.room));
        const reply = yield* readReply(socket).pipe(
          Effect.timeoutOrElse({
            duration: replyMs,
            orElse: () => Effect.fail("the relay didn't answer the hello"),
          }),
        );
        if (!reply.ok) return { _tag: "answered", reason: reply.reason } satisfies Outcome;

        const admitted = yield* Deferred.make<{ relayKey: string; firstUse: boolean }>();
        let refusal: Extract<Decision, { admit: false }> | undefined;
        attached = true;
        options.attach(socket, {
          persistent: true,
          admitRelay: (fingerprint) => {
            const decision = decide(fingerprint);
            if (decision.admit) {
              Deferred.doneUnsafe(
                admitted,
                Exit.succeed({ relayKey: fingerprint, firstUse: decision.firstUse }),
              );
              return true;
            }
            refusal = decision;
            // Refused, then cut: an impostor gets no second try on this link.
            setImmediate(() => socket.destroy());
            return false;
          },
        });
        const up = yield* Effect.raceFirst(
          Deferred.await(admitted).pipe(Effect.map(Option.some)),
          Deferred.await(closed).pipe(Effect.as(Option.none())),
        );
        if (Option.isNone(up)) {
          const refused = refusal as Extract<Decision, { admit: false }> | undefined;
          return refused
            ? ({ _tag: "keyRefused", reason: refused.reason, final: refused.final } as const)
            : ({
                _tag: "failed",
                // The relay drops a GM whose host key isn't the one that claimed the room, and says
                // nothing on the link: this is the one place its GM can hear of it.
                error: `the link closed before the relay logged in; if this keeps up, another GM's host key may hold room ${options.room} there`,
              } as const);
        }
        yield* setStatus({ state: "connected", ...up.value });
        yield* Deferred.await(closed);
        return { _tag: "dropped" } satisfies Outcome;
      }).pipe(Effect.scoped);

      /** Waits for the GM to change relay_known after a refusal. A pin on the command line can't change. */
      const awaitFix = Effect.gen(function* () {
        if (options.relayKey !== undefined) return yield* Effect.never;
        const snapshot = () => {
          try {
            return readKnownText(knownPath);
          } catch (e) {
            return `unreadable: ${messageOf(e)}`;
          }
        };
        const refusedOn = snapshot();
        while (snapshot() === refusedOn) yield* Effect.sleep(FIX_POLL);
        yield* Effect.logInfo(`relay ${where}: ${knownPath} changed; redialing`);
      });

      const run = Effect.gen(function* () {
        let attempt = 0;
        while (true) {
          const outcome = yield* linkOnce.pipe(
            Effect.catch((error) => Effect.succeed({ _tag: "failed", error } as const)),
          );
          switch (outcome._tag) {
            case "dropped":
              attempt = 0;
              yield* setStatus({ state: "connecting", lastError: "the link dropped" });
              break;
            case "failed":
              yield* setStatus({ state: "connecting", lastError: outcome.error });
              break;
            case "answered":
              yield* setStatus({ state: "refused", reason: outcome.reason, retrying: true });
              break;
            case "keyRefused":
              yield* setStatus({
                state: "refused",
                reason: outcome.reason,
                retrying: !outcome.final,
              });
              if (outcome.final) {
                yield* awaitFix;
                attempt = 0;
                yield* setStatus({ state: "connecting" });
                continue;
              }
              break;
          }
          yield* Effect.sleep(yield* redialDelay(attempt));
          attempt++;
        }
      });
      yield* Effect.forkScoped(run);

      return {
        status: { get: SubscriptionRef.get(status), changes: SubscriptionRef.changes(status) },
        joinCommand: relayJoinCommand(options.room, options.host, options.playerPort),
      };
    });

  static readonly layer = (options: RelayLinkOptions): Layer.Layer<RelayLink> =>
    Layer.effect(RelayLink, RelayLink.make(options));
}
