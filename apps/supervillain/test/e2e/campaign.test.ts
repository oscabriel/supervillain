import { describe, expect } from "bun:test";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";

import { must } from "../game/must.ts";
import { SAMPLE } from "../host/campaign.ts";
import { effect } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";
import { cli } from "./cli.ts";

const BESTIARY = path.join(import.meta.dir, "../content/fixtures/bestiary");

const list = (dir: string) =>
	Effect.promise(async () => {
		const names = await readdir(dir);

		return names.toSorted();
	});

describe("supervillain new", () => {
	effect(
		"makes a campaign folder its owner alone can read, with heroes/, monsters/ and maps/",
		() =>
			Effect.gen(function* () {
				const dir = path.join(yield* tempDir, "den");
				const made = yield* cli(["new", dir]);
				expect(made).toMatchObject({ exitCode: 0, stderr: "" });
				expect(made.stdout).toStartWith(
					`supervillain: made ${dir} with heroes/, monsters/ and maps/\n`
				);
				expect(yield* list(dir)).toEqual([
					"README.md",
					"campaign.yaml",
					"heroes",
					"maps",
					"monsters",
				]);
				expect(
					yield* Effect.promise(
						async () => await readFile(path.join(dir, "campaign.yaml"), "utf-8")
					)
				).toContain("\nrules: draw-steel\n");
				expect(yield* list(path.join(dir, "heroes"))).toEqual([]);
				expect(yield* list(path.join(dir, "maps"))).toEqual([]);
				expect(
					(yield* Effect.promise(async () => await stat(dir))).mode % 0o1000
				).toBe(0o700);

				const readme = yield* Effect.promise(
					async () => await readFile(path.join(dir, "README.md"), "utf-8")
				);

				expect(readme).toContain("heroes/<id>.yaml");
				expect(readme).toContain("maps/<id>.txt");
			})
	);

	effect(
		"makes a set.world campaign with --rules set-world: campaign.yaml says so, maps/ waits",
		() =>
			Effect.gen(function* () {
				const dir = path.join(yield* tempDir, "arena");
				const made = yield* cli(["new", dir, "--rules", "set-world"]);
				expect(made).toMatchObject({ exitCode: 0, stderr: "" });
				expect(made.stdout).toStartWith(
					`supervillain: made ${dir} playing set-world, with maps/\n`
				);
				expect(yield* list(dir)).toEqual([
					"README.md",
					"campaign.yaml",
					"maps",
				]);
				expect(
					yield* Effect.promise(
						async () => await readFile(path.join(dir, "campaign.yaml"), "utf-8")
					)
				).toBe(
					"# What this campaign plays: draw-steel, set-world or pf2e.\nrules: set-world\n"
				);
			})
	);

	effect(
		"makes a PF2e campaign with heroes/, monsters/ and maps/, and imports a Pathbuilder export into it",
		() =>
			Effect.gen(function* () {
				const dir = path.join(yield* tempDir, "marsh");
				const made = yield* cli(["new", dir, "--rules", "pf2e"]);
				expect(made).toMatchObject({ exitCode: 0, stderr: "" });
				expect(made.stdout).toStartWith(
					`supervillain: made ${dir} playing pf2e, with heroes/, monsters/ and maps/\n`
				);
				expect(yield* list(dir)).toEqual([
					"README.md",
					"campaign.yaml",
					"heroes",
					"maps",
					"monsters",
				]);

				const imported = yield* cli([
					"import",
					"pathbuilder",
					path.join(
						import.meta.dir,
						"../content/fixtures/pathbuilder/orrin.json"
					),
					dir,
				]);

				expect(imported).toMatchObject({ exitCode: 0, stderr: "" });
				expect(imported.stdout).toStartWith(
					"imported Orrin Vale to heroes/orrin-vale.yaml\n"
				);
				expect(yield* list(path.join(dir, "heroes"))).toEqual([
					"orrin-vale.yaml",
				]);
				const usage = yield* cli(["import", "pathbuilder"]);
				expect(usage.exitCode).toBe(1);
				expect(usage.stderr).toContain(
					"import pathbuilder <file.json> <campaign-dir>"
				);
			})
	);

	effect(
		"refuses --example with set-world, and a ruleset it doesn't know, writing nothing",
		() =>
			Effect.gen(function* () {
				const root = yield* tempDir;

				const sample = yield* cli([
					"new",
					path.join(root, "a"),
					"--example",
					"--rules",
					"set-world",
				]);

				expect(sample.exitCode).toBe(1);
				expect(sample.stderr).toBe(
					"supervillain: the sample campaign plays draw-steel, so --example can't make a set-world campaign; leave out --example for an empty one\n"
				);

				const unknown = yield* cli([
					"new",
					path.join(root, "b"),
					"--rules",
					"pathfinder",
				]);

				expect(unknown.exitCode).not.toBe(0);
				expect(yield* list(root)).toEqual([]);
			})
	);

	effect("copies the sample campaign with --example", () =>
		Effect.gen(function* () {
			const dir = path.join(yield* tempDir, "ford");
			expect((yield* cli(["new", dir, "--example"])).exitCode).toBe(0);
			expect(yield* list(path.join(dir, "heroes"))).toEqual(
				yield* list(path.join(SAMPLE, "heroes"))
			);
			expect(yield* list(path.join(dir, "monsters"))).toEqual(
				yield* list(path.join(SAMPLE, "monsters"))
			);
			expect(yield* list(path.join(dir, "maps"))).toEqual(["ford-road.txt"]);
		})
	);

	effect("refuses a folder that already has files, in one plain line", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			yield* Effect.promise(async () => {
				await writeFile(path.join(dir, "events.jsonl"), "");
			});
			const result = yield* cli(["new", dir]);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toBe(
				`supervillain: can't make a campaign in ${dir}: it already has files in it\n`
			);
			expect(yield* list(dir)).toEqual(["events.jsonl"]);
		})
	);
});

