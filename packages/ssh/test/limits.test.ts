import { describe, expect } from "bun:test";
import { connect } from "node:net";
import { TextRenderable } from "@opentui/core";
import { Effect, Exit, Fiber, Scope } from "effect";
import type ssh2 from "ssh2";
import { effect } from "./effect.ts";
import { clientKey, opensshKex, sshExec, sshShell, waitFor } from "./openssh.ts";
import { testServer } from "./server.ts";
import { ssh2Client, ssh2Exec } from "./ssh2client.ts";
import { tempDir } from "./tempDir.ts";

/** An exec handler that answers after a pause, so sessions stay open for a while. */
const slowEcho =
  (pause: `${number} millis`) => (session: { readonly write: (text: string) => void }) =>
    Effect.sleep(pause).pipe(
      Effect.as(0),
      Effect.tap(() => Effect.sync(() => session.write("ok"))),
    );

/** Resolves when the server cuts this client off. */
const closeOf = (client: InstanceType<typeof ssh2.Client>) =>
  Effect.callback<void>((resume) => {
    client.once("close", () => resume(Effect.void));
  });

/** Opens an ssh2 client in its own scope, so the test can drop it on demand. */
const heldClient = (options: Parameters<typeof ssh2Client>[0]) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const client = yield* ssh2Client(options).pipe(Scope.provide(scope));
    return { client, close: Scope.close(scope, Exit.void) };
  });

describe("handshake", () => {
  effect("a client that offers only a slow finite-field key exchange is refused at once", () =>
    Effect.gen(function* () {
      const key = yield* clientKey(yield* tempDir, "alice");
      const server = yield* testServer({ onExec: () => Effect.succeed(0) });
      const start = Date.now();
      const refused = yield* sshExec(server.port, ["hello"], {
        key,
        flags: ["-o", "KexAlgorithms=diffie-hellman-group18-sha512"],
      });
      expect(refused.exitCode).toBe(255);
      expect(Date.now() - start).toBeLessThan(2000);
      // Modern clients still get in.
      expect((yield* sshExec(server.port, ["hello"], { key })).exitCode).toBe(0);
    }),
  );

  effect.skipIf(!opensshKex.includes("mlkem768x25519-sha256"))(
    "OpenSSH agrees on the post-quantum hybrid key exchange and warns of nothing",
    () =>
      Effect.gen(function* () {
        const key = yield* clientKey(yield* tempDir, "alice");
        const server = yield* testServer({ onExec: () => Effect.succeed(0) });
        const only = yield* sshExec(server.port, ["hello"], {
          key,
          flags: ["-o", "KexAlgorithms=mlkem768x25519-sha256"],
        });
        expect(only.exitCode).toBe(0);
        // Left to its defaults, OpenSSH picks it first and says nothing about quantum computers.
        const chosen = yield* sshExec(server.port, ["hello"], { key, flags: ["-v"] });
        expect(chosen.exitCode).toBe(0);
        expect(chosen.stderr).toContain("kex: algorithm: mlkem768x25519-sha256");
        expect(chosen.stderr).not.toContain("post-quantum");
      }),
  );

  effect("our own client agrees on the post-quantum hybrid key exchange", () =>
    Effect.gen(function* () {
      const key = yield* clientKey(yield* tempDir, "alice");
      const server = yield* testServer({ onExec: () => Effect.succeed(7) });
      const client = yield* ssh2Client({
        port: server.port,
        key,
        kex: ["mlkem768x25519-sha256" as ssh2.KexAlgorithm],
      });
      expect((yield* ssh2Exec(client, "hello")).code).toBe(7);
    }),
  );

  effect("the server names itself, not the library, and never compresses", () =>
    Effect.gen(function* () {
      const key = yield* clientKey(yield* tempDir, "alice");
      const server = yield* testServer({ onExec: () => Effect.succeed(0) });
      const version = yield* Effect.promise(
        () =>
          new Promise<string>((resolve) => {
            const socket = connect(server.port, "127.0.0.1");
            socket.on("error", () => undefined);
            socket.once("data", (chunk: Buffer) => {
              resolve(chunk.toString("latin1").split("\r\n")[0]!);
              socket.destroy();
            });
          }),
      );
      expect(version).toBe("SSH-2.0-supervillain");
      // `ssh -C` asks for zlib and settles for none.
      const compressed = yield* sshExec(server.port, ["hello"], { key, flags: ["-C", "-v"] });
      expect(compressed.exitCode).toBe(0);
      expect(compressed.stderr).toContain("compression: none");
      expect(compressed.stderr).not.toContain("compression: zlib");
    }),
  );

  effect("a connection that never authenticates is cut after the login grace", () =>
    Effect.gen(function* () {
      yield* testServer({ timeouts: { loginMs: 200 } }).pipe(
        Effect.flatMap((server) =>
          Effect.promise(
            () =>
              new Promise<number>((resolve) => {
                const start = Date.now();
                // Says nothing at all, not even its SSH version.
                const socket = connect(server.port, "127.0.0.1");
                socket.on("error", () => undefined);
                socket.resume();
                socket.once("close", () => resolve(Date.now() - start));
              }),
          ),
        ),
        Effect.tap((ms) => Effect.sync(() => expect(ms).toBeLessThan(2000))),
        Effect.timeout("3 seconds"),
      );
    }),
  );
});

