import { describe, expect } from "bun:test";
import { Context, Effect, Layer, Logger } from "effect";
import { Presence } from "../../src/host/Presence.ts";
import { TableRoom } from "../../src/host/TableRoom.ts";
import { TableServer, type TableServerOptions } from "../../src/host/TableServer.ts";
import { clientKey, sshExec, sshShell, waitFor } from "../e2e/openssh.ts";
import { effect } from "./effect.ts";
import { tempDir } from "./tempDir.ts";

/** A table served on a free loopback port over a temp campaign, for the life of the test. */
const servedTable = (more: Partial<TableServerOptions> = {}) =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    const layer = TableServer.layer({
      campaignDir: dir,
      room: "den",
      port: 0,
      bind: "127.0.0.1",
      ...more,
    }).pipe(Layer.provideMerge(Presence.layer), Layer.provideMerge(TableRoom.layer(dir)));
    // Session logs would only clutter the test output.
    const context = yield* Layer.build(layer.pipe(Layer.provide(Logger.layer([]))));
    return {
      port: Context.get(context, TableServer).port,
      presence: Context.get(context, Presence),
    };
  });

describe("TableServer", () => {
  effect(
    "an ssh seat is present while its session lasts: Ctrl-C or a dropped client ends it",
    () =>
      Effect.gen(function* () {
        const table = yield* servedTable();
        const keys = yield* tempDir;
        const vex = yield* clientKey(keys, "vex");
        const wren = yield* clientKey(keys, "wren");
        const here = () => Effect.runSync(table.presence.here.get);

        const first = yield* sshShell(table.port, vex);
        const second = yield* sshShell(table.port, wren);
        yield* waitFor("both seats", () => here().length === 2);
        expect(here()).toContain(`key:${vex.fingerprint}`);

        first.write("\x03");
        yield* waitFor("Vex to leave", () => here().length === 1);
        expect(here()).toEqual([`key:${wren.fingerprint}`]);
        expect(yield* Effect.promise(() => first.exited)).toBe(0);

        second.kill();
        yield* waitFor("Wren's dropped seat to close", () => here().length === 0);
      }),
    20_000,
  );

  effect(
    "one-off commands from one address are held to a rate, refused on stderr past it",
    () =>
      Effect.gen(function* () {
        const table = yield* servedTable({ execRate: { burst: 3, perSecond: 0.1 } });
        const vex = yield* clientKey(yield* tempDir, "vex");
        for (let i = 0; i < 3; i++)
          expect((yield* sshExec(table.port, "help", vex)).exitCode).toBe(0);
        expect(yield* sshExec(table.port, "help", vex)).toMatchObject({
          exitCode: 1,
          stdout: "",
          stderr: "Too many commands from your address; wait a moment.\n",
        });
      }),
    20_000,
  );

  effect(
    "a shell without a terminal is told how to connect, and no seat opens",
    () =>
      Effect.gen(function* () {
        const table = yield* servedTable();
        const result = yield* sshExec(table.port, "");
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("ssh -t");
        expect(result.stderr).toContain("help");
        expect(Effect.runSync(table.presence.here.get)).toEqual([]);
      }),
    20_000,
  );
});
