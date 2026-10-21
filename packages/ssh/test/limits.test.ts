import { describe, expect } from "bun:test";
import { connect } from "node:net";
import { TextRenderable } from "@opentui/core";
import { Effect, Exit, Scope } from "effect";
import { effect } from "./effect.ts";
import { clientKey, sshExec, sshShell, waitFor } from "./openssh.ts";
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
