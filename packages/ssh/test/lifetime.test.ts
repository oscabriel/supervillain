import { describe, expect } from "bun:test";
import { TextRenderable } from "@opentui/core";
import { Effect, Exit, Logger, Scope } from "effect";
import type { ShellSession } from "../src/index.ts";
import { effect } from "./effect.ts";
import { clientKey, sshExec, sshShell, waitFor } from "./openssh.ts";
import { testServer } from "./server.ts";
import { ssh2Client, ssh2Shell } from "./ssh2client.ts";
import { tempDir } from "./tempDir.ts";

/** A shell handler that draws `READY`, then records when its scope closes. */
const recorder = (after: Effect.Effect<void> = Effect.never) => {
  const log: string[] = [];
  const sessions: ShellSession[] = [];
  const onShell = (session: ShellSession) =>
    Effect.gen(function* () {
      sessions.push(session);
      yield* Effect.addFinalizer(() => Effect.sync(() => log.push("closed")));
      session.renderer.root.add(new TextRenderable(session.renderer, { content: "READY" }));
      yield* after;
    });
  return { log, sessions, onShell };
};

describe("session lifetime", () => {
  effect("a client that drops closes the session scope and destroys the renderer", () =>
    Effect.gen(function* () {
      const key = yield* clientKey(yield* tempDir, "alice");
      const { log, sessions, onShell } = recorder();
      const server = yield* testServer({ onShell });
      const terminal = yield* sshShell(server.port, { cols: 80, rows: 24 }, { key });
      yield* waitFor("the session", () => terminal.output().includes("READY"));
      expect(log).toEqual([]);
      terminal.kill();
      yield* waitFor("the finalizer", () => log.length > 0);
      expect(log).toEqual(["closed"]);
      yield* waitFor("the renderer to go", () => sessions[0]!.renderer.isDestroyed);
    }),
  );

  effect("closing the server's scope ends live sessions and their clients", () =>
    Effect.gen(function* () {
      const key = yield* clientKey(yield* tempDir, "alice");
      const { log, onShell } = recorder();
      const scope = yield* Scope.make();
      const server = yield* testServer({
        onShell,
        shutdownNotice: "The GM closed the table.",
      }).pipe(Scope.provide(scope));
      const terminal = yield* sshShell(server.port, { cols: 80, rows: 24 }, { key });
      yield* waitFor("the session", () => terminal.output().includes("READY"));
      yield* Scope.close(scope, Exit.void);
      expect(log).toEqual(["closed"]);
      const exited = yield* Effect.promise(() => terminal.exited).pipe(Effect.timeout("3 seconds"));
      expect(exited).toBeNumber();
      // The notice comes after the renderer left the alternate screen, so it stays on the client's.
      const output = terminal.output();
      expect(output.lastIndexOf("The GM closed the table.\r\n")).toBeGreaterThan(
        output.lastIndexOf("\x1b[?1049l"),
      );
      const refused = yield* sshExec(server.port, ["hello"], { key });
      expect(refused.exitCode).toBe(255);
    }),
  );

  effect("the session ends when the handler returns, restoring the client's screen", () =>
    Effect.gen(function* () {
      const key = yield* clientKey(yield* tempDir, "alice");
      const { log, onShell } = recorder(Effect.sleep("100 millis"));
      const server = yield* testServer({ onShell });
      const terminal = yield* sshShell(server.port, { cols: 80, rows: 24 }, { key });
      const exited = yield* Effect.promise(() => terminal.exited).pipe(Effect.timeout("3 seconds"));
      expect(exited).toBe(0);
      expect(log).toEqual(["closed"]);
      expect(terminal.output()).toContain("READY");
      // The renderer left the alternate screen before the channel closed.
      expect(terminal.output()).toContain("\x1b[?1049l");
    }),
  );

  effect("the session ends when the handler calls close()", () =>
    Effect.gen(function* () {
      const key = yield* clientKey(yield* tempDir, "alice");
      const log: string[] = [];
      const server = yield* testServer({
        onShell: (session) =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Effect.sync(() => log.push("closed")));
            session.renderer.keyInput.on("keypress", (key) => {
              if (key.name === "q") session.close();
            });
            session.renderer.root.add(new TextRenderable(session.renderer, { content: "READY" }));
            yield* Effect.never;
          }),
      });
      const terminal = yield* sshShell(server.port, { cols: 80, rows: 24 }, { key });
      yield* waitFor("the session", () => terminal.output().includes("READY"));
      terminal.write("q");
      const exited = yield* Effect.promise(() => terminal.exited).pipe(Effect.timeout("3 seconds"));
      expect(exited).toBe(0);
      expect(log).toEqual(["closed"]);
    }),
  );

  effect("a client that leaves while its renderer is set up is not logged as a failure", () =>
    Effect.gen(function* () {
      const key = yield* clientKey(yield* tempDir, "alice");
      const logged: string[] = [];
      const collect = Logger.layer([
        Logger.make(({ logLevel, message }) => logged.push(`${logLevel}: ${String(message)}`)),
      ]);
      const server = yield* testServer({ onShell: () => Effect.never }).pipe(
        Effect.provide(collect),
      );
      const client = yield* ssh2Client({ port: server.port, key });
      for (let i = 0; i < 10; i++) {
        const channel = yield* ssh2Shell(client, { cols: 80, rows: 24 });
        channel.close();
      }
      yield* Effect.sleep("500 millis");
      expect(logged.filter((line) => line.startsWith("Error:"))).toEqual([]);
    }),
  );

  effect("a handler that dies ends its own session and nobody else's", () =>
    Effect.gen(function* () {
      const key = yield* clientKey(yield* tempDir, "alice");
      let calls = 0;
      const logged: string[] = [];
      const collect = Logger.layer([
        Logger.make(({ logLevel, message }) => logged.push(`${logLevel}: ${String(message)}`)),
      ]);
      const server = yield* testServer({
        onShell: () => Effect.die(new Error("handler blew up")),
        onExec: (session) =>
          calls++ === 0
            ? Effect.die(new Error("exec blew up"))
            : Effect.sync(() => {
                session.write("still here");
                return 0;
              }),
      }).pipe(Effect.provide(collect));
      const terminal = yield* sshShell(server.port, { cols: 80, rows: 24 }, { key });
      yield* Effect.promise(() => terminal.exited).pipe(Effect.timeout("3 seconds"));
      const died = yield* sshExec(server.port, ["boom"], { key });
      expect(died.exitCode).toBe(1);
      const next = yield* sshExec(server.port, ["hello"], { key });
      expect(next).toMatchObject({ stdout: "still here", exitCode: 0 });
      expect(logged.filter((line) => line.startsWith("Error:"))).toEqual([
        expect.stringContaining("handler blew up"),
        expect.stringContaining("exec blew up"),
      ]);
    }),
  );
});
