import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { serve } from "@supervillain/ssh";
import { Context, Duration, Effect, Layer, Logger, Random } from "effect";
import { TestClock } from "effect/testing";
import {
  joinNote,
  linkAlert,
  parseRelayAddress,
  RelayLink,
  type RelayLinkOptions,
  type RelayStatus,
  redialDelay,
  relayJoinCommand,
  roomSlug,
} from "../../src/host/RelayLink.ts";
import { tableServices } from "../../src/host/services.ts";
import { TableServer } from "../../src/host/TableServer.ts";
import { helloLine, OK_LINE, readLine } from "../../src/relay/protocol.ts";
import { type ClientKey, clientKey } from "../e2e/openssh.ts";
import { effect, waitFor } from "./effect.ts";
import { tempDir } from "./tempDir.ts";

const PLAYER = `key:SHA256:${"A1b2+/".repeat(7)}C`;

/** A loopback TCP listener for the life of the scope. */
const listen = (onSocket: (socket: Socket) => void) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ server: Server; port: number; sockets: Set<Socket> }>((resolve) => {
          const sockets = new Set<Socket>();
          const server = createServer((socket) => {
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
            socket.on("error", () => socket.destroy());
            onSocket(socket);
          });
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            resolve({
              server,
              sockets,
              port: typeof address === "object" && address ? address.port : 0,
            });
          });
        }),
    ),
    ({ server, sockets }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => resolve());
          }),
      ),
  );

const sshArgs = (port: number, key: ClientKey, more: ReadonlyArray<string>) => [
  "ssh",
  "-F",
  "/dev/null",
  "-p",
  String(port),
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "LogLevel=ERROR",
  "-o",
  "IdentityAgent=none",
  "-o",
  "IdentitiesOnly=yes",
  "-o",
  "BatchMode=yes",
  "-i",
  key.path,
  ...more,
];

/**
 * A relay as far as the GM's host can tell: it answers each hello with `answer(n)`, and then
 * OpenSSH, as the relay's SSH client, logs in over the latest link through a forwarder (OpenSSH
 * can't speak over a socket we hand it). Players' end is left out: the test plays the relay.
 */
const fakeRelay = (answer: (n: number) => string = () => OK_LINE) =>
  Effect.gen(function* () {
    const hellos: string[] = [];
    const links: Socket[] = [];
    const gm = yield* listen((socket) => {
      readLine(socket).then(
        (line) => {
          const reply = answer(hellos.length);
          hellos.push(line);
          socket.write(reply);
          if (reply === OK_LINE) links.push(socket);
          else socket.end();
        },
        () => socket.destroy(),
      );
    });
    const forwarder = yield* listen((socket) => {
      const link = links.at(-1);
      if (!link) return void socket.destroy();
      socket.pipe(link);
      link.pipe(socket);
    });
    /** Runs `ssh … den@127.0.0.1 <command>` as the relay, seating `actor`. */
    const exec = (key: ClientKey, command: string, actor = PLAYER) =>
      Effect.promise(async () => {
        const proc = Bun.spawn(
          sshArgs(forwarder.port, key, [
            "-o",
            `SetEnv=SV_ACTOR=${actor}`,
            "den@127.0.0.1",
            command,
          ]),
          { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        );
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { stdout, stderr, exitCode };
      });
    /** Logs in as the relay and holds the link with no session, for the life of the scope. */
    const hold = (key: ClientKey) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          Bun.spawn(sshArgs(forwarder.port, key, ["-N", "den@127.0.0.1"]), {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          }),
        ),
        (proc) =>
          Effect.promise(async () => {
            proc.kill("SIGKILL");
            await proc.exited;
          }),
      );
    return { port: gm.port, hellos, links, exec, hold };
  });

/** An SSH server whose exec prints the relayed player, or `-`. */
const gmServer = (sessionStartMs?: number) =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    return yield* serve({
      hostKeyPath: join(dir, "host_key"),
      port: 0,
      host: "127.0.0.1",
      onShell: () => Effect.void,
      onExec: (session) =>
        Effect.sync(() => {
          session.write(session.info.relayedActor ?? "-");
          return 0;
        }),
      ...(sessionStartMs === undefined ? {} : { timeouts: { sessionStartMs } }),
    });
  });

