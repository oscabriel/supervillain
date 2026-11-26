import { describe, expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import nodePath from "node:path";

import { Effect, Schema } from "effect";

import {
	CampaignConfigInvalid,
	ContentInvalid,
	loadIndex,
	readCampaignConfig,
	schemaFiles,
	SCHEMA_KINDS,
	validateCampaign,
} from "../../src/content/index.ts";
import { effect } from "../host/effect.ts";
import { withContent } from "./content.ts";
import {
	campaignOf,
	FREEFORM,
	FULL,
	MARA,
	MARKET,
	ROOK,
	THUG,
} from "./files.ts";

const messages = (problems: ReadonlyArray<{ readonly message: string }>) =>
	problems.map((p) => p.message);

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const decodeJson = Schema.decodeUnknownSync(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))
);

describe("loading a campaign's Markdown", () => {
	effect("a whole freeform campaign loads with no problems", () =>
		Effect.gen(function* () {
			const dir = yield* campaignOf(FULL);
			const { index, problems } = yield* validateCampaign(dir);

			expect(problems).toEqual([]);
			expect(index.rules).toBe("freeform");
			expect(index.table?.front.title).toBe("The Drowned Crown");
			expect(index.scenes.map((s) => s.id)).toEqual(["market"]);
			expect(index.party.map((p) => [p.id, p.name, p.refs.items])).toEqual([
				["rook", "Rook", ["brass-key"]],
			]);
			expect(index.maps).toEqual(["market"]);
			expect(index.art).toEqual(["mara"]);
		})
	);

	effect(
		"unknown fields, bad values and bad file names are each a problem, and nothing throws",
		() =>
			Effect.gen(function* () {
				const dir = yield* campaignOf({
					"campaign.yaml": FREEFORM,
					"scenes/market.md": "---\ntitle: A\ncolour: blue\n---\n",
					"scenes/Bad Name.md": "---\ntitle: B\n---\n",
					"npcs/mara.md": "---\nrole: nobody named\n---\n",
					"items/key.md": "no fields at all\n",
					"handouts/page.md": "---\ntitle: [unclosed\n---\n",
				});

				const { problems } = yield* loadIndex(dir, "freeform");

				expect(problems).toContainEqual({
					file: "scenes/market.md",
					field: "colour",
					message: "is not a field supervillain knows (check the spelling)",
				});
				expect(problems).toContainEqual({
					file: "npcs/mara.md",
					field: "name",
					message: "is required",
				});
				expect(problems).toContainEqual({
					file: "items/key.md",
					line: 1,
					message:
						"must begin with a --- line, then its fields, then --- again",
				});
				expect(messages(problems)).toContainEqual(
					"its name is its id, so it must be lower-case letters, digits and hyphens, at most 40, then .md"
				);
				expect(
					problems.some(
						(p) =>
							p.file === "handouts/page.md" &&
							p.message.startsWith("its fields aren't YAML")
					)
				).toBe(true);
			})
	);

	effect("a Markdown file over 64 KB is refused before it is read", () =>
		Effect.gen(function* () {
			const dir = yield* campaignOf({
				"campaign.yaml": FREEFORM,
				"scenes/huge.md": `---\ntitle: Huge\n---\n${"x".repeat(70 * 1024)}`,
			});

			const { problems, scenes } = yield* loadIndex(dir, "freeform");

			expect(scenes).toEqual([]);
			expect(problems).toEqual([
				{
					file: "scenes/huge.md",
					message: "is 71 KB; a campaign file holds at most 64 KB",
				},
			]);
		})
	);

	effect(
		"links to files that aren't there are problems, naming the field",
		() =>
			Effect.gen(function* () {
				const dir = yield* campaignOf({
					"campaign.yaml": FREEFORM,
					"table.md": "---\ntitle: T\nstart: nowhere\n---\n",
					"scenes/market.md": MARKET,
					"party/rook.md": ROOK.replace(
						"items: [brass-key]",
						"items: [brass-key]\nancestry: elf"
					),
					"npcs/mara.md": "---\nname: Mara\nmonster: ghost\n---\n",
					"handouts/ledger.md": "---\ntitle: L\nmap: atlas\n---\n",
				});

				const { problems } = yield* validateCampaign(dir);

				for (const expected of [
					{
						file: "table.md",
						field: "start",
						message: "names nowhere, but there's no scenes/nowhere.md",
					},
					{
						file: "scenes/market.md",
						field: "items",
						message: "names brass-key, but there's no items/brass-key.md",
					},
					{
						file: "scenes/market.md",
						field: "map",
						message: "names market, but there's no maps/market.txt",
					},
					{
						file: "scenes/market.md",
						field: "encounter.monsters",
						message: "names thug, but there's no monsters/thug.md",
					},
					{
						file: "npcs/mara.md",
						field: "monster",
						message: "names ghost, but there's no monsters/ghost.md",
					},
					{
						file: "handouts/ledger.md",
						field: "map",
						message: "names atlas, but there's no maps/atlas.txt",
					},
					{
						file: "party/rook.md",
						field: "ancestry",
						message: "names elf, but there's no ancestries/elf.md",
					},
				]) {
					expect(problems).toContainEqual(expected);
				}
			})
	);

	effect(
		"an id in both heroes/ and party/ is a problem; so are rules named twice",
		() =>
			Effect.gen(function* () {
				const dir = yield* campaignOf({
					"campaign.yaml": FREEFORM,
					"heroes/rook.yaml": "name: Rook\n",
					"party/rook.md": ROOK.replace("items: [brass-key]\n", ""),
				});

				const { problems } = yield* loadIndex(dir, "freeform");

				expect(problems).toContainEqual({
					file: "party/rook.md",
					message:
						"has the id rook, and so does heroes/rook.yaml; an id names one sheet",
				});

				const twice = yield* campaignOf({
					"campaign.yaml": "rules: freeform\n",
					"table.md": "---\ntitle: T\nrules: freeform\n---\n",
				});

				const refused = yield* Effect.flip(readCampaignConfig(twice));

				expect(refused).toBeInstanceOf(CampaignConfigInvalid);
				expect(refused.message).toContain("table.md names the rules too");
			})
	);

	effect("table.md can name the rules when campaign.yaml doesn't", () =>
		Effect.gen(function* () {
			const dir = yield* campaignOf({
				"table.md": "---\ntitle: T\nrules: freeform\n---\n",
			});

			expect(yield* readCampaignConfig(dir)).toEqual({ rules: "freeform" });
		})
	);

	effect("the host won't open a campaign whose files have problems", () =>
		Effect.gen(function* () {
			const dir = yield* campaignOf({
				"campaign.yaml": FREEFORM,
				"scenes/market.md": "---\ntitle: A\nnpcs: [ghost]\n---\n",
			});

			const refused = yield* Effect.flip(withContent(dir, () => Effect.void));

			expect(refused).toBeInstanceOf(ContentInvalid);
			expect(refused.message).toContain(
				"scenes/market.md: npcs names ghost, but there's no npcs/ghost.md"
			);
		})
	);
});

