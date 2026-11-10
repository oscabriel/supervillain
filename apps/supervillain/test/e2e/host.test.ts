import { describe, expect } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { effect } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";
import { campaignDir, cli, startHost } from "./cli.ts";
import { clientKey, sshExec, sshShell, waitFor } from "./openssh.ts";

const main = join(import.meta.dir, "../../src/main.ts");
const root = join(import.meta.dir, "../../../..");

/**
 * The host with the GM's seat in a real pseudo-terminal, once the table is drawn. `detached` runs
 * it in a session of its own, where the terminal going away sends it no hang-up.
 */
const seatedHost = (campaign: string, detached: boolean) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      let screen = "";
      const decoder = new TextDecoder();
      const command = ["bun", main, "host", campaign, "--port", "0", "--room", "den"];
      const proc = Bun.spawn(detached ? ["setsid", "--wait", ...command] : command, {
        cwd: root,
        env: { ...process.env, TERM: "xterm-256color" },
        terminal: {
          cols: 100,
          rows: 30,
          data: (_terminal, data) => {
            screen += decoder.decode(data, { stream: true });
          },
        },
      });
      const start = Date.now();
      let port: number | undefined;
      while (port === undefined || !screen.includes("at the table")) {
        if (Date.now() - start > 15_000)
          throw new Error(`the GM's table never came up:\n${screen}`);
        await Bun.sleep(20);
        const log = await readFile(join(campaign, "host.log"), "utf8").catch(() => "");
        const found = /on 127\.0\.0\.1:(\d+)/.exec(log);
        if (found) port = Number(found[1]);
      }
      // The lock names the host itself, which `setsid` stands in front of.
      const pid = Number(await readFile(join(campaign, "events.lock"), "utf8"));
      return { proc, pid, port, closeTerminal: () => proc.terminal?.close() };
    }),
    ({ proc, pid }) =>
      Effect.promise(async () => {
        for (const each of [pid, proc.pid]) {
          try {
            process.kill(each, "SIGKILL");
          } catch {
            // Gone already, as it should be.
          }
        }
        await proc.exited;
      }),
  );

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
        const campaign = yield* campaignDir;
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
        yield* Effect.promise(() => mkdir(join(elsewhere, "ford", "heroes"), { recursive: true }));
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

  effect(
    "an empty or unrelated folder is refused, pointing at `new`, and nothing is written in it",
    () =>
      Effect.gen(function* () {
        const empty = yield* tempDir;
        const refused = yield* cli(["host", empty, "--headless", "--port", "0"]);
        expect(refused.exitCode).toBe(1);
        expect(refused.stderr.trim().split("\n")).toEqual([
          `supervillain: ${empty} isn't a campaign: it has no campaign.yaml, events.jsonl, host_key, heroes/, monsters/ or maps/; make one there with: bun supervillain new ${empty} (--example for the sample)`,
        ]);
        expect(yield* Effect.promise(() => readdir(empty))).toEqual([]);

        const unrelated = yield* tempDir;
        yield* Effect.promise(() => writeFile(join(unrelated, "notes.txt"), "groceries\n"));
        const also = yield* cli(["host", unrelated, "--headless", "--port", "0"]);
        expect(also.exitCode).toBe(1);
        expect(also.stderr.trim().split("\n")).toEqual([
          `supervillain: ${unrelated} isn't a campaign: it has no campaign.yaml, events.jsonl, host_key, heroes/, monsters/ or maps/; make one in a new folder with: bun supervillain new <folder> (--example for the sample)`,
        ]);
        expect(yield* Effect.promise(() => readdir(unrelated))).toEqual(["notes.txt"]);
      }),
  );

  effect(
    "a campaign.yaml naming a ruleset the table doesn't know is one plain line, and no log is opened",
    () =>
      Effect.gen(function* () {
        const campaign = yield* campaignDir;
        const file = join(campaign, "campaign.yaml");
        yield* Effect.promise(() => writeFile(file, "rules: pathfinder\n"));
        const refused = yield* cli(["host", campaign, "--headless", "--port", "0"]);
        expect(refused.exitCode).toBe(1);
        expect(refused.stderr.trim().split("\n")).toEqual([
          `supervillain: ${file}: says rules: pathfinder, but a campaign plays draw-steel or set-world`,
        ]);
        expect(existsSync(join(campaign, "events.jsonl"))).toBe(false);
      }),
  );

  effect("a port in use is one plain line saying what to do", () =>
    Effect.gen(function* () {
      const campaign = yield* campaignDir;
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

  effect(
    "a port out of range, or a --bind that isn't an address, is one plain line",
    () =>
      Effect.gen(function* () {
        const campaign = yield* campaignDir;
        for (const [flags, said] of [
          [["--port", "99999"], "--port takes a port from 0 to 65535, not 99999"],
          [["--port", "-5"], "--port takes a port from 0 to 65535, not -5"],
          // Either would have the host listen on every interface.
          [
            ["--bind", "127.0.0.256"],
            '--bind takes an IP address, such as 127.0.0.1 or 0.0.0.0, or localhost, not "127.0.0.256"',
          ],
          [
            ["--bind", "127.0.0.1 "],
            '--bind takes an IP address, such as 127.0.0.1 or 0.0.0.0, or localhost, not "127.0.0.1 "',
          ],
        ] as const) {
          const result = yield* cli(["host", campaign, "--headless", ...flags, "--port", "0"]);
          expect(result.exitCode).toBe(1);
          expect(result.stderr.trim().split("\n")).toEqual([`supervillain: ${said}`]);
        }
      }),
    30_000,
  );
});

describe("supervillain host, the GM at its terminal", () => {
  for (const [how, detached] of [
    ["with a hang-up", false],
    ["without one", true],
  ] as const)
    effect(
      `the GM's terminal going away ${how} closes the table: players told, their terminals put back, no lock left`,
      () =>
        Effect.gen(function* () {
          const campaign = yield* campaignDir;
          const host = yield* seatedHost(campaign, detached);
          const terminal = yield* sshShell(host.port);
          yield* waitFor("the player's seat", () => terminal.text().includes("call you?"));
          host.closeTerminal();
          // With no hang-up the host learns of it when the GM's seat next draws: here, a new name.
          terminal.write("Kai\r");
          yield* waitFor("the host to stop", () => !existsSync(join(campaign, "events.lock")));
          yield* waitFor("the goodbye", () => terminal.text().includes("The GM closed the table."));
          const output = terminal.output();
          // Off the alternate screen first, so the notice stays on the player's own.
          expect(output.lastIndexOf("\x1b[?1049l")).toBeGreaterThan(
            output.lastIndexOf("\x1b[?1049h"),
          );
          expect(output.lastIndexOf("The GM closed the table.")).toBeGreaterThan(
            output.lastIndexOf("\x1b[?1049l"),
          );
        }),
      30_000,
    );
});
