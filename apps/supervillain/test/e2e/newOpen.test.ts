import { describe, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";

import { effect, waitFor } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";
import { plainEnv } from "./cli.ts";

const main = path.join(import.meta.dir, "../../src/main.ts");

const textOf = (file: string) =>
	existsSync(file) ? readFileSync(file, "utf-8") : undefined;

const places = Effect.gen(function* () {
	const dir = yield* tempDir;
	const home = path.join(dir, "home");
	const config = path.join(dir, "config");

	return {
		home,
		config,
		gmJson: path.join(config, "supervillain", "gm.json"),
		env: {
			SUPERVILLAIN_HOME: home,
			SUPERVILLAIN_RELAY: "127.0.0.1:1",
			XDG_CONFIG_HOME: config,
		},
	};
});

const run = (
	args: ReadonlyArray<string>,
	env: Readonly<Record<string, string>>
) =>
	Effect.promise(async () => {
		const proc = Bun.spawn(["bun", main, ...args], {
			env: { ...plainEnv(), ...env },
			stdout: "pipe",
			stderr: "pipe",
		});

		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		return { stdout, stderr, exitCode };
	});

const inPty = (
	args: ReadonlyArray<string>,
	env: Readonly<Record<string, string>>
) =>
	Effect.acquireRelease(
		Effect.sync(() => {
			let output = "";
			const decoder = new TextDecoder();

			const proc = Bun.spawn(["bun", main, ...args], {
				env: { ...plainEnv(), TERM: "xterm-256color", ...env },
				terminal: {
					cols: 100,
					rows: 30,
					data: (_terminal, data) => {
						output += decoder.decode(data, { stream: true });
					},
				},
			});

			return { proc, output: () => output };
		}),
		({ proc }) =>
			Effect.promise(async () => {
				if (proc.exitCode === null && proc.signalCode === null) {
					proc.kill("SIGKILL");
				}

				await proc.exited;
			})
	);

describe("supervillain new --open checks everything before it writes", () => {
	effect(
		"a bad --handle leaves neither a campaign folder nor gm.json behind",
		() =>
			Effect.gen(function* () {
				const where = yield* places;

				const made = yield* run(
					["new", "foo", "--open", "--handle", "Bad_Handle"],
					where.env
				);

				expect(made.exitCode).toBe(1);
				expect(made.stderr).toContain("--handle is");
				expect(made.stderr).toContain("not Bad_Handle");
				expect(existsSync(path.join(where.home, "foo"))).toBe(false);
				expect(existsSync(where.gmJson)).toBe(false);
			}),
		20_000
	);

	effect(
		"a bad --relay is refused before the folder is made, and --relay goes with --open",
		() =>
			Effect.gen(function* () {
				const where = yield* places;

				const bad = yield* run(
					["new", "foo", "--open", "--handle", "ana", "--relay", "a b"],
					where.env
				);

				expect(bad.exitCode).toBe(1);
				expect(bad.stderr).toContain("--relay takes host:port, not a b");
				expect(existsSync(path.join(where.home, "foo"))).toBe(false);
				expect(existsSync(where.gmJson)).toBe(false);

				const alone = yield* run(
					[
						"new",
						path.join(where.home, "bar"),
						"--relay",
						"relay.example:7022",
					],
					where.env
				);

				expect(alone.exitCode).toBe(1);
				expect(alone.stderr).toContain("--relay goes with --open");
			}),
		20_000
	);

	effect(
		"the launcher refuses --local with --relay instead of ignoring one",
		() =>
			Effect.gen(function* () {
				const where = yield* places;

				const both = yield* run(
					["--local", "--relay", "relay.example:7022"],
					where.env
				);

				expect(both.exitCode).toBe(1);
				expect(both.stderr).toContain("can't go with --relay");
			}),
		20_000
	);

	effect(
		"an explicit --handle replaces the one gm.json holds, once the table is made",
		() =>
			Effect.gen(function* () {
				const where = yield* places;

				yield* Effect.promise(async () => {
					await mkdir(path.dirname(where.gmJson), {
						recursive: true,
						mode: 0o700,
					});
					await writeFile(where.gmJson, '{"handle":"old"}\n', { mode: 0o600 });
				});

				yield* inPty(["new", "ford", "--open", "--handle", "bo"], where.env);

				yield* waitFor(
					"gm.json to hold the new handle",
					() => textOf(where.gmJson) === '{"handle":"bo"}\n',
					20_000
				);
				expect(existsSync(path.join(where.home, "ford", "campaign.yaml"))).toBe(
					true
				);
			}),
		30_000
	);
});
