import { describe, expect, test } from "bun:test";

import { Clock, Effect } from "effect";

import { lobbyFrame } from "../../src/relay/lobby.ts";
import type { LobbyScreen } from "../../src/relay/lobby.ts";
import { JOIN_HINT } from "../../src/relay/protocol.ts";
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

const PROMPT = "Enter sits you at";

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
				expect(lobby).toContain(
					"a virtual tabletop you reach with ssh  ·  1 open table knows your key"
				);
				expect(lobby).toContain("┌─ ¹ tables ─");
				expect(lobby).toMatch(/│ ▌ 1 {2}ford +● 3 │/u);
				expect(lobby).not.toContain("keep");
				expect(lobby).toContain("key       ssh-ed25519");
				expect(lobby).toContain(`│ ${vex.fingerprint}`);
				expect(lobby).toContain("> Enter sits you at ford");
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
			expect(lobby).toContain("2 open tables know your key");
			expect(lobby).toMatch(/│ ▌ 1 {2}ford +● 2 │/u);
			expect(lobby).toMatch(/│ {3}2 {2}keep +● 1 │/u);
			expect(lobby).toContain(
				"↑↓ pick · 1-2 by number · Enter sits you down · Ctrl-C leaves"
			);
			terminal.write("7\r");
			yield* waitFor("the refusal", () =>
				shown(terminal).includes("› There's no 7 on the list.")
			);
			terminal.write("\u001B[B");
			yield* waitFor("the pick", () =>
				/│ ▌ 2 {2}keep/u.test(shown(terminal).split(PROMPT).at(-2) ?? "")
			);
			terminal.write("1");
			yield* waitFor("the number", () => shown(terminal).endsWith("> 1"));
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
		"a key no open table knows, and a guest, get today's hint; a guest asks nobody",
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

				const shell = yield* sshShell(relay.playerPort, SIZE, {
					user: "lobby",
				});

				expect(yield* Effect.promise(async () => await shell.exited)).toBe(1);
				expect(shell.output()).toBe(`${JOIN_HINT}\r\n`);
				expect(ford.asked.count).toBe(asked);
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
			yield* waitFor("the number", () => shown(terminal).endsWith("> 1"));
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
			fingerprint: "SHA256:Lb2N0yQ8m4fBkqyC2r0wbqv1o3cJm7k6zgWcT4m2Ywo",
			algorithm: "ssh-ed25519",
			term: "xterm-ghostty",
		},
	};

	test("it fits the terminal, from a narrow one to a wide one, cleared and drawn from the top", () => {
		for (const [cols, height] of [
			[60, 20],
			[80, 24],
			[100, 30],
			[140, 40],
		] as const) {
			const frame = lobbyFrame(screen, cols, height);
			expect(frame).toStartWith("\u001B[H\u001B[2J");
			const lines = rows(frame);
			expect(lines.length).toBeLessThanOrEqual(height);

			for (const line of lines) {
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(cols);
			}

			expect(frame).toEndWith(
				`\u001B[${lines.length};${(lines.at(-1) ?? "").indexOf(">") + 3}H`
			);
		}
	});

	test("the title: between a hero and a villain when wide, in quadrants at 80, a word when short", () => {
		const wide = rows(lobbyFrame(screen, 140, 40));
		expect(
			Math.max(...wide.slice(0, 6).map((l) => Bun.stringWidth(l.trim())))
		).toBeGreaterThan(110);
		const eighty = rows(lobbyFrame(screen, 80, 24));
		expect(eighty[0]).toMatch(/[▘▝▖▗▚▞▙▟▛▜]/u);
		expect((rows(lobbyFrame(screen, 80, 16))[0] ?? "").trim()).toBe(
			"supervillain"
		);
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

	test("the pick is marked and named at the prompt; a number typed shows; a line is said", () => {
		const first = Bun.stripANSI(lobbyFrame(screen, 100, 30));
		expect(first).toMatch(/│ ▌ 1 {2}ford +● 3 │/u);
		expect(first).toMatch(/│ {3}2 {2}the-keep +○ 0 │/u);
		expect(first).toContain("> Enter sits you at ford");

		const second = Bun.stripANSI(
			lobbyFrame(
				{ ...screen, picked: 1, typed: "2", said: "There's no 7 on the list." },
				100,
				30
			)
		);

		expect(second).toMatch(/│ ▌ 2 {2}the-keep/u);
		expect(second).toContain("› There's no 7 on the list.");
		expect((second.split("\r\n").at(-1) ?? "").trim()).toBe("> 2");
		expect(first).toContain(screen.you.fingerprint);
		expect(Bun.stripANSI(lobbyFrame(screen, 60, 20))).not.toContain("² you");
	});
});
