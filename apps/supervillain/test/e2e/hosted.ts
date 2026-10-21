import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Envelope } from "@supervillain/engine";
import { Context, Effect, Exit, Layer, Logger, Scope } from "effect";
import { plainText } from "../../src/game/index.ts";
import { runLine } from "../../src/host/line.ts";
import { tableServices } from "../../src/host/services.ts";
import { TableRoom, type TableRoomOptions } from "../../src/host/TableRoom.ts";
import { TableServer } from "../../src/host/TableServer.ts";
import { type ClientKey, sshExec } from "./openssh.ts";

/**
 * The host as `supervillain host` builds it, in this process so the test can sit in the GM's
 * seat (the local one, which no ssh client can reach). Closing the returned scope stops it.
 * `options` can loosen the players' rate for a test that plays one player's whole turn quickly.
 */
export const hostTable = (dir: string, options: TableRoomOptions = {}) =>
  Effect.gen(function* () {
    // A child of the test's scope: closed by `stop`, or with the test if it fails first.
    const scope = yield* Scope.fork(yield* Scope.Scope);
    const layer = TableServer.layer({
      campaignDir: dir,
      room: "ford",
      port: 0,
      bind: "127.0.0.1",
    }).pipe(Layer.provideMerge(tableServices(dir, options)), Layer.provide(Logger.layer([])));
    const context = yield* Layer.buildWithScope(layer, scope);
    const gm = (line: string) => runLine("gm", line).pipe(Effect.provideContext(context));
    const state = Context.get(context, TableRoom).state.get;
    return {
      port: Context.get(context, TableServer).port,
      gm,
      state,
      stop: Scope.close(scope, Exit.void),
    };
  });

export type Hosted = Effect.Success<ReturnType<typeof hostTable>>;

/** Runs one GM line, failing the test unless it was written; returns what it said. */
export const asGm = (table: Hosted, line: string) =>
  Effect.gen(function* () {
    const reply = yield* table.gm(line);
    if (reply.kind !== "done")
      throw new Error(`the GM's ${line} came back ${JSON.stringify(reply)}`);
    return reply.lines.map(plainText);
  });

/** Runs one player line over real ssh, failing the test unless it worked; returns stdout. */
export const asPlayer = (port: number, key: ClientKey, line: string) =>
  Effect.gen(function* () {
    const result = yield* sshExec(port, line, key);
    if (result.exitCode !== 0) throw new Error(`${line} failed: ${result.stderr}`);
    return result.stdout;
  });

export const logOf = (dir: string) =>
  Effect.promise(async () =>
    (await readFile(join(dir, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Envelope),
  );
