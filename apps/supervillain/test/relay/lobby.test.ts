import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { Clock, Effect } from "effect";

import { lobbyFrame } from "../../src/relay/lobby/index.ts";
import type { LobbyScreen } from "../../src/relay/lobby/index.ts";
import { closedTableMessage, JOIN_HINT } from "../../src/relay/protocol.ts";
import { lobbyText } from "../../src/relay/server.ts";
import { effect, waitFor } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";
import { gmTable, linkGm, startRelay } from "./harness.ts";
import type { GmTableOptions } from "./harness.ts";
import { clientKey, sshExec, sshShell } from "./openssh.ts";

type Relay = Effect.Success<ReturnType<typeof startRelay>>;

const gmKeys = new WeakMap<Relay, Buffer>();

const gmKeyFor = (relay: Relay) =>
	Effect.gen(function* () {
		const held = gmKeys.get(relay);

		if (held !== undefined) {
			return held;
		}

		const made = yield* gmTable();

		const pem = yield* Effect.promise(
			async () => await readFile(made.hostKeyPath)
		);

		gmKeys.set(relay, pem);

		return pem;
	});

const openTable = (
	relay: Relay,
	table: string,
	knows?: GmTableOptions["knows"]
) =>
	Effect.gen(function* () {
		const gm = yield* gmTable(knows === undefined ? {} : { knows });
		const hostKey = yield* gmKeyFor(relay);

		const link = yield* linkGm(
			{ server: gm.server, hostKey },
			relay.gmPort,
			table,
			relay.relayKeyFingerprint
		);

		expect(link.answer).toBe("OK");
		yield* waitFor(`table ana/${table} linked`, () =>
			relay.linkedTables().includes(`ana/${table}`)
		);

		return gm;
	});

const atAna = (table: string, seated: number) => ({
	handle: "ana",
	table,
	seated,
});

const SIZE = { cols: 100, rows: 30 };

const shown = (terminal: { output: () => string }) =>
	Bun.stripANSI(terminal.output());

const OPEN_READY = "open tables";

const EMPTY_READY = "join by name";

const rows = (frame: string) => Bun.stripANSI(frame).split("\r\n");

