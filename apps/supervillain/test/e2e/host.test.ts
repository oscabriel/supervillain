import { describe, expect } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
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
          stdout: "Vex joins the table.\n",
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
    "runs from any folder, on a campaign folder given relative to it",
    () =>
      Effect.gen(function* () {
        const elsewhere = yield* tempDir;
        yield* Effect.promise(() => mkdir(join(elsewhere, "ford")));
        const host = yield* startHost(["ford", "--headless"], elsewhere);
        expect((yield* sshExec(host.port, "help")).exitCode).toBe(0);
        expect(existsSync(join(elsewhere, "ford", "host_key"))).toBe(true);
        expect(yield* Effect.promise(() => host.stop())).toBe(0);
      }),
    30_000,
  );

  effect(
    "a campaign folder that isn't there is refused, pointing at `new`, and nothing is made",
    () =>
      Effect.gen(function* () {
        const typo = join(yield* tempDir, "frod");
        const result = yield* cli(["host", typo, "--headless", "--port", "0"]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr.trim().split("\n")).toEqual([
          `supervillain: there's no campaign at ${typo}; make one with: bun supervillain new ${typo} (--example for the sample)`,
        ]);
        expect(existsSync(typo)).toBe(false);
      }),
  );

  effect("a port in use is one plain line saying what to do", () =>
    Effect.gen(function* () {
      const campaign = yield* tempDir;
      const busy = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
      try {
        const result = yield* cli(["host", campaign, "--headless", "--port", String(busy.port)]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr.trim().split("\n")).toEqual([
          `supervillain: port ${busy.port} on 127.0.0.1 is in use (another table?); pick another with --port, or --port 0 for any free one`,
        ]);
      } finally {
        busy.stop(true);
      }
    }),
  );
});
