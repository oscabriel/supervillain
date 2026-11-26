import { describe, expect } from "bun:test";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect, Schema } from "effect";

import { JOIN_HINT } from "../../src/relay/protocol.ts";
import { cli } from "../e2e/cli.ts";
import { effect, waitFor } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";
import { clientKey, sshExec } from "./openssh.ts";

const main = path.join(import.meta.dir, "../../src/main.ts");

const GM = `SHA256:${"A".repeat(43)}`;

const LINKED = "2026-10-01T12:00:00.000Z";

const TWO_HANDLES = JSON.stringify({
	ana: { keys: [GM], claimed: LINKED, seen: LINKED },
	bo: { keys: [GM], claimed: LINKED, seen: LINKED },
});

const STARTED = /GMs dial 127\.0\.0\.1:\d+/u;

const RELAY_KEY = /relay key (?<key>SHA256:[A-Za-z0-9+/]{43})/u;

const PLAYER_PORT = /ssh -p (?<port>\d+) <handle>\/<table>@/u;

const StoredHandles = Schema.fromJsonString(
	Schema.Record(
		Schema.String,
		Schema.Struct({
			keys: Schema.Array(Schema.String),
			claimed: Schema.String,
			seen: Schema.String,
		})
	)
);

const writeText = (file: string, text: string, mode?: number) =>
	Effect.promise(async () => {
		await writeFile(file, text, mode === undefined ? {} : { mode });
	});

const privateBits = (file: string) =>
	Effect.promise(async () => await stat(file)).pipe(
		Effect.map(({ mode }) => mode % 0o100)
	);

const relayProcess = (args: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const proc = yield* Effect.acquireRelease(
			Effect.sync(() =>
				Bun.spawn(["bun", main, "relay", ...args], {
					stdout: "pipe",
					stderr: "pipe",
				})
			),
			(spawned) =>
				Effect.promise(async () => {
					spawned.kill("SIGINT");
					await spawned.exited;
				})
		);

		let output = "";
		const decoder = new TextDecoder();

		const pump = (stream: ReadableStream<Uint8Array>) =>
			Effect.promise(async () => {
				for await (const chunk of stream) {
					output += decoder.decode(chunk, { stream: true });
				}
			});

		yield* Effect.forkScoped(pump(proc.stdout));
		yield* Effect.forkScoped(pump(proc.stderr));

		return { proc, output: () => output };
	});