describe("relay: the lobby", () => {
	effect(
		"a known key sees its table without key clutter, can inspect Session with 4, and Enter seats it",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();
				const vex = yield* clientKey(yield* tempDir, "vex");

				const ford = yield* openTable(relay, "ford", {
					actors: [`key:${vex.fingerprint}`],
					seated: 3,
				});

				const keep = yield* openTable(relay, "keep", { actors: [] });

				const terminal = yield* sshShell(relay.playerPort, SIZE, {
					key: vex,
					user: "lobby",
				});

				yield* waitFor("the lobby", () => shown(terminal).includes(OPEN_READY));
				const lobby = shown(terminal);
				expect(lobby).toContain("1 Tables · 1");
				expect(lobby).toMatch(/ana\/ford +● 3/u);
				expect(lobby).not.toContain("keep");
				expect(lobby).toContain("ssh ana/ford@…");
				expect(lobby).not.toContain(vex.fingerprint);

				terminal.write("4");
				yield* waitFor("the session tab", () =>
					shown(terminal).includes(vex.fingerprint)
				);
				expect(shown(terminal)).toContain("key       ssh-ed25519");
				terminal.write("c");
				yield* waitFor("the copied confirmation", () =>
					shown(terminal).includes("› Copied fingerprint to clipboard.")
				);
				expect(terminal.output()).toContain("\u001B]52;c;");
				terminal.write("1");
				yield* waitFor(
					"back to tables",
					() => shown(terminal).split(OPEN_READY).length === 3
				);

				terminal.resize(120, 40);
				yield* waitFor(
					"the lobby again",
					() => shown(terminal).split(OPEN_READY).length === 4
				);
				terminal.write("\r");
				yield* waitFor("the seat", () =>
					terminal
						.output()
						.includes(
							`seat key:${vex.fingerprint} xterm-256color 120x40 pty=true`
						)
				);
				expect(terminal.output()).toContain("Joining ana/ford…\r\n");
				terminal.resize(90, 20);
				yield* waitFor("the resize", () =>
					terminal.output().includes("resize 90x20|")
				);
				terminal.write("x");
				yield* waitFor("the echo", () => terminal.output().includes("echo:x|"));
				terminal.write("q");
				expect(yield* Effect.promise(async () => await terminal.exited)).toBe(
					5
				);
				expect(ford.asked.count).toBe(1);
				expect(keep.asked.count).toBe(1);
			})
	);

	effect(
		"two tables are listed by name; the player picks one with arrows",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();
				const vex = yield* clientKey(yield* tempDir, "vex");
				const actors = [`key:${vex.fingerprint}`];
				yield* openTable(relay, "keep", { actors, seated: 1 });
				yield* openTable(relay, "ford", { actors, seated: 2 });

				const terminal = yield* sshShell(relay.playerPort, SIZE, {
					key: vex,
					user: "alex",
				});

				yield* waitFor("the lobby", () => shown(terminal).includes(OPEN_READY));
				const lobby = shown(terminal);
				expect(lobby).not.toContain("alex");
				expect(lobby).toContain("1 Tables · 2");
				expect(lobby).toMatch(/ana\/ford +● 2/u);
				expect(lobby).toMatch(/ana\/keep +● 1/u);
				expect(lobby).toContain(
					"↑/↓ pick   enter sit down   / join by name   1-4 tabs   q quit"
				);
				terminal.write("\u001B[B");
				yield* waitFor("the pick", () =>
					shown(terminal).includes("ssh ana/keep@…")
				);
				terminal.write("\r");
				yield* waitFor("the seat", () =>
					terminal.output().includes(`seat key:${vex.fingerprint}`)
				);
				expect(terminal.output()).toContain("Joining ana/keep…");
				terminal.write("q");
				expect(yield* Effect.promise(async () => await terminal.exited)).toBe(
					5
				);
			})
	);

	effect(
		"without a terminal, a key no open table knows, and a guest, get the hint; a guest asks nobody",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();
				const dir = yield* tempDir;
				const vex = yield* clientKey(dir, "vex");
				const kai = yield* clientKey(dir, "kai");

				const ford = yield* openTable(relay, "ford", {
					actors: [`key:${vex.fingerprint}`],
				});

				for (const user of ["lobby", "root"]) {
					const unknown = yield* sshExec(relay.playerPort, ["hi"], {
						key: kai,
						user,
					});

					expect(unknown).toEqual({
						stdout: "",
						stderr: `${JOIN_HINT}\n`,
						exitCode: 1,
					});
				}

				const named = yield* sshExec(relay.playerPort, ["hi"], {
					key: kai,
					user: "nowhere",
				});

				expect(named.stderr).toBe(`${JOIN_HINT}\n`);
				const asked = ford.asked.count;

				const guest = yield* sshExec(relay.playerPort, ["hi"], {
					user: "lobby",
				});

				expect(guest).toEqual({
					stdout: "",
					stderr: `${JOIN_HINT}\n`,
					exitCode: 1,
				});

				expect(ford.asked.count).toBe(asked);
			})
	);

	effect(
		"a key no open table knows sees the lobby with none listed, opens join-by-name with Enter, and sits",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();
				const dir = yield* tempDir;
				const vex = yield* clientKey(dir, "vex");
				const kai = yield* clientKey(dir, "kai");

				const ford = yield* openTable(relay, "ford", {
					actors: [`key:${vex.fingerprint}`],
				});

				const terminal = yield* sshShell(relay.playerPort, SIZE, {
					key: kai,
					user: "alex",
				});

				yield* waitFor("the lobby", () =>
					shown(terminal).includes(EMPTY_READY)
				);
				const lobby = shown(terminal);
				expect(lobby).toContain("○ no open tables yet");
				expect(lobby).not.toContain("ford");
				expect(lobby).not.toContain("alex");
				expect(lobby).not.toContain(kai.fingerprint);
				expect(lobby).toContain(
					"enter join by name   1-4 tabs   tab next   q quit"
				);
				expect(ford.asked.count).toBe(1);

				terminal.write("\r");
				yield* waitFor("editing mode", () =>
					shown(terminal).includes("> handle/table")
				);
				terminal.write("\r");
				yield* waitFor("the nudge", () =>
					shown(terminal).includes("› Type your table's name, then Enter.")
				);
				terminal.write("ford\r");
				yield* waitFor("the refusal", () =>
					shown(terminal).includes("› No open table called ford knows")
				);
				terminal.write("Ana/Fo-\u007Frd");
				yield* waitFor("the name", () =>
					shown(terminal).includes("> ana/ford")
				);
				terminal.write("\r");
				yield* waitFor("the seat", () =>
					terminal.output().includes(`seat key:${kai.fingerprint}`)
				);
				expect(terminal.output()).toContain("Joining ana/ford…\r\n");
				terminal.write("q");
				expect(yield* Effect.promise(async () => await terminal.exited)).toBe(
					5
				);
			})
	);

	effect(
		"a guest sees the lobby too, asks nobody, and sits as a guest by a table's full name",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();
				const vex = yield* clientKey(yield* tempDir, "vex");

				const ford = yield* openTable(relay, "ford", {
					actors: [`key:${vex.fingerprint}`],
				});

				const terminal = yield* sshShell(relay.playerPort, SIZE, {
					user: "root",
				});

				yield* waitFor("the lobby", () =>
					shown(terminal).includes(EMPTY_READY)
				);
				const lobby = shown(terminal);
				expect(lobby).toContain("○ guest session · no saved tables");
				expect(lobby).not.toContain("ford");
				expect(ford.asked.count).toBe(0);

				terminal.write("4");
				yield* waitFor("guest session tab", () =>
					shown(terminal).includes("ssh-keygen -t ed25519")
				);
				terminal.write("1");
				yield* waitFor(
					"back to tables",
					() => shown(terminal).split(EMPTY_READY).length >= 3
				);
				terminal.write("/ana.ford\r");
				yield* waitFor("the seat", () =>
					/seat guest:[A-Za-z0-9_-]{1,64} /u.test(terminal.output())
				);
				terminal.write("q");
				expect(yield* Effect.promise(async () => await terminal.exited)).toBe(
					5
				);
			})
	);

	effect(
		"a known key sits at a table off its list via /; a closed table isn't open; five misses and the lobby lets go",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();
				const vex = yield* clientKey(yield* tempDir, "vex");
				yield* openTable(relay, "ford", { actors: [`key:${vex.fingerprint}`] });
				yield* openTable(relay, "keep", { actors: [] });
				yield* Effect.scoped(openTable(relay, "shut", { actors: [] }));
				yield* waitFor(
					"table ana/shut unlinked",
					() => !relay.linkedTables().includes("ana/shut")
				);

				const named = yield* sshShell(relay.playerPort, SIZE, {
					key: vex,
					user: "lobby",
				});

				yield* waitFor("the lobby", () => shown(named).includes(OPEN_READY));
				named.write("/ana/keep\r");
				yield* waitFor("the seat", () =>
					named.output().includes(`seat key:${vex.fingerprint}`)
				);
				expect(named.output()).toContain("Joining ana/keep…");
				named.write("q");
				expect(yield* Effect.promise(async () => await named.exited)).toBe(5);

				const missing = yield* sshShell(relay.playerPort, SIZE, {
					key: vex,
					user: "lobby",
				});

				yield* waitFor("the lobby", () => shown(missing).includes(OPEN_READY));
				missing.write("/ana/shut\r");
				yield* waitFor("the closed table", () =>
					shown(missing).includes(`› ${closedTableMessage("ana/shut")}`)
				);

				for (const miss of ["one", "two", "three"]) {
					missing.write(`${miss}\r`);
					yield* waitFor(`no ${miss}`, () =>
						shown(missing).includes(`› No open table called ${miss} knows`)
					);
				}

				missing.write("root\r");
				expect(yield* Effect.promise(async () => await missing.exited)).toBe(1);
				expect(missing.output()).toEndWith(`${JOIN_HINT}\r\n`);
				expect(missing.output()).not.toContain("Joining");
			})
	);

	effect(
		"a host that doesn't answer in time is left off; the rest are listed",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay({ lobby: { deadlineMs: 400 } });
				const vex = yield* clientKey(yield* tempDir, "vex");
				const slow = yield* openTable(relay, "slow", "silent");
				yield* openTable(relay, "ford", { actors: [`key:${vex.fingerprint}`] });
				const started = yield* Clock.currentTimeMillis;

				const listed = yield* sshExec(relay.playerPort, ["hi"], {
					key: vex,
					user: "lobby",
				});

				expect(
					(yield* Clock.currentTimeMillis) - started
				).toBeGreaterThanOrEqual(400);
				expect(listed).toEqual({
					stdout: "",
					stderr: `${lobbyText([atAna("ford", 1)])}\n`,
					exitCode: 1,
				});
				expect(slow.asked.count).toBe(1);
			})
	);

	effect(
		"a frozen host, which never answers the channel's open, is cut by the deadline",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay({ lobby: { deadlineMs: 400 } });
				const vex = yield* clientKey(yield* tempDir, "vex");
				const actors = [`key:${vex.fingerprint}`];
				const frozen = yield* gmTable({ knows: { actors } });

				const link = yield* linkGm(
					{ server: frozen.server, hostKey: yield* gmKeyFor(relay) },
					relay.gmPort,
					"frozen",
					relay.relayKeyFingerprint
				);

				yield* waitFor("table ana/frozen linked", () =>
					relay.linkedTables().includes("ana/frozen")
				);
				yield* openTable(relay, "ford", { actors });
				link.socket.pause();

				for (const _attempt of Array.from({ length: 6 })) {
					const started = yield* Clock.currentTimeMillis;

					const listed = yield* sshExec(relay.playerPort, ["hi"], {
						key: vex,
						user: "lobby",
					});

					expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(3000);
					expect(listed.stderr).toBe(`${lobbyText([atAna("ford", 1)])}\n`);
				}

				expect(frozen.asked.count).toBe(0);
			})
	);

	effect(
		"an older host, which refuses the question, counts as no and isn't asked again",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();
				const vex = yield* clientKey(yield* tempDir, "vex");
				yield* openTable(relay, "old");

				for (const _attempt of Array.from({ length: 2 })) {
					const asked = yield* sshExec(relay.playerPort, ["hi"], {
						key: vex,
						user: "lobby",
					});

					expect(asked).toMatchObject({
						stderr: `${JOIN_HINT}\n`,
						exitCode: 1,
					});
				}

				const said = relay.logs.filter((l) =>
					l.includes("doesn't answer the lobby")
				);

				expect(said).toEqual([
					"table ana/old: its host doesn't answer the lobby (older)",
				]);

				const seated = yield* sshExec(relay.playerPort, ["hi"], {
					key: vex,
					user: "ana/old",
				});

				expect(seated).toMatchObject({
					stdout: `exec key:${vex.fingerprint} hi\n`,
					exitCode: 0,
				});
			})
	);

	effect("without a terminal, the list comes as text with how to join", () =>
		Effect.gen(function* () {
			const relay = yield* startRelay();
			const vex = yield* clientKey(yield* tempDir, "vex");
			const actors = [`key:${vex.fingerprint}`];
			yield* openTable(relay, "ford", { actors, seated: 3 });
			yield* openTable(relay, "keep", { actors, seated: 1 });

			const ran = yield* sshExec(relay.playerPort, ["roll", "2d10"], {
				key: vex,
				user: "lobby",
			});

			expect(ran).toEqual({
				stdout: "",
				stderr:
					"Your tables open now: ana/ford (3 seated), ana/keep (1 seated).\nJoin one with its name before the @: ssh ana/ford@…\n",
				exitCode: 1,
			});

			const plain = yield* sshExec(relay.playerPort, [], {
				key: vex,
				user: "lobby",
				flags: ["-T"],
			});

			expect(plain.stderr).toContain("Your tables open now:");
		})
	);

	effect("a key that changes nothing on screen sends nothing", () =>
		Effect.gen(function* () {
			const relay = yield* startRelay();
			const vex = yield* clientKey(yield* tempDir, "vex");
			yield* openTable(relay, "ford", { actors: [`key:${vex.fingerprint}`] });

			const terminal = yield* sshShell(relay.playerPort, SIZE, {
				key: vex,
				user: "lobby",
			});

			yield* waitFor("the lobby", () => shown(terminal).includes(OPEN_READY));
			terminal.write("z\u007F");
			terminal.write("/");
			yield* waitFor("editing", () =>
				shown(terminal).includes("> handle/table")
			);
			expect(terminal.output().split("\u001B[H\u001B[2J")).toHaveLength(3);
		})
	);

	effect(
		"a CR LF Enter is one Enter, and a lone Esc exits editing without swallowing the next key",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();
				const vex = yield* clientKey(yield* tempDir, "vex");
				yield* openTable(relay, "ford", { actors: [`key:${vex.fingerprint}`] });

				const terminal = yield* sshShell(relay.playerPort, SIZE, {
					key: vex,
					user: "lobby",
				});

				yield* waitFor("the lobby", () => shown(terminal).includes(OPEN_READY));
				terminal.write("/\r\n");
				yield* waitFor("the nudge", () =>
					shown(terminal).includes("Type your table's name, then Enter.")
				);
				yield* Effect.sleep("200 millis");
				expect(terminal.output()).not.toContain("Joining");
				terminal.write("\u001B");
				yield* Effect.sleep("120 millis");
				terminal.write("\r");
				yield* waitFor("the seat", () =>
					terminal.output().includes(`seat key:${vex.fingerprint}`)
				);
				terminal.write("q");
				expect(yield* Effect.promise(async () => await terminal.exited)).toBe(
					5
				);
			})
	);

	effect(
		"q and Ctrl-C leave cleanly; sitting idle too long closes cleanly",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay({ lobby: { idleMs: 500 } });
				const vex = yield* clientKey(yield* tempDir, "vex");

				const ford = yield* openTable(relay, "ford", {
					actors: [`key:${vex.fingerprint}`],
				});

				const quitting = yield* sshShell(relay.playerPort, SIZE, {
					key: vex,
					user: "lobby",
				});

				yield* waitFor("the lobby", () => shown(quitting).includes(OPEN_READY));
				quitting.write("q");
				expect(yield* Effect.promise(async () => await quitting.exited)).toBe(
					0
				);
				expect(quitting.output()).not.toContain("Joining");

				const leaving = yield* sshShell(relay.playerPort, SIZE, {
					key: vex,
					user: "lobby",
				});

				yield* waitFor("the lobby", () => shown(leaving).includes(OPEN_READY));
				leaving.write("/a\u001B\u0003");
				expect(yield* Effect.promise(async () => await leaving.exited)).toBe(0);
				expect(leaving.output()).not.toContain("Joining");

				const idle = yield* sshShell(relay.playerPort, SIZE, {
					key: vex,
					user: "lobby",
				});

				yield* waitFor("the lobby", () => shown(idle).includes(OPEN_READY));
				expect(yield* Effect.promise(async () => await idle.exited)).toBe(1);
				expect(idle.output()).toContain("No table picked; come back any time.");
				expect(ford.ended).toEqual([]);
			})
	);
});

