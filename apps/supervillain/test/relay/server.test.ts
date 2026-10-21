import { describe, expect } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { TERMINAL_RESET } from "@supervillain/ssh";
import { Effect, Exit, Fiber, Scope } from "effect";
import { closedRoomMessage, readLine } from "../../src/relay/protocol.ts";
import { forgetRoom } from "../../src/relay/rooms.ts";
import { claimLimiter } from "../../src/relay/server.ts";
import { effect, waitFor } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";
import { gmTable, linkGm, startRelay } from "./harness.ts";
import { clientKey, sshExec, sshShell } from "./openssh.ts";

/** Waits until the relay has `room` linked, or doesn't. */
const linked = (relay: { linkedRooms: () => ReadonlyArray<string> }, room: string, up = true) =>
  waitFor(`room ${room} ${up ? "linked" : "unlinked"}`, () =>
    up ? relay.linkedRooms().includes(room) : !relay.linkedRooms().includes(room),
  );

/** A GM table linked to the relay as `room`, ready for players. */
const openTable = (relay: Effect.Success<ReturnType<typeof startRelay>>, room = "den") =>
  Effect.gen(function* () {
    const gm = yield* gmTable();
    const link = yield* linkGm(gm, relay.gmPort, room, relay.relayKeyFingerprint);
    expect(link.answer).toBe("OK");
    yield* linked(relay, room);
    return { gm, link };
  });

/** Runs `body` in its own scope and closes it, so a test can end a link while it goes on. */
const scoped = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const value = yield* body.pipe(Scope.provide(scope));
    return { value, close: Scope.close(scope, Exit.void) };
  });

describe("relay: players reach the GM's table", () => {
  effect("an exec is bridged as the player: output, stderr, exit status and stdin to EOF", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay();
      yield* openTable(relay);
      const key = yield* clientKey(yield* tempDir, "vex");
      const ran = yield* sshExec(relay.playerPort, ["roll", "2d10"], { key });
      expect(ran).toEqual({
        stdout: `exec key:${key.fingerprint} roll 2d10\n`,
        stderr: "note\n",
        exitCode: 0,
      });
      expect((yield* sshExec(relay.playerPort, ["fail"], { key })).exitCode).toBe(3);
      const piped = yield* sshExec(relay.playerPort, ["cat"], { key, stdin: "one\ntwo\n" });
      expect(piped).toMatchObject({ stdout: "ONE\nTWO\n", exitCode: 0 });
    }),
  );

  effect("a player with an RSA key is seated as that key, even with it offered first", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay();
      yield* openTable(relay);
      const dir = yield* tempDir;
      const rsa = yield* clientKey(dir, "rsa", "rsa");
      const ed = yield* clientKey(dir, "ed");
      const alone = yield* sshExec(relay.playerPort, ["hi"], { key: rsa });
      expect(alone).toEqual({
        stdout: `exec key:${rsa.fingerprint} hi\n`,
        stderr: "note\n",
        exitCode: 0,
      });
      const both = yield* sshExec(relay.playerPort, ["hi"], { key: ed, flags: ["-i", rsa.path] });
      expect(both).toMatchObject({ stdout: `exec key:${rsa.fingerprint} hi\n`, exitCode: 0 });
    }),
  );

  effect("a room's name is typed in any case", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay();
      yield* openTable(relay);
      const key = yield* clientKey(yield* tempDir, "vex");
      const ran = yield* sshExec(relay.playerPort, ["hi"], { key, user: "Den" });
      expect(ran).toMatchObject({ stdout: `exec key:${key.fingerprint} hi\n`, exitCode: 0 });
    }),
  );

  effect("a keyless player is seated as a guest", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay();
      yield* openTable(relay);
      const ran = yield* sshExec(relay.playerPort, ["hi"], {});
      expect(ran.exitCode).toBe(0);
      expect(ran.stdout).toMatch(/^exec guest:[A-Za-z0-9_-]{1,64} hi\n$/);
    }),
  );

  effect("a shell is bridged with its pty, env, window-changes, keystrokes and exit status", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay();
      yield* openTable(relay);
      const key = yield* clientKey(yield* tempDir, "vex");
      const terminal = yield* sshShell(
        relay.playerPort,
        { cols: 100, rows: 30 },
        { key, flags: ["-o", "SetEnv=COLORTERM=truecolor LD_PRELOAD=/evil.so"] },
      );
      yield* waitFor("the seat", () =>
        terminal
          .output()
          .includes(
            `seat key:${key.fingerprint} xterm-256color 100x30 pty=true env={"COLORTERM":"truecolor"}|`,
          ),
      );
      terminal.resize(120, 40);
      yield* waitFor("the resize", () => terminal.output().includes("resize 120x40|"));
      terminal.write("x");
      yield* waitFor("the echo", () => terminal.output().includes("echo:x|"));
      terminal.write("q");
      expect(yield* Effect.promise(() => terminal.exited)).toBe(5);
    }),
  );

  effect("a player who leaves closes their channel at the GM", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay();
      const { gm } = yield* openTable(relay);
      const key = yield* clientKey(yield* tempDir, "vex");
      const terminal = yield* sshShell(relay.playerPort, { cols: 80, rows: 24 }, { key });
      yield* waitFor("the seat", () => terminal.output().includes("seat key:"));
      terminal.kill();
      yield* waitFor("the GM's session to end", () => gm.ended.includes(`key:${key.fingerprint}`));
    }),
  );
});