describe("what check finds in a file's body and its links", () => {
	effect(
		"an unclosed fence, an underline in GM notes and near-miss GM headings are problems with lines",
		() =>
			Effect.gen(function* () {
				const dir = yield* campaignOf({
					...FULL,
					"npcs/mara.md": `${MARA}Plain.\n---\nMore secrets.\n\n\`\`\`\nopen\n`,
					"handouts/ledger.md":
						"---\ntitle: L\n---\n## Notes for the GM\nOops.\n\n**GM Notes:**\nOops.\n",
				});

				const { problems } = yield* validateCampaign(dir);

				expect(problems).toEqual([
					{
						file: "npcs/mara.md",
						line: 13,
						message:
							"has a --- or === under a line of GM notes, which Markdown reads as a heading; leave a blank line above it, or use *** for a rule",
					},
					{
						file: "npcs/mara.md",
						line: 16,
						message:
							"opens a code fence that never closes; close it with the same ``` or ~~~",
					},
					{
						file: "handouts/ledger.md",
						line: 4,
						message:
							'has the heading "Notes for the GM", which mentions the GM but doesn\'t hide anything; start it with GM, like ## GM Notes, to keep it from the players, or reword it',
					},
					{
						file: "handouts/ledger.md",
						line: 7,
						message:
							'has "**GM Notes:**" on a line of its own, which looks like a GM heading but isn\'t one, so the text under it reaches the players; write it like ## GM Notes',
					},
				]);
			})
	);

	effect("a scene's map that won't draw is a problem, not a missing map", () =>
		Effect.gen(function* () {
			const dir = yield* campaignOf({
				...FULL,
				"maps/market.txt": "..\u0007.\n",
			});

			const { problems } = yield* validateCampaign(dir);

			expect(messages(problems)).toEqual([
				"maps/market.txt line 1, column 3 is a control character (U+0007); draw maps with . floor, # wall, ~ difficult terrain and space for outside.",
			]);
			expect(problems[0]?.file).toBe("scenes/market.md");
		})
	);

	effect(
		"art that isn't a plain file, and a table.md that's a folder, are problems and never hang",
		() =>
			Effect.gen(function* () {
				const dir = yield* campaignOf({
					...FULL,
					"art/mara.txt": "",
					"table.md": "",
				});

				yield* Effect.promise(async () => {
					await Bun.file(nodePath.join(dir, "art/mara.txt")).delete();
					await Bun.file(nodePath.join(dir, "table.md")).delete();
					await mkdir(nodePath.join(dir, "table.md"));
				});

				const made = Bun.spawnSync([
					"mkfifo",
					nodePath.join(dir, "art/mara.txt"),
				]);

				expect(made.exitCode).toBe(0);

				const { problems } = yield* validateCampaign(dir);

				expect(problems).toContainEqual({
					file: "table.md",
					message: "isn't a plain file",
				});
				expect(problems).toContainEqual({
					file: "npcs/mara.md",
					message: "art/mara.txt isn't a plain file",
				});
			})
	);

	effect(
		"frontmatter refuses what the table would: a negative resource, a subtitle past 80",
		() =>
			Effect.gen(function* () {
				const dir = yield* campaignOf({
					...FULL,
					"monsters/thug.md": THUG.replace("hp: 6", "hp: -1"),
					"items/brass-key.md": `---\nname: Brass key\nsummary: ${"x".repeat(81)}\n---\n`,
				});

				const { problems } = yield* validateCampaign(dir);

				expect(problems).toContainEqual({
					file: "monsters/thug.md",
					field: "resources.hp",
					message: "must be a whole number from 0 to 9999",
				});
				expect(problems).toContainEqual({
					file: "items/brass-key.md",
					field: "summary",
					message: "must be at most 80 characters",
				});
			})
	);
});

