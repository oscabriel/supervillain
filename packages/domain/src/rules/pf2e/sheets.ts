import type { Footprint } from "../board/footprint.ts";

export const SIZES = [
	"tiny",
	"small",
	"medium",
	"large",
	"huge",
	"gargantuan",
] as const;

export type PfSize = (typeof SIZES)[number];

export const ATTRIBUTES = ["str", "dex", "con", "int", "wis", "cha"] as const;

export type PfAttribute = (typeof ATTRIBUTES)[number];

export type PfAttributes = Readonly<Record<PfAttribute, number>>;

export const SAVES = ["fort", "ref", "will"] as const;

export type PfSave = (typeof SAVES)[number];

export type PfSaves = Readonly<Record<PfSave, number>>;

export interface PfStrike {
	readonly name: string;
	readonly bonus: number;
	readonly damage: string;
	readonly damageType: string;
	readonly traits?: ReadonlyArray<string>;
	readonly range?: number;
	readonly reach?: number;
}

export interface PfAbility {
	readonly name: string;
	readonly actions?: string;
	readonly traits?: ReadonlyArray<string>;
	readonly text?: string;
}

export interface PfSpell {
	readonly name: string;
	readonly rank: number;
	readonly actions?: number;
	readonly attack?: boolean;
	readonly save?: PfSave;
	readonly basic?: boolean;
	readonly damage?: string;
	readonly damageType?: string;
	readonly heal?: string;
	readonly range?: number;
	readonly text?: string;
}

export interface PfSlots {
	readonly rank: number;
	readonly count: number;
}

export interface PfSpells {
	readonly tradition?: string;
	readonly dc?: number;
	readonly attack?: number;
	readonly slots?: ReadonlyArray<PfSlots>;
	readonly list: ReadonlyArray<PfSpell>;
}

export interface PfShieldStats {
	readonly bonus: number;
	readonly hardness: number;
	readonly hp: number;
	readonly broken: number;
}

export interface PfAmount {
	readonly type: string;
	readonly value: number;
}

export interface PfSkill {
	readonly name: string;
	readonly bonus: number;
}

export interface PfSheet {
	readonly id: string;
	readonly name: string;
	readonly level: number;
	readonly size: PfSize;
	readonly ancestry?: string;
	readonly class?: string;
	readonly traits?: ReadonlyArray<string>;
	readonly attributes: PfAttributes;
	readonly hp: number;
	readonly speed: number;
	readonly perception: number;
	readonly ac: number;
	readonly saves: PfSaves;
	readonly classDc?: number;
	readonly skills: ReadonlyArray<PfSkill>;
	readonly shield?: PfShieldStats;
	readonly strikes: ReadonlyArray<PfStrike>;
	readonly abilities?: ReadonlyArray<PfAbility>;
	readonly spells?: PfSpells;
	readonly immunities?: ReadonlyArray<string>;
	readonly weaknesses?: ReadonlyArray<PfAmount>;
	readonly resistances?: ReadonlyArray<PfAmount>;
	readonly flurry?: boolean;
}

export type PfHeroSheet = PfSheet;

export type PfCreatureBlock = PfSheet;

export interface PfSpace {
	readonly footprint: Footprint;
	readonly tiny: boolean;
}

const SPACES: Readonly<Record<PfSize, PfSpace>> = {
	tiny: { footprint: 1, tiny: true },
	small: { footprint: 1, tiny: false },
	medium: { footprint: 1, tiny: false },
	large: { footprint: 2, tiny: false },
	huge: { footprint: 3, tiny: false },
	gargantuan: { footprint: 4, tiny: false },
};

export const spaceOf = (size: PfSize): PfSpace => SPACES[size];

export const sizeRank = (size: PfSize): number => SIZES.indexOf(size);

export const SKILL_ATTRIBUTES = {
	acrobatics: "dex",
	arcana: "int",
	athletics: "str",
	crafting: "int",
	deception: "cha",
	diplomacy: "cha",
	intimidation: "cha",
	medicine: "wis",
	nature: "wis",
	occultism: "int",
	performance: "cha",
	religion: "wis",
	society: "int",
	stealth: "dex",
	survival: "wis",
	thievery: "dex",
} as const satisfies Readonly<Record<string, PfAttribute>>;

export const SKILLS: ReadonlyArray<string> = Object.keys(SKILL_ATTRIBUTES);

export const attributeOfSkill = (skill: string): PfAttribute | undefined =>
	Object.entries(SKILL_ATTRIBUTES).find(([name]) => name === skill)?.[1];

export const hasTrait = (
	traits: ReadonlyArray<string> | undefined,
	name: string
): boolean =>
	(traits ?? []).some(
		(t) => t.toLowerCase() === name || t.toLowerCase().startsWith(`${name} `)
	);

export const traitDie = (
	traits: ReadonlyArray<string> | undefined,
	name: string
): number | undefined => {
	const found = (traits ?? []).find((t) =>
		t.toLowerCase().startsWith(`${name} `)
	);

	const sides = /d(?<sides>\d+)$/u.exec(found ?? "")?.groups?.sides;

	return sides === undefined ? undefined : Number(sides);
};

export const traitFeet = (
	traits: ReadonlyArray<string> | undefined,
	name: string
): number | undefined => {
	const found = (traits ?? []).find((t) =>
		t.toLowerCase().startsWith(`${name} `)
	);

	const feet = /(?<feet>\d+)/u.exec(found ?? "")?.groups?.feet;

	return feet === undefined ? undefined : Number(feet);
};

export const isRanged = (strike: PfStrike): boolean =>
	strike.range !== undefined;

export const BARE_REACH = 10;

export const reachOfStrike = (strike: PfStrike): number =>
	strike.reach ??
	traitFeet(strike.traits, "reach") ??
	(hasTrait(strike.traits, "reach") ? BARE_REACH : 5);

export const meleeReach = (sheet: PfSheet): number =>
	Math.max(5, ...sheet.strikes.filter((s) => !isRanged(s)).map(reachOfStrike));
