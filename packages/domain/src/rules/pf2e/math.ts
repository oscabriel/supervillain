import { signed } from "../../dice.ts";
import { ifDefined, listIfDefined } from "../../present.ts";
import type { Dice, Refused } from "../engine.ts";
import type { PfAmount, PfSheet } from "./sheets.ts";

export const DEGREES = [
	"crit-failure",
	"failure",
	"success",
	"crit-success",
] as const;

export type Degree = (typeof DEGREES)[number];

const clampIndex = (i: number): number =>
	Math.max(0, Math.min(DEGREES.length - 1, i));

const degreeAt = (i: number): Degree => DEGREES[clampIndex(i)] ?? "failure";

const baseIndex = (total: number, dc: number): number => {
	if (total >= dc + 10) {
		return 3;
	}

	if (total >= dc) {
		return 2;
	}

	return total <= dc - 10 ? 0 : 1;
};

export const shiftOf = (natural: number): number => {
	if (natural === 20) {
		return 1;
	}

	return natural === 1 ? -1 : 0;
};

export const degree = (total: number, dc: number, natural: number): Degree =>
	degreeAt(baseIndex(total, dc) + shiftOf(natural));

export const succeeded = (d: Degree): boolean =>
	d === "success" || d === "crit-success";

export const DEGREE_TEXT: Readonly<Record<Degree, string>> = {
	"crit-success": "critical success",
	success: "success",
	failure: "failure",
	"crit-failure": "critical failure",
};

export const MODIFIER_TYPES = [
	"circumstance",
	"status",
	"item",
	"untyped",
] as const;

export type ModifierType = (typeof MODIFIER_TYPES)[number];

export interface Modifier {
	readonly type: ModifierType;
	readonly value: number;
	readonly label: string;
}

export interface Modified {
	readonly bonus: number;
	readonly parts: ReadonlyArray<Modifier>;
}

const best = (
	list: ReadonlyArray<Modifier>,
	better: (a: Modifier, b: Modifier) => boolean
): ReadonlyArray<Modifier> => {
	let found: Modifier | undefined;

	for (const m of list) {
		if (found === undefined || better(m, found)) {
			found = m;
		}
	}

	return found === undefined ? [] : [found];
};

export const modifiers = (list: ReadonlyArray<Modifier>): Modified => {
	const live = list.filter((m) => m.value !== 0);

	const typed = (["circumstance", "status", "item"] as const).flatMap(
		(type) => {
			const of = live.filter((m) => m.type === type);

			return [
				...best(
					of.filter((m) => m.value > 0),
					(a, b) => a.value > b.value
				),
				...best(
					of.filter((m) => m.value < 0),
					(a, b) => a.value < b.value
				),
			];
		}
	);

	const parts = [...typed, ...live.filter((m) => m.type === "untyped")];

	return { bonus: parts.reduce((n, m) => n + m.value, 0), parts };
};

export const partsText = (parts: ReadonlyArray<Modifier>): string =>
	parts.map((m) => `${m.label} ${signed(m.value)}`).join(", ");

export const mapPenalty = (
	attacks: number,
	agile: boolean,
	flurry: boolean
): number => {
	const step = Math.min(2, Math.max(0, attacks));
	const agileSteps = flurry ? [0, -2, -4] : [0, -4, -8];
	const plainSteps = flurry ? [0, -3, -6] : [0, -5, -10];

	return (agile ? agileSteps : plainSteps)[step] ?? 0;
};

export interface DamageTerm {
	readonly count: number;
	readonly sides: number;
}

export interface DamageExpression {
	readonly terms: ReadonlyArray<DamageTerm>;
	readonly flat: number;
}

const TERM = /^(?<count>\d*)d(?<sides>\d+)$/u;

const FLAT = /^\d+$/u;

const MAX_DICE = 60;

const MAX_SIDES = 100;

const MAX_FLAT = 1000;

