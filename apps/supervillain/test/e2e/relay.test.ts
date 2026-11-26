import { describe, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import nodePath from "node:path";

import { Effect, Predicate, Schema } from "effect";

import { must } from "../game/must.ts";
import { effect, waitFor } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";
import { clientKey, sshExec, sshShell } from "../relay/openssh.ts";
import { campaignDir, CONFIG_HOME, plainEnv } from "./cli.ts";
import { logOf, pollFor, readLog } from "./log.ts";

const main = nodePath.join(import.meta.dir, "../../src/main.ts");

const root = nodePath.join(import.meta.dir, "../../../..");

interface Child {
	readonly output: () => string;
	readonly stop: (signal?: NodeJS.Signals) => Promise<number>;
}

const supervillain = (
	args: ReadonlyArray<string>,
	configHome: string = CONFIG_HOME
) =>
	Effect.acquireRelease(
		Effect.sync(() => {
			const proc = Bun.spawn(["bun", main, ...args], {
				cwd: root,
				env: { ...plainEnv(), XDG_CONFIG_HOME: configHome },
				stdout: "pipe",
				stderr: "pipe",
			});

			let output = "";
			const decoder = new TextDecoder();

			const pump = async (stream: ReadableStream<Uint8Array>) => {
				for await (const chunk of stream) {
					output += decoder.decode(chunk, { stream: true });
				}
			};

			void pump(proc.stdout);
			void pump(proc.stderr);

			const child: Child = {
				output: () => output,
				stop: async (signal = "SIGINT") => {
					if (proc.exitCode === null && proc.signalCode === null) {
						proc.kill(signal);
					}

					return await proc.exited;
				},
			};

			return { child, proc };
		}),
		({ proc }) =>
			Effect.promise(async () => {
				if (proc.exitCode === null && proc.signalCode === null) {
					proc.kill("SIGKILL");
				}

				await proc.exited;
			})
	).pipe(Effect.map(({ child }) => child));

const freePort = Effect.sync(() => {
	const listener = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			data: (socket) => {
				socket.end();
			},
		},
	});

	const { port } = listener;
	listener.stop(true);

	return port;
});

interface Ports {
	readonly player: number;
	readonly gm: number;
}

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

		yield* waitFor(
			"the relay to start",
			() => /^relay key /mu.test(relay.output()),
			15_000
		);

		const key = /relay key (?<key>SHA256:[A-Za-z0-9+/]{43})/u.exec(
			relay.output()
		)?.groups?.key;

		if (key === undefined) {
			throw new Error(`no relay key in:\n${relay.output()}`);
		}

		return { ...relay, key };
	});

const startHost = (
	campaign: string,
	gmPort: number,
	extra: ReadonlyArray<string> = [],
	configHome: string = CONFIG_HOME
) =>
	Effect.gen(function* () {
		const host = yield* supervillain(
			[
				"host",
				campaign,
				"--headless",
				"--port",
				"0",
				"--table",
				"den",
				"--handle",
				"ana",
				"--door",
				"open",
				"--relay",
				`127.0.0.1:${gmPort}`,
				...extra,
			],
			configHome
		);

		yield* waitFor(
			"the host to start",
			() => /^host key /mu.test(host.output()),
			15_000
		);

		const hostKey = /host key (?<key>SHA256:[A-Za-z0-9+/]{43})/u.exec(
			host.output()
		)?.groups?.key;

		const gmKey = /your GM key (?<key>SHA256:[A-Za-z0-9+/]{43})/u.exec(
			host.output()
		)?.groups?.key;

		return { ...host, hostKey: must(hostKey), gmKey: must(gmKey) };
	});

const links = (host: Child) =>
	host.output().split("linked as ana/den").length - 1;

const Handles = Schema.fromJsonString(
	Schema.Record(
		Schema.String,
		Schema.Struct({
			keys: Schema.Array(Schema.String),
			claimed: Schema.String,
			seen: Schema.String,
		})
	)
);

const decodeHandles = Schema.decodeUnknownSync(Handles);

const handlesOf = (relayDir: string) =>
	Effect.promise(async () =>
		decodeHandles(
			await readFile(nodePath.join(relayDir, "handles.json"), "utf-8")
		)
	);

const handleKeys = (
	handles: Readonly<Record<string, { readonly keys: ReadonlyArray<string> }>>
): Readonly<Record<string, ReadonlyArray<string>>> =>
	Object.fromEntries(
		Object.entries(handles).map(([handle, { keys }]) => [handle, keys])
	);