describe("relay: shutting down", () => {
  effect("a relay that stops puts seated terminals back before it says so", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const relay = yield* startRelay().pipe(Scope.provide(scope));
      yield* openTable(relay);
      const key = yield* clientKey(yield* tempDir, "vex");
      const seated = yield* sshShell(relay.playerPort, { cols: 80, rows: 24 }, { key });
      yield* waitFor("the seat", () => seated.output().includes("seat key:"));
      yield* Scope.close(scope, Exit.void);
      expect(yield* Effect.promise(() => seated.exited)).toBe(1);
      // Out of the alternate screen, cursor back, mouse reports off: then the notice, on its own line.
      expect(seated.output()).toContain(`${TERMINAL_RESET}\r\nThe relay is shutting down.\r\n`);
    }),
  );
});

describe("relay: rooms", () => {
  effect("an unknown room says so; a claimed room with no GM says it isn't open", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay();
      const key = yield* clientKey(yield* tempDir, "vex");
      const unknown = yield* sshExec(relay.playerPort, ["hi"], { key, user: "nowhere" });
      expect(unknown).toMatchObject({
        stdout: "",
        stderr: "There's no table called nowhere here.\n",
        exitCode: 1,
      });
      const odd = yield* sshExec(relay.playerPort, ["hi"], { key, user: "Not_A-Room" });
      expect(odd).toMatchObject({ stderr: "There's no table by that name here.\n", exitCode: 1 });
      const shell = yield* sshShell(
        relay.playerPort,
        { cols: 80, rows: 24 },
        {
          key,
          user: "nowhere",
        },
      );
      expect(yield* Effect.promise(() => shell.exited)).toBe(1);
      expect(shell.output()).toContain("There's no table called nowhere here.\r\n");

      const table = yield* scoped(openTable(relay));
      yield* table.close;
      yield* linked(relay, "den", false);
      const closed = yield* sshExec(relay.playerPort, ["hi"], { key });
      expect(closed).toMatchObject({ stderr: `${closedRoomMessage("den")}\n`, exitCode: 1 });
    }),
  );

  effect("the first GM host key claims a room; another key is refused until it's forgotten", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay();
      const rightful = yield* gmTable();
      const rooms = () =>
        Effect.promise(async () =>
          JSON.parse(await readFile(join(relay.dir, "rooms.json"), "utf8")),
        );
      /** Links `gm` as den until the returned close. */
      const linkDen = (gm: Effect.Success<ReturnType<typeof gmTable>>) =>
        scoped(linkGm(gm, relay.gmPort, "den", relay.relayKeyFingerprint));

      const first = yield* linkDen(rightful);
      yield* linked(relay, "den");
      expect(yield* rooms()).toEqual({
        den: { key: rightful.server.hostKeyFingerprint, linked: expect.any(String) },
      });
      yield* first.close;
      yield* linked(relay, "den", false);

      // An impostor: another host key asking for the same room.
      const impostor = yield* gmTable();
      const refused = yield* linkGm(impostor, relay.gmPort, "den", relay.relayKeyFingerprint);
      expect(refused.answer).toBe("OK");
      yield* waitFor("the impostor's link to be closed", refused.closed);
      expect(relay.linkedRooms()).toEqual([]);
      expect(relay.logs.join("\n")).toContain(
        `room den: refused a GM with host key ${impostor.server.hostKeyFingerprint}`,
      );
      expect(yield* rooms()).toMatchObject({ den: { key: rightful.server.hostKeyFingerprint } });

      // The rightful GM relinks with its own key.
      const again = yield* linkDen(rightful);
      yield* linked(relay, "den");
      yield* again.close;
      yield* linked(relay, "den", false);

      // Forgotten, the room goes to the next host key that links it.
      yield* forgetRoom(join(relay.dir, "rooms.json"), "den");
      yield* linkGm(impostor, relay.gmPort, "den", relay.relayKeyFingerprint);
      yield* linked(relay, "den");
      expect(yield* rooms()).toMatchObject({ den: { key: impostor.server.hostKeyFingerprint } });
    }),
  );

  effect("the same GM linking again replaces its old link at once", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay();
      const { gm, link: old } = yield* openTable(relay);
      const key = yield* clientKey(yield* tempDir, "vex");
      const seated = yield* sshShell(relay.playerPort, { cols: 80, rows: 24 }, { key });
      yield* waitFor("the seat", () => seated.output().includes("seat key:"));

      const fresh = yield* linkGm(gm, relay.gmPort, "den", relay.relayKeyFingerprint);
      expect(fresh.answer).toBe("OK");
      yield* waitFor("the old link to close", old.closed);
      // Whoever sat on the old link hears it went; new players sit on the new one.
      yield* waitFor("the notice", () => seated.output().includes("The table closed."));
      expect(yield* Effect.promise(() => seated.exited)).toBe(1);
      expect(fresh.closed()).toBe(false);
      expect((yield* sshExec(relay.playerPort, ["hi"], { key })).exitCode).toBe(0);
    }),
  );

  effect("a claim no GM has linked for --claim-days lapses, and another host key claims it", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const roomsFile = join(dir, "rooms.json");
      const days = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
      const gone = `SHA256:${"A".repeat(43)}`;
      const lapsed = days(8);
      yield* Effect.promise(() =>
        writeFile(
          roomsFile,
          JSON.stringify({
            den: { key: gone, linked: lapsed },
            attic: { key: gone, linked: days(6) },
          }),
          { mode: 0o600 },
        ),
      );
      const relay = yield* startRelay({ dir, gm: { claimDays: 7 } });
      const newcomer = yield* gmTable();
      yield* linkGm(newcomer, relay.gmPort, "den", relay.relayKeyFingerprint);
      yield* linked(relay, "den");
      expect(relay.logs.join("\n")).toContain(
        `room den: dropped the claim of GM host key ${gone}, last linked ${lapsed}\n`,
      );
      // Attic's claim is younger than the expiry, and holds.
      const attic = yield* linkGm(
        yield* gmTable(),
        relay.gmPort,
        "attic",
        relay.relayKeyFingerprint,
      );
      yield* waitFor("the second GM to be refused", attic.closed);
      const after = JSON.parse(yield* Effect.promise(() => readFile(roomsFile, "utf8")));
      expect(after).toMatchObject({
        den: { key: newcomer.server.hostKeyFingerprint },
        attic: { key: gone },
      });
    }),
  );

  effect("a GM's link renews its claim when it begins and when it ends", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay();
      const roomsFile = join(relay.dir, "rooms.json");
      const linkedAt = () =>
        Effect.promise(async () =>
          Date.parse(JSON.parse(await readFile(roomsFile, "utf8")).den.linked as string),
        );
      const table = yield* scoped(openTable(relay));
      const began = yield* linkedAt();
      yield* Effect.sleep("20 millis");
      yield* table.close;
      yield* linked(relay, "den", false);
      for (let tries = 0; (yield* linkedAt()) === began && tries < 100; tries++)
        yield* Effect.sleep("20 millis");
      expect(yield* linkedAt()).toBeGreaterThan(began);
    }),
  );

  effect("a full registry drops its stalest unlinked claim for a new one, never a linked one", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const roomsFile = join(dir, "rooms.json");
      const absent = `SHA256:${"A".repeat(43)}`;
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      yield* Effect.promise(() =>
        writeFile(roomsFile, JSON.stringify({ attic: { key: absent, linked: yesterday } }), {
          mode: 0o600,
        }),
      );
      const relay = yield* startRelay({ dir, gm: { maxRooms: 2 } });
      yield* openTable(relay, "den");
      yield* openTable(relay, "cellar");
      expect(relay.logs.join("\n")).toContain(
        `room attic: dropped the claim of GM host key ${absent}, last linked ${yesterday}, to make room for cellar`,
      );
      const rooms = () =>
        Effect.promise(async () =>
          Object.keys(JSON.parse(await readFile(roomsFile, "utf8"))).sort(),
        );
      expect(yield* rooms()).toEqual(["cellar", "den"]);
      // Both claims left have a GM linked now: a third is refused, and neither is dropped.
      const third = yield* linkGm(
        yield* gmTable(),
        relay.gmPort,
        "loft",
        relay.relayKeyFingerprint,
      );
      yield* waitFor("the third claim to be refused", third.closed);
      // Refused on the hello, so the GM's host hears why, and nothing logs in.
      expect(third.answer).toBe("ERR the relay holds its most rooms, each with a GM linked now");
      expect(relay.logs.join("\n")).toContain(
        "room loft: refused: the relay holds its most rooms (2), each with a GM linked now",
      );
      expect(yield* rooms()).toEqual(["cellar", "den"]);
    }),
  );

  effect("a GM link that drops tells shells the table closed and fails execs", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay();
      const { link } = yield* openTable(relay);
      const key = yield* clientKey(yield* tempDir, "vex");
      const seated = yield* sshShell(relay.playerPort, { cols: 80, rows: 24 }, { key });
      yield* waitFor("the seat", () => seated.output().includes("seat key:"));
      const waiting = yield* Effect.forkChild(sshExec(relay.playerPort, ["wait"], { key }));
      yield* Effect.sleep("300 millis");
      link.socket.destroy();
      yield* waitFor("the notice", () => seated.output().includes("The table closed.\r\n"));
      expect(yield* Effect.promise(() => seated.exited)).toBe(1);
      const exec = yield* Fiber.join(waiting);
      expect(exec.exitCode).toBe(1);
      expect(exec.stderr).toContain("The table closed.");
    }),
  );

  effect("a GM whose host doesn't trust this relay's key never links", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay();
      const gm = yield* gmTable();
      const link = yield* linkGm(gm, relay.gmPort, "den", `SHA256:${"Z".repeat(43)}`);
      yield* waitFor("the link to close", link.closed);
      expect(relay.linkedRooms()).toEqual([]);
      expect(relay.logs.join("\n")).toContain("refused this relay's key");
    }),
  );

  effect("a bad hello is answered with ERR and the link closed", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay();
      const answer = yield* Effect.promise(async () => {
        const socket = connect(relay.gmPort, "127.0.0.1");
        socket.on("error", () => undefined);
        await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
        socket.write("SUPERVILLAIN 1 ROOM Bad_Room\n");
        const line = await readLine(socket);
        await new Promise<void>((resolve) => {
          socket.once("close", () => resolve());
          socket.resume();
        });
        return line;
      });
      expect(answer).toStartWith("ERR ");
      expect(relay.linkedRooms()).toEqual([]);
    }),
  );
});

