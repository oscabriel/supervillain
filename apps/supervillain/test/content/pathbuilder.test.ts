import { describe, expect } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";

import {
	importPathbuilder,
	pathbuilderReportText,
} from "../../src/content/index.ts";
import { effect } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";
import { withContent } from "./content.ts";

const FIXTURES = path.join(import.meta.dir, "fixtures", "pathbuilder");

const pf2eCampaign = Effect.gen(function* () {
	const dir = yield* tempDir;
	yield* Effect.promise(async () => {
		await writeFile(path.join(dir, "campaign.yaml"), "rules: pf2e\n");
	});

	return dir;
});

describe("a Pathbuilder 2e export", () => {
	effect(
		"becomes a hero file that loads back as the same sheet, saying what it left out",
		() =>
			Effect.gen(function* () {
				const dir = yield* pf2eCampaign;

				const report = yield* importPathbuilder({
					from: path.join(FIXTURES, "tamsin.json"),
					into: dir,
				});

				expect(report.file).toBe("heroes/tamsin-reedwhistle.yaml");
				expect(report.skipped).toEqual([
					"Javelin: extra damage isn't converted",
					"equipment (not part of a sheet)",
					"money (not part of a sheet)",
				]);
				expect(pathbuilderReportText(report).at(-1)).toBe(
					"bring them to the table with: /pc tamsin-reedwhistle"
				);

				const sheet = yield* withContent(dir, (c) => c.pfHero("tamsin"));

				expect(sheet).toEqual({
					id: "tamsin-reedwhistle",
					name: "Tamsin Reedwhistle",
					level: 3,
					size: "medium",
					ancestry: "Human",
					class: "Fighter",
					attributes: { str: 4, dex: 2, con: 2, int: 0, wis: 1, cha: 0 },
					hp: 44,
					speed: 25,
					perception: 8,
					ac: 20,
					saves: { fort: 9, ref: 9, will: 6 },
					classDc: 19,
					skills: [
						{ name: "acrobatics", bonus: 7 },
						{ name: "athletics", bonus: 11 },
						{ name: "intimidation", bonus: 5 },
						{ name: "survival", bonus: 6 },
						{ name: "sailing lore", bonus: 5 },
					],
					shield: { bonus: 2, hardness: 5, hp: 20, broken: 10 },
					strikes: [
						{
							name: "+1 Longsword",
							bonus: 13,
							damage: "1d8+4",
							damageType: "slashing",
						},
						{
							name: "Javelin",
							bonus: 10,
							damage: "1d6+4",
							damageType: "piercing",
						},
					],
					abilities: [
						{ name: "Reactive Strike" },
						{ name: "Shield Block" },
						{ name: "Sudden Charge" },
					],
				});

				const text = yield* Effect.promise(
					async () => await readFile(path.join(dir, report.file), "utf-8")
				);

				expect(text).toStartWith(
					"# Tamsin Reedwhistle, imported from Pathbuilder 2e.\n# Left out:\n"
				);
				expect(text).toContain("damage: 1d8+4 slashing");
			})
	);

	effect(
		"a caster keeps its tradition, DC, attack, slots and spell names",
		() =>
			Effect.gen(function* () {
				const dir = yield* pf2eCampaign;

				const report = yield* importPathbuilder({
					from: path.join(FIXTURES, "orrin.json"),
					into: dir,
				});

				expect(report.skipped).toContain(
					"spell effects (attack, save, damage, healing) aren't in the export; add them to each spell by hand"
				);

				const sheet = yield* withContent(dir, (c) => c.pfHero("orrin-vale"));

				expect(sheet).toMatchObject({
					size: "small",
					hp: 15,
					ac: 15,
					saves: { fort: 4, ref: 5, will: 6 },
					spells: {
						tradition: "arcane",
						dc: 17,
						attack: 7,
						slots: [{ rank: 1, count: 2 }],
						list: [
							{ name: "Spark Arc", rank: 0 },
							{ name: "Light Mote", rank: 0 },
							{ name: "Searing Bolt", rank: 1 },
						],
					},
				});

				const listed = yield* withContent(dir, (c) => c.catalog);

				expect(listed.heroes).toEqual([
					{ id: "orrin-vale", name: "Orrin Vale" },
				]);
			})
	);

	effect(
		"refuses to overwrite without --overwrite, and refuses what isn't an export",
		() =>
			Effect.gen(function* () {
				const dir = yield* pf2eCampaign;
				const from = path.join(FIXTURES, "orrin.json");
				yield* importPathbuilder({ from, into: dir });

				const again = yield* Effect.flip(
					importPathbuilder({ from, into: dir })
				);

				expect(again.message).toBe(
					"heroes/orrin-vale.yaml is there already; pass --overwrite to replace it"
				);
				yield* importPathbuilder({ from, into: dir, overwrite: true });
				const junk = path.join(dir, "junk.json");
				yield* Effect.promise(async () => {
					await writeFile(junk, '{"build": {"name": 3}}');
				});

				const bad = yield* Effect.flip(
					importPathbuilder({ from: junk, into: dir })
				);

				expect(bad.message).toStartWith(
					`${junk} isn't a Pathbuilder 2e export`
				);
			})
	);
});
