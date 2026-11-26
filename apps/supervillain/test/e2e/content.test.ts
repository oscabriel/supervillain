import { describe, expect } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import nodePath from "node:path";

import { Effect, Schema } from "effect";

import { campaignOf, FULL } from "../content/files.ts";
import { effect } from "../host/effect.ts";
import { cli } from "./cli.ts";

const decodeJson = Schema.decodeUnknownSync(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))
);

describe("supervillain check, on a campaign's Markdown", () => {
	effect(
		"a campaign with good files and no log yet says both",
		() =>
			Effect.gen(function* () {
				const dir = yield* campaignOf(FULL);
				const result = yield* cli(["check", dir]);

				expect(result.exitCode).toBe(0);
				expect(result.stderr).toBe("");
				expect(result.stdout.split("\n")).toEqual([
					`${nodePath.join(dir, "events.jsonl")}: no log yet; the table hasn't been opened`,
					`${dir}: 7 campaign files, no problems`,
					"",
				]);
			}),
		15_000
	);

	effect(
		"each problem is a line naming its file and field, and the check exits 1",
		() =>
			Effect.gen(function* () {
				const dir = yield* campaignOf({
					...FULL,
					"scenes/market.md":
						"---\ntitle: The Market\nnpcs: [ghost]\nweather: rain\n---\n",
					"scenes/dock.md": "---\ntitle: The Dock\nnext: nowhere\n---\n",
				});

				const result = yield* cli(["check", dir]);

				expect(result.exitCode).toBe(1);
				expect(result.stderr.split("\n")).toEqual([
					"scenes/market.md: weather is not a field supervillain knows (check the spelling)",
					"table.md: start names market, but there's no scenes/market.md",
					"scenes/dock.md: next names nowhere, but there's no scenes/nowhere.md",
					`supervillain: ${dir}: 3 problems in the campaign's files`,
					"",
				]);
				expect(result.stdout).toContain("no log yet");
			}),
		15_000
	);
});

describe("supervillain schema", () => {
	effect(
		"writes a schema per kind and index.json into schemas/, or where --out says",
		() =>
			Effect.gen(function* () {
				const dir = yield* campaignOf(FULL);
				const result = yield* cli(["schema", dir]);

				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain(
					"wrote 11 files (JSON Schema draft 2020-12, rules freeform)"
				);

				const written = yield* Effect.promise(
					async () => await readdir(nodePath.join(dir, "schemas"))
				);

				expect(written.toSorted()).toEqual([
					"ability.schema.json",
					"ancestry.schema.json",
					"class.schema.json",
					"handout.schema.json",
					"index.json",
					"item.schema.json",
					"monster.schema.json",
					"npc.schema.json",
					"party.schema.json",
					"scene.schema.json",
					"table.schema.json",
				]);

				const out = nodePath.join(dir, "elsewhere");

				const older = yield* cli([
					"schema",
					dir,
					"--out",
					out,
					"--draft",
					"07",
				]);

				expect(older.exitCode).toBe(0);

				const table = decodeJson(
					yield* Effect.promise(
						async () =>
							await readFile(nodePath.join(out, "table.schema.json"), "utf-8")
					)
				);

				expect(table.$schema).toBe("http://json-schema.org/draft-07/schema#");
			}),
		15_000
	);
});
