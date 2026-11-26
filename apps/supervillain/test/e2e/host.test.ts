import { describe, expect } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";

import { must } from "../game/must.ts";
import { effect } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";
import { campaignDir, cli, startHost } from "./cli.ts";
import { logOf, pollFor, readLog } from "./log.ts";
import { clientKey, sshExec, sshShell, waitFor } from "./openssh.ts";

const main = path.join(import.meta.dir, "../../src/main.ts");

const root = path.join(import.meta.dir, "../../../..");

const killed = (pid: number) => {
	try {
		return process.kill(pid, "SIGKILL");
	} catch {
		return false;
	}
};

const seatedHost = (campaign: string, detached: boolean) =>
	Effect.acquireRelease(
		Effect.promise(async () => {
			let screen = "";
			const decoder = new TextDecoder();

			const command = [
				"bun",
				main,
				"host",
				campaign,
				"--port",
				"0",
				"--room",
				"den",
			];

			const proc = Bun.spawn(
				detached ? ["setsid", "--wait", ...command] : command,
				{
					cwd: root,
					env: { ...process.env, TERM: "xterm-256color" },
					terminal: {
						cols: 100,
						rows: 30,
						data: (_terminal, data) => {
							screen += decoder.decode(data, { stream: true });
						},
					},
				}
			);

			const hostPort = async () => {
				const log = await readFile(
					path.join(campaign, "host.log"),
					"utf-8"
				).catch(() => "");

				const found = /on 127\.0\.0\.1:(?<port>\d+)/u.exec(log)?.groups?.port;

				return found === undefined || !screen.includes("at the table")
					? undefined
					: Number(found);
			};

			const port = await pollFor(
				hostPort,
				() => `the GM's table never came up:\n${screen}`,
				15_000
			);

			const pid = Number(
				await readFile(path.join(campaign, "events.lock"), "utf-8")
			);

			return { proc, pid, port, closeTerminal: () => proc.terminal?.close() };
		}),
		({ proc, pid }) =>
			Effect.promise(async () => {
				for (const each of [pid, proc.pid]) {
					killed(each);
				}

				await proc.exited;
			})
	);