describe("connection limits", () => {
  effect("connections are capped per address", () =>
    Effect.gen(function* () {
      const server = yield* testServer({
        allowGuests: true,
        limits: { connectionsPerAddress: 2 },
        onExec: slowEcho("0 millis"),
      });
      const guest = { port: server.port, keyboard: true };
      const first = yield* heldClient(guest);
      yield* heldClient(guest);
      const third = yield* Effect.flip(ssh2Client(guest));
      expect(third).toBeInstanceOf(Error);
      // Another address is not held back by this one.
      const elsewhere = yield* ssh2Client({ ...guest, localAddress: "127.0.0.2" });
      expect((yield* ssh2Exec(elsewhere, "x")).stdout).toBe("ok");
      // A connection that goes gives its place back.
      yield* first.close;
      yield* Effect.sleep("100 millis");
      const again = yield* ssh2Client(guest);
      expect((yield* ssh2Exec(again, "x")).stdout).toBe("ok");
    }),
  );

  effect("connections are capped in total", () =>
    Effect.gen(function* () {
      const server = yield* testServer({ allowGuests: true, limits: { connections: 2 } });
      const guest = { port: server.port, keyboard: true };
      yield* heldClient({ ...guest, localAddress: "127.0.0.1" });
      yield* heldClient({ ...guest, localAddress: "127.0.0.2" });
      const third = yield* Effect.flip(ssh2Client({ ...guest, localAddress: "127.0.0.3" }));
      expect(third).toBeInstanceOf(Error);
    }),
  );

  effect("sessions are capped per address, across its connections", () =>
    Effect.gen(function* () {
      const server = yield* testServer({
        allowGuests: true,
        limits: { sessionsPerAddress: 2 },
        onExec: slowEcho("300 millis"),
      });
      const a = yield* ssh2Client({ port: server.port, keyboard: true });
      const b = yield* ssh2Client({ port: server.port, keyboard: true });
      const runs = yield* Effect.all(
        [a, a, b].map((client) => Effect.result(ssh2Exec(client, "x"))),
        { concurrency: "unbounded" },
      );
      expect(runs.filter((r) => r._tag === "Success")).toHaveLength(2);
      const other = yield* ssh2Client({
        port: server.port,
        keyboard: true,
        localAddress: "127.0.0.2",
      });
      expect((yield* ssh2Exec(other, "x")).stdout).toBe("ok");
    }),
  );

  effect("an authenticated connection that opens no session is cut after the start grace", () =>
    Effect.gen(function* () {
      const server = yield* testServer({ allowGuests: true, timeouts: { sessionStartMs: 200 } });
      const client = yield* ssh2Client({ port: server.port, keyboard: true });
      const start = Date.now();
      yield* closeOf(client).pipe(Effect.timeout("3 seconds"));
      expect(Date.now() - start).toBeLessThan(2000);
    }),
  );

  effect("idle connections give their places back, so an address isn't locked out for good", () =>
    Effect.gen(function* () {
      const server = yield* testServer({
        allowGuests: true,
        limits: { connectionsPerAddress: 2 },
        timeouts: { sessionStartMs: 200 },
        onExec: slowEcho("0 millis"),
      });
      const guest = { port: server.port, keyboard: true };
      const idle = [yield* ssh2Client(guest), yield* ssh2Client(guest)];
      expect(yield* Effect.flip(ssh2Client(guest))).toBeInstanceOf(Error);
      yield* Effect.forEach(idle, closeOf).pipe(Effect.timeout("3 seconds"));
      yield* Effect.sleep("100 millis");
      expect((yield* ssh2Exec(yield* ssh2Client(guest), "x")).stdout).toBe("ok");
    }),
  );

  effect("a connection keeps its place while a session runs, and is cut once none is left", () =>
    Effect.gen(function* () {
      const server = yield* testServer({
        allowGuests: true,
        timeouts: { sessionStartMs: 300 },
        onExec: slowEcho("800 millis"),
      });
      const client = yield* ssh2Client({ port: server.port, keyboard: true });
      // Runs well past the grace; then the connection has nothing open.
      expect((yield* ssh2Exec(client, "x")).stdout).toBe("ok");
      const ended = Date.now();
      yield* closeOf(client).pipe(Effect.timeout("3 seconds"));
      expect(Date.now() - ended).toBeLessThan(2000);
    }),
  );

  effect("a channel that never starts is closed alone; the session beside it carries on", () =>
    Effect.gen(function* () {
      const key = yield* clientKey(yield* tempDir, "alice");
      const server = yield* testServer({
        limits: { sessionsPerConnection: 2 },
        timeouts: { sessionStartMs: 200 },
        onExec: slowEcho("1200 millis"),
      });
      const client = yield* ssh2Client({ port: server.port, key });
      const running = yield* Effect.forkScoped(ssh2Exec(client, "x"));
      yield* Effect.sleep("50 millis");
      // A refused subsystem request leaves its session channel open and idle.
      client.subsys("nothing", () => undefined);
      yield* Effect.sleep("500 millis");
      // The idle channel's place came back: a second session fits beside the first.
      const beside = yield* Effect.forkScoped(ssh2Exec(client, "y"));
      expect((yield* Fiber.join(running)).stdout).toBe("ok");
      expect((yield* Fiber.join(beside)).stdout).toBe("ok");
    }),
  );

  effect("a session that never asks for a shell or exec loses its connection", () =>
    Effect.gen(function* () {
      const server = yield* testServer({ allowGuests: true, timeouts: { sessionStartMs: 200 } });
      const client = yield* ssh2Client({ port: server.port, keyboard: true });
      const closed = yield* Effect.promise(
        () =>
          new Promise<number>((resolve) => {
            const start = Date.now();
            client.once("close", () => resolve(Date.now() - start));
            // A subsystem request is refused, which leaves the session channel open and idle.
            client.subsys("nothing", () => undefined);
          }),
      ).pipe(Effect.timeout("3 seconds"));
      expect(closed).toBeLessThan(2000);
    }),
  );
});

