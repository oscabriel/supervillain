import { readFileSync } from "node:fs";
import path from "node:path";

import type { SetCharacter } from "@supervillain/domain";
import { Effect, Schema } from "effect";

import { decodeRoll } from "../../src/host/SetWorld.ts";

export const FIXTURES = path.join(import.meta.dir, "../fixtures/set-world");

export const RECORDED_SEEDS = [101, 611, 7, 501] as const;

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

export const recordedAnswer = (seed: number): Schema.Json | undefined =>
	RECORDED_SEEDS.some((recorded) => recorded === seed)
		? decodeJson(
				readFileSync(path.join(FIXTURES, `roll-${seed}.json`), "utf-8")
			)
		: undefined;

export const recorded = (seed: (typeof RECORDED_SEEDS)[number]): SetCharacter =>
	Effect.runSync(decodeRoll(seed, recordedAnswer(seed)));

export const character = (
	overrides: Partial<SetCharacter["attributes"]> = {},
	mainhand = "sword",
	seed = 1
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
		...overrides,
	},
	gear: [{ slot: "tool", name: `steel ${mainhand}` }],
});
