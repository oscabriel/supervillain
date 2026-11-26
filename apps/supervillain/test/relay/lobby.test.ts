import { describe, expect, test } from "bun:test";

import { Clock, Effect } from "effect";

import { lobbyFrame } from "../../src/relay/lobby.ts";
import type { LobbyScreen } from "../../src/relay/lobby.ts";
import { closedRoomMessage, JOIN_HINT } from "../../src/relay/protocol.ts";
import { lobbyText } from "../../src/relay/server.ts";
import { effect, waitFor } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";
import { gmTable, linkGm, startRelay } from "./harness.ts";
import type { GmTableOptions } from "./harness.ts";
import { clientKey, sshExec, sshShell } from "./openssh.ts";

type Relay = Effect.Success<ReturnType<typeof startRelay>>;

const openTable = (
	relay: Relay,
	room: string,
	knows?: GmTableOptions["knows"]
) =>
	Effect.gen(function* () {
		const gm = yield* gmTable(knows === undefined ? {} : { knows });

		const link = yield* linkGm(
			gm,
			relay.gmPort,
			room,
			relay.relayKeyFingerprint
		);

		expect(link.answer).toBe("OK");
		yield* waitFor(`room ${room} linked`, () =>
			relay.linkedRooms().includes(room)
		);

		return gm;
	});

const SIZE = { cols: 100, rows: 30 };

const shown = (terminal: { output: () => string }) =>
	Bun.stripANSI(terminal.output());

const PROMPT = "Enter sits at";

const NAME_PROMPT = "> type your table's room name";

const rows = (frame: string) => Bun.stripANSI(frame).split("\r\n");

