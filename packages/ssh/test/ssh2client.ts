import { readFile } from "node:fs/promises";
import type { Duplex } from "node:stream";
import { Effect } from "effect";
import ssh2, { type ClientChannel } from "ssh2";
import type { ClientKey } from "./openssh.ts";

/** An ssh2 Client: it can send env requests and pick its auth method, which OpenSSH won't do on demand. */

export interface Ssh2Options {
  readonly port?: number;
  /** Speak SSH over this stream instead of dialing `port`. */
  readonly sock?: Duplex;
  readonly key?: ClientKey;
  /** Try keyboard-interactive whatever the server advertises. */
  readonly keyboard?: boolean;
  readonly user?: string;
  /** Connect from this local address, e.g. `127.0.0.2`, to look like another machine. */
  readonly localAddress?: string;
  /** Offer only these key exchanges. */
  readonly kex?: Array<ssh2.KexAlgorithm>;
}

/** A connected, authenticated client for the life of the scope. Fails with the client's error. */
export const ssh2Client = (options: Ssh2Options) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const privateKey = options.key ? await readFile(options.key.path, "utf8") : undefined;
        const client = new ssh2.Client();
        await new Promise<void>((resolve, reject) => {
          client.once("ready", resolve).once("error", reject);
          let tried = false;
          client.connect({
            host: "127.0.0.1",
            port: options.port,
            localAddress: options.localAddress,
            ...(options.kex ? { algorithms: { kex: options.kex } } : {}),
            sock: options.sock as never,
            username: options.user ?? "den",
            hostVerifier: () => true,
            readyTimeout: 5000,
            authHandler: (_methodsLeft, _partial, next) => {
              if (tried) return next(false as never);
              tried = true;
              if (privateKey)
                return next({
                  type: "publickey",
                  username: options.user ?? "den",
                  key: privateKey,
                });
              if (options.keyboard)
                return next({
                  type: "keyboard-interactive",
                  username: options.user ?? "den",
                  prompt: (_name, _instructions, _lang, _prompts, answer) => answer([]),
                });
              return next({ type: "none", username: options.user ?? "den" });
            },
          });
        });
        return client;
      },
      catch: (e) => (e instanceof Error ? e : new Error(String(e))),
    }),
    (client) => Effect.sync(() => client.end()),
  );

/** Runs one command, with a pty if asked; resolves with its output and exit status. */
export const ssh2Exec = (
  client: InstanceType<typeof ssh2.Client>,
  command: string,
  env: Record<string, string> = {},
  pty = false,
) =>
  Effect.tryPromise({
    try: () =>
      new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
        client.exec(command, { env, pty }, (err, channel) => {
          if (err) return reject(err);
          let stdout = "";
          let stderr = "";
          let code: number | null = null;
          channel.on("data", (d: Buffer) => (stdout += d.toString()));
          channel.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
          channel.on("exit", (c: number | null) => (code = c));
          channel.on("close", () => resolve({ stdout, stderr, code }));
        });
      }),
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  });

/** Opens a shell with a pty of the given size. */
export const ssh2Shell = (
  client: InstanceType<typeof ssh2.Client>,
  size: { cols: number; rows: number },
  env: Record<string, string> = {},
) =>
  Effect.tryPromise({
    try: () =>
      new Promise<ClientChannel>((resolve, reject) => {
        client.shell(
          { term: "xterm-256color", cols: size.cols, rows: size.rows, width: 0, height: 0 },
          { env },
          (err, channel) => (err ? reject(err) : resolve(channel)),
        );
      }),
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  });
