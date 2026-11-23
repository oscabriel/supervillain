import { listIf } from "../../present.ts";
import { mapPenalty } from "./math.ts";
import type { Modifier } from "./math.ts";
import { hasTrait, isRanged, attributeOfSkill } from "./sheets.ts";
import type { PfSave, PfStrike } from "./sheets.ts";
import {
	conditionOf,
	findCreature,
	hasCondition,
	isDead,
	isOffGuard,
	isUnconscious,
	valueOf,
} from "./state.ts";
import type {
	PfCombat,
	PfConditionName,
	PfCreature,
	PfState,
} from "./state.ts";

export const BASE_ACTIONS = 3;

const status = (
	c: PfCreature,
	name: PfConditionName
): ReadonlyArray<Modifier> =>
	listIf(valueOf(c, name) > 0, () => [
		{ type: "status" as const, value: -valueOf(c, name), label: name },
	]);

const shared = (c: PfCreature): ReadonlyArray<Modifier> => [
	...status(c, "frightened"),
	...status(c, "sickened"),
];

const knockedOut = (c: PfCreature): ReadonlyArray<Modifier> =>
	listIf(isUnconscious(c), () => [
		{ type: "status" as const, value: -4, label: "unconscious" },
	]);

export type Defence = "ac" | PfSave | "perception";

export const defencePenalties = (
	c: PfCreature,
	defence: Defence
): ReadonlyArray<Modifier> => {
	if (defence === "ac") {
		return [
			...shared(c),
			...status(c, "clumsy"),
			...status(c, "fatigued"),
			...knockedOut(c),
		];
	}

	if (defence === "fort") {
		return [...shared(c), ...status(c, "drained"), ...status(c, "fatigued")];
	}

	if (defence === "ref") {
		return [
			...shared(c),
			...status(c, "clumsy"),
			...status(c, "fatigued"),
			...knockedOut(c),
		];
	}

	if (defence === "will") {
		return [...shared(c), ...status(c, "stupefied"), ...status(c, "fatigued")];
	}

	return [...shared(c), ...status(c, "stupefied"), ...knockedOut(c)];
};

export const skillPenalties = (
	c: PfCreature,
	skill: string
): ReadonlyArray<Modifier> => {
	if (skill === "perception") {
		return defencePenalties(c, "perception");
	}

	const attribute = attributeOfSkill(skill);

	return [
		...shared(c),
		...listIf(attribute === "dex", () => status(c, "clumsy")),
		...listIf(attribute === "str", () => status(c, "enfeebled")),
		...listIf(
			attribute === "int" ||
				attribute === "wis" ||
				attribute === "cha" ||
				skill.endsWith("lore"),
			() => status(c, "stupefied")
		),
	];
};

export const attackPenalties = (
	c: PfCreature,
	strike: PfStrike
): ReadonlyArray<Modifier> => {
	const finesse = hasTrait(strike.traits, "finesse");
	const ranged = isRanged(strike);

	return [
		...shared(c),
		...listIf(ranged || finesse, () => status(c, "clumsy")),
		...listIf(!ranged && !finesse, () => status(c, "enfeebled")),
		...listIf(hasCondition(c, "prone"), () => [
			{ type: "circumstance" as const, value: -2, label: "prone" },
		]),
	];
};

export const spellPenalties = (c: PfCreature): ReadonlyArray<Modifier> => [
	...shared(c),
	...status(c, "stupefied"),
];

export const offGuard = (c: PfCreature): ReadonlyArray<Modifier> =>
	listIf(isOffGuard(c), () => [
		{ type: "circumstance" as const, value: -2, label: "off-guard" },
	]);

export const shieldBonus = (c: PfCreature): ReadonlyArray<Modifier> => {
	const stats = c.sheet.shield;
	const { shield } = c;

	return listIf(
		stats !== undefined &&
			shield !== undefined &&
			shield.raised &&
			shield.hp > stats.broken,
		() => [
			{
				type: "circumstance" as const,
				value: stats?.bonus ?? 0,
				label: "shield",
			},
		]
	);
};

export const isBroken = (c: PfCreature): boolean => {
	const stats = c.sheet.shield;

	return (
		stats === undefined || c.shield === undefined || c.shield.hp <= stats.broken
	);
};

export interface TurnActions {
	readonly actions: number;
	readonly stunned?: number;
}

export const actionsFor = (c: PfCreature): TurnActions => {
	if (isDead(c) || isUnconscious(c) || hasCondition(c, "paralyzed")) {
		return { actions: 0 };
	}

	const base = BASE_ACTIONS + (hasCondition(c, "quickened") ? 1 : 0);
	const stunned = valueOf(c, "stunned");
	const slowed = valueOf(c, "slowed");
	const used = Math.min(stunned, base);
	const lost = Math.max(used, slowed);
	const actions = Math.max(0, base - lost);

	return conditionOf(c, "stunned") === undefined
		? { actions }
		: { actions, stunned: stunned - used };
};

export const maxActions = (c: PfCreature): number =>
	BASE_ACTIONS + (hasCondition(c, "quickened") ? 1 : 0);

export const sortOrder = (
	creatures: ReadonlyArray<PfCreature>
): ReadonlyArray<string> =>
	creatures
		.flatMap((c, i) => (c.initiative === undefined ? [] : [{ c, i }]))
		.toSorted(
			(a, b) =>
				(b.c.initiative ?? 0) - (a.c.initiative ?? 0) ||
				Number(a.c.side === "party") - Number(b.c.side === "party") ||
				a.i - b.i
		)
		.map(({ c }) => c.id);

export interface Next {
	readonly id: string;
	readonly round: number;
}

export const nextAfter = (
	slice: PfState,
	combat: PfCombat,
	from: string | undefined
): Next | undefined => {
	const { order } = combat;
	const start = from === undefined ? -1 : order.indexOf(from);

	for (let step = 1; step <= order.length; step += 1) {
		const index = start + step;
		const id = order[index % order.length];
		const c = id === undefined ? undefined : findCreature(slice, id);

		if (
			c !== undefined &&
			!isDead(c) &&
			(id !== from || step === order.length)
		) {
			return {
				id: c.id,
				round: combat.round + (index >= order.length ? 1 : 0),
			};
		}
	}

	return undefined;
};

export const actionsText = (left: number, max: number): string =>
	`${"◆".repeat(Math.max(0, left))}${"◇".repeat(Math.max(0, max - left))}`;

export const mapPenaltyFor = (c: PfCreature, attacks: number): number =>
	mapPenalty(attacks, false, c.sheet.flurry === true);
