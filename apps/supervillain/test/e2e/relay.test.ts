// The relay end to end, every part a real process: `supervillain relay`, `supervillain host
// --relay --headless`, and OpenSSH players who reach the table only through the relay.
import { describe, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import { join } from "node:path";
import { Effect } from "effect";
import { effect, waitFor } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";
import { clientKey, sshExec, sshShell } from "../relay/openssh.ts";

const main = join(import.meta.dir, "../../src/main.ts");
const root = join(import.meta.dir, "../../../..");

interface Child {
  /** Everything it has printed so far, stdout and stderr together. */
  readonly output: () => string;
  /** Sends `signal` and waits for the exit code. */
  readonly stop: (signal?: NodeJS.Signals) => Promise<number>;
}

/** `supervillain <args>` as a child for the life of the scope (or until stopped). */
const supervillain = (args: ReadonlyArray<string>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const proc = Bun.spawn(["bun", main, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      let output = "";
      const decoder = new TextDecoder();
      const pump = async (stream: ReadableStream<Uint8Array>) => {
        for await (const chunk of stream) output += decoder.decode(chunk, { stream: true });
      };
      void pump(proc.stdout);
      void pump(proc.stderr);
      const child: Child = {
        output: () => output,
        stop: async (signal = "SIGINT") => {
          if (proc.exitCode === null && proc.signalCode === null) proc.kill(signal);
          return proc.exited;
        },
      };
      return { child, proc };
    }),
    ({ proc }) =>
      Effect.promise(async () => {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
        await proc.exited;
      }),
  ).pipe(Effect.map(({ child }) => child));

/** A loopback port free right now, so a relay can come back on the same one after a restart. */
const freePort = Effect.promise(
  () =>
    new Promise<number>((resolve, reject) => {
      const server = createServer();
      // Two @types/node versions in one program leave net.Server without its EventEmitter methods.
      (server as unknown as NodeJS.EventEmitter).once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        server.close(() => resolve(port));
      });
    }),
);

interface Ports {
  readonly player: number;
  readonly gm: number;
}

/** `supervillain relay` on the given ports over `dir`, once it has said its key. */
const startRelay = (dir: string, ports: Ports) =>
  Effect.gen(function* () {
    const relay = yield* supervillain([
      "relay",
      "--player-port",
      String(ports.player),
      "--gm-port",
      String(ports.gm),
      "--bind",
      "127.0.0.1",
      "--dir",
      dir,
    ]);
    yield* waitFor("the relay to start", () => /^relay key /m.test(relay.output()), 15_000);
    const key = /relay key (SHA256:[A-Za-z0-9+/]{43})/.exec(relay.output())?.[1];
    if (key === undefined) throw new Error(`no relay key in:\n${relay.output()}`);
    return { ...relay, key };
  });

/** `supervillain host --headless --relay` for room den, once it has printed its host key. */
const startHost = (campaign: string, gmPort: number, extra: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const host = yield* supervillain([
      "host",
      campaign,
      "--headless",
      "--port",
      "0",
      "--room",
      "den",
      "--relay",
      `127.0.0.1:${gmPort}`,
      ...extra,
    ]);
    yield* waitFor("the host to start", () => /^host key /m.test(host.output()), 15_000);
    const hostKey = /host key (SHA256:[A-Za-z0-9+/]{43})/.exec(host.output())?.[1];
    return { ...host, hostKey: hostKey! };
  });

/** How many times the host has said its link came up. */
const links = (host: Child) => host.output().split('linked as room "den"').length - 1;

