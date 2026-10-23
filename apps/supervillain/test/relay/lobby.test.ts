// The relay's lobby, on the real relay with stand-in GM tables and OpenSSH players: a player who
// comes with a key and no room is shown the open tables that know their key, and picks one.
import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { JOIN_HINT } from "../../src/relay/protocol.ts";
import { lobbyText } from "../../src/relay/server.ts";
import { effect, waitFor } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";
import { type GmTableOptions, gmTable, linkGm, startRelay } from "./harness.ts";
import { clientKey, sshExec, sshShell } from "./openssh.ts";

type Relay = Effect.Success<ReturnType<typeof startRelay>>;

/** A stand-in table linked to the relay as `room`, answering the lobby as `knows` says. */
const openTable = (relay: Relay, room: string, knows?: GmTableOptions["knows"]) =>
  Effect.gen(function* () {
    const gm = yield* gmTable(knows === undefined ? {} : { knows });
    const link = yield* linkGm(gm, relay.gmPort, room, relay.relayKeyFingerprint);
    expect(link.answer).toBe("OK");
    yield* waitFor(`room ${room} linked`, () => relay.linkedRooms().includes(room));
    return gm;
  });

const SIZE = { cols: 100, rows: 30 };

describe("relay: the lobby", () => {
  effect("a known key sees its table, and Enter seats it there as a <room>@ would", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay();
      const vex = yield* clientKey(yield* tempDir, "vex");
      const ford = yield* openTable(relay, "ford", {
        actors: [`key:${vex.fingerprint}`],
        seated: 3,
      });
      const keep = yield* openTable(relay, "keep", { actors: [] });
      const terminal = yield* sshShell(relay.playerPort, SIZE, { key: vex, user: "lobby" });
      yield* waitFor("the lobby", () => terminal.output().includes("or Ctrl-C to leave: "));
      expect(terminal.output()).toBe(
        "Your table open now:\r\n  1  ford (3 seated)\r\nPress Enter to join ford, or Ctrl-C to leave: ",
      );
      // A window change while at the prompt reaches the table with the seat.
      terminal.resize(120, 40);
      yield* Effect.sleep("200 millis");
      terminal.write("\r");
      yield* waitFor("the seat", () =>
        terminal.output().includes(`seat key:${vex.fingerprint} xterm-256color 120x40 pty=true`),
      );
      expect(terminal.output()).toContain("Joining ford…\r\n");
      terminal.resize(90, 20);
      yield* waitFor("the resize", () => terminal.output().includes("resize 90x20|"));
      terminal.write("x");
      yield* waitFor("the echo", () => terminal.output().includes("echo:x|"));
      terminal.write("q");
      expect(yield* Effect.promise(() => terminal.exited)).toBe(5);
      expect(ford.asked.count).toBe(1);
      expect(keep.asked.count).toBe(1);
    }),
  );

  effect("two tables are listed by name; the player picks one by number", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay();
      const vex = yield* clientKey(yield* tempDir, "vex");
      const actors = [`key:${vex.fingerprint}`];
      yield* openTable(relay, "keep", { actors, seated: 1 });
      yield* openTable(relay, "ford", { actors, seated: 2 });
      // The local username a bare ssh sends, not a room anyone holds.
      const terminal = yield* sshShell(relay.playerPort, SIZE, { key: vex, user: "alex" });
      yield* waitFor("the lobby", () => terminal.output().includes("or Ctrl-C to leave: "));
      expect(terminal.output()).toBe(
        "There's no table called alex here.\r\nYour tables open now:\r\n  1  ford (2 seated)\r\n  2  keep (1 seated)\r\nPick a table (1-2), or Ctrl-C to leave: ",
      );
      // Enter alone, a number off the list, an arrow key and a backspace are all taken in stride.
      terminal.write("\r");
      terminal.write("7\r");
      yield* waitFor("the refusal", () => terminal.output().includes("There's no 7 on the list."));
      terminal.write("\x1b[A1\x7f2\r");
      yield* waitFor("the seat", () => terminal.output().includes(`seat key:${vex.fingerprint}`));
      expect(terminal.output()).toContain("Joining keep…");
      terminal.write("q");
      expect(yield* Effect.promise(() => terminal.exited)).toBe(5);
    }),
  );

  effect("a key no open table knows, and a guest, get today's hint; a guest asks nobody", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay();
      const dir = yield* tempDir;
      const vex = yield* clientKey(dir, "vex");
      const kai = yield* clientKey(dir, "kai");
      const ford = yield* openTable(relay, "ford", { actors: [`key:${vex.fingerprint}`] });
      for (const user of ["lobby", "root"]) {
        const unknown = yield* sshExec(relay.playerPort, ["hi"], { key: kai, user });
        expect(unknown).toEqual({ stdout: "", stderr: `${JOIN_HINT}\n`, exitCode: 1 });
      }
      const named = yield* sshExec(relay.playerPort, ["hi"], { key: kai, user: "nowhere" });
      expect(named.stderr).toBe("There's no table called nowhere here.\n");
      const asked = ford.asked.count;
      const guest = yield* sshExec(relay.playerPort, ["hi"], { user: "lobby" });
      expect(guest).toEqual({ stdout: "", stderr: `${JOIN_HINT}\n`, exitCode: 1 });
      const shell = yield* sshShell(relay.playerPort, SIZE, { user: "lobby" });
      expect(yield* Effect.promise(() => shell.exited)).toBe(1);
      expect(shell.output()).toBe(`${JOIN_HINT}\r\n`);
      expect(ford.asked.count).toBe(asked);
    }),
  );

  effect("a host that doesn't answer in time is left off; the rest are listed", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay({ lobby: { deadlineMs: 400 } });
      const vex = yield* clientKey(yield* tempDir, "vex");
      const slow = yield* openTable(relay, "slow", "silent");
      yield* openTable(relay, "ford", { actors: [`key:${vex.fingerprint}`] });
      const started = Date.now();
      const listed = yield* sshExec(relay.playerPort, ["hi"], { key: vex, user: "lobby" });
      expect(Date.now() - started).toBeGreaterThanOrEqual(400);
      expect(listed).toEqual({
        stdout: "",
        stderr: `${lobbyText(undefined, [{ room: "ford", seated: 1 }])}\n`,
        exitCode: 1,
      });
      expect(slow.asked.count).toBe(1);
    }),
  );

  effect("a frozen host, which never answers the channel's open, is cut by the deadline", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay({ lobby: { deadlineMs: 400 } });
      const vex = yield* clientKey(yield* tempDir, "vex");
      const actors = [`key:${vex.fingerprint}`];
      const frozen = yield* gmTable({ knows: { actors } });
      const link = yield* linkGm(frozen, relay.gmPort, "frozen", relay.relayKeyFingerprint);
      yield* waitFor("room frozen linked", () => relay.linkedRooms().includes("frozen"));
      yield* openTable(relay, "ford", { actors });
      // The link stays up as far as the relay knows; the host just stops reading it.
      link.socket.pause();
      // More visits than the link's questions: past them, the frozen table isn't even asked.
      for (let i = 0; i < 6; i++) {
        const started = Date.now();
        const listed = yield* sshExec(relay.playerPort, ["hi"], { key: vex, user: "lobby" });
        expect(Date.now() - started).toBeLessThan(3000);
        expect(listed.stderr).toBe(`${lobbyText(undefined, [{ room: "ford", seated: 1 }])}\n`);
      }
      expect(frozen.asked.count).toBe(0);
    }),
  );

  effect("an older host, which refuses the question, counts as no and isn't asked again", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay();
      const vex = yield* clientKey(yield* tempDir, "vex");
      yield* openTable(relay, "old");
      for (let i = 0; i < 2; i++) {
        const asked = yield* sshExec(relay.playerPort, ["hi"], { key: vex, user: "lobby" });
        expect(asked).toMatchObject({ stderr: `${JOIN_HINT}\n`, exitCode: 1 });
      }
      const said = relay.logs.filter((l) => l.includes("doesn't answer the lobby"));
      expect(said).toEqual(["room old: its host doesn't answer the lobby (older)"]);
      // Its players still sit down by name.
      const seated = yield* sshExec(relay.playerPort, ["hi"], { key: vex, user: "old" });
      expect(seated).toMatchObject({ stdout: `exec key:${vex.fingerprint} hi\n`, exitCode: 0 });
    }),
  );

  effect("without a terminal, the list comes as text with how to join", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay();
      const vex = yield* clientKey(yield* tempDir, "vex");
      const actors = [`key:${vex.fingerprint}`];
      yield* openTable(relay, "ford", { actors, seated: 3 });
      yield* openTable(relay, "keep", { actors, seated: 1 });
      const ran = yield* sshExec(relay.playerPort, ["roll", "2d10"], { key: vex, user: "lobby" });
      expect(ran).toEqual({
        stdout: "",
        stderr:
          "Your tables open now: ford (3 seated), keep (1 seated).\nJoin one with its name before the @, as you came here: ssh ford@…\n",
        exitCode: 1,
      });
      const plain = yield* sshExec(relay.playerPort, [], {
        key: vex,
        user: "lobby",
        flags: ["-T"],
      });
      expect(plain.stderr).toContain("Your tables open now:");
    }),
  );

  effect("a CR LF Enter is one Enter, and a lone Esc doesn't swallow the key after it", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay();
      const vex = yield* clientKey(yield* tempDir, "vex");
      yield* openTable(relay, "ford", { actors: [`key:${vex.fingerprint}`] });
      const terminal = yield* sshShell(relay.playerPort, SIZE, { key: vex, user: "lobby" });
      yield* waitFor("the lobby", () => terminal.output().includes("or Ctrl-C to leave: "));
      // With one table, a stray LF read as a second Enter would seat the player.
      terminal.write("5\r\n");
      yield* waitFor("the refusal", () => terminal.output().includes("There's no 5 on the list."));
      yield* Effect.sleep("300 millis");
      expect(terminal.output()).not.toContain("Joining");
      expect(terminal.output().split("Press Enter to join ford").length).toBe(3);
      // Esc, then Enter: the Enter still counts.
      terminal.write("\x1b");
      yield* Effect.sleep("100 millis");
      terminal.write("\r");
      yield* waitFor("the seat", () => terminal.output().includes(`seat key:${vex.fingerprint}`));
      terminal.write("q");
      expect(yield* Effect.promise(() => terminal.exited)).toBe(5);
    }),
  );

  effect("Ctrl-C at the prompt leaves cleanly; so does sitting there too long", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay({ lobby: { idleMs: 500 } });
      const vex = yield* clientKey(yield* tempDir, "vex");
      const ford = yield* openTable(relay, "ford", { actors: [`key:${vex.fingerprint}`] });
      const leaving = yield* sshShell(relay.playerPort, SIZE, { key: vex, user: "lobby" });
      yield* waitFor("the lobby", () => leaving.output().includes("or Ctrl-C to leave: "));
      // Ctrl-C leaves even just after a lone Esc.
      leaving.write("1\x1b\x03");
      expect(yield* Effect.promise(() => leaving.exited)).toBe(0);
      expect(leaving.output()).not.toContain("Joining");

      const idle = yield* sshShell(relay.playerPort, SIZE, { key: vex, user: "lobby" });
      yield* waitFor("the lobby", () => idle.output().includes("or Ctrl-C to leave: "));
      expect(yield* Effect.promise(() => idle.exited)).toBe(1);
      expect(idle.output()).toContain("No table picked; come back any time.");
      expect(ford.ended).toEqual([]);
    }),
  );
});
