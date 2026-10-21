import { describe, expect, test } from "bun:test";
import type { SessionInfo } from "@supervillain/ssh";
import { Context, Effect, Layer, Logger } from "effect";
import { Presence } from "../../src/host/Presence.ts";
import { tableServices } from "../../src/host/services.ts";
import type { TableRoomOptions } from "../../src/host/TableRoom.ts";
import { rateKeyOf, TableServer, type TableServerOptions } from "../../src/host/TableServer.ts";
import { clientKey, sshExec, sshShell, waitFor } from "../e2e/openssh.ts";
import { startRelay } from "../relay/harness.ts";
import { sshExec as relayExec } from "../relay/openssh.ts";
import { effect } from "./effect.ts";
import { tempDir } from "./tempDir.ts";

/** A table served on a free loopback port over a temp campaign, for the life of the test. */
const servedTable = (more: Partial<TableServerOptions> = {}, roomOptions: TableRoomOptions = {}) =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    const layer = TableServer.layer({
      campaignDir: dir,
      room: "den",
      port: 0,
      bind: "127.0.0.1",
      ...more,
    }).pipe(Layer.provideMerge(tableServices(dir, roomOptions)));
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
    "behind a relay, each player's one-off commands are rated as that player, not the relay's address",
    () =>
      Effect.gen(function* () {
        const relay = yield* startRelay();
        yield* servedTable({
          execRate: { burst: 2, perSecond: 0.01 },
          relay: { host: "127.0.0.1", port: relay.gmPort, relayKey: relay.relayKeyFingerprint },
        });
        yield* waitFor("the link", () => relay.linkedRooms().includes("den"), 10_000);
        const keys = yield* tempDir;
        const vex = yield* clientKey(keys, "vex");
        const kai = yield* clientKey(keys, "kai");
        const through = (key: typeof vex) => relayExec(relay.playerPort, ["help"], { key });
        expect((yield* through(vex)).exitCode).toBe(0);
        expect((yield* through(vex)).exitCode).toBe(0);
        expect(yield* through(vex)).toMatchObject({
          exitCode: 1,
          stderr: "Too many commands from your address; wait a moment.\n",
        });
        // Everyone through the relay comes from its address; Kai has a budget of their own.
        expect((yield* through(kai)).exitCode).toBe(0);
      }),
    20_000,
  );

  effect(
    "guests from one address share one rate, however many connections they open",
    () =>
      Effect.gen(function* () {
        const table = yield* servedTable({}, { playerRate: { burst: 2, perSecond: 0.01 } });
        expect((yield* sshExec(table.port, "/say one")).exitCode).toBe(0);
        expect((yield* sshExec(table.port, "/say two")).exitCode).toBe(0);
        expect(yield* sshExec(table.port, "/say three")).toMatchObject({
          exitCode: 1,
          stderr: "You're sending lines too fast; wait a moment.\n",
        });
        // A key is its own sender, wherever it connects from.
        const vex = yield* clientKey(yield* tempDir, "vex");
        expect((yield* sshExec(table.port, "/say mine", vex)).exitCode).toBe(0);
      }),
    20_000,
  );

  effect(
    "guest seats from one address share that rate too",
    () =>
      Effect.gen(function* () {
        const table = yield* servedTable({}, { playerRate: { burst: 2, perSecond: 0.01 } });
        const ann = yield* sshShell(table.port);
        const bea = yield* sshShell(table.port);
        yield* waitFor("both seats", () => Effect.runSync(table.presence.here.get).length === 2);
        yield* waitFor("Ann's name prompt", () => ann.text().includes("call you?"));
        ann.write("Ann\r");
        yield* waitFor("Ann named", () => ann.text().includes("is now Ann"));
        yield* waitFor("Bea's name prompt", () => bea.text().includes("call you?"));
        bea.write("Bea\r");
        yield* waitFor("Bea named", () => bea.text().includes("is now Bea"));
        bea.write("hello\r");
        yield* waitFor("Bea held back", () => bea.text().includes("You're sending lines too fast"));
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

describe("rateKeyOf", () => {
  const PLAYER: `key:${string}` = `key:SHA256:${"p".repeat(43)}`;
  const RELAY: `key:${string}` = `key:SHA256:${"r".repeat(43)}`;
  const info = (
    identity: SessionInfo["identity"],
    more: Partial<SessionInfo> = {},
  ): SessionInfo => ({
    identity,
    user: "den",
    term: "xterm-256color",
    cols: 80,
    rows: 24,
    env: {},
    remoteAddress: "203.0.113.7",
    ...more,
  });
  const key = (actor: `key:${string}`) =>
    ({ kind: "key", actor, fingerprint: actor.slice(4), algorithm: "ssh-ed25519" }) as const;

  test("a key is rated as itself, a guest by the address it came from", () => {
    expect(rateKeyOf(info(key(PLAYER)))).toBe(PLAYER);
    expect(rateKeyOf(info({ kind: "guest", actor: "guest:abc" }))).toBe("address:203.0.113.7");
    expect(rateKeyOf(info({ kind: "guest", actor: "guest:xyz" }))).toBe("address:203.0.113.7");
  });

  test("through a relay, a key is still itself and a guest is the relay's guest", () => {
    expect(rateKeyOf(info(key(RELAY), { relayedActor: PLAYER }))).toBe(PLAYER);
    expect(rateKeyOf(info(key(RELAY), { relayedActor: "guest:abc" }))).toBe(
      `relay:${RELAY}/guest:abc`,
    );
    expect(rateKeyOf(info(key(RELAY), { relayedActor: "guest:xyz" }))).toBe(
      `relay:${RELAY}/guest:xyz`,
    );
  });
});