/** The GM's host linked to `relayPort`, with its campaign folder. */
const linked = (relayPort: number, more: Partial<RelayLinkOptions> = {}, sessionStartMs?: number) =>
  Effect.gen(function* () {
    const server = yield* gmServer(sessionStartMs);
    const campaignDir = yield* tempDir;
    const link = yield* RelayLink.make({
      host: "127.0.0.1",
      port: relayPort,
      room: "den",
      campaignDir,
      attach: server.attach,
      ...more,
    });
    const status = () => Effect.runSync(link.status.get);
    return { link, campaignDir, status };
  });

/** No jitter, so redial delays are exactly 1 s, 2 s, 4 s… */
const steadyRandom = Effect.provideService(Random.Random, {
  nextDoubleUnsafe: () => 0.5,
  nextIntUnsafe: () => 0,
});

/** Runs with a TestClock and no jitter, and without log output. */
const controlled = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  body.pipe(steadyRandom, Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([])));

/** Gives anything that shouldn't happen a moment to happen. */
const moment = Effect.promise(() => Bun.sleep(150));

/** Moves the TestClock on, once whatever is about to sleep has had a moment to start sleeping. */
const advance = (duration: Duration.Input) => Effect.andThen(moment, TestClock.adjust(duration));

const isState = (state: RelayStatus["state"]) => (s: RelayStatus) => s.state === state;

