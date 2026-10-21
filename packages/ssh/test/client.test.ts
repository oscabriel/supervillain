import { describe, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { Deferred, Effect, Exit, Scope } from "effect";
import { connectClient } from "../src/index.ts";
import { effect } from "./effect.ts";
import { clientKey, waitFor } from "./openssh.ts";
import { testServer } from "./server.ts";
import { tcpListener } from "./tcp.ts";
import { tempDir } from "./tempDir.ts";

const PLAYER = `key:SHA256:${"A1b2+/".repeat(7)}C`;

const dial = (port: number) =>
  Effect.promise(
    () =>
      new Promise<Socket>((resolve) => {
        const socket = connect(port, "127.0.0.1");
        socket.once("connect", () => resolve(socket));
      }),
  );

/** Reads a stream to its end. */
const drain = (stream: NodeJS.ReadableStream) =>
  new Promise<string>((resolve) => {
    let text = "";
    stream.on("data", (chunk: Buffer) => (text += chunk.toString()));
    stream.once("end", () => resolve(text));
  });

describe("connectClient", () => {
  effect("speaks SSH over a socket it's handed: env first, a pty, exec, both streams, exit", () =>
    Effect.gen(function* () {
      const key = yield* clientKey(yield* tempDir, "relay");
      const server = yield* testServer({
        trustedRelayKeys: [key.fingerprint],
        onRaw: (session) =>
          Effect.gen(function* () {
            const request = session.request;
            const input = yield* Effect.promise(() => drain(session.stream));
            session.stream.write(
              `${session.info.relayedActor} ${request.kind === "exec" ? request.command : "shell"} ${session.info.term} ${session.info.cols}x${session.info.rows} ${JSON.stringify(session.info.env)} in=${input}`,
            );
            session.stderr.write("err");
            session.exit({ signal: "HUP" });
          }),
      });
      const offered: string[] = [];
      const client = yield* connectClient({
        socket: yield* dial(server.port),
        username: "relay",
        privateKey: yield* Effect.promise(() => readFile(key.path)),
        verifyHostKey: async (fingerprint) => {
          offered.push(fingerprint);
          return true;
        },
      });
      expect(offered).toEqual([server.hostKeyFingerprint]);
      expect(client.hostKeyFingerprint).toBe(server.hostKeyFingerprint);
      const channel = yield* Effect.promise(() =>
        client.open(
          { kind: "exec", command: "go" },
          { SV_ACTOR: PLAYER, COLORTERM: "truecolor" },
          {
            term: "xterm",
            cols: 90,
            rows: 20,
          },
        ),
      );
      channel.stream.end("typed");
      const [out, err, ending] = yield* Effect.promise(() =>
        Promise.all([drain(channel.stream), drain(channel.stderr), channel.ended]),
      );
      expect(out).toBe(`${PLAYER} go xterm 90x20 {"COLORTERM":"truecolor"} in=typed`);
      expect(err).toBe("err");
      expect(ending).toEqual({ signal: "HUP", coreDumped: false, message: "" });
    }),
  );

  effect("a shell hears resizes; the link says when it closes", () =>
    Effect.gen(function* () {
      const key = yield* clientKey(yield* tempDir, "relay");
      const server = yield* testServer({
        trustedRelayKeys: [key.fingerprint],
        onRaw: (session) =>
          Effect.gen(function* () {
            session.onResize((c, r) => session.stream.write(`${c}x${r}`));
            session.stream.resume();
            return yield* Effect.never;
          }),
      });
      const scope = yield* Scope.make();
      const client = yield* connectClient({
        socket: yield* dial(server.port),
        username: "relay",
        privateKey: yield* Effect.promise(() => readFile(key.path)),
        verifyHostKey: async () => true,
      }).pipe(Scope.provide(scope));
      const closed = yield* Deferred.make<void>();
      client.onClose(() => Deferred.doneUnsafe(closed, Exit.void));
      const channel = yield* Effect.promise(() =>
        client.open({ kind: "shell" }, { SV_ACTOR: PLAYER }, { term: "xterm", cols: 80, rows: 24 }),
      );
      let seen = "";
      channel.stream.on("data", (chunk: Buffer) => (seen += chunk.toString()));
      channel.resize(132, 43);
      yield* waitFor("the resize", () => seen === "132x43");
      // Closing the client's scope ends the link; the channel ends with no exit of its own.
      yield* Scope.close(scope, Exit.void);
      yield* Deferred.await(closed);
      expect(yield* Effect.promise(() => channel.ended)).toBeUndefined();
      expect(client.closed()).toBe(true);
    }),
  );

  effect("a host key the caller refuses, or a key the server refuses, fails the connect", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const key = yield* clientKey(dir, "relay");
      const server = yield* testServer({});
      const privateKey = yield* Effect.promise(() => readFile(key.path));
      const refusedHost = yield* Effect.flip(
        connectClient({
          socket: yield* dial(server.port),
          username: "relay",
          privateKey,
          verifyHostKey: async () => false,
        }),
      );
      expect(refusedHost.message).toContain("host key");
      // A server whose link admits no relay key.
      const farEnd = yield* Deferred.make<Socket>();
      const relay = yield* tcpListener((socket) =>
        Deferred.doneUnsafe(farEnd, Effect.succeed(socket)),
      );
      server.attach(connect(relay.port, "127.0.0.1"), { admitRelay: () => false });
      const refusedKey = yield* Effect.flip(
        connectClient({
          socket: yield* Deferred.await(farEnd),
          username: "relay",
          privateKey,
          verifyHostKey: async () => true,
        }),
      );
      expect(refusedKey.message).toContain("refused this client's key");
    }),
  );
});
