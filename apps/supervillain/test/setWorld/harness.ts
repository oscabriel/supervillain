import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import type { SetCharacter } from "../../src/game/index.ts";
import { decodeRoll } from "../../src/host/SetWorld.ts";

/**
 * Rolls recorded from set.world's `/api/roll/character?seed=<n>` on 2026-10-22, as it answered
 * them (content version 7.1bmmTgz1B0Y9UKhiu84STg): Ada's Wayguard with a targe (101), a
 * Skirmisher with a sling (611), a Wizard with a tome (7) and a Dragoon with a pike (501).
 * `invalid-seed.json` is its answer, with status 400, to `seed=-5`.
 */
export const FIXTURES = join(import.meta.dir, "../fixtures/set-world");

export const RECORDED_SEEDS = [101, 611, 7, 501] as const;

/** A recorded answer as set.world sent it, or undefined for a seed with none. */
export const recordedAnswer = (seed: number): unknown =>
  (RECORDED_SEEDS as ReadonlyArray<number>).includes(seed)
    ? JSON.parse(readFileSync(join(FIXTURES, `roll-${seed}.json`), "utf8"))
    : undefined;

/** A recorded roll as the table keeps it. */
export const recorded = (seed: (typeof RECORDED_SEEDS)[number]): SetCharacter =>
  Effect.runSync(decodeRoll(seed, recordedAnswer(seed)));

/**
 * A made-up character with round numbers, for arithmetic that reads plainly: 100 health, 100
 * stamina, a turn every second, speed 5, a sword (melee, reach 1), 30 physical and 20 magical
 * damage, no dodge, no critical, no armour. Override what a test is about.
 */
export const character = (
  overrides: Partial<SetCharacter["attributes"]> = {},
  mainhand = "sword",
  seed = 1,
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
