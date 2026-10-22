import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { type AttachOptions, type RawSession, serve } from "@supervillain/ssh";
import { Effect, Logger } from "effect";
import { helloLine, readLine } from "../../src/relay/protocol.ts";
import { Relay, type RelayOptions } from "../../src/relay/server.ts";
import { tempDir } from "../host/tempDir.ts";

/** A relay on free loopback ports over a temp folder, for the life of the scope, with its log lines. */
export const startRelay = (options: Partial<RelayOptions> = {}) =>
  Effect.gen(function* () {
    const dir = options.dir ?? (yield* tempDir);
    const logs: string[] = [];
    const logger = Logger.make(({ message }) => {
      logs.push((Array.isArray(message) ? message : [message]).map(String).join(" "));
    });
    const relay = yield* Relay.make({
      dir,
      playerPort: 0,
      gmPort: 0,
      bind: "127.0.0.1",
      ...options,
    }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])));
    return { ...relay, dir, logs };
  });

/**
 * A stand-in for the GM's table on the real packages/ssh server, in raw mode: a shell prints who it
 * seated and its terminal, echoes what's typed, reports resizes, and ends with status 5 on `q`. An
 * exec prints who ran what and ends with 3 for `fail`; `cat` echoes stdin, upper-cased, to its EOF;
 * `wait` never ends on its own.
 */
export const gmTable = (hostKeyPath?: string) =>
  Effect.gen(function* () {
    const keyPath = hostKeyPath ?? join(yield* tempDir, "host_key");
    const ended: string[] = [];
    const server = yield* serve({
      hostKeyPath: keyPath,
      port: 0,
      host: "127.0.0.1",
      onRaw: (session) => table(session, ended),
    });
    return { server, hostKeyPath: keyPath, ended };
  });

const table = (session: RawSession, ended: string[]) =>
  Effect.gen(function* () {
    const who = session.info.relayedActor ?? "-";
    yield* Effect.addFinalizer(() => Effect.sync(() => void ended.push(who)));
    const request = session.request;
    if (request.kind === "shell") {
      const { term, cols, rows, env, client } = session.info;
      session.stream.write(
        `seat ${who} ${term} ${cols}x${rows} pty=${session.pty} env=${JSON.stringify(env)} client=${client.split("_")[0]}|`,
      );
      session.onResize((c, r) => session.stream.write(`resize ${c}x${r}|`));
      session.stream.on("data", (chunk: Buffer) => {
        if (chunk.includes("q")) session.exit(5);
        else session.stream.write(`echo:${chunk.toString()}|`);
      });
      return yield* Effect.never;
    }
    if (request.command === "cat") {
      const input = yield* Effect.callback<string>((resume) => {
        let text = "";
        session.stream.on("data", (chunk: Buffer) => (text += chunk.toString()));
        session.stream.once("end", () => resume(Effect.succeed(text)));
      });
      session.stream.write(input.toUpperCase());
      return session.exit(0);
    }
    session.stream.resume();
    session.stream.write(`exec ${who} ${request.command}\n`);
    session.stderr.write("note\n");
    if (request.command === "wait") return yield* Effect.never;
    session.exit(request.command === "fail" ? 3 : 0);
  });

export interface GmLink {
  /** The relay's answer line. */
  readonly answer: string;
  /** The GM's end of the link. */
  readonly socket: Socket;
  readonly closed: () => boolean;
}

/**
 * Dials the relay's GM port as a GM's host would: the hello, the answer, then the GM's SSH server
 * on the socket, believing `relayKey` (the relay's, unless a test says otherwise).
 */
export const linkGm = (
  gm: { readonly server: { readonly attach: (s: Socket, o?: AttachOptions) => void } },
  gmPort: number,
  room: string,
  relayKey: string,
) =>
  Effect.acquireRelease(
    Effect.promise(async (): Promise<GmLink> => {
      const socket = connect(gmPort, "127.0.0.1");
      let closed = false;
      socket.once("close", () => (closed = true));
      socket.on("error", () => socket.destroy());
      await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
      socket.write(helloLine(room));
      const answer = await readLine(socket).catch((e: Error) => `(no answer: ${e.message})`);
      // As the GM's host-link does: only the pinned relay key logs in, and the link stays up.
      if (answer === "OK")
        gm.server.attach(socket, { admitRelay: (fp) => fp === relayKey, persistent: true });
      return { answer, socket, closed: () => closed };
    }),
    (link) => Effect.sync(() => link.socket.destroy()),
  );
