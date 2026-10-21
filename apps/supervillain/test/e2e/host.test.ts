import { describe, expect } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { effect } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";
import { cli, startHost } from "./cli.ts";
import { clientKey, sshExec, sshShell, waitFor } from "./openssh.ts";

const logOf = (dir: string) =>
  Effect.promise(async () =>
    (await readFile(join(dir, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as { seq: number; actor: string; type: string; payload: unknown }),
  );

describe("supervillain host --headless", () => {
  effect(
    "players reach the table over real ssh: exec commands, a pty seat, and a clean stop",
    () =>
      Effect.gen(function* () {
        const campaign = yield* tempDir;
        const vex = yield* clientKey(yield* tempDir, "vex");
        const host = yield* startHost([campaign, "--headless", "--room", "den"]);
        expect(host.output()).toContain(`ssh -p ${host.port} den@127.0.0.1`);
        expect(host.output()).toMatch(/host key SHA256:[A-Za-z0-9+/]{43}/);

        const label = vex.fingerprint.slice("SHA256:".length, "SHA256:".length + 8);
        const rolled = yield* sshExec(host.port, "roll 2d6", vex);
        expect(rolled).toMatchObject({ exitCode: 0, stderr: "" });
        expect(rolled.stdout).toMatch(/^.{8} rolled 2d6: \[[1-6], [1-6]\] = \d+\n$/);
        expect(rolled.stdout.startsWith(`${label} rolled`)).toBe(true);

        expect(yield* sshExec(host.port, "/name Vex", vex)).toMatchObject({
          exitCode: 0,
          stdout: `${label} is now Vex\n`,
        });
        expect(yield* sshExec(host.port, "hello everyone", vex)).toMatchObject({
          exitCode: 0,
          stdout: "Vex: hello everyone\n",
        });
        expect(yield* sshExec(host.port, "/narrate The sky falls.", vex)).toMatchObject({
          exitCode: 1,
          stdout: "",
          stderr: "Only the GM can use /narrate.\n",
        });
        const guest = yield* sshExec(host.port, "roll d6");
        expect(guest.exitCode).toBe(0);
        expect(guest.stdout).toMatch(/^guest-.{4} rolled 1d6: \[[1-6]\] = [1-6]\n$/);

        const log = yield* logOf(campaign);
        expect(log.map((e) => [e.seq, e.type])).toEqual([
          [1, "core.dice-rolled"],
          [2, "core.name-set"],
          [3, "core.chat-posted"],
          [4, "core.dice-rolled"],
        ]);
        expect(log.slice(0, 3).map((e) => e.actor)).toEqual(
          Array(3).fill(`key:${vex.fingerprint}`),
        );
        expect(log[1]!.payload).toEqual({ name: "Vex" });
        expect(log[3]!.actor).toMatch(/^guest:/);

        // A pty seat: Vex is named already, so the table opens on the feed.
        const terminal = yield* sshShell(host.port, vex);
        yield* waitFor("the feed", () => terminal.text().includes("everyone"));
        terminal.write("from the pty\r");
        yield* Effect.promise(async () => {
          const start = Date.now();
          while ((await readFile(join(campaign, "events.jsonl"), "utf8")).split("\n").length < 6) {
            if (Date.now() - start > 5000) throw new Error("the pty chat never reached the log");
            await Bun.sleep(20);
          }
        });
        expect((yield* logOf(campaign)).at(-1)).toMatchObject({
          seq: 5,
          actor: `key:${vex.fingerprint}`,
          payload: { text: "from the pty" },
        });

        expect(yield* Effect.promise(() => host.stop())).toBe(0);
        expect(existsSync(join(campaign, "events.lock"))).toBe(false);
      }),
    30_000,
  );

  effect(
    "runs from any folder, and makes a new campaign folder only its owner can read",
    () =>
      Effect.gen(function* () {
        const campaign = join(yield* tempDir, "new-campaign");
        const elsewhere = yield* tempDir;
        const host = yield* startHost([campaign, "--headless"], elsewhere);
        expect((yield* sshExec(host.port, "help")).exitCode).toBe(0);
        expect((yield* Effect.promise(() => stat(campaign))).mode & 0o777).toBe(0o700);
        expect(yield* Effect.promise(() => host.stop())).toBe(0);
      }),
    30_000,
  );

  effect("a campaign folder that can't be made is one plain line, not a stack trace", () =>
    Effect.gen(function* () {
      const result = yield* cli(["host", "/proc/nope/campaign", "--headless"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.trim().split("\n")).toEqual([
        expect.stringMatching(
          /^supervillain: can't make the campaign folder \/proc\/nope\/campaign: /,
        ),
      ]);
    }),
  );
});
