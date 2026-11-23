import { Story } from "@alchemy.run/domain/Story";
import { Schema } from "effect";

import {
	ActorId,
	CurrentActor,
	GM_ID,
	playerActor,
} from "../src/Actor.context.ts";
import { diceOf, Entropy } from "../src/Entropy.context.ts";
import type { HeroSheet, StatBlock } from "../src/rules/drawSteel/sheets.ts";
import type { PfSheet } from "../src/rules/pf2e/sheets.ts";
import type { SetCharacter } from "../src/rules/setWorld/state.ts";
import { Supervillain } from "../src/Supervillain.model.ts";
import { Table } from "../src/Table.aggregate.ts";

export const GM = GM_ID;

export const ALICE = ActorId.make(
	"key:SHA256:abcdefghIJKLMNOPqrstuvwxyz0123456789ABCDEFG"
);

export const BOB = ActorId.make(
	"key:SHA256:Zyxwvuts+/0123456789abcdefghijklmnopqrstuvw"
);

export const GUEST = ActorId.make("guest:7f3a9c01");

export const story = Story.make(Supervillain);

export const table = Table.ref("table");

export const as = (actor: ActorId) =>
	Story.provide(CurrentActor, playerActor(actor));

export const seeded = (seed: number) => Story.provide(Entropy, { seed });

export const seedRolling = (
	...draws: ReadonlyArray<readonly [number, number]>
): number => {
	for (const seed of Array.from({ length: 2_000_000 }, (_, n) => n)) {
		const dice = diceOf(seed);

		if (draws.every(([sides, face]) => dice(sides) === face)) {
			return seed;
		}
	}

	throw new Error(`no seed rolls ${JSON.stringify(draws)}`);
};

export const isActor = Schema.is(ActorId);

export const VEX: HeroSheet = {
	id: "vex",
	name: "Vex",
	class: "Censor",
	level: 1,
	characteristics: {
		might: 2,
		agility: 0,
		reason: -1,
		intuition: 1,
		presence: 2,
	},
	stamina: 21,
	recoveries: 8,
	speed: 5,
	stability: 1,
	resource: { name: "Wrath", perTurn: 2 },
	victories: 2,
	abilities: [
		{
			name: "Spinning Strike",
			kind: "Main action",
			characteristics: ["might", "agility"],
			keywords: ["Melee", "Strike", "Weapon"],
			distance: "Melee 1",
			target: "One creature",
			tier1: "3 damage",
			tier2: "5 damage; push 1",
			tier3: "7 damage; push 2",
		},
		{
			name: "Spirit Lash",
			kind: "Main action",
			characteristics: ["presence"],
			tier1: "2 holy damage",
			tier2: "4 holy damage",
			tier3: "6 holy damage; taunted (EoT)",
		},
	],
};

export const KOR: HeroSheet = {
	id: "kor",
	name: "Kor",
	class: "Fury",
	level: 1,
	characteristics: {
		might: 2,
		agility: 2,
		reason: -1,
		intuition: 0,
		presence: -1,
	},
	stamina: 24,
	recoveries: 10,
	recoveryValue: 9,
	speed: 6,
	stability: 0,
	resource: { name: "Ferocity", perTurn: "1d3" },
	victories: 2,
	weaknesses: [{ type: "holy", value: 3 }],
	abilities: [
		{
			name: "Brutal Slam",
			characteristics: ["might"],
			tier1: "3 damage",
			tier2: "6 damage",
			tier3: "9 damage",
		},
	],
};

export const GOBLIN: StatBlock = {
	id: "goblin-warrior",
	name: "Goblin Warrior",
	level: 1,
	organization: "horde",
	role: "Harrier",
	stamina: 15,
	speed: 6,
	stability: 0,
	freeStrike: 2,
	characteristics: {
		might: -2,
		agility: 2,
		reason: 0,
		intuition: 0,
		presence: -1,
	},
	abilities: [
		{
			name: "Spear Charge",
			kind: "Main action",
			bonus: 2,
			tier1: "3 damage",
			tier2: "4 damage",
			tier3: "5 damage",
		},
	],
};

export const RUNNER: StatBlock = {
	id: "goblin-runner",
	name: "Goblin Runner",
	level: 1,
	organization: "minion",
	role: "Harrier",
	ev: "3 for four minions",
	stamina: 5,
	speed: 7,
	stability: 0,
	freeStrike: 1,
	characteristics: {
		might: -2,
		agility: 2,
		reason: 0,
		intuition: 0,
		presence: -2,
	},
	abilities: [
		{
			name: "Dagger",
			bonus: 2,
			tier1: "1 damage",
			tier2: "2 damage",
			tier3: "3 damage",
		},
	],
	withCaptain: "Edge on strikes",
};

export const ARCHER: StatBlock = {
	...GOBLIN,
	id: "goblin-archer",
	name: "Goblin Archer",
	abilities: [
		{
			name: "Bow",
			bonus: 2,
			tier1: "2 damage",
			tier2: "3 damage",
			tier3: "4 damage",
		},
	],
};

export const IMP: StatBlock = {
	id: "ember-imp",
	name: "Ember Imp",
	level: 2,
	organization: "elite",
	stamina: 40,
	speed: 5,
	stability: 1,
	freeStrike: 4,
	characteristics: {
		might: 0,
		agility: 3,
		reason: 1,
		intuition: 1,
		presence: 0,
	},
	immunities: [
		{ type: "fire", value: 5 },
		{ type: "all", value: 2 },
	],
	weaknesses: [
		{ type: "holy", value: 4 },
		{ type: "all", value: 1 },
	],
	abilities: [],
};