export const parseDamage = (input: string): DamageExpression | Refused => {
	const compact = input.replaceAll(/\s+/gu, "").toLowerCase();
	const bad: Refused = { refusal: `'${input}' isn't damage like 2d6+3.` };

	if (compact === "" || !/^[+-]?[\dd+-]+$/u.test(compact)) {
		return bad;
	}

	const pieces = compact.match(/[+-]?[^+-]+/gu) ?? [];
	const terms: Array<DamageTerm> = [];
	let flat = 0;

	for (const piece of pieces) {
		const negative = piece.startsWith("-");
		const body = piece.replace(/^[+-]/u, "");
		const groups = TERM.exec(body)?.groups;

		if (groups !== undefined && !negative) {
			const count = groups.count === "" ? 1 : Number(groups.count);
			const sides = Number(groups.sides);

			if (count < 1 || count > MAX_DICE || sides < 2 || sides > MAX_SIDES) {
				return bad;
			}

			terms.push({ count, sides });
		} else if (FLAT.test(body)) {
			flat += negative ? -Number(body) : Number(body);
		} else {
			return bad;
		}
	}

	return Math.abs(flat) > MAX_FLAT ? bad : { terms, flat };
};

export const expressionText = (e: DamageExpression): string => {
	const dice = e.terms.map((t) => `${t.count}d${t.sides}`).join("+");

	if (dice === "") {
		return String(e.flat);
	}

	return `${dice}${signed(e.flat)}`;
};

export const withFlat = (input: string, by: number): string => {
	const parsed = parseDamage(input);

	return "refusal" in parsed
		? input
		: expressionText({ ...parsed, flat: parsed.flat + by });
};

export interface RollOptions {
	readonly critical: boolean;
	readonly deadly?: number;
	readonly fatal?: number;
}

export interface Rolled {
	readonly expression: string;
	readonly rolls: ReadonlyArray<number>;
	readonly total: number;
}

const rollTerms = (
	terms: ReadonlyArray<DamageTerm>,
	dice: Dice
): ReadonlyArray<number> =>
	terms.flatMap((t) => Array.from({ length: t.count }, () => dice(t.sides)));

const sum = (ns: ReadonlyArray<number>): number =>
	ns.reduce((n, m) => n + m, 0);

export const rollDamage = (
	e: DamageExpression,
	dice: Dice,
	options: RollOptions
): Rolled => {
	const { fatal, deadly } = options;

	const terms =
		options.critical && fatal !== undefined
			? e.terms.map((t) => ({ count: t.count, sides: fatal }))
			: e.terms;

	const rolls = rollTerms(terms, dice);
	const base = Math.max(1, sum(rolls) + e.flat);

	if (!options.critical) {
		return {
			expression: expressionText({ terms, flat: e.flat }),
			rolls,
			total: base,
		};
	}

	const extraDice = [
		...listIfDefined(fatal, (f) => [f]),
		...listIfDefined(deadly, (d) => [d]),
	];

	const extras = extraDice.map((sides) => dice(sides));
	const named = extraDice.map((sides) => `+1d${sides}`).join("");

	return {
		expression: `2×(${expressionText({ terms, flat: e.flat })})${named}`,
		rolls: [...rolls, ...extras],
		total: base * 2 + sum(extras),
	};
};

export const rollFlat = (e: DamageExpression, dice: Dice): Rolled =>
	rollDamage(e, dice, { critical: false });

const PHYSICAL: ReadonlySet<string> = new Set([
	"bludgeoning",
	"piercing",
	"slashing",
]);

const applies = (type: string, damageType: string): boolean => {
	const t = type.toLowerCase();
	const d = damageType.toLowerCase();

	return t === d || t === "all" || (t === "physical" && PHYSICAL.has(d));
};

const highest = (
	list: ReadonlyArray<PfAmount> | undefined,
	damageType: string
): PfAmount | undefined => {
	let found: PfAmount | undefined;

	for (const a of list ?? []) {
		if (applies(a.type, damageType) && (found?.value ?? -1) < a.value) {
			found = a;
		}
	}

	return found;
};

export interface Resolved {
	readonly applied: number;
	readonly notes: ReadonlyArray<string>;
}

export type Defences = Pick<
	PfSheet,
	"immunities" | "weaknesses" | "resistances"
>;

