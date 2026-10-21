import type { DamageModifier } from "./sheets.ts";

export type Tier = 1 | 2 | 3;

export interface PowerRoll {
  readonly total: number;
  readonly tier: Tier;
  /** Edges less banes, each counted to at most two: -2 to 2. */
  readonly net: number;
  /** The two dice came to 19 or 20, which is always tier 3. */
  readonly natural: boolean;
}

const tierOf = (total: number): Tier => (total <= 11 ? 1 : total <= 16 ? 2 : 3);

/**
 * A power roll: 2d10 + bonus, tier 1 at 11 or less, tier 2 at 12 to 16, tier 3 at 17 or more.
 * Edges and banes count to two each and cancel one for one: a single edge is +2 and a single bane
 * -2, while a double edge raises the tier a step and a double bane lowers it, with no +2 or -2.
 * A natural 19 or 20 is tier 3 whatever else applies.
 */
export function powerRoll(
  dice: readonly [number, number],
  bonus: number,
  edges: number,
  banes: number,
): PowerRoll {
  const net = Math.min(edges, 2) - Math.min(banes, 2);
  const natural = dice[0] + dice[1] >= 19;
  const total = dice[0] + dice[1] + bonus + (net === 1 ? 2 : net === -1 ? -2 : 0);
  const shifted = tierOf(total) + (net === 2 ? 1 : net === -2 ? -1 : 0);
  const tier = natural ? 3 : (Math.max(1, Math.min(3, shifted)) as Tier);
  return { total, tier, net, natural };
}

export interface Damage {
  /** What the target takes, never below 0. */
  readonly dealt: number;
  readonly weakness: number;
  readonly immunity: number;
}

/** A modifier applies to damage of its type, and "all" to any damage, typed or not. */
const applies = (modifier: DamageModifier, type: string | undefined) =>
  modifier.type.toLowerCase() === "all" ||
  (type !== undefined && modifier.type.toLowerCase() === type.toLowerCase());

const highest = (modifiers: ReadonlyArray<DamageModifier> | undefined, type: string | undefined) =>
  Math.max(0, ...(modifiers ?? []).filter((m) => applies(m, type)).map((m) => m.value));

/** Damage after the highest applicable weakness adds and then the highest applicable immunity subtracts. */
export function modifiedDamage(
  amount: number,
  type: string | undefined,
  modifiers: {
    readonly weaknesses?: ReadonlyArray<DamageModifier>;
    readonly immunities?: ReadonlyArray<DamageModifier>;
  },
): Damage {
  const weakness = highest(modifiers.weaknesses, type);
  const immunity = highest(modifiers.immunities, type);
  return { dealt: Math.max(0, amount + weakness - immunity), weakness, immunity };
}