describe("the campaign's content at the table", () => {
	effect(
		"a card is player-safe: read-aloud apart, GM notes and comments gone",
		() =>
			Effect.gen(function* () {
				const dir = yield* campaignOf(FULL);

				yield* withContent(dir, (content) =>
					Effect.gen(function* () {
						const scene = yield* content.card("market");
						const mara = yield* content.card("npc:mara");

						expect(scene).toMatchObject({
							key: "scene:market",
							kind: "scene",
							title: "The Drowned Market",
							subtitle: "Stalls on stilts over black water.",
							readAloud: [{ kind: "para", text: "Water laps at the boards." }],
							body: [{ kind: "para", text: "Stalls lean over the water." }],
						});
						expect(scene.map?.terrain.length).toBe(6);
						expect(mara).toMatchObject({
							title: "Mara Venn",
							subtitle: "Harbour-master · she/her",
							art: ["  /\\", " (oo)"],
							tags: ["ally"],
						});
						expect(json([scene, mara])).not.toContain("GMSECRET");
						expect(yield* content.gmNotes("scene:market")).toContain(
							"GMSECRET the ledger"
						);
						expect(yield* content.gmNotes("scene:nowhere")).toBeUndefined();
					})
				);
			})
	);

	effect(
		"cards are found by key, id or the start of one; an unclear start says which",
		() =>
			Effect.gen(function* () {
				const dir = yield* campaignOf({
					...FULL,
					"npcs/marek.md": "---\nname: Marek\n---\n",
				});

				yield* withContent(dir, (content) =>
					Effect.gen(function* () {
						expect((yield* content.card("brass")).key).toBe("item:brass-key");

						const unclear = yield* Effect.flip(content.card("mar"));

						expect(unclear.message).toContain("npc:mara, npc:marek");

						const missing = yield* Effect.flip(content.card("ghost"));

						expect(missing._tag).toBe("CardNotFound");
						expect(
							yield* content.cards(["npc:mara", "npc:ghost"])
						).toHaveLength(1);
					})
				);
			})
	);

	effect(
		"a freeform sheet comes from party/ and monsters/, its notes player-safe",
		() =>
			Effect.gen(function* () {
				const dir = yield* campaignOf(FULL);

				yield* withContent(dir, (content) =>
					Effect.gen(function* () {
						const rook = yield* content.ffHero("rook");
						const thug = yield* content.ffMonster("thug");

						expect(rook).toEqual({
							id: "rook",
							name: "Rook",
							pronouns: "she/her",
							concept: "Disgraced duelist",
							stats: { might: 1, wits: 2 },
							resources: { hp: 10 },
							tags: ["brave"],
							notes: [{ kind: "para", text: "Owes the Gilded Hand a debt." }],
						});
						expect(thug.name).toBe("Dock Thug");
						expect(json([rook, thug])).not.toContain("GMSECRET");
					})
				);
			})
	);

	effect(
		"the prep catalog lists scenes, people, handouts, items and trackers",
		() =>
			Effect.gen(function* () {
				const dir = yield* campaignOf(FULL);

				yield* withContent(dir, (content) =>
					Effect.gen(function* () {
						const catalog = yield* content.catalog;

						expect(catalog.heroes).toEqual([{ id: "rook", name: "Rook" }]);
						expect(catalog.monsters).toEqual([
							{ id: "thug", name: "Dock Thug" },
						]);
						expect(catalog.scenes).toEqual([
							{
								id: "market",
								name: "The Drowned Market",
								encounter: {
									map: "market",
									monsters: [{ id: "thug", count: 3 }],
								},
							},
						]);
						expect(catalog.npcs).toEqual([{ id: "mara", name: "Mara Venn" }]);
						expect(catalog.handouts).toEqual([
							{ id: "ledger", name: "A torn ledger page" },
						]);
						expect(catalog.items).toEqual([
							{ id: "brass-key", name: "Brass key" },
						]);
						expect(catalog.trackers).toEqual([
							{
								id: "alarm",
								label: "The alarm",
								kind: "clock",
								max: 4,
								scene: "market",
							},
						]);
					})
				);
			})
	);

	effect(
		"a Draw Steel hero in party/*.md reads like heroes/*.yaml, abilities by id",
		() =>
			Effect.gen(function* () {
				const dir = yield* campaignOf({
					"campaign.yaml": "rules: draw-steel\n",
					"party/vex.md": `---
name: Vex
class: Censor
level: 1
characteristics: { might: 2, agility: 0, reason: -1, intuition: 1, presence: 2 }
stamina: 21
recoveries: 8
speed: 5
resource: { name: Wrath, perTurn: 2 }
abilities: [spinning-strike]
items: [lantern]
---
A judge of the wicked.

## GM Notes
GMSECRET
`,
					"abilities/spinning-strike.md": `---
name: Spinning Strike
kind: Main action
characteristics: [might]
tier1: 3 damage
tier2: 5 damage
tier3: 7 damage
---
`,
					"items/lantern.md": "---\nname: Lantern\n---\n",
				});

				const { problems } = yield* validateCampaign(dir);

				expect(problems).toEqual([]);

				yield* withContent(dir, (content) =>
					Effect.gen(function* () {
						const vex = yield* content.hero("vex");

						expect(vex.name).toBe("Vex");
						expect(vex.abilities.map((a) => [a.name, a.tier3])).toEqual([
							["Spinning Strike", "7 damage"],
						]);
						expect(yield* content.heroes).toEqual(["vex"]);
					})
				);
			})
	);

	effect(
		"a Draw Steel sheet in Markdown that its rules refuse is a problem",
		() =>
			Effect.gen(function* () {
				const dir = yield* campaignOf({
					"campaign.yaml": "rules: draw-steel\n",
					"monsters/rat.md": "---\nname: Rat\n---\n",
				});

				const { problems } = yield* validateCampaign(dir);

				expect(problems.some((p) => p.file === "monsters/rat.md")).toBe(true);
			})
	);

	effect("monsters in monsters/*.md stand beside monsters/*.yaml", () =>
		Effect.gen(function* () {
			const dir = yield* campaignOf({
				"campaign.yaml": FREEFORM,
				"monsters/thug.md": THUG,
			});

			yield* withContent(dir, (content) =>
				Effect.gen(function* () {
					expect(yield* content.monsters).toEqual(["thug"]);
				})
			);
		})
	);
});