describe("dead peers", () => {
  effect(
    "a frozen client is cut by keepalive, and its session ends",
    () =>
      Effect.gen(function* () {
        const key = yield* clientKey(yield* tempDir, "alice");
        const ended: string[] = [];
        const server = yield* testServer({
          timeouts: { keepaliveMs: 200, keepaliveCount: 2 },
          onShell: (session) =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() => Effect.sync(() => ended.push("closed")));
              session.renderer.root.add(new TextRenderable(session.renderer, { content: "READY" }));
              yield* Effect.never;
            }),
        });
        const terminal = yield* sshShell(server.port, { cols: 80, rows: 24 }, { key });
        yield* waitFor("the session", () => terminal.output().includes("READY"));
        terminal.pause();
        yield* waitFor("the frozen session to end", () => ended.length > 0, 5000);
      }),
    10_000,
  );
});

describe("exec and shell without a terminal", () => {
  effect("a shell without a pty is refused with a hint, and no seat opens", () =>
    Effect.gen(function* () {
      const key = yield* clientKey(yield* tempDir, "alice");
      let shells = 0;
      const server = yield* testServer({
        noPtyMessage: "Needs a terminal: try ssh -t.",
        onShell: () => Effect.sync(() => void shells++),
      });
      const result = yield* sshExec(server.port, [], { key, flags: ["-T"] });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("Needs a terminal: try ssh -t.\n");
      expect(result.stdout).toBe("");
      expect(shells).toBe(0);
    }),
  );

  effect("exec output ends lines with CRLF when the client asked for a pty", () =>
    Effect.gen(function* () {
      const key = yield* clientKey(yield* tempDir, "alice");
      const server = yield* testServer({
        onExec: (session) =>
          Effect.sync(() => {
            session.write("one\ntwo\n");
            session.writeError("oops\n");
            return 0;
          }),
      });
      const client = yield* ssh2Client({ port: server.port, key });
      const plain = yield* ssh2Exec(client, "x");
      expect([plain.stdout, plain.stderr]).toEqual(["one\ntwo\n", "oops\n"]);
      const withPty = yield* ssh2Exec(client, "x", {}, true);
      // A pty merges stderr into the output stream on the client.
      expect(withPty.stdout + withPty.stderr).toContain("one\r\ntwo\r\n");
      expect(withPty.stdout + withPty.stderr).toContain("oops\r\n");
    }),
  );
});