export const character = (
	mainhand = "sword",
	seed = 1,
	attributes: Partial<SetCharacter["attributes"]> = {}
): SetCharacter => ({
	seed,
	contentVersion: "test",
	className: "Tester",
	flavor: "Made up for a test.",
	mainhand,
	powerRating: 1000,
	finalStats: { strength: 16 },
	attributes: {
		maxHealth: 100,
		stamina: 100,
		initiative: 1,
		walkSpeed: 1,
		physicalDamage: 30,
		magicalDamage: 20,
		physicalDamageReduction: 0,
		magicalDamageReduction: 0,
		globalResistance: 0,
		dodgeRate: 0,
		criticalHitChance: 0,
		clarity: 0,
		...attributes,
	},
	gear: [{ slot: "tool", name: `steel ${mainhand}` }],
});

export const FIELD = {
	name: "Field",
	terrain: ["........", "...##...", "..~~....", "........"],
};

export const ARI: PfSheet = {
	id: "ari",
	name: "Ari",
	level: 1,
	size: "medium",
	ancestry: "human",
	class: "fighter",
	attributes: { str: 4, dex: 2, con: 2, int: 0, wis: 1, cha: 0 },
	hp: 20,
	speed: 25,
	perception: 7,
	ac: 18,
	saves: { fort: 7, ref: 7, will: 5 },
	classDc: 19,
	skills: [
		{ name: "athletics", bonus: 9 },
		{ name: "intimidation", bonus: 5 },
		{ name: "acrobatics", bonus: 7 },
	],
	shield: { bonus: 2, hardness: 5, hp: 20, broken: 10 },
	strikes: [
		{
			name: "Longsword",
			bonus: 9,
			damage: "1d8+4",
			damageType: "slashing",
			traits: ["versatile p"],
		},
		{
			name: "Dagger",
			bonus: 9,
			damage: "1d4+4",
			damageType: "piercing",
			traits: ["agile", "finesse"],
		},
	],
};

export const BRYN: PfSheet = {
	id: "bryn",
	name: "Bryn",
	level: 1,
	size: "small",
	ancestry: "halfling",
	class: "wizard",
	attributes: { str: 0, dex: 2, con: 1, int: 4, wis: 1, cha: 0 },
	hp: 15,
	speed: 25,
	perception: 5,
	ac: 16,
	saves: { fort: 4, ref: 6, will: 7 },
	skills: [{ name: "arcana", bonus: 7 }],
	strikes: [
		{
			name: "Shortbow",
			bonus: 7,
			damage: "1d6",
			damageType: "piercing",
			traits: ["deadly d10"],
			range: 60,
		},
		{
			name: "Glaive",
			bonus: 5,
			damage: "1d8",
			damageType: "slashing",
			traits: ["deadly d8", "forceful", "reach"],
			reach: 10,
		},
	],
	spells: {
		tradition: "arcane",
		dc: 17,
		attack: 7,
		slots: [{ rank: 1, count: 1 }],
		list: [
			{
				name: "Spark Arc",
				rank: 0,
				save: "ref",
				basic: true,
				damage: "2d4",
				damageType: "electricity",
			},
			{
				name: "Searing Bolt",
				rank: 1,
				attack: true,
				damage: "2d6",
				damageType: "fire",
			},
			{ name: "Mending Light", rank: 1, heal: "1d8+4" },
		],
	},
};

export const GNASHER: PfSheet = {
	id: "gnasher",
	name: "Bog Gnasher",
	level: 1,
	size: "medium",
	traits: ["animal"],
	attributes: { str: 3, dex: 2, con: 2, int: -4, wis: 1, cha: -2 },
	hp: 20,
	speed: 30,
	perception: 6,
	ac: 16,
	saves: { fort: 7, ref: 5, will: 4 },
	skills: [{ name: "athletics", bonus: 7 }],
	strikes: [
		{ name: "Jaws", bonus: 9, damage: "1d10+3", damageType: "piercing" },
		{
			name: "Claw",
			bonus: 9,
			damage: "1d6+3",
			damageType: "slashing",
			traits: ["agile"],
		},
	],
	weaknesses: [{ type: "fire", value: 3 }],
	resistances: [{ type: "piercing", value: 2 }],
};

export const LUMBERER: PfSheet = {
	id: "lumberer",
	name: "Hill Lumberer",
	level: 3,
	size: "large",
	traits: ["giant"],
	attributes: { str: 5, dex: 0, con: 4, int: -2, wis: 0, cha: -1 },
	hp: 50,
	speed: 25,
	perception: 7,
	ac: 17,
	saves: { fort: 12, ref: 6, will: 7 },
	skills: [{ name: "athletics", bonus: 11 }],
	strikes: [
		{
			name: "Club",
			bonus: 11,
			damage: "1d10+7",
			damageType: "bludgeoning",
			traits: ["reach 10"],
		},
	],
};

export const SPRITE: PfSheet = {
	id: "sprite",
	name: "Ash Sprite",
	level: -1,
	size: "tiny",
	attributes: { str: -1, dex: 3, con: 0, int: 0, wis: 1, cha: 1 },
	hp: 6,
	speed: 20,
	perception: 4,
	ac: 15,
	saves: { fort: 2, ref: 7, will: 4 },
	skills: [],
	strikes: [
		{
			name: "Sting",
			bonus: 6,
			damage: "1d4",
			damageType: "piercing",
			traits: ["agile", "finesse"],
		},
	],
	immunities: ["fire"],
};

export const OPEN = {
	name: "Open Ground",
	terrain: [
		"..........",
		"..........",
		"..........",
		"..........",
		"..........",
		"..........",
	],
};

export const BOG = {
	name: "Bog",
	terrain: ["..~~......", "..~~......", "..........", ".....#...."],
};
