import { describe, expect } from "bun:test";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { cli } from "../e2e/cli.ts";
import { effect, waitFor } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";
import { clientKey, sshExec } from "./openssh.ts";

const main = join(import.meta.dir, "../../src/main.ts");
const GM = `SHA256:${"A".repeat(43)}`;

/** `supervillain relay …` as a child process for the life of the scope. */
const relayProcess = (args: ReadonlyArray<string>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const proc = Bun.spawn(["bun", main, "relay", ...args], { stdout: "pipe", stderr: "pipe" });
      let output = "";
      const decoder = new TextDecoder();
      const pump = async (stream: ReadableStream<Uint8Array>) => {
        for await (const chunk of stream) output += decoder.decode(chunk, { stream: true });
      };
      void pump(proc.stdout);
      void pump(proc.stderr);
      return { proc, output: () => output };
    }),
    ({ proc }) =>
      Effect.promise(async () => {
        proc.kill("SIGINT");
        await proc.exited;
      }),
  );

describe("supervillain relay", () => {
  effect(
    "starts on the ports it's given, prints its key for GMs to pin, and keeps its files in --dir",
    () =>
      Effect.gen(function* () {
        const dir = join(yield* tempDir, "relay");
        const relay = yield* relayProcess([
          "--player-port",
          "0",
          "--gm-port",
          "0",
          "--bind",
          "127.0.0.1",
          "--dir",
          dir,
        ]);
        yield* waitFor(
          "the relay to start",
          () => /GMs dial 127\.0\.0\.1:\d+/.test(relay.output()),
          10_000,
        );
        const key = /relay key (SHA256:[A-Za-z0-9+/]{43})/.exec(relay.output())?.[1];
        expect(key).toBeDefined();
        expect(relay.output()).toContain(`--relay-key ${key}`);
        const playerPort = Number(/ssh -p (\d+) <room>@/.exec(relay.output())?.[1]);
        const vex = yield* clientKey(yield* tempDir, "vex");
        const ran = yield* sshExec(playerPort, ["hi"], { key: vex, user: "den" });
        expect(ran).toMatchObject({ exitCode: 1, stderr: "There's no table called den here.\n" });
        // Its keys are its owner's alone.
        const { stat } = yield* Effect.promise(() => import("node:fs/promises"));
        for (const name of ["relay_key", "host_key"])
          expect((yield* Effect.promise(() => stat(join(dir, name)))).mode & 0o077).toBe(0);
      }),
    20_000,
  );

  effect("relay forget releases a room's claim", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const rooms = join(dir, "rooms.json");
      yield* Effect.promise(() => writeFile(rooms, JSON.stringify({ den: GM, attic: GM })));
      yield* Effect.promise(() => writeFile(join(dir, "relay_key"), "", { mode: 0o600 }));
      const forgot = yield* cli(["relay", "forget", "den", "--dir", dir]);
      expect(forgot.exitCode).toBe(0);
      expect(forgot.stdout).toContain(`released room den`);
      expect(forgot.stdout).toContain(GM);
      // A GM linked now isn't left believing it keeps the room.
      expect(forgot.stdout).toContain("replaces the GM linked now");
      expect(JSON.parse(yield* Effect.promise(() => readFile(rooms, "utf8")))).toEqual({
        attic: GM,
      });
      const again = yield* cli(["relay", "forget", "den", "--dir", dir]);
      expect(again).toMatchObject({ exitCode: 0 });
      expect(again.stdout).toContain(`no GM holds room den in ${rooms}`);
      const bad = yield* cli(["relay", "forget", "Not A Room", "--dir", dir]);
      expect(bad.exitCode).toBe(1);
    }),
  );

  effect("relay forget fails on a folder that holds no relay, naming it", () =>
    Effect.gen(function* () {
      const dir = join(yield* tempDir, "nowhere");
      const forgot = yield* cli(["relay", "forget", "den", "--dir", dir]);
      expect(forgot.exitCode).toBe(1);
      expect(forgot.stderr).toContain(dir);
      expect(forgot.stderr).toContain("--dir");
    }),
  );

  effect("a relay folder others can write to is refused, by the relay and by forget", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      yield* Effect.promise(() => writeFile(join(dir, "relay_key"), "", { mode: 0o600 }));
      yield* Effect.promise(() => chmod(dir, 0o777));
      const forgot = yield* cli(["relay", "forget", "den", "--dir", dir]);
      expect(forgot.exitCode).toBe(1);
      expect(forgot.stderr).toContain("chmod 700");
      const started = yield* cli([
        "relay",
        "--player-port",
        "0",
        "--gm-port",
        "0",
        "--bind",
        "127.0.0.1",
        "--dir",
        dir,
      ]);
      expect(started.exitCode).toBe(1);
      expect(started.stderr).toContain("chmod 700");
    }),
  );
});