describe("the lobby's frame", () => {
	const screen: LobbyScreen = {
		tables: [atAna("ford", 3), atAna("the-keep", 0)],
		picked: 0,
		typed: "",
		you: {
			key: {
				fingerprint: "SHA256:Lb2N0yQ8m4fBkqyC2r0wbqv1o3cJm7k6zgWcT4m2Ywo",
				algorithm: "ssh-ed25519",
			},
			term: "xterm-ghostty",
		},
	};

	const nobody: LobbyScreen = { ...screen, tables: [] };

	const guest: LobbyScreen = {
		...nobody,
		you: { key: undefined, term: "xterm-ghostty" },
	};

	test("it fits the terminal, hides the cursor in nav mode, and places it inline when editing", () => {
		for (const [cols, height] of [
			[60, 20],
			[80, 24],
			[100, 30],
			[140, 40],
		] as const) {
			for (const each of [
				screen,
				nobody,
				guest,
				{ ...nobody, tab: "session" as const },
				{
					...nobody,
					tab: "session" as const,
					you: {
						...nobody.you,
						term: "screen.xterm-256color-extra-long-terminal-name",
					},
				},
			]) {
				const frame = lobbyFrame(each, cols, height);
				expect(frame).toStartWith("\u001B[H\u001B[2J");
				expect(frame).toEndWith("\u001B[?25l");
				const lines = rows(frame);
				expect(lines.length).toBeLessThanOrEqual(height);

				for (const line of lines) {
					expect(Bun.stringWidth(line)).toBeLessThanOrEqual(cols);
				}
			}

			for (const editing of [
				{ ...nobody, editing: true, typed: "ana/ford" },
				{ ...screen, editing: true, typed: "ana/keep" },
			]) {
				const frame = lobbyFrame(editing, cols, height);
				expect(frame).toEndWith("\u001B[?25h");
				const lines = rows(frame);
				expect(lines.length).toBeLessThanOrEqual(height);

				for (const line of lines) {
					expect(Bun.stringWidth(line)).toBeLessThanOrEqual(cols);
				}

				const promptIndex = lines.findIndex((line) => line.includes("> ana/"));
				expect(promptIndex).toBeGreaterThan(-1);
			}
		}
	});

	test("with no table to list it guides getting started without dumping identity; Session shows identity", () => {
		const narrow = rows(lobbyFrame(nobody, 60, 20))
			.map((l) => l.trim())
			.join(" ")
			.replaceAll(/ +/gu, " ");

		expect(narrow).toContain("○ no open tables yet");
		expect(narrow).toContain("join by name");
		expect(narrow).not.toContain("SHA256:");

		for (const [cols, height] of [
			[80, 24],
			[100, 30],
			[140, 40],
		] as const) {
			const wide = Bun.stripANSI(lobbyFrame(nobody, cols, height));
			expect(wide).toContain("○ no open tables yet");
			expect(wide).toContain("getting started");
			expect(wide).toContain("Try a Table");
			expect(wide).toContain("Create a Table");
			expect(wide).not.toContain(screen.you.key?.fingerprint ?? "no key");

			const session = Bun.stripANSI(
				lobbyFrame({ ...nobody, tab: "session" }, cols, height)
			);

			expect(session).toContain("ssh-ed25519");
			expect(session).toContain("ssh <handle>/<table>@…");
			expect(session).toContain("supervillain host --handle");
			expect(session).toContain("draw-steel · set.world · pf2e · freeform");
			expect(session).toContain(screen.you.key?.fingerprint ?? "no key");
		}

		const asGuest = Bun.stripANSI(lobbyFrame(guest, 100, 30));
		expect(asGuest).toContain("○ guest session · no saved tables");
		expect(asGuest).not.toContain("SHA256:");

		const guestSession = Bun.stripANSI(
			lobbyFrame({ ...guest, tab: "session" }, 100, 30)
		);

		expect(guestSession).toContain("key       none");
		expect(guestSession).toContain("ssh-keygen -t ed25519");
	});

	test("the title: between a hero and a villain when wide, in quadrants at 80, compact when short", () => {
		const wide = rows(lobbyFrame(screen, 140, 40));
		const nonEmpty = wide.filter((line) => line.trim() !== "");
		expect(
			Math.max(...nonEmpty.slice(0, 6).map((l) => Bun.stringWidth(l.trim())))
		).toBeGreaterThan(100);

		const eighty = rows(lobbyFrame(screen, 80, 24)).find(
			(line) => line.trim() !== ""
		);

		expect(eighty).toMatch(/[▘▝▖▗▚▞▙▟▛▜]/u);
		const short = Bun.stripANSI(lobbyFrame(screen, 80, 16));
		expect(short).toContain("◆ supervillain · lobby");
		expect(short).toContain("! 80×16 (min 72×20)");
	});

	test("a colour is set where it changes, not for every cell, so a frame stays small", () => {
		for (const [cols, height] of [
			[80, 24],
			[100, 30],
			[140, 40],
		] as const) {
			const frame = lobbyFrame(screen, cols, height);
			expect(Buffer.byteLength(frame)).toBeLessThan(
				3 * Buffer.byteLength(Bun.stripANSI(frame))
			);
		}
	});

	test("the pick is highlighted and detailed on the right; editing shifts the detail pane; a line is said", () => {
		const first = Bun.stripANSI(lobbyFrame(screen, 100, 30));
		expect(first).toMatch(/ana\/ford +● 3/u);
		expect(first).toMatch(/ana\/the-keep +○ 0/u);
		expect(first).toContain("● 3 seated · open now");
		expect(first).toContain("ssh ana/ford@…");
		expect(first).not.toContain(screen.you.key?.fingerprint ?? "no key");

		const second = Bun.stripANSI(
			lobbyFrame(
				{ ...screen, picked: 1, said: "ana/shut isn't open right now." },
				100,
				30
			)
		);

		expect(second).toContain("○ empty · open now");
		expect(second).toContain("ssh ana/the-keep@…");
		expect(second).toContain("› ana/shut isn't open right now.");

		const named = Bun.stripANSI(
			lobbyFrame({ ...screen, editing: true, typed: "dungeon" }, 100, 30)
		);

		expect(named).toContain("dungeon");
		expect(named).toContain("◈ joining by table name");
		expect(named).toContain("> dungeon");
		expect(named).toContain("ssh dungeon@…");
	});

	test("many open tables stay within the terminal height with scroll indicators", () => {
		const many: LobbyScreen = {
			...screen,
			picked: 6,
			tables: Array.from({ length: 14 }, (_item, i) =>
				atAna(`table-${i + 1}`, i % 3)
			),
		};

		const frame = lobbyFrame(many, 100, 24);
		const lines = rows(frame);
		expect(lines.length).toBeLessThanOrEqual(24);
		expect(Bun.stripANSI(frame)).toContain("table-7");
		expect(Bun.stripANSI(frame)).toMatch(/↑\d+/u);
		expect(Bun.stripANSI(frame)).toMatch(/↓\d+/u);
	});
});