describe("supervillain relay", () => {
	effect(
		"starts on the ports it's given, prints its key for GMs to pin, and keeps its files in --dir",
		() =>
			Effect.gen(function* () {
				const dir = path.join(yield* tempDir, "relay");

				const relay = yield* relayProcess([
					"--player-port",
					"0",
					"--gm-port",
					"0",
					"--bind",
					"127.0.0.1",
					"--dir",
					dir,
				]);

				yield* waitFor(
					"the relay to start",
					() => STARTED.test(relay.output()),
					10_000
				);

				const key = RELAY_KEY.exec(relay.output())?.groups?.key;

				expect(key).toBeDefined();
				expect(relay.output()).toContain(`--relay-key ${key}`);
				expect(relay.output()).toContain(
					"a handle's claim lapses after 180 days with no GM linked"
				);

				const playerPort = Number(
					PLAYER_PORT.exec(relay.output())?.groups?.port
				);

				const vex = yield* clientKey(yield* tempDir, "vex");

				const ran = yield* sshExec(playerPort, ["hi"], {
					key: vex,
					user: "den",
				});

				expect(ran).toMatchObject({
					exitCode: 1,
					stderr: `${JOIN_HINT}\n`,
				});

				for (const name of ["relay_key", "host_key"]) {
					expect(yield* privateBits(path.join(dir, name))).toBe(0);
				}
			}),
		20_000
	);

	effect("relay forget releases a handle's claim", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const handles = path.join(dir, "handles.json");
			yield* writeText(handles, TWO_HANDLES);
			yield* writeText(path.join(dir, "relay_key"), "", 0o600);
			const forgot = yield* cli(["relay", "forget", "ana", "--dir", dir]);
			expect(forgot.exitCode).toBe(0);
			expect(forgot.stdout).toContain("released the handle ana");
			expect(forgot.stdout).toContain(GM);
			expect(forgot.stdout).toContain(
				"The next GM to link a table under it claims it"
			);
			expect(
				yield* Effect.promise(
					async () => await readFile(handles, "utf-8")
				).pipe(Effect.flatMap(Schema.decodeUnknownEffect(StoredHandles)))
			).toEqual({
				bo: { keys: [GM], claimed: LINKED, seen: LINKED },
			});
			const again = yield* cli(["relay", "forget", "ana", "--dir", dir]);
			expect(again).toMatchObject({ exitCode: 0 });
			expect(again.stdout).toContain(
				`no GM holds the handle ana in ${handles}`
			);
			const bad = yield* cli(["relay", "forget", "Not A Handle", "--dir", dir]);
			expect(bad.exitCode).toBe(1);
		})
	);

	effect("--public-relay takes host:port", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;

			const started = yield* cli([
				"relay",
				"--player-port",
				"0",
				"--gm-port",
				"0",
				"--bind",
				"127.0.0.1",
				"--public-relay",
				"not a relay",
				"--dir",
				dir,
			]);

			expect(started.exitCode).toBe(1);
			expect(started.stderr).toContain(
				"--public-relay takes host:port, not not a relay"
			);
		})
	);

	effect("--claim-days takes a whole number of days, at least one", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;

			const started = yield* cli([
				"relay",
				"--player-port",
				"0",
				"--gm-port",
				"0",
				"--bind",
				"127.0.0.1",
				"--claim-days",
				"0",
				"--dir",
				dir,
			]);

			expect(started.exitCode).toBe(1);
			expect(started.stderr).toContain(
				"--claim-days takes a number of days from 1, not 0"
			);
		})
	);

	effect(
		"--sandboxes takes a count from 0, and says what the lobby offers",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;

				const refused = yield* cli([
					"relay",
					"--player-port",
					"0",
					"--gm-port",
					"0",
					"--bind",
					"127.0.0.1",
					"--sandboxes",
					"-1",
					"--dir",
					dir,
				]);

				expect(refused.exitCode).toBe(1);
				expect(refused.stderr).toContain(
					"--sandboxes takes a number from 0, not -1"
				);

				const off = yield* relayProcess([
					"--player-port",
					"0",
					"--gm-port",
					"0",
					"--bind",
					"127.0.0.1",
					"--sandboxes",
					"0",
					"--dir",
					dir,
				]);

				yield* waitFor("the relay", () => STARTED.test(off.output()), 15_000);
				yield* waitFor("the sandbox line", () =>
					off
						.output()
						.includes("the lobby's Try a Table is off (--sandboxes 0)")
				);
			})
	);

	effect(
		"a port out of range, or a --bind that isn't an address, is one plain line",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;

				for (const [flags, said] of [
					[
						["--player-port", "99999"],
						"--player-port takes a port from 0 to 65535, not 99999",
					],
					[
						["--gm-port", "-1"],
						"--gm-port takes a port from 0 to 65535, not -1",
					],
					[
						["--bind", "999.1.1.1"],
						'--bind takes an IP address, such as 127.0.0.1 or 0.0.0.0, or localhost, not "999.1.1.1"',
					],
				] as const) {
					const defaults = [
						["--player-port", "0"],
						["--gm-port", "0"],
						["--bind", "127.0.0.1"],
					].filter(([flag]) => flag !== flags[0]);

					const args = [...flags, ...defaults.flat()];
					const started = yield* cli(["relay", ...args, "--dir", dir]);
					expect(started.exitCode).toBe(1);
					expect(started.stderr.trim().split("\n")).toEqual([
						`supervillain: ${said}`,
					]);
				}
			}),
		30_000
	);

	effect("relay forget fails on a folder that holds no relay, naming it", () =>
		Effect.gen(function* () {
			const dir = path.join(yield* tempDir, "nowhere");
			const forgot = yield* cli(["relay", "forget", "den", "--dir", dir]);
			expect(forgot.exitCode).toBe(1);
			expect(forgot.stderr).toContain(dir);
			expect(forgot.stderr).toContain("--dir");
		})
	);

	effect(
		"a relay folder others can write to is refused, by the relay and by forget",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;
				yield* writeText(path.join(dir, "relay_key"), "", 0o600);

				yield* Effect.promise(async () => {
					await chmod(dir, 0o777);
				});
				const forgot = yield* cli(["relay", "forget", "den", "--dir", dir]);
				expect(forgot.exitCode).toBe(1);
				expect(forgot.stderr).toContain("chmod 700");

				const started = yield* cli([
					"relay",
					"--player-port",
					"0",
					"--gm-port",
					"0",
					"--bind",
					"127.0.0.1",
					"--dir",
					dir,
				]);

				expect(started.exitCode).toBe(1);
				expect(started.stderr).toContain("chmod 700");
			})
	);
});
