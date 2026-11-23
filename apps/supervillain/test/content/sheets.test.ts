import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import {
	decodeHero,
	decodeMonster,
	monsterYaml,
} from "../../src/content/index.ts";

const vex = `# a hero file, as a GM writes one
name: Vex
class: Shadow
level: 1
characteristics: { might: 0, agility: 2, reason: 1, intuition: 0, presence: -1 }
stamina: 20
recoveries: 8
speed: 5
resource: { name: insight, perTurn: 1d3 }
immunities: { poison: 2 }
abilities:
  - name: Quick Cut
    kind: main action
    characteristics: agility
    keywords: Melee, Strike, Weapon
    distance: Melee 1
    target: One creature
    tier1: 3 damage
    tier2: 6 damage
    tier3: 8 damage
  - name: Smoke Step
    characteristics: [agility, intuition]
    cost: 3
    effect: Shift 3.
`;

const failure = <A, E>(effect: Effect.Effect<A, E>): E =>
	Effect.runSync(Effect.flip(effect));

describe("hero files", () => {
	test("decode into a HeroSheet, with the id from the file name and the rules' defaults", () => {
		const hero = Effect.runSync(decodeHero("heroes/vex.yaml", vex));
		expect(hero).toEqual({
			id: "vex",
			name: "Vex",
			class: "Shadow",
			level: 1,
			characteristics: {
				might: 0,
				agility: 2,
				reason: 1,
				intuition: 0,
				presence: -1,
			},
			stamina: 20,
			recoveries: 8,
			recoveryValue: 6,
			speed: 5,
			stability: 0,
			resource: { name: "insight", perTurn: "1d3" },
			victories: 0,
			immunities: [{ type: "poison", value: 2 }],
			abilities: [
				{
					name: "Quick Cut",
					kind: "main action",
					characteristics: ["agility"],
					keywords: ["Melee", "Strike", "Weapon"],
					distance: "Melee 1",
					target: "One creature",
					tier1: "3 damage",
					tier2: "6 damage",
					tier3: "8 damage",
				},
				{
					name: "Smoke Step",
					characteristics: ["agility", "intuition"],
					cost: 3,
					effect: "Shift 3.",
				},
			],
		});
	});

	test("keep what the file says over a default", () => {
		const hero = Effect.runSync(
			decodeHero(
				"heroes/vex.yaml",
				`${vex}recoveryValue: 7\nstability: 1\nvictories: 2\nresource: { name: insight, perTurn: 2 }\n`
			)
		);

		expect(hero.recoveryValue).toBe(7);
		expect(hero.stability).toBe(1);
		expect(hero.victories).toBe(2);
		expect(hero.resource).toEqual({ name: "insight", perTurn: 2 });
	});

	test("a bad value names the file and the field", () => {
		const error = failure(
			decodeHero("heroes/vex.yaml", vex.replace("might: 0", "might: 9"))
		);

		expect(error._tag).toBe("SheetInvalid");
		expect(error.message).toBe(
			"heroes/vex.yaml: characteristics.might must be a whole number from -5 to 5"
		);
	});

	test("every problem is reported, one line each", () => {
		const text = vex
			.replace("stamina: 20\n", "")
			.replace("speed: 5", "sped: 5")
			.replace("tier1: 3 damage", "tier1: [3, damage]")
			.replace("perTurn: 1d3", "perTurn: lots");

		const error = failure(decodeHero("heroes/vex.yaml", text));
		expect(error.message.split("\n").toSorted()).toEqual([
			"heroes/vex.yaml: abilities[1].tier1 must be text",
			"heroes/vex.yaml: resource.perTurn must be a whole number or dice like 1d3",
			"heroes/vex.yaml: sped is not a field supervillain knows (check the spelling)",
			"heroes/vex.yaml: speed is required",
			"heroes/vex.yaml: stamina is required",
		]);
	});

	test("a file name too long to be an id says so, apart from one with the wrong letters", () => {
		const long = "a-very-long-hero-file-name-past-forty-chars";
		const error = failure(decodeHero(`heroes/${long}.yaml`, vex));
		expect(error.message).toBe(
			`heroes/${long}.yaml: the file name (the id) must be at most 40 characters`
		);
		expect(failure(decodeHero("heroes/Vex.yaml", vex)).message).toBe(
			"heroes/Vex.yaml: the file name is the id, so it must be lowercase letters, digits and dashes"
		);
		const forty = "x".repeat(40);
		expect(Effect.runSync(decodeHero(`heroes/${forty}.yaml`, vex)).id).toBe(
			forty
		);
	});

	test("a file that isn't YAML, or isn't a set of fields, says so", () => {
		expect(
			failure(decodeHero("heroes/vex.yaml", "name: [Vex\n")).message
		).toStartWith("heroes/vex.yaml: isn't valid YAML");
		expect(failure(decodeHero("heroes/vex.yaml", "")).message).toBe(
			"heroes/vex.yaml: must be a list of fields like `name: Vex`, one per line"
		);
	});

	test("an unknown characteristic in an ability is named", () => {
		const error = failure(
			decodeHero(
				"heroes/vex.yaml",
				vex.replace("[agility, intuition]", "[agility, luck]")
			)
		);

		expect(error.message).toBe(
			"heroes/vex.yaml: abilities[2].characteristics[2] must be one of might, agility, reason, intuition, presence"
		);
	});
});

const rat = `name: Gutter Rat
level: 1
organization: minion
role: harrier
ev: 3
stamina: 4
speed: 7
freeStrike: 1
characteristics: { might: -2, agility: 2, reason: -4, intuition: 1, presence: -3 }
weaknesses: { fire: 3 }
withCaptain: +1 damage bonus to strikes
abilities:
  - name: Bite
    kind: Main action
    bonus: 2
    tier1: 1 damage
    tier2: 2 damage
    tier3: 3 damage
`;

describe("monster files", () => {
	test("decode into a StatBlock", () => {
		expect(
			Effect.runSync(decodeMonster("monsters/gutter-rat.yaml", rat))
		).toEqual({
			id: "gutter-rat",
			name: "Gutter Rat",
			level: 1,
			organization: "minion",
			role: "harrier",
			ev: "3",
			stamina: 4,
			speed: 7,
			stability: 0,
			freeStrike: 1,
			characteristics: {
				might: -2,
				agility: 2,
				reason: -4,
				intuition: 1,
				presence: -3,
			},
			weaknesses: [{ type: "fire", value: 3 }],
			withCaptain: "+1 damage bonus to strikes",
			abilities: [
				{
					name: "Bite",
					kind: "Main action",
					bonus: 2,
					tier1: "1 damage",
					tier2: "2 damage",
					tier3: "3 damage",
				},
			],
		});
	});

	test("a bad organization lists the ones there are", () => {
		const error = failure(
			decodeMonster("monsters/gutter-rat.yaml", rat.replace("minion", "swarm"))
		);

		expect(error.message).toBe(
			"monsters/gutter-rat.yaml: organization must be one of minion, horde, platoon, elite, leader, solo"
		);
	});

	test("a written stat block reads back as the same stat block", () => {
		const block = Effect.runSync(
			decodeMonster("monsters/gutter-rat.yaml", rat)
		);

		const text = monsterYaml(block, ["Written by a test"]);
		expect(text).toStartWith("# Written by a test\n");
		expect(
			Effect.runSync(decodeMonster("monsters/gutter-rat.yaml", text))
		).toEqual(block);
	});
});