describe("supervillain map", () => {
	effect(
		"generates a map into the campaign's maps/, by seed, and says how to load it",
		() =>
			Effect.gen(function* () {
				const dir = path.join(yield* tempDir, "camp");
				expect((yield* cli(["new", dir, "--example"])).exitCode).toBe(0);
				const made = yield* cli(["map", "keep", dir, "--seed", "7"]);
				expect(made).toMatchObject({ exitCode: 0, stderr: "" });

				const { generateMap, mapFileText } = yield* Effect.promise(
					async () => await import("../../src/content/mapgen.ts")
				);

				const map = generateMap("keep", 7);
				expect(
					yield* Effect.promise(
						async () =>
							await readFile(path.join(dir, "maps/keep-7.txt"), "utf-8")
					)
				).toBe(mapFileText(map));
				expect(made.stdout).toContain(
					`supervillain: wrote ${map.name} to maps/keep-7.txt`
				);
				expect(made.stdout).toContain("load it at the table with: /map keep-7");
				expect(made.stdout).toContain(must(map.lines[0]));
				expect(
					(yield* cli([
						"map",
						"crossing",
						dir,
						"--seed",
						"3",
						"--id",
						"ford-2",
					])).exitCode
				).toBe(0);

				const again = yield* cli([
					"map",
					"keep",
					dir,
					"--seed",
					"8",
					"--id",
					"keep-7",
				]);

				expect(again.exitCode).toBe(1);
				expect(again.stderr).toBe(
					"supervillain: there's already a map called keep-7 in maps/; pick another --id\n"
				);
				expect(yield* list(path.join(dir, "maps"))).toEqual([
					"ford-2.txt",
					"ford-road.txt",
					"keep-7.txt",
				]);
			})
	);

	effect(
		"refuses a kind it doesn't know, a seed out of range and a folder that isn't a campaign",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const kind = yield* cli(["map", "castle", dir]);
				expect(kind.exitCode).toBe(1);
				expect(kind.stderr).toContain("crossing");

				for (const seed of ["-1", "4294967296"]) {
					const bad = yield* cli(["map", "keep", dir, `--seed=${seed}`]);
					expect(bad.exitCode).toBe(1);
					expect(bad.stderr).toBe(
						"supervillain: a map's seed is a whole number from 0 to 4294967295\n"
					);
				}

				const none = yield* cli(["map", "keep", path.join(dir, "nowhere")]);
				expect(none.exitCode).toBe(1);
				expect(none.stderr).toBe(
					`supervillain: there's no campaign at ${path.join(dir, "nowhere")}; make one with: bun supervillain new ${path.join(dir, "nowhere")}\n`
				);
			})
	);
});

describe("supervillain import", () => {
	effect(
		"writes the named creatures into the campaign's monsters/ and reports each",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;

				const result = yield* cli([
					"import",
					BESTIARY,
					"--into",
					dir,
					"Gutter Rat",
				]);

				expect(result).toMatchObject({
					exitCode: 0,
					stdout: "wrote monsters/gutter-rat.yaml (Gutter Rat)\n",
					stderr: "",
				});
				expect(yield* list(path.join(dir, "monsters"))).toEqual([
					"gutter-rat.yaml",
				]);
				expect(
					(yield* cli(["import", BESTIARY, "--into", dir, "gutter"])).stdout
				).toBe(
					"kept monsters/gutter-rat.yaml (Gutter Rat): it exists; --overwrite replaces it\n"
				);
			})
	);

	effect("a creature it can't find or read fails the import, naming why", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const result = yield* cli(["import", BESTIARY, "--into", dir, "nobody"]);
			expect(result).toMatchObject({
				exitCode: 1,
				stdout: 'no monster named "nobody"\n',
				stderr: "supervillain: one creature not imported\n",
			});

			const missing = yield* cli([
				"import",
				path.join(dir, "nope"),
				"--into",
				dir,
			]);

			expect(missing.exitCode).toBe(1);
			expect(missing.stderr).toStartWith(
				`supervillain: can't read ${path.join(dir, "nope")}: `
			);
		})
	);
});