describe("supervillain host --relay, through supervillain relay", () => {
	effect(
		"players sit at the table through the relay, as their own keys, and come back after a relay restart",
		() =>
			Effect.gen(function* () {
				const relayDir = yield* tempDir;
				const campaign = yield* campaignDir;
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
				yield* waitFor("the pin said", () =>
					host.output().includes(`trusted relay key ${relay.key} on first use`)
				);

				const known = yield* Effect.promise(
					async () =>
						await readFile(nodePath.join(campaign, "relay_known"), "utf-8")
				);

				expect(known.trim()).toBe(relay.key);
				yield* waitFor(
					"the claim",
					() => relay.output().includes("handle ana: claimed by GM key"),
					10_000
				);
				expect(handleKeys(yield* handlesOf(relayDir))).toEqual({
					ana: [host.gmKey],
				});
				expect(host.gmKey).not.toBe(host.hostKey);
				expect(host.output()).toContain(
					`players join with: ssh -p ${ports.player} ana/den@127.0.0.1`
				);
				expect(host.output()).toContain(
					"players' ssh sees the relay's host key"
				);
				expect(host.output()).toContain(
					`host key ${host.hostKey} (this table's: direct connections only)`
				);
				expect(host.output()).toMatch(
					/players here can also join directly: ssh -p \d+ den@127\.0\.0\.1/u
				);

				const logged = host
					.output()
					.split("\n")
					.find((line) => / INFO .*hosting "den"/u.test(line));

				expect(logged).toContain(
					"players' ssh sees the relay's host key: ask whoever runs the relay"
				);
				expect(logged).toContain(
					`this table's host key ${host.hostKey} is for direct connections only`
				);

				const rolled = yield* sshExec(ports.player, ["roll", "2d6"], {
					key: vex,
					user: "ana/den",
				});

				expect(rolled.exitCode).toBe(0);
				expect(rolled.stdout).toMatch(
					/ rolled 2d6: \[[1-6], [1-6]\] = \d+\n$/u
				);

				const terminal = yield* sshShell(
					ports.player,
					{ cols: 100, rows: 30 },
					{ key: kai, user: "ana/den" }
				);

				yield* waitFor("the name prompt", () =>
					Bun.stripANSI(terminal.output()).includes("type the name you want")
				);
				terminal.write("Kai\r");
				yield* Effect.promise(
					async () =>
						await pollFor(
							async () => {
								const log = await readLog(campaign);

								return log.some(
									(e) =>
										Predicate.hasProperty(e.payload, "name") &&
										e.payload.name === "Kai"
								)
									? log
									: undefined;
							},
							() => "Kai's name never reached the log",
							5000
						)
				);
				const log = yield* logOf(campaign);
				expect(log.map((e) => [e.actor, e.type])).toEqual([
					["gm", "core.door-set"],
					[`key:${vex.fingerprint}`, "core.dice-rolled"],
					[`key:${kai.fingerprint}`, "core.name-set"],
				]);

				const rsa = yield* clientKey(keys, "rsa", "rsa");

				const offered = yield* sshExec(ports.player, ["roll", "1d2"], {
					key: vex,
					user: "ana/den",
					flags: ["-i", rsa.path],
				});

				expect(offered.exitCode).toBe(0);
				expect(offered.stdout).toMatch(/rolled 1d2/u);

				const usurper = yield* startHost(
					yield* campaignDir,
					ports.gm,
					[],
					yield* tempDir
				);

				yield* waitFor(
					"the relay to refuse the second GM",
					() =>
						relay.output().includes(`refused a GM with key ${usurper.gmKey}`),
					10_000
				);
				expect(links(usurper)).toBe(0);
				yield* waitFor("the usurper's warning", () =>
					usurper
						.output()
						.includes("another GM's key may hold the handle ana there")
				);
				expect(handleKeys(yield* handlesOf(relayDir))).toEqual({
					ana: [host.gmKey],
				});
				yield* Effect.promise(async () => await usurper.stop());

				expect(
					yield* Effect.promise(async () => await relay.stop("SIGKILL"))
				).not.toBe(0);
				yield* Effect.promise(async () => await terminal.exited);
				yield* waitFor(
					"the host to notice",
					() => host.output().includes("connecting (the link dropped"),
					10_000
				);
				const back = yield* startRelay(relayDir, ports);
				expect(back.key).toBe(relay.key);
				yield* waitFor("the redial", () => links(host) === 2, 15_000);

				const again = yield* sshExec(ports.player, ["/name Vex"], {
					key: vex,
					user: "ana/den",
				});

				expect(again).toMatchObject({
					exitCode: 0,
					stdout: "Vex joins the table.\n",
				});
				expect((yield* logOf(campaign)).at(-1)).toMatchObject({
					actor: `key:${vex.fingerprint}`,
					type: "core.name-set",
				});

				const seated = yield* sshShell(
					ports.player,
					{ cols: 100, rows: 30 },
					{ key: kai, user: "ana/den" }
				);

				yield* waitFor("Kai's seat", () =>
					Bun.stripANSI(seated.output()).includes("Kai")
				);
				expect(yield* Effect.promise(async () => await host.stop())).toBe(0);
				yield* waitFor(
					"the goodbye",
					() =>
						Bun.stripANSI(seated.output()).includes("The GM closed the table."),
					10_000
				);
				yield* Effect.promise(async () => await seated.exited);
				yield* waitFor("the relay to see the link go", () =>
					back.output().includes("table ana/den: GM link closed")
				);

				const closed = yield* sshExec(ports.player, ["help"], {
					key: vex,
					user: "ana/den",
				});

				expect(closed).toMatchObject({
					exitCode: 1,
					stderr: "ana/den isn't open right now.\n",
				});
			}),
		90_000
	);

	effect(
		"a player who has sat at a table finds it in the lobby, unless its GM says --no-lobby",
		() =>
			Effect.gen(function* () {
				const campaign = yield* campaignDir;
				const keys = yield* tempDir;
				const vex = yield* clientKey(keys, "vex");
				const kai = yield* clientKey(keys, "kai");
				const ports = { player: yield* freePort, gm: yield* freePort };
				yield* startRelay(yield* tempDir, ports);
				const host = yield* startHost(campaign, ports.gm);
				yield* waitFor("the link", () => links(host) === 1, 10_000);
				expect(host.output()).toContain(
					"its lobby lists this table to players whose key has sat here (--no-lobby: never)"
				);

				expect(
					(yield* sshExec(ports.player, ["roll", "1d6"], {
						key: vex,
						user: "ana/den",
					})).exitCode
				).toBe(0);

				const stranger = yield* sshExec(ports.player, ["help"], {
					key: kai,
					user: "lobby",
				});

				expect(stranger.stderr).toBe(
					"To join a table, put its name before the @ (ssh <handle>/<table>@…). Your GM has it.\n"
				);

				const terminal = yield* sshShell(
					ports.player,
					{ cols: 100, rows: 30 },
					{ key: vex, user: "lobby" }
				);

				yield* waitFor("the lobby", () =>
					Bun.stripANSI(terminal.output()).includes("ssh ana/den@…")
				);
				expect(Bun.stripANSI(terminal.output())).toMatch(/ana\/den +○ 0/u);
				terminal.write("\r");
				yield* waitFor(
					"the name prompt",
					() =>
						Bun.stripANSI(terminal.output()).includes("type the name you want"),
					10_000
				);
				yield* waitFor("the host to say so", () =>
					host
						.output()
						.includes(
							`lobby: the relay listed this table for key:${vex.fingerprint}`
						)
				);
				terminal.write("\u0003");
				yield* Effect.promise(async () => await terminal.exited);

				expect(yield* Effect.promise(async () => await host.stop())).toBe(0);
				const quiet = yield* startHost(campaign, ports.gm, ["--no-lobby"]);
				yield* waitFor("the relink", () => links(quiet) === 1, 15_000);
				expect(quiet.output()).toContain(
					"its lobby never lists this table (--no-lobby)"
				);

				const hidden = yield* sshExec(ports.player, ["help"], {
					key: vex,
					user: "lobby",
				});

				expect(hidden).toMatchObject({ exitCode: 1, stderr: stranger.stderr });
			}),
		60_000
	);

	effect(
		"a relay stopped with SIGTERM puts players' terminals back before it says so",
		() =>
			Effect.gen(function* () {
				const kai = yield* clientKey(yield* tempDir, "kai");
				const ports = { player: yield* freePort, gm: yield* freePort };
				const relay = yield* startRelay(yield* tempDir, ports);
				const host = yield* startHost(yield* campaignDir, ports.gm);
				yield* waitFor("the link", () => links(host) === 1, 10_000);

				const terminal = yield* sshShell(
					ports.player,
					{ cols: 100, rows: 30 },
					{ key: kai, user: "ana/den" }
				);

				yield* waitFor("the name prompt", () =>
					Bun.stripANSI(terminal.output()).includes("type the name you want")
				);
				expect(terminal.output()).toContain("\u001B[?1049h");
				expect(
					yield* Effect.promise(async () => await relay.stop("SIGTERM"))
				).toBe(0);
				yield* Effect.promise(async () => await terminal.exited);
				const output = terminal.output();
				const notice = output.lastIndexOf("The relay is shutting down.");
				expect(notice).toBeGreaterThan(-1);
				expect(output.lastIndexOf("\u001B[?1049l")).toBeLessThan(notice);
				expect(output.lastIndexOf("\u001B[?1049l")).toBeGreaterThan(
					output.lastIndexOf("\u001B[?1049h")
				);
				expect(output.lastIndexOf("\u001B[?25h")).toBeLessThan(notice);
				expect(output.slice(notice - 2, notice)).toBe("\r\n");
			}),
		60_000
	);

	effect(
		"a host that dies mid-game: a relayed pty player sees The table closed.",
		() =>
			Effect.gen(function* () {
				const relayDir = yield* tempDir;
				const campaign = yield* campaignDir;
				const kai = yield* clientKey(yield* tempDir, "kai");
				const ports = { player: yield* freePort, gm: yield* freePort };
				yield* startRelay(relayDir, ports);
				const host = yield* startHost(campaign, ports.gm);
				yield* waitFor("the link", () => links(host) === 1, 10_000);

				const terminal = yield* sshShell(
					ports.player,
					{ cols: 100, rows: 30 },
					{ key: kai, user: "ana/den" }
				);

				yield* waitFor("the name prompt", () =>
					Bun.stripANSI(terminal.output()).includes("type the name you want")
				);
				yield* Effect.promise(async () => await host.stop("SIGKILL"));
				yield* waitFor(
					"the notice",
					() => Bun.stripANSI(terminal.output()).includes("The table closed."),
					10_000
				);
				expect(yield* Effect.promise(async () => await terminal.exited)).toBe(
					1
				);
			}),
		60_000
	);

	effect(
		"a host refuses a relay whose key isn't the one in relay_known, and keeps the pin",
		() =>
			Effect.gen(function* () {
				const campaign = yield* campaignDir;
				const vex = yield* clientKey(yield* tempDir, "vex");
				const realPorts = { player: yield* freePort, gm: yield* freePort };
				const real = yield* startRelay(yield* tempDir, realPorts);
				const first = yield* startHost(campaign, realPorts.gm);
				yield* waitFor("the link", () => links(first) === 1, 10_000);
				expect(yield* Effect.promise(async () => await first.stop())).toBe(0);

				const fakePorts = { player: yield* freePort, gm: yield* freePort };
				const fake = yield* startRelay(yield* tempDir, fakePorts);
				expect(fake.key).not.toBe(real.key);
				const host = yield* startHost(campaign, fakePorts.gm);
				yield* waitFor(
					"the host to refuse the relay",
					() =>
						host
							.output()
							.includes(`its key ${fake.key} doesn't match ${real.key}`),
					10_000
				);
				expect(host.output()).toContain("Not redialing until that's fixed.");
				expect(links(host)).toBe(0);
				yield* waitFor("the relay to log the refusal", () =>
					fake.output().includes("refused this relay's key")
				);

				const known = yield* Effect.promise(
					async () =>
						await readFile(nodePath.join(campaign, "relay_known"), "utf-8")
				);

				expect(known.trim()).toBe(real.key);

				const turnedAway = yield* sshExec(fakePorts.player, ["help"], {
					key: vex,
					user: "ana/den",
				});

				expect(turnedAway.exitCode).toBe(1);
				expect(turnedAway.stderr).toBe("ana/den isn't open right now.\n");

				expect(yield* Effect.promise(async () => await host.stop())).toBe(0);

				const pinned = yield* startHost(campaign, fakePorts.gm, [
					"--relay-key",
					real.key,
				]);

				yield* waitFor(
					"the pinned host to refuse the relay",
					() =>
						pinned.output().includes(`doesn't match --relay-key ${real.key}`),
					10_000
				);
			}),
		60_000
	);
});
