export const CHARACTERISTICS = [
	"might",
	"agility",
	"reason",
	"intuition",
	"presence",
] as const;

export type Characteristic = (typeof CHARACTERISTICS)[number];

export type Characteristics = Readonly<Record<Characteristic, number>>;

export interface DamageModifier {
	readonly type: string;
	readonly value: number;
}

export interface Ability {
	readonly name: string;
	readonly kind?: string;
	readonly characteristics?: ReadonlyArray<Characteristic>;
	readonly bonus?: number;
	readonly cost?: number;
	readonly keywords?: ReadonlyArray<string>;
	readonly distance?: string;
	readonly target?: string;
	readonly tier1?: string;
	readonly tier2?: string;
	readonly tier3?: string;
	readonly effect?: string;
}

export interface HeroSheet {
	readonly id: string;
	readonly name: string;
	readonly class: string;
	readonly level: number;
	readonly characteristics: Characteristics;
	readonly stamina: number;
	readonly recoveries: number;
	readonly recoveryValue?: number;
	readonly speed: number;
	readonly stability: number;
	readonly size?: string;
	readonly resource: {
		readonly name: string;
		readonly perTurn: string | number;
		readonly min?: number;
	};
	readonly victories: number;
	readonly immunities?: ReadonlyArray<DamageModifier>;
	readonly weaknesses?: ReadonlyArray<DamageModifier>;
	readonly abilities: ReadonlyArray<Ability>;
}

export type Organization =
	| "minion"
	| "horde"
	| "platoon"
	| "elite"
	| "leader"
	| "solo";

export interface StatBlock {
	readonly id: string;
	readonly name: string;
	readonly level: number;
	readonly organization: Organization;
	readonly role?: string;
	readonly ev?: string;
	readonly stamina: number;
	readonly size?: string;
	readonly speed: number;
	readonly stability: number;
	readonly freeStrike: number;
	readonly characteristics: Characteristics;
	readonly immunities?: ReadonlyArray<DamageModifier>;
	readonly weaknesses?: ReadonlyArray<DamageModifier>;
	readonly abilities: ReadonlyArray<Ability>;
	readonly withCaptain?: string;
}

export const isTrait = (ability: Ability): boolean =>
	/^\s*trait\b/iu.test(ability.kind ?? "");

export type ActionKind = "main" | "maneuver" | "move" | "triggered";

export const actionKindOf = (ability: Ability): ActionKind | undefined => {
	const kind = ability.kind ?? "";

	if (/\bfree\b/iu.test(kind)) {
		return undefined;
	}

	if (/\btriggered\b/iu.test(kind)) {
		return "triggered";
	}

	if (/\bmaneuver\b/iu.test(kind)) {
		return "maneuver";
	}

	if (/\bmain action\b/iu.test(kind)) {
		return "main";
	}

	return /\bmove action\b/iu.test(kind) ? "move" : undefined;
};

export const isStrike = (ability: Ability): boolean =>
	(ability.keywords ?? []).some((k) => /^\s*strike\s*$/iu.test(k));

export const isActionThatBleeds = (ability: Ability): boolean =>
	/\b(?:main|triggered) action\b/iu.test(ability.kind ?? "");

export const reachOf = (ability: Ability): number | undefined => {
	const reaches = Array.from(
		(ability.distance ?? "").matchAll(/\b(?:melee|ranged)\s+(?<reach>\d+)/giu),
		(m) => Number(m.groups?.reach)
	);

	return reaches.length === 0 ? undefined : Math.max(...reaches);
};

const LETTERS = new Map<string, Characteristic>([
	["M", "might"],
	["A", "agility"],
	["R", "reason"],
	["I", "intuition"],
	["P", "presence"],
]);

const PLUS = String.raw`(?<!\+\s*)\b(\d+)(?:\s*\+\s*([MARIP](?:\s*,\s*(?:or\s+)?[MARIP]|\s+or\s+[MARIP])*)\b)?`;

export const TIER_PLUS = new RegExp(PLUS, "giu");

const DAMAGE = new RegExp(String.raw`${PLUS}(?:\s+([a-z]+))?\s+damage\b`, "iu");

export const bestScore = (
	letters: string,
	scores: Characteristics | undefined
): number =>
	Math.max(
		...Array.from(letters.matchAll(/\b[MARIP]\b/giu), ([l = ""]) => {
			const name = LETTERS.get(l.toUpperCase());

			return name === undefined ? 0 : (scores?.[name] ?? 0);
		})
	);

export const tierDamage = (
	text: string | undefined,
	scores: Characteristics | undefined
): { readonly amount: number; readonly type?: string } | undefined => {
	const match = DAMAGE.exec(text ?? "");

	if (match === null) {
		return undefined;
	}

	const added = match[2] === undefined ? 0 : bestScore(match[2], scores);
	const amount = Math.max(0, Number(match[1]) + added);
	const type = match[3]?.toLowerCase();

	return type === undefined ? { amount } : { amount, type };
};
