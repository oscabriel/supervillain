import { orEmpty } from "../../present.ts";
import type { DamageModifier } from "./sheets.ts";

export type Tier = 1 | 2 | 3;

export interface PowerRoll {
	readonly total: number;
	readonly tier: Tier;
	readonly net: number;
	readonly natural: boolean;
}

const tierOf = (total: number): Tier => {
	if (total <= 11) {
		return 1;
	}

	return total <= 16 ? 2 : 3;
};

const EDGE_BONUS = new Map([
	[1, 2],
	[-1, -2],
]);

const TIER_SHIFT = new Map([
	[2, 1],
	[-2, -1],
]);

const clampTier = (n: number): Tier => {
	if (n <= 1) {
		return 1;
	}

	return n >= 3 ? 3 : 2;
};

export const powerRoll = (
	dice: readonly [number, number],
	bonus: number,
	edges: number,
	banes: number
): PowerRoll => {
	const net = Math.min(edges, 2) - Math.min(banes, 2);
	const natural = dice[0] + dice[1] >= 19;

	const total = dice[0] + dice[1] + bonus + (EDGE_BONUS.get(net) ?? 0);
	const shifted = tierOf(total) + (TIER_SHIFT.get(net) ?? 0);
	const tier = natural ? 3 : clampTier(shifted);

	return { total, tier, net, natural };
};

export interface Damage {
	readonly dealt: number;
	readonly weakness: number;
	readonly immunity: number;
}

const applies = (modifier: DamageModifier, type: string | undefined) =>
	modifier.type.toLowerCase() === "all" ||
	(type !== undefined && modifier.type.toLowerCase() === type.toLowerCase());

const highest = (
	modifiers: ReadonlyArray<DamageModifier> | undefined,
	type: string | undefined
) =>
	Math.max(
		0,
		...orEmpty(modifiers)
			.filter((m) => applies(m, type))
			.map((m) => m.value)
	);

export const modifiedDamage = (
	amount: number,
	type: string | undefined,
	modifiers: {
		readonly weaknesses?: ReadonlyArray<DamageModifier>;
		readonly immunities?: ReadonlyArray<DamageModifier>;
	}
): Damage => {
	const weakness = highest(modifiers.weaknesses, type);
	const immunity = highest(modifiers.immunities, type);

	return {
		dealt: Math.max(0, amount + weakness - immunity),
		weakness,
		immunity,
	};
};