describe("supervillain host --headless", () => {
	effect(
		"players reach the table over real ssh: exec commands, a pty seat, and a clean stop",
		() =>
			Effect.gen(function* () {
				const campaign = yield* campaignDir;
				const vex = yield* clientKey(yield* tempDir, "vex");

				const host = yield* startHost([
					campaign,
					"--headless",
					"--room",
					"den",
					"--door",
					"open",
				]);

				expect(host.output()).toContain(`ssh -p ${host.port} den@127.0.0.1`);
				expect(host.output()).toMatch(/host key SHA256:[A-Za-z0-9+/]{43}/u);

				const label = vex.fingerprint.slice(
					"SHA256:".length,
					"SHA256:".length + 8
				);

				const rolled = yield* sshExec(host.port, "roll 2d6", vex);
				expect(rolled).toMatchObject({ exitCode: 0, stderr: "" });
				expect(rolled.stdout).toMatch(
					/^.{8} rolled 2d6: \[[1-6], [1-6]\] = \d+\n$/u
				);
				expect(rolled.stdout.startsWith(`${label} rolled`)).toBe(true);

				expect(yield* sshExec(host.port, "/name Vex", vex)).toMatchObject({
					exitCode: 0,
					stdout: "Vex joins the table.\n",
				});
				expect(yield* sshExec(host.port, "hello everyone", vex)).toMatchObject({
					exitCode: 0,
					stdout: "Vex: hello everyone\n",
				});
				expect(
					yield* sshExec(host.port, "/narrate The sky falls.", vex)
				).toMatchObject({
					exitCode: 1,
					stdout: "",
					stderr: "Only the GM can use /narrate.\n",
				});
				const guest = yield* sshExec(host.port, "roll d6");
				expect(guest.exitCode).toBe(0);
				expect(guest.stdout).toMatch(
					/^guest-.{4} rolled 1d6: \[[1-6]\] = [1-6]\n$/u
				);

				const log = yield* logOf(campaign);
				expect(log.map((e) => [e.seq, e.type])).toEqual([
					[1, "core.door-set"],
					[2, "core.dice-rolled"],
					[3, "core.name-set"],
					[4, "core.chat-posted"],
					[5, "core.dice-rolled"],
				]);
				expect(log.slice(1, 4).map((e) => e.actor)).toEqual(
					Array.from({ length: 3 }, () => `key:${vex.fingerprint}`)
				);
				expect(must(log[2]).payload).toEqual({ name: "Vex" });
				expect(must(log[4]).actor).toMatch(/^guest:/u);

				const terminal = yield* sshShell(host.port, vex);
				yield* waitFor("the feed", () => terminal.text().includes("everyone"));
				terminal.write("from the pty\r");
				yield* Effect.promise(
					async () =>
						await pollFor(
							async () => {
								const lines = await readLog(campaign);

								return lines.length < 6 ? undefined : lines;
							},
							() => "the pty chat never reached the log",
							5000
						)
				);
				expect((yield* logOf(campaign)).at(-1)).toMatchObject({
					seq: 6,
					actor: `key:${vex.fingerprint}`,
					payload: { text: "from the pty" },
				});

				expect(yield* Effect.promise(async () => await host.stop())).toBe(0);
				expect(existsSync(path.join(campaign, "events.lock"))).toBe(false);
			}),
		30_000
	);

	effect(
		"runs from any folder, on a campaign folder given relative to it",
		() =>
			Effect.gen(function* () {
				const elsewhere = yield* tempDir;
				yield* Effect.promise(
					async () =>
						await mkdir(path.join(elsewhere, "ford", "heroes"), {
							recursive: true,
						})
				);
				const host = yield* startHost(["ford", "--headless"], elsewhere);
				expect(yield* sshExec(host.port, "help")).toMatchObject({
					exitCode: 1,
					stderr:
						"This table lets players in by knocking: connect interactively and wait for the GM.\n",
				});
				expect(existsSync(path.join(elsewhere, "ford", "host_key"))).toBe(true);
				expect(yield* Effect.promise(async () => await host.stop())).toBe(0);
			}),
		30_000
	);

	effect(
		"a campaign folder that isn't there is refused, pointing at `new`, and nothing is made",
		() =>
			Effect.gen(function* () {
				const typo = path.join(yield* tempDir, "frod");
				const result = yield* cli(["host", typo, "--headless", "--port", "0"]);
				expect(result.exitCode).toBe(1);
				expect(result.stderr.trim().split("\n")).toEqual([
					`supervillain: there's no campaign at ${typo}; make one with: bun supervillain new ${typo} (--example for the sample)`,
				]);
				expect(existsSync(typo)).toBe(false);
			})
	);

	effect(
		"an empty or unrelated folder is refused, pointing at `new`, and nothing is written in it",
		() =>
			Effect.gen(function* () {
				const empty = yield* tempDir;

				const refused = yield* cli([
					"host",
					empty,
					"--headless",
					"--port",
					"0",
				]);

				expect(refused.exitCode).toBe(1);
				expect(refused.stderr.trim().split("\n")).toEqual([
					`supervillain: ${empty} isn't a campaign: it has no campaign.yaml, table.md, events.jsonl, host_key, heroes/, party/, monsters/, scenes/ or maps/; make one there with: bun supervillain new ${empty} (--example for the sample)`,
				]);
				expect(yield* Effect.promise(async () => await readdir(empty))).toEqual(
					[]
				);

				const unrelated = yield* tempDir;
				yield* Effect.promise(async () => {
					await writeFile(path.join(unrelated, "notes.txt"), "groceries\n");
				});

				const also = yield* cli([
					"host",
					unrelated,
					"--headless",
					"--port",
					"0",
				]);

				expect(also.exitCode).toBe(1);
				expect(also.stderr.trim().split("\n")).toEqual([
					`supervillain: ${unrelated} isn't a campaign: it has no campaign.yaml, table.md, events.jsonl, host_key, heroes/, party/, monsters/, scenes/ or maps/; make one in a new folder with: bun supervillain new <folder> (--example for the sample)`,
				]);
				expect(
					yield* Effect.promise(async () => await readdir(unrelated))
				).toEqual(["notes.txt"]);
			})
	);

	effect(
		"a campaign.yaml naming a ruleset the table doesn't know is one plain line, and no log is opened",
		() =>
			Effect.gen(function* () {
				const campaign = yield* campaignDir;
				const file = path.join(campaign, "campaign.yaml");
				yield* Effect.promise(async () => {
					await writeFile(file, "rules: pathfinder\n");
				});

				const refused = yield* cli([
					"host",
					campaign,
					"--headless",
					"--port",
					"0",
				]);

				expect(refused.exitCode).toBe(1);
				expect(refused.stderr.trim().split("\n")).toEqual([
					`supervillain: ${file}: says rules: pathfinder, but a campaign plays draw-steel, set-world, pf2e or freeform`,
				]);
				expect(existsSync(path.join(campaign, "events.jsonl"))).toBe(false);
			})
	);

	effect("a port in use is one plain line saying what to do", () =>
		Effect.gen(function* () {
			const campaign = yield* campaignDir;

			const busy = Bun.listen({
				hostname: "127.0.0.1",
				port: 0,
				socket: { data() {} },
			});

			try {
				const result = yield* cli([
					"host",
					campaign,
					"--headless",
					"--port",
					String(busy.port),
				]);

				expect(result.exitCode).toBe(1);
				expect(result.stderr.trim().split("\n")).toEqual([
					`supervillain: port ${busy.port} on 127.0.0.1 is in use (another table?); pick another with --port, or --port 0 for any free one`,
				]);
			} finally {
				busy.stop(true);
			}
		})
	);

	effect(
		"a port out of range, or a --bind that isn't an address, is one plain line",
		() =>
			Effect.gen(function* () {
				const campaign = yield* campaignDir;

				for (const [flags, said] of [
					[
						["--port", "99999"],
						"--port takes a port from 0 to 65535, not 99999",
					],
					[["--port", "-5"], "--port takes a port from 0 to 65535, not -5"],
					[
						["--bind", "127.0.0.256"],
						'--bind takes an IP address, such as 127.0.0.1 or 0.0.0.0, or localhost, not "127.0.0.256"',
					],
					[
						["--bind", "127.0.0.1 "],
						'--bind takes an IP address, such as 127.0.0.1 or 0.0.0.0, or localhost, not "127.0.0.1 "',
					],
				] as const) {
					const port = flags[0] === "--port" ? [] : ["--port", "0"];

					const result = yield* cli([
						"host",
						campaign,
						"--headless",
						...flags,
						...port,
					]);

					expect(result.exitCode).toBe(1);
					expect(result.stderr.trim().split("\n")).toEqual([
						`supervillain: ${said}`,
					]);
				}
			}),
		30_000
	);
});

describe("supervillain host, the GM at its terminal", () => {
	for (const [how, detached] of [
		["with a hang-up", false],
		["without one", true],
	] as const) {
		effect(
			`the GM's terminal going away ${how} closes the table: players told, their terminals put back, no lock left`,
			() =>
				Effect.gen(function* () {
					const campaign = yield* campaignDir;
					const host = yield* seatedHost(campaign, detached);
					const terminal = yield* sshShell(host.port);
					yield* waitFor("the player's seat", () =>
						terminal.text().includes("call you?")
					);
					host.closeTerminal();
					terminal.write("Kai\r");
					yield* waitFor(
						"the host to stop",
						() => !existsSync(path.join(campaign, "events.lock"))
					);
					yield* waitFor("the goodbye", () =>
						terminal.text().includes("The GM closed the table.")
					);
					const output = terminal.output();
					expect(output.lastIndexOf("\u001B[?1049l")).toBeGreaterThan(
						output.lastIndexOf("\u001B[?1049h")
					);
					expect(
						output.lastIndexOf("The GM closed the table.")
					).toBeGreaterThan(output.lastIndexOf("\u001B[?1049l"));
				}),
			30_000
		);
	}
});
