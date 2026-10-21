import type { Duplex, Readable } from "node:stream";
import { Effect, type Scope } from "effect";
import ssh2, { type ClientChannel } from "ssh2";
import { fingerprintOf, KEX } from "./keys.ts";
import { type RawExit, type RawRequest, SshError } from "./types.ts";

/** How long a closing link waits for its disconnect to go out before cutting the socket. */
const CLOSE_GRACE_MS = 250;

export interface ClientOptions {
  /** A connected stream to speak SSH over: a socket the far end dialed to us, say. */
  readonly socket: Duplex;
  readonly username: string;
  /** The key to log in with (publickey only), in any form ssh2 reads. */
  readonly privateKey: Buffer | string;
  /** Decides the server's host key by its fingerprint. Nothing is sent before it says yes. */
  readonly verifyHostKey: (fingerprint: string) => Promise<boolean>;
  /** How long the handshake and login may take. Default 20 s. */
  readonly readyTimeoutMs?: number;
  /** How often a quiet server is pinged; after `keepaliveCount` unanswered pings the link goes. */
  readonly keepaliveMs?: number;
  /** Default 3. */
  readonly keepaliveCount?: number;
}

export interface ClientPty {
  readonly term: string;
  readonly cols: number;
  readonly rows: number;
}

/** One session channel the client opened. */
export interface ClientSession {
  /** The session's bytes: write what its client types (ending it sends EOF), read what it shows. */
  readonly stream: Duplex;
  readonly stderr: Readable;
  /** Sends a window-change. */
  readonly resize: (cols: number, rows: number) => void;
  /** At close: how the server said the session ended, or undefined if it closed without saying. */
  readonly ended: Promise<RawExit | undefined>;
  readonly close: () => void;
}

export interface ClientLink {
  /** The server's host key, as `verifyHostKey` accepted it. */
  readonly hostKeyFingerprint: string;
  /** Opens a session: env requests in the order given, then the pty if any, then shell or exec. */
  readonly open: (
    request: RawRequest,
    env: Readonly<Record<string, string>>,
    pty: ClientPty | false,
  ) => Promise<ClientSession>;
  /**
   * Runs once the link has closed, from either end; its sessions close right after. `closed()` is
   * true by then, so a session that ends without an exit can tell the link went.
   */
  readonly onClose: (listener: () => void) => void;
  readonly closed: () => boolean;
  /** Says goodbye and closes the socket. */
  readonly close: () => void;
}

const session = (channel: ClientChannel): ClientSession => {
  const ended = new Promise<RawExit | undefined>((resolve) => {
    let exit: RawExit | undefined;
    channel.on(
      "exit",
      (code: number | null, signal?: string, coreDumped?: boolean, message?: string) => {
        exit =
          typeof code === "number"
            ? code
            : {
                signal: (signal ?? "SIGTERM").replace(/^SIG/, ""),
                coreDumped: coreDumped === true,
                message: message ?? "",
              };
      },
    );
    channel.once("close", () => resolve(exit));
  });
  return {
    stream: channel,
    stderr: channel.stderr,
    resize: (cols, rows) => channel.setWindow(rows, cols, 0, 0),
    ended,
    close: () => channel.close(),
  };
};

/**
 * Logs in as an SSH client over a stream that's already connected, for the life of the scope.
 * Fails with an SshError naming what went wrong: the host key refused, this key refused, or other.
 */
export const connectClient = (
  options: ClientOptions,
): Effect.Effect<ClientLink, SshError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<ClientLink, SshError>((resume) => {
      const client = new ssh2.Client();
      let hostKeyFingerprint: string | undefined;
      let hostKeyRefused = false;
      let ready = false;
      let isClosed = false;
      const listeners = new Set<() => void>();
      const destroy = () => {
        client.destroy();
        options.socket.destroy();
      };
      const close = () => {
        if (isClosed) return;
        client.end();
        setTimeout(destroy, CLOSE_GRACE_MS).unref();
      };
      const link: ClientLink = {
        get hostKeyFingerprint() {
          return hostKeyFingerprint ?? "";
        },
        open: (request, env, pty) =>
          new Promise<ClientSession>((resolve, reject) => {
            const done = (err: Error | undefined, channel: ClientChannel) =>
              err ? reject(err) : resolve(session(channel));
            try {
              if (request.kind === "shell")
                client.shell(
                  pty ? { ...pty, width: 0, height: 0 } : false,
                  { env: { ...env } },
                  done,
                );
              else
                client.exec(
                  request.command,
                  { env: { ...env }, pty: pty ? { ...pty, width: 0, height: 0 } : false },
                  done,
                );
            } catch (e) {
              reject(e instanceof Error ? e : new Error(String(e)));
            }
          }),
        onClose: (listener) => {
          if (isClosed) listener();
          else listeners.add(listener);
        },
        closed: () => isClosed,
        close,
      };
      client.once("ready", () => {
        ready = true;
        resume(Effect.succeed(link));
      });
      client.on("error", (e: Error & { level?: string }) => {
        if (ready) return;
        const message = hostKeyRefused
          ? "the server's host key was refused"
          : e.level === "client-authentication"
            ? "the server refused this client's key"
            : e.message;
        resume(Effect.fail(new SshError({ message })));
        destroy();
      });
      client.on("close", () => {
        isClosed = true;
        options.socket.destroy();
        if (!ready) resume(Effect.fail(new SshError({ message: "the link closed during login" })));
        for (const listener of listeners) listener();
        listeners.clear();
      });
      client.connect({
        sock: options.socket as never,
        username: options.username,
        privateKey: options.privateKey,
        algorithms: { kex: KEX },
        readyTimeout: options.readyTimeoutMs ?? 20_000,
        keepaliveInterval: options.keepaliveMs ?? 15_000,
        keepaliveCountMax: options.keepaliveCount ?? 3,
        hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
          const offered = fingerprintOf(key);
          options.verifyHostKey(offered).then(
            (ok) => {
              if (ok) hostKeyFingerprint = offered;
              else hostKeyRefused = true;
              verify(ok);
            },
            () => {
              hostKeyRefused = true;
              verify(false);
            },
          );
        },
      });
      return Effect.sync(destroy);
    }),
    (link) => Effect.sync(() => link.close()),
  );