const partySchema = (rules: "draw-steel" | "pf2e" | "freeform" | "set-world") =>
	schemaFiles(rules, "2020-12").find((f) => f.file === "party.schema.json")
		?.text ?? "";

describe("JSON Schemas for the frontmatter", () => {
	const ids = SCHEMA_KINDS.map((kind) => `${kind}.schema.json`);

	effect(
		"one schema per kind and an index of file patterns, in either draft",
		() =>
			Effect.sync(() => {
				const files = schemaFiles("freeform", "2020-12");

				expect(files.map((f) => f.file)).toEqual([...ids, "index.json"]);

				const scene = decodeJson(
					files.find((f) => f.file === "scene.schema.json")?.text ?? ""
				);

				expect(scene.$schema).toBe(
					"https://json-schema.org/draft/2020-12/schema"
				);
				expect(json(scene)).toContain('"additionalProperties":false');
				expect(json(scene)).toContain("The scene's name.");

				const index = decodeJson(files.at(-1)?.text ?? "");

				expect(index.schemas).toMatchObject({
					"table.md": "table.schema.json",
					"scenes/*.md": "scene.schema.json",
					"party/*.md": "party.schema.json",
				});

				const older = decodeJson(schemaFiles("freeform", "07")[0]?.text ?? "");

				expect(older.$schema).toBe("http://json-schema.org/draft-07/schema#");
			})
	);

	effect("party and monster schemas follow the campaign's rules", () =>
		Effect.sync(() => {
			expect(partySchema("draw-steel")).toContain("recoveries");
			expect(partySchema("pf2e")).toContain("perception");
			expect(partySchema("freeform")).toContain("resources");
			expect(partySchema("set-world")).toContain("seed");
		})
	);
});