describe("RelayLink", () => {
  effect(
    "links, serves the relay's players, pins its key on first use and refuses another for good",
    () =>
      controlled(
        Effect.gen(function* () {
          const keys = yield* tempDir;
          const relayKey = yield* clientKey(keys, "relay");
          const mallory = yield* clientKey(keys, "mallory");
          const relay = yield* fakeRelay();
          const { campaignDir, status } = yield* linked(relay.port);
          const known = join(campaignDir, "relay_known");

          yield* waitFor("the hello", () => relay.links.length === 1);
          expect(relay.hellos).toEqual([helloLine("den").trimEnd()]);
          expect(status()).toEqual({ state: "connecting" });
          // Nothing is trusted yet: the plaintext exchange named no key.
          expect(existsSync(known)).toBe(false);

          const served = yield* relay.exec(relayKey, "who");
          expect(served).toMatchObject({ stdout: PLAYER, exitCode: 0 });
          expect((yield* Effect.promise(() => readFile(known, "utf8"))).trim()).toBe(
            relayKey.fingerprint,
          );

          // The relay's client went, and the link with it: the host redials after a second.
          yield* waitFor("the drop", () => status().state === "connecting");
          expect(status()).toEqual({ state: "connecting", lastError: "the link dropped" });
          yield* advance("1 second");
          yield* waitFor("the redial", () => relay.links.length === 2);

          // A relay with another key is refused, loudly, and never redialed.
          expect((yield* relay.exec(mallory, "who")).exitCode).toBe(255);
          yield* waitFor("the refusal", () => isState("refused")(status()));
          const refused = status();
          expect(refused).toMatchObject({ state: "refused", retrying: false });
          expect(refused.state === "refused" && refused.reason).toContain(mallory.fingerprint);
          expect(refused.state === "refused" && refused.reason).toContain(known);
          yield* advance("10 minutes");
          yield* moment;
          expect(relay.hellos).toHaveLength(2);
          expect((yield* Effect.promise(() => readFile(known, "utf8"))).trim()).toBe(
            relayKey.fingerprint,
          );

          // The GM decides the relay's key really changed and says so in the file.
          yield* Effect.promise(() => writeFile(known, `${mallory.fingerprint}\n`));
          yield* advance("5 seconds");
          yield* waitFor("the link after the fix", () => relay.links.length === 3);
          expect(yield* relay.exec(mallory, "who")).toMatchObject({ stdout: PLAYER, exitCode: 0 });
        }),
      ),
    30_000,
  );

  effect(
    "--relay-key pins the key: relay_known is neither read nor written",
    () =>
      controlled(
        Effect.gen(function* () {
          const keys = yield* tempDir;
          const relayKey = yield* clientKey(keys, "relay");
          const other = yield* clientKey(keys, "other");
          const relay = yield* fakeRelay();
          const { campaignDir, status } = yield* linked(relay.port, {
            relayKey: relayKey.fingerprint,
          });
          // Even a relay_known naming another key doesn't count against the pin.
          yield* Effect.promise(() =>
            writeFile(join(campaignDir, "relay_known"), `${other.fingerprint}\n`),
          );

          yield* waitFor("the hello", () => relay.links.length === 1);
          expect(yield* relay.exec(relayKey, "who")).toMatchObject({ stdout: PLAYER, exitCode: 0 });
          yield* advance("1 second");
          yield* waitFor("the redial", () => relay.links.length === 2);

          expect((yield* relay.exec(other, "who")).exitCode).toBe(255);
          yield* waitFor("the refusal", () => isState("refused")(status()));
          expect(status()).toMatchObject({ state: "refused", retrying: false });
          const refused = status();
          expect(refused.state === "refused" && refused.reason).toContain("--relay-key");
          yield* advance("10 minutes");
          yield* moment;
          expect(relay.hellos).toHaveLength(2);
          expect(
            (yield* Effect.promise(() =>
              readFile(join(campaignDir, "relay_known"), "utf8"),
            )).trim(),
          ).toBe(other.fingerprint);
        }),
      ),
    30_000,
  );

  effect(
    "a link that carries nobody stays up past the session-start timer",
    () =>
      Effect.gen(function* () {
        const relayKey = yield* clientKey(yield* tempDir, "relay");
        const relay = yield* fakeRelay();
        const { status } = yield* linked(relay.port, {}, 150);
        yield* waitFor("the hello", () => relay.links.length === 1);
        const proc = yield* relay.hold(relayKey);
        yield* waitFor("the login", () => isState("connected")(status()));
        expect(status()).toEqual({
          state: "connected",
          relayKey: relayKey.fingerprint,
          firstUse: true,
        });
        // Well past the 150 ms a connection without a session would be given.
        yield* Effect.promise(() => Bun.sleep(700));
        expect(isState("connected")(status())).toBe(true);
        expect(relay.hellos).toHaveLength(1);
        expect(proc.exitCode).toBeNull();
      }).pipe(Effect.provide(Logger.layer([]))),
    20_000,
  );

  effect(
    "a dropped link is redialed after 1 s, then 2 s, …; an ERR answer shows as the status",
    () =>
      controlled(
        Effect.gen(function* () {
          const relayKey = yield* clientKey(yield* tempDir, "relay");
          const relay = yield* fakeRelay((n) => (n === 0 ? OK_LINE : "ERR room den is busy\n"));
          const { status } = yield* linked(relay.port);
          yield* waitFor("the hello", () => relay.links.length === 1);
          yield* relay.hold(relayKey);
          yield* waitFor("the login", () => isState("connected")(status()));

          relay.links[0]!.destroy();
          yield* waitFor("the drop", () => isState("connecting")(status()));
          yield* advance("999 millis");
          yield* moment;
          expect(relay.hellos).toHaveLength(1);
          yield* advance("1 millis");
          yield* waitFor("the first redial", () => relay.hellos.length === 2);
          yield* waitFor("the ERR", () => isState("refused")(status()));
          expect(status()).toEqual({
            state: "refused",
            reason: "room den is busy",
            retrying: true,
          });

          yield* advance("1999 millis");
          yield* moment;
          expect(relay.hellos).toHaveLength(2);
          yield* advance("1 millis");
          yield* waitFor("the second redial", () => relay.hellos.length === 3);
          yield* moment;
          yield* advance("3999 millis");
          yield* moment;
          expect(relay.hellos).toHaveLength(3);
          yield* advance("1 millis");
          yield* waitFor("the third redial", () => relay.hellos.length === 4);
        }),
      ),
    30_000,
  );

  effect(
    "a relay that never answers the hello is given up on, and redialed",
    () =>
      controlled(
        Effect.gen(function* () {
          let dialed = 0;
          const silent = yield* listen(() => void dialed++);
          const { status } = yield* linked(silent.port);
          yield* waitFor("the dial", () => dialed === 1);
          yield* advance("10 seconds");
          yield* waitFor(
            "the timeout",
            () => status().state === "connecting" && "lastError" in status(),
          );
          expect(status()).toEqual({
            state: "connecting",
            lastError: "the relay didn't answer the hello",
          });
          yield* advance("1 second");
          yield* waitFor("the redial", () => dialed === 2);
        }),
      ),
    20_000,
  );

  effect(
    "the table server links when given a relay, and its seats serve relayed players",
    () =>
      Effect.gen(function* () {
        const relayKey = yield* clientKey(yield* tempDir, "relay");
        const relay = yield* fakeRelay();
        const dir = yield* tempDir;
        const layer = TableServer.layer({
          campaignDir: dir,
          room: "den",
          port: 0,
          bind: "127.0.0.1",
          relay: { host: "127.0.0.1", port: relay.port },
        }).pipe(Layer.provideMerge(tableServices(dir)));
        const context = yield* Layer.build(layer.pipe(Layer.provide(Logger.layer([]))));
        const server = Context.get(context, TableServer);
        expect(server.relay?.joinCommand).toBe("ssh -p 2222 den@127.0.0.1");
        yield* waitFor("the hello", () => relay.links.length === 1);
        const said = yield* relay.exec(relayKey, "/say hello from afar");
        expect(said.exitCode).toBe(0);
        const log = yield* Effect.promise(() => readFile(join(dir, "events.jsonl"), "utf8"));
        expect(log).toContain(`"actor":"${PLAYER}"`);
        expect(log).toContain("hello from afar");
      }),
    20_000,
  );
});

