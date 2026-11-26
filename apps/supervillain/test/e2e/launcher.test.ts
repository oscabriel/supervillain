import { describe, expect } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";

import { effect, waitFor } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";
import { cli, plainEnv } from "./cli.ts";

const main = path.join(import.meta.dir, "../../src/main.ts");

const inPty = (
	args: ReadonlyArray<string>,
	cwd: string,
	env: Readonly<Record<string, string>>
) =>
	Effect.acquireRelease(
		Effect.sync(() => {
			let output = "";
			const decoder = new TextDecoder();

			const proc = Bun.spawn(["bun", main, ...args], {
				cwd,
				env: { ...plainEnv(), TERM: "xterm-256color", ...env },
				terminal: {
					cols: 100,
					rows: 30,
					data: (_terminal, data) => {
						output += decoder.decode(data, { stream: true });
					},
				},
			});

			return {
				proc,
				output: () => Bun.stripANSI(output),
				write: (text: string) => {
					proc.terminal?.write(text);
				},
			};
		}),
		({ proc }) =>
			Effect.promise(async () => {
				if (proc.exitCode === null && proc.signalCode === null) {
					proc.kill("SIGKILL");
				}

				await proc.exited;
			})
	);

describe("bare supervillain", () => {
	effect("without a terminal, prints its help and exits 0", () =>
		Effect.gen(function* () {
			const ran = yield* cli([]);
			expect(ran.exitCode).toBe(0);
			expect(ran.stdout).toContain("SUBCOMMANDS");
			expect(ran.stdout).toContain("--local");
			expect(ran.stdout).toContain("new ");
		})
	);

	effect(
		"in a terminal, lists the tables it finds, and N makes and opens a new one",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const home = path.join(dir, "home");
				const here = path.join(dir, "here");

				yield* Effect.promise(async () => {
					await mkdir(path.join(home, "keep"), { recursive: true });
					await writeFile(
						path.join(home, "keep", "campaign.yaml"),
						"rules: pf2e\n"
					);
					await mkdir(here);
				});

				const env = {
					SUPERVILLAIN_HOME: home,
					XDG_CONFIG_HOME: path.join(dir, "config"),
				};

				const quitting = yield* inPty(["--local"], here, env);
				yield* waitFor(
					"the launcher",
					() => quitting.output().includes("N new table"),
					10_000
				);
				expect(quitting.output()).toContain("keep");
				expect(quitting.output()).toContain("PF2e (ORC)");
				expect(quitting.output()).toContain("local only");
				quitting.write("q");
				expect(
					yield* Effect.promise(async () => await quitting.proc.exited)
				).toBe(0);

				const making = yield* inPty(["--local"], here, env);
				yield* waitFor(
					"the launcher",
					() => making.output().includes("N new table"),
					10_000
				);
				making.write("n");
				yield* waitFor("the wizard", () =>
					making.output().includes("New table")
				);
				making.write("Ford Road");
				yield* Effect.sleep("100 millis");
				making.write("\r");
				yield* Effect.sleep("100 millis");
				making.write("\r");
				yield* Effect.sleep("100 millis");
				making.write("\r");
				yield* waitFor(
					"the table",
					() => making.output().includes("say something, or /help"),
					15_000
				);
				expect(
					yield* Effect.promise(
						async () =>
							await readFile(
								path.join(home, "ford-road", "heroes", "brann.yaml"),
								"utf-8"
							)
					)
				).toContain("Brann");
				making.write("\u0003");
				expect(
					yield* Effect.promise(async () => await making.proc.exited)
				).toBe(0);
			}),
		40_000
	);
});