describe("relay: the lobby", () => {
	effect(
		"a known key sees its table, and Enter seats it there as a <room>@ would",
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

				yield* waitFor("the lobby", () => shown(terminal).includes(PROMPT));
				const lobby = shown(terminal);
				expect(lobby).toContain("● 1 open table");
				expect(lobby).toContain("tables ─");
				expect(lobby).toMatch(/1 {2}ford +● 3/u);
				expect(lobby).not.toContain("keep");
				expect(lobby).toContain("ssh ford@…");
				expect(lobby).toContain("key       ssh-ed25519");
				expect(lobby).toContain(vex.fingerprint);
				expect(lobby).toContain("> Enter sits at ford");
				terminal.resize(120, 40);
				yield* waitFor(
					"the lobby again",
					() => shown(terminal).split(PROMPT).length === 3
				);
				terminal.write("\r");
				yield* waitFor("the seat", () =>
					terminal
						.output()
						.includes(
							`seat key:${vex.fingerprint} xterm-256color 120x40 pty=true`
						)
				);
				expect(terminal.output()).toContain("Joining ford…\r\n");
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

	effect("two tables are listed by name; the player picks one by number", () =>
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

			yield* waitFor("the lobby", () => shown(terminal).includes(PROMPT));
			const lobby = shown(terminal);
			expect(lobby).not.toContain("alex");
			expect(lobby).toContain("● 2 open tables");
			expect(lobby).toMatch(/1 {2}ford +● 2/u);
			expect(lobby).toMatch(/2 {2}keep +● 1/u);
			expect(lobby).toContain(
				"↑/↓ pick   1-2 jump   enter sit down   ctrl-c quit"
			);
			terminal.write("7\r");
			yield* waitFor("the refusal", () =>
				shown(terminal).includes("› There's no 7 on the list.")
			);
			terminal.write("\u001B[B");
			yield* waitFor("the pick", () =>
				shown(terminal).includes("> Enter sits at keep")
			);
			terminal.write("1");
			yield* waitFor("the number", () =>
				shown(terminal)
					.split("\r\n")
					.some((line) => line.trim() === "> 1")
			);
			terminal.write("\u007F\u001B[A\r");
			yield* waitFor("the seat", () =>
				terminal.output().includes(`seat key:${vex.fingerprint}`)
			);
			expect(terminal.output()).toContain("Joining keep…");
			terminal.write("q");
			expect(yield* Effect.promise(async () => await terminal.exited)).toBe(5);
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

				expect(named.stderr).toBe(
					`There's no table called nowhere here.\n${JOIN_HINT}\n`
				);
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
		"a key no open table knows sees the lobby with none listed, and sits by typing a room's name",
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
					shown(terminal).includes(NAME_PROMPT)
				);
				const lobby = shown(terminal);
				expect(lobby).toContain("○ no open tables");
				expect(lobby).toContain("tables ─");
				expect(lobby).toContain("○ none open yet");
				expect(lobby).toContain("Ask your GM for a room name.");
				expect(lobby).not.toContain("ford");
				expect(lobby).not.toContain("alex");
				expect(lobby).toContain(kai.fingerprint);
				expect(lobby).toContain("a-z room name   enter sit down   ctrl-c quit");
				expect(ford.asked.count).toBe(1);
				terminal.write("\u001B[B7\r");
				yield* waitFor("the nudge", () =>
					shown(terminal).includes("› Type your table's room name, then Enter.")
				);
				terminal.write("nowhere\r");
				yield* waitFor("the refusal", () =>
					shown(terminal).includes("› There's no table called nowhere here.")
				);
				terminal.write("Fo-\u007Frd");
				yield* waitFor("the name", () =>
					shown(terminal)
						.split("\r\n")
						.some((line) => line.trim() === "> ford")
				);
				terminal.write("\r");
				yield* waitFor("the seat", () =>
					terminal.output().includes(`seat key:${kai.fingerprint}`)
				);
				expect(terminal.output()).toContain("Joining ford…\r\n");
				terminal.write("q");
				expect(yield* Effect.promise(async () => await terminal.exited)).toBe(
					5
				);
			})
	);

	effect(
		"a guest sees the lobby too, asks nobody, and sits as a guest by a room's name",
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
					shown(terminal).includes(NAME_PROMPT)
				);
				const lobby = shown(terminal);
				expect(lobby).toContain("○ guest session");
				expect(lobby).toContain("key       none");
				expect(lobby).toContain("ssh-keygen -t ed25519");
				expect(lobby).not.toContain("ford");
				expect(ford.asked.count).toBe(0);
				terminal.write("ford\r");
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
		"a known key sits at a table off its list by name; a claimed room with no GM isn't open; five misses and the lobby lets go",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();
				const vex = yield* clientKey(yield* tempDir, "vex");
				yield* openTable(relay, "ford", { actors: [`key:${vex.fingerprint}`] });
				yield* openTable(relay, "keep", { actors: [] });
				yield* Effect.scoped(openTable(relay, "shut", { actors: [] }));
				yield* waitFor(
					"room shut unlinked",
					() => !relay.linkedRooms().includes("shut")
				);

				const named = yield* sshShell(relay.playerPort, SIZE, {
					key: vex,
					user: "lobby",
				});

				yield* waitFor("the lobby", () => shown(named).includes(PROMPT));
				expect(shown(named)).toContain(
					"> Enter sits at ford, or type another room"
				);
				named.write("keep\r");
				yield* waitFor("the seat", () =>
					named.output().includes(`seat key:${vex.fingerprint}`)
				);
				expect(named.output()).toContain("Joining keep…");
				named.write("q");
				expect(yield* Effect.promise(async () => await named.exited)).toBe(5);

				const missing = yield* sshShell(relay.playerPort, SIZE, {
					key: vex,
					user: "lobby",
				});

				yield* waitFor("the lobby", () => shown(missing).includes(PROMPT));
				missing.write("shut\r");
				yield* waitFor("the closed room", () =>
					shown(missing).includes(`› ${closedRoomMessage("shut")}`)
				);
				expect(shown(missing).split(PROMPT).at(-2)).toMatch(/1 {2}ford/u);

				for (const miss of ["one", "two", "three"]) {
					missing.write(`${miss}\r`);
					yield* waitFor(`no ${miss}`, () =>
						shown(missing).includes(`› There's no table called ${miss} here.`)
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
					stderr: `${lobbyText([{ room: "ford", seated: 1 }])}\n`,
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
					frozen,
					relay.gmPort,
					"frozen",
					relay.relayKeyFingerprint
				);

				yield* waitFor("room frozen linked", () =>
					relay.linkedRooms().includes("frozen")
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
					expect(listed.stderr).toBe(
						`${lobbyText([{ room: "ford", seated: 1 }])}\n`
					);
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
					"room old: its host doesn't answer the lobby (older)",
				]);

				const seated = yield* sshExec(relay.playerPort, ["hi"], {
					key: vex,
					user: "old",
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
					"Your tables open now: ford (3 seated), keep (1 seated).\nJoin one with its name before the @, as you came here: ssh ford@…\n",
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

			yield* waitFor("the lobby", () => shown(terminal).includes(PROMPT));
			terminal.write("\u001B[C\u001B[C\u007F");
			terminal.write("1");
			yield* waitFor("the number", () =>
				shown(terminal)
					.split("\r\n")
					.some((line) => line.trim() === "> 1")
			);
			expect(terminal.output().split("\u001B[H\u001B[2J")).toHaveLength(3);
		})
	);

	effect(
		"a CR LF Enter is one Enter, and a lone Esc doesn't swallow the key after it",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();
				const vex = yield* clientKey(yield* tempDir, "vex");
				yield* openTable(relay, "ford", { actors: [`key:${vex.fingerprint}`] });

				const terminal = yield* sshShell(relay.playerPort, SIZE, {
					key: vex,
					user: "lobby",
				});

				yield* waitFor("the lobby", () => shown(terminal).includes(PROMPT));
				terminal.write("5\r\n");
				yield* waitFor("the refusal", () =>
					shown(terminal).includes("There's no 5 on the list.")
				);
				yield* Effect.sleep("300 millis");
				expect(terminal.output()).not.toContain("Joining");
				terminal.write("\u001B");
				yield* Effect.sleep("100 millis");
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
		"Ctrl-C at the prompt leaves cleanly; so does sitting there too long",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay({ lobby: { idleMs: 500 } });
				const vex = yield* clientKey(yield* tempDir, "vex");

				const ford = yield* openTable(relay, "ford", {
					actors: [`key:${vex.fingerprint}`],
				});

				const leaving = yield* sshShell(relay.playerPort, SIZE, {
					key: vex,
					user: "lobby",
				});

				yield* waitFor("the lobby", () => shown(leaving).includes(PROMPT));
				leaving.write("1\u001B\u0003");
				expect(yield* Effect.promise(async () => await leaving.exited)).toBe(0);
				expect(leaving.output()).not.toContain("Joining");

				const idle = yield* sshShell(relay.playerPort, SIZE, {
					key: vex,
					user: "lobby",
				});

				yield* waitFor("the lobby", () => shown(idle).includes(PROMPT));
				expect(yield* Effect.promise(async () => await idle.exited)).toBe(1);
				expect(idle.output()).toContain("No table picked; come back any time.");
				expect(ford.ended).toEqual([]);
			})
	);
});

