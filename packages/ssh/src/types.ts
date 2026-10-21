import type { Socket } from "node:net";
import type { Duplex, Writable } from "node:stream";
import type { CliRenderer } from "@opentui/core";
import type { Effect, Scope } from "effect";
import { Schema } from "effect";

/** Who is on the other end of a connection. A key is an identity; a guest is one connection. */
export type Identity =
  | {
      readonly kind: "key";
      readonly actor: `key:${string}`;
      /** `SHA256:<base64, no padding>`, the same string `ssh-keygen -lf` prints. */
      readonly fingerprint: string;
      /** The key's algorithm, e.g. `ssh-ed25519`. */
      readonly algorithm: string;
    }
  | { readonly kind: "guest"; readonly actor: `guest:${string}` };

/** What the server knows about one session (one SSH channel). */
export interface SessionInfo {
  readonly identity: Identity;
  /** The ssh username: the room's name. */
  readonly user: string;
  /** The client's TERM from its pty request, else `xterm-256color`. */
  readonly term: string;
  /** The terminal size from the pty request, else 80×24. A shell's renderer tracks later resizes. */
  readonly cols: number;
  readonly rows: number;
  /** Client env requests, allow-listed keys only. */
  readonly env: Readonly<Record<string, string>>;
  readonly remoteAddress: string;
  /**
   * The player a trusted relay seated on this channel (`key:SHA256:…` or `guest:…`), from its `SV_ACTOR`.
   * Set only on a connection authenticated with a trusted relay key, whose channels are refused
   * without it; never `gm`.
   */
  readonly relayedActor?: string;
}

export interface ShellSession {
  readonly info: SessionInfo;
  /** A renderer drawing to this channel, sized from the pty request and resized on window-change. */
  readonly renderer: CliRenderer;
  /** Ends the session: the renderer is destroyed, the channel closed and the session scope closed. */
  readonly close: () => void;
}

export interface ExecSession {
  readonly info: SessionInfo;
  /** The command line the client sent, e.g. `hello world`. */
  readonly command: string;
  readonly write: (text: string) => void;
  readonly writeError: (text: string) => void;
}

/** What a raw session's client asked for. */
export type RawRequest =
  | { readonly kind: "shell" }
  | { readonly kind: "exec"; readonly command: string };

/** How a raw session ends for its client: an exit status, or a signal's name (`TERM`, not `SIGTERM`). */
export type RawExit =
  | number
  | { readonly signal: string; readonly coreDumped?: boolean; readonly message?: string };

/**
 * A session as bytes, for a handler that forwards it rather than draws it (a relay). Nothing is
 * rendered, nothing rewritten and a shell without a pty is not refused: `pty` says what was asked.
 */
export interface RawSession {
  readonly info: SessionInfo;
  readonly request: RawRequest;
  /** Whether the client asked for a pty; `info` holds its term and size. */
  readonly pty: boolean;
  /**
   * The channel's bytes: read what the client sends, write what it sees, with the channel's flow
   * control. It ends when the client sends EOF. Don't end it yourself: `exit` does.
   */
  readonly stream: Duplex;
  readonly stderr: Writable;
  /** Called with each window-change, sized as the pty request is (clamped to 300×100). */
  readonly onResize: (listener: (cols: number, rows: number) => void) => void;
  /**
   * Ends the session: after what's been written, the client gets this exit, EOF and close, and the
   * session's scope closes. A handler that returns without calling it ends with 0; one that dies, 1.
   */
  readonly exit: (how: RawExit) => void;
}

/** Caps on what the server holds open. Over a cap, a socket is closed and a session refused. */
export interface Limits {
  /** Open connections, logged in or not. Default 64. */
  readonly connections?: number;
  /** Open connections from one remote address. Default 8. Through a tunnel, every player shares one. */
  readonly connectionsPerAddress?: number;
  /** Open sessions on one ordinary connection. Default 2. */
  readonly sessionsPerConnection?: number;
  /** Open sessions on one connection authenticated with a trusted relay key. Default 64. */
  readonly sessionsPerRelay?: number;
  /** Open sessions from one remote address, relays aside. Default 16. */
  readonly sessionsPerAddress?: number;
  /** Open sessions across the server. Default 64. */
  readonly sessions?: number;
  /**
   * How fast one remote address may open connections, listened or attached; over it, a new socket
   * is closed at once. Unlimited by default: a relay or tunnel brings everyone from one address.
   */
  readonly connectRate?: { readonly burst: number; readonly perSecond: number };
}