export const resolveDamage = (
	amount: number,
	damageType: string | undefined,
	sheet: Defences
): Resolved => {
	if (damageType === undefined || damageType === "") {
		return { applied: Math.max(0, amount), notes: [] };
	}

	if ((sheet.immunities ?? []).some((i) => applies(i, damageType))) {
		return { applied: 0, notes: [`immune to ${damageType}`] };
	}

	const weak = highest(sheet.weaknesses, damageType);
	const resist = highest(sheet.resistances, damageType);
	const weakened = amount + (weak?.value ?? 0);
	const applied = Math.max(0, weakened - (resist?.value ?? 0));

	return {
		applied,
		notes: [
			...listIfDefined(weak, (w) => [`weakness ${w.value}`]),
			...listIfDefined(resist, (r) => [`resistance ${r.value}`]),
		],
	};
};

export const basicDamage = (d: Degree, amount: number): number => {
	if (d === "crit-success") {
		return 0;
	}

	if (d === "success") {
		return Math.floor(amount / 2);
	}

	return d === "failure" ? amount : amount * 2;
};

export type Adjustment = "elite" | "weak";

const eliteHp = (level: number): number => {
	if (level <= 1) {
		return 10;
	}

	if (level <= 4) {
		return 15;
	}

	return level <= 19 ? 20 : 30;
};

const weakHp = (level: number): number => {
	if (level <= 2) {
		return -10;
	}

	if (level <= 5) {
		return -15;
	}

	return level <= 20 ? -20 : -30;
};

export const hpAdjustment = (level: number, adjustment: Adjustment): number =>
	adjustment === "elite" ? eliteHp(level) : weakHp(level);

export const levelAdjustment = (
	level: number,
	adjustment: Adjustment
): number => {
	if (adjustment === "elite") {
		return level <= 0 ? 2 : 1;
	}

	return level === 1 ? -2 : -1;
};

export const adjusted = (sheet: PfSheet, adjustment: Adjustment): PfSheet => {
	const by = adjustment === "elite" ? 2 : -2;
	const hp = hpAdjustment(sheet.level, adjustment);
	const { spells } = sheet;

	return {
		...sheet,
		level: sheet.level + levelAdjustment(sheet.level, adjustment),
		hp: Math.max(1, sheet.hp + hp),
		ac: sheet.ac + by,
		perception: sheet.perception + by,
		saves: {
			fort: sheet.saves.fort + by,
			ref: sheet.saves.ref + by,
			will: sheet.saves.will + by,
		},
		skills: sheet.skills.map((s) => ({ ...s, bonus: s.bonus + by })),
		strikes: sheet.strikes.map((s) => ({
			...s,
			bonus: s.bonus + by,
			damage: withFlat(s.damage, by),
		})),
		...ifDefined(sheet.classDc, (dc) => ({ classDc: dc + by })),
		...ifDefined(spells, (s) => ({
			spells: {
				...s,
				...ifDefined(s.dc, (dc) => ({ dc: dc + by })),
				...ifDefined(s.attack, (attack) => ({ attack: attack + by })),
			},
		})),
	};
};

const XP_FROM_FOUR_BELOW = [10, 15, 20, 30, 40, 60, 80, 120, 160] as const;

export const creatureXp = (level: number, partyLevel: number): number => {
	const difference = level - partyLevel;

	if (difference < -4) {
		return 0;
	}

	return XP_FROM_FOUR_BELOW[Math.min(4, difference) + 4] ?? 0;
};

export const THREATS = [
	"trivial",
	"low",
	"moderate",
	"severe",
	"extreme",
] as const;

export type Threat = (typeof THREATS)[number];

const BUDGET: Readonly<Record<Threat, number>> = {
	trivial: 40,
	low: 60,
	moderate: 80,
	severe: 120,
	extreme: 160,
};

const PER_EXTRA: Readonly<Record<Threat, number>> = {
	trivial: 10,
	low: 20,
	moderate: 20,
	severe: 30,
	extreme: 40,
};

export const budgetFor = (threat: Threat, partySize: number): number =>
	BUDGET[threat] + PER_EXTRA[threat] * (Math.max(1, partySize) - 4);

export const threatOf = (xp: number, partySize: number): Threat => {
	const reached = THREATS.filter((t) => xp >= budgetFor(t, partySize));

	return reached.at(-1) ?? "trivial";
};