describe("the lobby's frame", () => {
	const screen: LobbyScreen = {
		tables: [
			{ room: "ford", seated: 3 },
			{ room: "the-keep", seated: 0 },
		],
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

	test("it fits the terminal, from a narrow one to a wide one, cleared and positioned on the prompt", () => {
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
				{
					...nobody,
					you: {
						...nobody.you,
						term: "screen.xterm-256color-extra-long-terminal-name",
					},
				},
			]) {
				const frame = lobbyFrame(each, cols, height);
				expect(frame).toStartWith("\u001B[H\u001B[2J");
				const lines = rows(frame);
				expect(lines.length).toBeLessThanOrEqual(height);

				for (const line of lines) {
					expect(Bun.stringWidth(line)).toBeLessThanOrEqual(cols);
				}

				const promptIndex = lines.findIndex((line) =>
					line.trimStart().startsWith("> ")
				);

				expect(promptIndex).toBeGreaterThan(-1);
				expect(frame).toEndWith(
					`\u001B[${promptIndex + 1};${(lines[promptIndex] ?? "").indexOf(">") + 3}H`
				);
			}
		}
	});

	test("with no table to list it says how to sit down and shows identity and commands; a guest is told so", () => {
		const narrow = rows(lobbyFrame(nobody, 60, 20))
			.map((l) => l.trim())
			.join(" ")
			.replaceAll(/ +/gu, " ");

		expect(narrow).toContain("○ none open yet");
		expect(narrow).toContain(
			"Played tables appear here whenever their GM is live."
		);
		expect(narrow).toContain("Ask your GM for a room name.");
		expect(narrow).toContain("> type your table's room name");
		expect(narrow).not.toContain("identity ─");

		for (const [cols, height] of [
			[80, 24],
			[100, 30],
			[140, 40],
		] as const) {
			const wide = Bun.stripANSI(lobbyFrame(nobody, cols, height));
			expect(wide).toContain("○ no open tables");
			expect(wide).toContain("○ none open yet");
			expect(wide).toContain("identity ─");
			expect(wide).toContain("commands ─");
			expect(wide).toContain("ssh <room>@…");
			expect(wide).toContain("supervillain host --room <name>");
			expect(wide).toContain("draw-steel · set.world · pf2e");
			expect(wide).toContain(screen.you.key?.fingerprint ?? "no key");
		}

		const asGuest = Bun.stripANSI(lobbyFrame(guest, 100, 30));
		expect(asGuest).toContain("○ guest session");
		expect(asGuest).toContain("○ unavailable as guest");
		expect(asGuest).toContain("key       none");
		expect(asGuest).toContain("ssh-keygen -t ed25519");
		expect(asGuest).not.toContain("SHA256:");
	});

	test("the title: between a hero and a villain when wide, in quadrants at 80, compact in the bar when short", () => {
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

	test("the pick is highlighted and detailed on the right; typing another room shifts the detail pane; a line is said", () => {
		const first = Bun.stripANSI(lobbyFrame(screen, 100, 30));
		expect(first).toMatch(/1 {2}ford +● 3/u);
		expect(first).toMatch(/2 {2}the-keep +○ 0/u);
		expect(first).toContain("● 3 seated · open now");
		expect(first).toContain("ssh ford@…");
		expect(first).toContain("> Enter sits at ford, or type another room");

		const second = Bun.stripANSI(
			lobbyFrame(
				{ ...screen, picked: 1, typed: "2", said: "There's no 7 on the list." },
				100,
				30
			)
		);

		expect(second).toContain("○ empty · open now");
		expect(second).toContain("ssh the-keep@…");
		expect(second).toContain("› There's no 7 on the list.");
		expect(second.split("\r\n").some((line) => line.trim() === "> 2")).toBe(
			true
		);
		expect(first).toContain(screen.you.key?.fingerprint ?? "no key");
		expect(Bun.stripANSI(lobbyFrame(screen, 60, 20))).not.toContain(
			"identity ─"
		);

		const named = Bun.stripANSI(
			lobbyFrame({ ...screen, typed: "dungeon" }, 100, 30)
		);

		expect(named).toContain("dungeon ─");
		expect(named).toContain("◈ joining by room name");
		expect(named).toContain("ssh dungeon@…");
	});

	test("many open tables stay within the terminal height with scroll indicators", () => {
		const many: LobbyScreen = {
			...screen,
			picked: 6,
			tables: Array.from({ length: 14 }, (_item, i) => ({
				room: `table-${i + 1}`,
				seated: i % 3,
			})),
		};

		const frame = lobbyFrame(many, 100, 24);
		const lines = rows(frame);
		expect(lines.length).toBeLessThanOrEqual(24);
		expect(Bun.stripANSI(frame)).toContain("table-7");
		expect(Bun.stripANSI(frame)).toMatch(/↑\d+/u);
		expect(Bun.stripANSI(frame)).toMatch(/↓\d+/u);
	});
});