export interface Timeouts {
  /** How long a connection has to log in before its socket is closed. Default 20 s. */
  readonly loginMs?: number;
  /**
   * How long a session channel has to ask for a shell or exec before it is closed, and how long a
   * logged-in connection may go without a started session (after login, or once its last session
   * ends) before it is cut, unless it was attached as `persistent`. A missed start cuts the
   * connection too when it leaves nothing started, unless it carries a relay. Default 10 s.
   */
  readonly sessionStartMs?: number;
  /** How often a quiet client is pinged; after `keepaliveCount` unanswered pings it is cut. Default 15 s. */
  readonly keepaliveMs?: number;
  /** Default 3, so a dead peer goes within about a minute. */
  readonly keepaliveCount?: number;
}

export interface ServeOptions {
  /** The host key file. Generated as ed25519 (mode 0600) if missing. */
  readonly hostKeyPath: string;
  /** 0 picks a free port. */
  readonly port: number;
  readonly host: string;
  /** Let clients without a key in, as guests (keyboard-interactive with no prompts). */
  readonly allowGuests?: boolean;
  /** Fingerprints of relay keys whose `SV_ACTOR` is believed. */
  readonly trustedRelayKeys?: ReadonlyArray<string>;
  readonly limits?: Limits;
  readonly timeouts?: Timeouts;
  /** Told, on stderr, to a client that asks for a shell without a pty; its session then ends with status 1. */
  readonly noPtyMessage?: string;
  /** Written to each open shell, after its terminal is restored, when the server closes. */
  readonly shutdownNotice?: string;
  /**
   * Runs for each shell. The session ends when it returns, when it calls `close()`, or when the
   * client goes. Without it (or with `onRaw`), a shell is not drawn.
   */
  readonly onShell?: (session: ShellSession) => Effect.Effect<void, never, Scope.Scope>;
  /**
   * Runs for each exec request; its number is the exit status. Without it, exec is refused.
   * When the client asked for a pty, `\n` in what it writes goes out as `\r\n`.
   */
  readonly onExec?: (session: ExecSession) => Effect.Effect<number, never, Scope.Scope>;
  /**
   * Takes every shell and exec as raw bytes instead; `onShell`, `onExec` and `noPtyMessage` are
   * then unused. Every other guard (limits, timeouts, guests, the env allow-list, relay trust)
   * applies as before. The session ends when it returns, when it calls `exit`, or when the client goes.
   */
  readonly onRaw?: (session: RawSession) => Effect.Effect<void, never, Scope.Scope>;
}

export interface AttachOptions {
  /** Relay keys believed on this connection only, on top of `trustedRelayKeys`. */
  readonly trustedRelayKeys?: ReadonlyArray<string>;
  /**
   * Makes this connection a relay's link, which only a relay may log in on. A verified key in
   * neither trusted list is passed here: true logs it in as a relay (the caller pinned it, say, or
   * trusts it on first use), false refuses it. Guests are refused. Without this, any key logs in as
   * itself, as on a listened connection.
   */
  readonly admitRelay?: (fingerprint: string) => boolean;
  /**
   * Exempt from the idle cut: a link that carries nobody, or no longer does, stays up for the next
   * player. Keepalives still cut one whose far end stops answering.
   */
  readonly persistent?: boolean;
}

export interface SshServer {
  readonly port: number;
  readonly hostKeyFingerprint: string;
  /** Serves SSH on a socket we dialed out (ssh2's `injectSocket`): the far end is the SSH client. */
  readonly attach: (socket: Socket, options?: AttachOptions) => void;
}

export class SshError extends Schema.TaggedError<SshError>()("SshError", {
  message: Schema.String,
}) {}