describe("relay: limits", () => {
  effect("per-address connection caps and session rates apply to players at the relay", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay({
        limits: { connectionsPerAddress: 1 },
        sessionRate: { burst: 2, perSecond: 0.001 },
      });
      yield* openTable(relay);
      const key = yield* clientKey(yield* tempDir, "vex");
      const held = yield* sshShell(relay.playerPort, { cols: 80, rows: 24 }, { key });
      yield* waitFor("the seat", () => held.output().includes("seat key:"));
      // One connection from this address is all it gets, and the relay says why it cut the next.
      expect((yield* sshExec(relay.playerPort, ["hi"], { key })).exitCode).toBe(255);
      yield* waitFor("the refusal in the log", () =>
        relay.logs.some((l) => l.includes("refused a connection from 127.0.0.1")),
      );
      held.kill();
      yield* Effect.promise(() => held.exited);
      yield* Effect.sleep("100 millis");
      // Two sessions started; the third comes too fast.
      expect((yield* sshExec(relay.playerPort, ["hi"], { key })).exitCode).toBe(0);
      const third = yield* sshExec(relay.playerPort, ["hi"], { key });
      expect(third).toMatchObject({ exitCode: 1 });
      expect(third.stderr).toContain("Too many sessions from your address");
    }),
  );

  effect("a room seats so many players at once; the next is told it's full", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay({ sessionsPerRoom: 1 });
      yield* openTable(relay);
      const key = yield* clientKey(yield* tempDir, "vex");
      const held = yield* sshShell(relay.playerPort, { cols: 80, rows: 24 }, { key });
      yield* waitFor("the seat", () => held.output().includes("seat key:"));
      const turned = yield* sshExec(relay.playerPort, ["hi"], { key });
      expect(turned).toMatchObject({ exitCode: 1, stderr: "The table den is full right now.\n" });
      held.kill();
      yield* Effect.promise(() => held.exited);
      yield* Effect.sleep("200 millis");
      expect((yield* sshExec(relay.playerPort, ["hi"], { key })).exitCode).toBe(0);
    }),
  );

  effect("linked GMs count apart from links still saying hello, and links are capped", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay({ gm: { pendingLinks: 1, links: 2 } });
      // Linked, den and attic no longer hold the one place for links in their handshake.
      yield* openTable(relay, "den");
      yield* openTable(relay, "attic");
      // A third room is past the cap on linked GMs; the GM already linked relinks all the same.
      const third = yield* linkGm(
        yield* gmTable(),
        relay.gmPort,
        "cellar",
        relay.relayKeyFingerprint,
      );
      yield* waitFor("the third GM to be refused", third.closed);
      expect(third.answer).toBe("ERR the relay has its most GMs linked; try again later");
      expect(relay.logs.join("\n")).toContain(
        "room cellar: refused: the relay has its most GMs linked (2)",
      );
      expect([...relay.linkedRooms()].sort()).toEqual(["attic", "den"]);
      // A link that can't be kept claims nothing.
      const rooms = yield* Effect.promise(() => readFile(join(relay.dir, "rooms.json"), "utf8"));
      expect(Object.keys(JSON.parse(rooms)).sort()).toEqual(["attic", "den"]);
    }),
  );

  effect("rooms are claimed at a rate per address and up to a total; held rooms relink", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay({ gm: { claimRate: { burst: 1, perSecond: 0.0001 } } });
      const { gm, link } = yield* openTable(relay, "den");
      const squatter = yield* linkGm(
        yield* gmTable(),
        relay.gmPort,
        "attic",
        relay.relayKeyFingerprint,
      );
      yield* waitFor("the second claim to be refused", squatter.closed);
      expect(squatter.answer).toBe("ERR this address claims rooms too fast; try again later");
      expect(relay.logs.join("\n")).toContain(
        "room attic: refused: 127.0.0.1 claims rooms too fast",
      );
      link.socket.destroy();
      yield* linked(relay, "den", false);
      // Den is held already: its GM relinks without a new claim.
      yield* linkGm(gm, relay.gmPort, "den", relay.relayKeyFingerprint);
      yield* linked(relay, "den");

      const full = yield* startRelay({ gm: { maxRooms: 1 } });
      yield* openTable(full, "den");
      const over = yield* linkGm(yield* gmTable(), full.gmPort, "attic", full.relayKeyFingerprint);
      yield* waitFor("the claim past the total to be refused", over.closed);
      expect(over.answer).toBe("ERR the relay holds its most rooms, each with a GM linked now");
      expect(full.logs.join("\n")).toContain(
        "room attic: refused: the relay holds its most rooms (1), each with a GM linked now",
      );
      const rooms = yield* Effect.promise(() => readFile(join(full.dir, "rooms.json"), "utf8"));
      expect(Object.keys(JSON.parse(rooms))).toEqual(["den"]);
    }),
  );

  effect("GM links are capped per address, and a silent one is cut", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay({ gm: { linksPerAddress: 2, lineTimeoutMs: 200 } });
      const open = () =>
        Effect.promise(async () => {
          const socket = connect(relay.gmPort, "127.0.0.1");
          let closed = false;
          socket.on("error", () => undefined);
          socket.once("close", () => (closed = true));
          await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
          return { socket, closed: () => closed };
        });
      const a = yield* open();
      const b = yield* open();
      const c = yield* open();
      yield* waitFor("the third link to be refused", c.closed, 1000);
      expect(a.closed() || b.closed()).toBe(false);
      yield* waitFor("the silent links to be cut", () => a.closed() && b.closed(), 2000);
      // Its place freed, a real GM links.
      const gm = yield* gmTable();
      const link = yield* linkGm(gm, relay.gmPort, "den", relay.relayKeyFingerprint);
      expect(link.answer).toBe("OK");
      yield* linked(relay, "den");
    }),
  );
});

describe("relay: claim rates", () => {
  effect("claims count per IPv4 address, and per IPv6 /64 and /48 both", () =>
    Effect.sync(() => {
      const one = { burst: 1, perSecond: 1 / 3600 };
      const allowed = claimLimiter(one, { burst: 2, perSecond: 1 / 3600 });
      expect(allowed("203.0.113.7", 0)).toBeUndefined();
      expect(allowed("203.0.113.7", 1)).toBe("203.0.113.7");
      expect(allowed("203.0.113.8", 1)).toBeUndefined();
      // One /64 claims once; a second /64 in the same /48 claims too; a third is over the /48.
      expect(allowed("2001:db8:1:1::1", 0)).toBeUndefined();
      expect(allowed("2001:db8:1:1::2", 0)).toBe("2001:db8:1:1::/64");
      expect(allowed("2001:db8:1:2::1", 0)).toBeUndefined();
      expect(allowed("2001:db8:1:3::1", 0)).toBe("2001:db8:1::/48");
      expect(allowed("2001:db8:2:3::1", 0)).toBeUndefined();
      // An hour on, each has a claim again.
      expect(allowed("2001:db8:1:3::1", 3_600_000)).toBeUndefined();
    }),
  );
});