describe("relay odds and ends", () => {
  test("redials back off from 1 s, doubling to 30 s, jittered by a fifth either way", () => {
    const delays = (r: number) =>
      [0, 1, 2, 3, 4, 5, 6, 40].map((attempt) =>
        Effect.runSync(
          redialDelay(attempt).pipe(
            Effect.provideService(Random.Random, {
              nextDoubleUnsafe: () => r,
              nextIntUnsafe: () => 0,
            }),
            Effect.map(Duration.toMillis),
          ),
        ),
      );
    expect(delays(0.5)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(delays(0)).toEqual([800, 1600, 3200, 6400, 12800, 24000, 24000, 24000]);
  });

  test("--relay takes host:port, a bare host, or a bracketed IPv6 address", () => {
    expect(parseRelayAddress("relay.example:7022")).toEqual({ host: "relay.example", port: 7022 });
    expect(parseRelayAddress("relay.example")).toEqual({ host: "relay.example", port: 7022 });
    expect(parseRelayAddress("[::1]:7100")).toEqual({ host: "::1", port: 7100 });
    for (const bad of ["", ":7022", "relay:0", "relay:70000", "relay:x", "a b:1"])
      expect(parseRelayAddress(bad)).toBeUndefined();
  });

  test("a campaign folder's name becomes a room name players can type", () => {
    expect(roomSlug("den")).toBe("den");
    expect(roomSlug("The Iron Den!")).toBe("the-iron-den");
    expect(roomSlug("2026 campaign")).toBe("campaign");
    expect(roomSlug("x".repeat(40))).toBe("x".repeat(32));
    expect(roomSlug("???")).toBe("table");
  });

  test("players join through the relay's player port, 2222 unless the GM says otherwise", () => {
    expect(relayJoinCommand("den", "relay.example")).toBe("ssh -p 2222 den@relay.example");
    expect(relayJoinCommand("den", "relay.example", 2200)).toBe("ssh -p 2200 den@relay.example");
    expect(relayJoinCommand("den", "relay.example", 22)).toBe("ssh den@relay.example");
  });

  test("the GM's band says how players join, or how the relay is doing", () => {
    const join = "ssh -p 2222 den@relay.example";
    const fp = `SHA256:${"a".repeat(43)}`;
    expect(joinNote({ state: "connected", relayKey: fp, firstUse: false }, join)).toBe(
      `players join with: ${join}`,
    );
    expect(joinNote({ state: "connected", relayKey: fp, firstUse: true }, join)).toBe(
      `players join with: ${join} · relay key ${fp} trusted on first use`,
    );
    expect(joinNote({ state: "connecting" }, join)).toBe("relay: connecting…");
    expect(joinNote({ state: "connecting", lastError: "the link dropped" }, join)).toBe(
      "relay: connecting… (the link dropped)",
    );
    expect(joinNote({ state: "refused", reason: "room den is busy", retrying: true }, join)).toBe(
      "relay refused: room den is busy",
    );
  });

  test("the GM's header says when the link isn't up, and nothing while it is", () => {
    const fp = `SHA256:${"a".repeat(43)}`;
    expect(linkAlert({ state: "connected", relayKey: fp, firstUse: true })).toBeUndefined();
    expect(linkAlert({ state: "connecting" })).toBe("relay: connecting…");
    expect(linkAlert({ state: "connecting", lastError: "the link dropped" })).toBe(
      "relay: down, redialing",
    );
    expect(linkAlert({ state: "refused", reason: "busy", retrying: true })).toBe(
      "relay: refused, redialing",
    );
    expect(linkAlert({ state: "refused", reason: "its key …", retrying: false })).toBe(
      "relay: refused, see host.log",
    );
  });
});