const logOf = (dir: string) =>
  Effect.promise(async () =>
    (await readFile(join(dir, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as { actor: string; type: string; payload: unknown }),
  );

const roomsOf = (relayDir: string) =>
  Effect.promise(
    async () =>
      JSON.parse(await readFile(join(relayDir, "rooms.json"), "utf8")) as Record<string, string>,
  );

describe("supervillain host --relay, through supervillain relay", () => {
  effect(
    "players sit at the table through the relay, as their own keys, and come back after a relay restart",
    () =>
      Effect.gen(function* () {
        const relayDir = yield* tempDir;
        const campaign = yield* tempDir;
        const keys = yield* tempDir;
        const vex = yield* clientKey(keys, "vex");
        const kai = yield* clientKey(keys, "kai");
        const ports = { player: yield* freePort, gm: yield* freePort };

        const relay = yield* startRelay(relayDir, ports);
        const host = yield* startHost(campaign, ports.gm, [
          "--relay-player-port",
          String(ports.player),
        ]);
        yield* waitFor("the link", () => links(host) === 1, 10_000);
        // The host trusted the relay's key on first use, said so, and pinned it.
        expect(host.output()).toContain(`trusted relay key ${relay.key} on first use`);
        const known = yield* Effect.promise(() => readFile(join(campaign, "relay_known"), "utf8"));
        expect(known.trim()).toBe(relay.key);
        // The relay claimed the room for this campaign's host key.
        expect(yield* roomsOf(relayDir)).toEqual({ den: host.hostKey });
        expect(host.output()).toContain(`players join with: ssh -p ${ports.player} den@127.0.0.1`);
        // Players' ssh meets the relay's host key there, not this table's, and the GM is told so.
        expect(host.output()).toContain("players' ssh sees the relay's host key");
        expect(host.output()).toContain(
          `host key ${host.hostKey} (this table's: direct connections only)`,
        );
        expect(host.output()).toMatch(
          /players here can also join directly: ssh -p \d+ den@127\.0\.0\.1/,
        );

        // One player by exec, one in a pseudo-terminal.
        const rolled = yield* sshExec(ports.player, ["roll", "2d6"], { key: vex, user: "den" });
        expect(rolled.exitCode).toBe(0);
        expect(rolled.stdout).toMatch(/ rolled 2d6: \[[1-6], [1-6]\] = \d+\n$/);
        const terminal = yield* sshShell(
          ports.player,
          { cols: 100, rows: 30 },
          { key: kai, user: "den" },
        );
        yield* waitFor("the name prompt", () =>
          Bun.stripANSI(terminal.output()).includes("type the name you want"),
        );
        terminal.write("Kai\r");
        yield* Effect.promise(async () => {
          const start = Date.now();
          while (!(await readFile(join(campaign, "events.jsonl"), "utf8")).includes('"Kai"')) {
            if (Date.now() - start > 5000) throw new Error("Kai's name never reached the log");
            await Bun.sleep(20);
          }
        });
        const log = yield* logOf(campaign);
        expect(log.map((e) => [e.actor, e.type])).toEqual([
          [`key:${vex.fingerprint}`, "core.dice-rolled"],
          [`key:${kai.fingerprint}`, "core.name-set"],
        ]);

        // A player whose ssh offers an RSA key first, as OpenSSH's defaults do.
        const rsa = yield* clientKey(keys, "rsa", "rsa");
        const offered = yield* sshExec(ports.player, ["roll", "1d2"], {
          key: vex,
          user: "den",
          flags: ["-i", rsa.path],
        });
        expect(offered).toMatchObject({ exitCode: 0, stdout: expect.stringMatching(/rolled 1d2/) });

        // A second GM, with its own host key, can't take the room.
        const usurper = yield* startHost(yield* tempDir, ports.gm);
        yield* waitFor(
          "the relay to refuse the second GM",
          () => relay.output().includes(`refused a GM with host key ${usurper.hostKey}`),
          10_000,
        );
        expect(links(usurper)).toBe(0);
        // Its GM is told what that may mean, not just that the link closed.
        yield* waitFor("the usurper's warning", () =>
          usurper.output().includes("another GM's host key may hold room den there"),
        );
        expect(yield* roomsOf(relayDir)).toEqual({ den: host.hostKey });
        yield* Effect.promise(() => usurper.stop());

        // The relay goes away: the seated player's connection with it. It comes back on the same
        // ports and folder, the host redials, and players can join again.
        expect(yield* Effect.promise(() => relay.stop("SIGKILL"))).not.toBe(0);
        yield* Effect.promise(() => terminal.exited);
        yield* waitFor(
          "the host to notice",
          () => host.output().includes("connecting (the link dropped)"),
          10_000,
        );
        const back = yield* startRelay(relayDir, ports);
        expect(back.key).toBe(relay.key);
        yield* waitFor("the redial", () => links(host) === 2, 15_000);
        const again = yield* sshExec(ports.player, ["/name Vex"], { key: vex, user: "den" });
        expect(again).toMatchObject({
          exitCode: 0,
          stdout: expect.stringMatching(/is now Vex\n$/),
        });
        expect((yield* logOf(campaign)).at(-1)).toMatchObject({
          actor: `key:${vex.fingerprint}`,
          type: "core.name-set",
        });

        // The GM stops the table: a seated player is told, and the relay reports the link gone.
        const seated = yield* sshShell(
          ports.player,
          { cols: 100, rows: 30 },
          { key: kai, user: "den" },
        );
        yield* waitFor("Kai's seat", () => Bun.stripANSI(seated.output()).includes("Kai"));
        expect(yield* Effect.promise(() => host.stop())).toBe(0);
        yield* waitFor(
          "the goodbye",
          () => Bun.stripANSI(seated.output()).includes("The GM closed the table."),
          10_000,
        );
        yield* Effect.promise(() => seated.exited);
        yield* waitFor("the relay to see the link go", () =>
          back.output().includes("room den: GM link closed"),
        );
        const closed = yield* sshExec(ports.player, ["help"], { key: vex, user: "den" });
        expect(closed).toMatchObject({
          exitCode: 1,
          stderr: "The table den isn't open right now.\n",
        });
      }),
    90_000,
  );

  effect(
    "a relay stopped with SIGTERM puts players' terminals back before it says so",
    () =>
      Effect.gen(function* () {
        const kai = yield* clientKey(yield* tempDir, "kai");
        const ports = { player: yield* freePort, gm: yield* freePort };
        const relay = yield* startRelay(yield* tempDir, ports);
        const host = yield* startHost(yield* tempDir, ports.gm);
        yield* waitFor("the link", () => links(host) === 1, 10_000);
        const terminal = yield* sshShell(
          ports.player,
          { cols: 100, rows: 30 },
          { key: kai, user: "den" },
        );
        yield* waitFor("the name prompt", () =>
          Bun.stripANSI(terminal.output()).includes("type the name you want"),
        );
        // The table put the player's terminal on the alternate screen.
        expect(terminal.output()).toContain("\x1b[?1049h");
        expect(yield* Effect.promise(() => relay.stop("SIGTERM"))).toBe(0);
        yield* Effect.promise(() => terminal.exited);
        const output = terminal.output();
        const notice = output.lastIndexOf("The relay is shutting down.");
        expect(notice).toBeGreaterThan(-1);
        // Off the alternate screen, cursor shown, mouse off, before the notice, which has its own line.
        expect(output.lastIndexOf("\x1b[?1049l")).toBeLessThan(notice);
        expect(output.lastIndexOf("\x1b[?1049l")).toBeGreaterThan(
          output.lastIndexOf("\x1b[?1049h"),
        );
        expect(output.lastIndexOf("\x1b[?25h")).toBeLessThan(notice);
        expect(output.slice(notice - 2, notice)).toBe("\r\n");
      }),
    60_000,
  );

  effect(
    "a host that dies mid-game: a relayed pty player sees The table closed.",
    () =>
      Effect.gen(function* () {
        const relayDir = yield* tempDir;
        const campaign = yield* tempDir;
        const kai = yield* clientKey(yield* tempDir, "kai");
        const ports = { player: yield* freePort, gm: yield* freePort };
        yield* startRelay(relayDir, ports);
        const host = yield* startHost(campaign, ports.gm);
        yield* waitFor("the link", () => links(host) === 1, 10_000);
        const terminal = yield* sshShell(
          ports.player,
          { cols: 100, rows: 30 },
          { key: kai, user: "den" },
        );
        yield* waitFor("the name prompt", () =>
          Bun.stripANSI(terminal.output()).includes("type the name you want"),
        );
        yield* Effect.promise(() => host.stop("SIGKILL"));
        yield* waitFor(
          "the notice",
          () => Bun.stripANSI(terminal.output()).includes("The table closed."),
          10_000,
        );
        expect(yield* Effect.promise(() => terminal.exited)).toBe(1);
      }),
    60_000,
  );

  effect(
    "a host refuses a relay whose key isn't the one in relay_known, and keeps the pin",
    () =>
      Effect.gen(function* () {
        const campaign = yield* tempDir;
        const vex = yield* clientKey(yield* tempDir, "vex");
        const realPorts = { player: yield* freePort, gm: yield* freePort };
        const real = yield* startRelay(yield* tempDir, realPorts);
        const first = yield* startHost(campaign, realPorts.gm);
        yield* waitFor("the link", () => links(first) === 1, 10_000);
        expect(yield* Effect.promise(() => first.stop())).toBe(0);

        // Another relay, with its own key, where the host is pointed next.
        const fakePorts = { player: yield* freePort, gm: yield* freePort };
        const fake = yield* startRelay(yield* tempDir, fakePorts);
        expect(fake.key).not.toBe(real.key);
        const host = yield* startHost(campaign, fakePorts.gm);
        yield* waitFor(
          "the host to refuse the relay",
          () => host.output().includes(`its key ${fake.key} doesn't match ${real.key}`),
          10_000,
        );
        expect(host.output()).toContain("Not redialing until that's fixed.");
        expect(links(host)).toBe(0);
        yield* waitFor("the relay to log the refusal", () =>
          fake.output().includes("refused this relay's key"),
        );
        const known = yield* Effect.promise(() => readFile(join(campaign, "relay_known"), "utf8"));
        expect(known.trim()).toBe(real.key);
        // It never logged in, so it never claimed the room either.
        const turnedAway = yield* sshExec(fakePorts.player, ["help"], { key: vex, user: "den" });
        expect(turnedAway).toMatchObject({
          exitCode: 1,
          stderr: "There's no table called den here.\n",
        });

        // A --relay-key pin on the command line is held to as well.
        expect(yield* Effect.promise(() => host.stop())).toBe(0);
        const pinned = yield* startHost(campaign, fakePorts.gm, ["--relay-key", real.key]);
        yield* waitFor(
          "the pinned host to refuse the relay",
          () => pinned.output().includes(`doesn't match --relay-key ${real.key}`),
          10_000,
        );
      }),
    60_000,
  );
});
