import { describe, expect } from "bun:test";
import { TextRenderable } from "@opentui/core";
import { Effect } from "effect";
import type { ShellSession } from "../src/index.ts";
import { effect } from "./effect.ts";
import { clientKey, sshShell, waitFor } from "./openssh.ts";
import { testServer } from "./server.ts";
import { ssh2Client, ssh2Shell } from "./ssh2client.ts";
import { tempDir } from "./tempDir.ts";

describe("shell", () => {
  effect("a pty client gets a renderer of its size, sees what it draws, and resizes it", () =>
    Effect.gen(function* () {
      const key = yield* clientKey(yield* tempDir, "alice");
      const sessions: ShellSession[] = [];
      const server = yield* testServer({
        onShell: (session) =>
          Effect.gen(function* () {
            sessions.push(session);
            session.renderer.root.add(
              new TextRenderable(session.renderer, { content: "HELLO_TABLE" }),
            );
            yield* Effect.never;
          }),
      });
      const terminal = yield* sshShell(server.port, { cols: 100, rows: 30 }, { key });
      yield* waitFor("the drawn text", () => terminal.output().includes("HELLO_TABLE"));
      const [session] = sessions;
      expect(session!.info).toMatchObject({
        identity: { actor: `key:${key.fingerprint}` },
        user: "den",
        term: "xterm-256color",
        cols: 100,
        rows: 30,
      });
      expect([session!.renderer.width, session!.renderer.height]).toEqual([100, 30]);

      terminal.resize(120, 40);
      yield* waitFor(
        "the renderer to resize",
        () => session!.renderer.width === 120 && session!.renderer.height === 40,
      );
      // A huge terminal is held to 300x100: a renderer's cost grows with its size.
      terminal.resize(400, 150);
      yield* waitFor(
        "the renderer to clamp",
        () => session!.renderer.width === 300 && session!.renderer.height === 100,
      );
    }),
  );

  effect(
    "a dozen shells at once raise no listener warning, which would land on the GM's screen",
    () =>
      Effect.gen(function* () {
        const key = yield* clientKey(yield* tempDir, "alice");
        const warnings: string[] = [];
        const onWarning = (w: Error) => void warnings.push(w.message);
        process.on("warning", onWarning);
        yield* Effect.addFinalizer(() => Effect.sync(() => process.off("warning", onWarning)));
        let open = 0;
        const server = yield* testServer({
          onShell: () => Effect.sync(() => void open++).pipe(Effect.andThen(Effect.never)),
        });
        const clients = yield* Effect.all(
          Array.from({ length: 6 }, () => ssh2Client({ port: server.port, key })),
        );
        for (const client of clients) {
          yield* ssh2Shell(client, { cols: 80, rows: 24 });
          yield* ssh2Shell(client, { cols: 80, rows: 24 });
        }
        yield* waitFor("twelve seats", () => open === 12, 10_000);
        yield* Effect.sleep("100 millis");
        expect(warnings).toEqual([]);
      }),
    20_000,
  );

  effect("a shell reports clicks, drags and the wheel, never every motion of the mouse", () =>
    Effect.gen(function* () {
      const key = yield* clientKey(yield* tempDir, "alice");
      const server = yield* testServer({
        onShell: (session) =>
          Effect.gen(function* () {
            session.renderer.root.add(new TextRenderable(session.renderer, { content: "READY" }));
            yield* Effect.never;
          }),
      });
      const terminal = yield* sshShell(server.port, { cols: 80, rows: 24 }, { key });
      yield* waitFor("the session", () => terminal.output().includes("READY"));
      const output = terminal.output();
      // Normal and button-event tracking in SGR form: presses, releases, drags and the wheel.
      for (const mode of ["\x1b[?1000h", "\x1b[?1002h", "\x1b[?1006h"])
        expect(output).toContain(mode);
      // Any-event tracking, every motion over the wire, stays off.
      expect(output).not.toContain("\x1b[?1003h");
    }),
  );
});
