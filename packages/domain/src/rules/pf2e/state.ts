import { charsOf, quote } from "../../text.ts";
import type { Square } from "../board/grid.ts";
import type { Occupant, Occupants } from "../board/movement.ts";
import { GM } from "../core/module.ts";
import { matching, pick } from "../drawSteel/state.ts";
import type { Refused } from "../engine.ts";
import type { Adjustment, Degree } from "./math.ts";
import { attributeOfSkill, spaceOf } from "./sheets.ts";
import type { PfAttribute, PfSave, PfSheet, PfSpace } from "./sheets.ts";

export const VALUED = [
	"clumsy",
	"drained",
	"enfeebled",
	"frightened",
	"sickened",
	"slowed",
	"stunned",
	"stupefied",
] as const;

export const PLAIN = [
	"blinded",
	"concealed",
	"confused",
	"controlled",
	"dazzled",
	"deafened",
	"fascinated",
	"fatigued",
	"fleeing",
	"grabbed",
	"hidden",
	"immobilized",
	"invisible",
	"off-guard",
	"paralyzed",
	"petrified",
	"prone",
	"quickened",
	"restrained",
	"unconscious",
	"undetected",
] as const;

export const CONDITIONS = [...VALUED, ...PLAIN] as const;

export type PfConditionName = (typeof CONDITIONS)[number];

export const COUNTERS = ["dying", "wounded", "doomed"] as const;

export type PfCounter = (typeof COUNTERS)[number];

export const EXPIRIES = ["eot", "sot"] as const;

export type PfExpiry = (typeof EXPIRIES)[number];

export interface PfExpires {
	readonly at: PfExpiry;
	readonly of: string;
	readonly skip?: boolean;
}

export interface PfCondition {
	readonly name: PfConditionName;
	readonly value?: number;
	readonly expires?: PfExpires;
	readonly by?: string;
}

export interface PfPersistent {
	readonly damageType: string;
	readonly dice: string;
}

export type PfSide = "party" | "foes";

export type PfKind = "pc" | "npc";

export interface PfShield {
	readonly hp: number;
	readonly raised: boolean;
}

export type CheckKind = "check" | "save" | "flat" | "strike";

export interface PfLastCheck {
	readonly kind: CheckKind;
	readonly label: string;
	readonly bonus: number;
	readonly dc?: number;
	readonly natural: number;
	readonly degree?: Degree;
	readonly fortune: boolean;
	readonly target?: string;
	readonly weapon?: string;
}

export interface PfLastHit {
	readonly dealt: number;
	readonly beforeHp: number;
	readonly beforeTemp: number;
	readonly beforeDying: number;
	readonly beforeWounded: number;
	readonly wasUnconscious: boolean;
	readonly crit: boolean;
	readonly blocked: boolean;
	readonly beforeOrder?: ReadonlyArray<string>;
	readonly beforeDelayed?: ReadonlyArray<string>;
}

export interface PfCreature {
	readonly id: string;
	readonly name: string;
	readonly side: PfSide;
	readonly kind: PfKind;
	readonly sheet: PfSheet;
	readonly block?: string;
	readonly adjustment?: Adjustment;
	readonly hp: number;
	readonly temp: number;
	readonly dying: number;
	readonly wounded: number;
	readonly doomed: number;
	readonly dead: boolean;
	readonly heroPoints: number;
	readonly conditions: ReadonlyArray<PfCondition>;
	readonly persistent: ReadonlyArray<PfPersistent>;
	readonly shield?: PfShield;
	readonly slotsUsed: ReadonlyArray<{
		readonly rank: number;
		readonly used: number;
	}>;
	readonly initiative?: number;
	readonly player?: string;
	readonly at?: Square;
	readonly lastCheck?: PfLastCheck;
	readonly lastHit?: PfLastHit;
}

export interface PfTurn {
	readonly id: string;
	readonly actions: number;
	readonly granted: number;
	readonly max: number;
	readonly attacks: number;
	readonly struck: ReadonlyArray<string>;
	readonly diagonalParity: 0 | 1;
}

export interface PfCombat {
	readonly round: number;
	readonly order: ReadonlyArray<string>;
	readonly delayed: ReadonlyArray<string>;
	readonly reacted: ReadonlyArray<string>;
	readonly turn?: PfTurn;
}

export interface PfMap {
	readonly id: string;
	readonly name: string;
	readonly terrain: ReadonlyArray<string>;
	readonly dressing?: ReadonlyArray<string>;
}

export interface PfState {
	readonly creatures: ReadonlyArray<PfCreature>;
	readonly map?: PfMap;
	readonly combat?: PfCombat;
}

export const initial: PfState = { creatures: [] };

export const HERO_POINTS_MAX = 3;

export const mapSide = (c: PfCreature): "heroes" | "director" =>
	c.side === "party" ? "heroes" : "director";

export const isPc = (c: PfCreature): boolean => c.kind === "pc";

export const isDead = (c: PfCreature): boolean =>
	c.dead || (c.kind === "npc" && c.hp <= 0);

export const conditionOf = (
	c: PfCreature,
	name: PfConditionName
): PfCondition | undefined => c.conditions.find((x) => x.name === name);

export const hasCondition = (c: PfCreature, name: PfConditionName): boolean =>
	conditionOf(c, name) !== undefined;

export const valueOf = (c: PfCreature, name: PfConditionName): number => {
	const found = conditionOf(c, name);

	if (found === undefined) {
		return 0;
	}

	return found.value ?? 1;
};

export const isUnconscious = (c: PfCreature): boolean =>
	c.hp <= 0 || hasCondition(c, "unconscious");

export const canAct = (c: PfCreature): boolean =>
	!isDead(c) &&
	!isUnconscious(c) &&
	!hasCondition(c, "paralyzed") &&
	!hasCondition(c, "petrified");

const OFF_GUARD_FROM: ReadonlyArray<PfConditionName> = [
	"off-guard",
	"prone",
	"grabbed",
	"restrained",
	"paralyzed",
	"unconscious",
];

export const isOffGuard = (c: PfCreature): boolean =>
	OFF_GUARD_FROM.some((n) => hasCondition(c, n)) || isUnconscious(c);

export const spaceOfCreature = (c: PfCreature): PfSpace =>
	spaceOf(c.sheet.size);

export const deadAt = (c: PfCreature): number => Math.max(1, 4 - c.doomed);

export const findCreature = (
	slice: PfState,
	id: string
): PfCreature | undefined => slice.creatures.find((c) => c.id === id);

export const creatureOf = (
	slice: PfState,
	actor: string
): PfCreature | undefined => slice.creatures.find((c) => c.player === actor);

export const controls = (actor: string, c: PfCreature): boolean =>
	actor === GM || (c.player !== undefined && c.player === actor);

export const attributeMod = (c: PfCreature, attribute: PfAttribute): number =>
	c.sheet.attributes[attribute];

export const skillBonus = (c: PfCreature, skill: string): number => {
	const found = c.sheet.skills.find((s) => s.name.toLowerCase() === skill);

	if (found !== undefined) {
		return found.bonus;
	}

	if (skill === "perception") {
		return c.sheet.perception;
	}

	const attribute = attributeOfSkill(skill);

	const fallback = skill.endsWith("lore") ? "int" : "wis";

	return attributeMod(c, attribute ?? fallback);
};

export const saveBonus = (c: PfCreature, save: PfSave): number =>
	c.sheet.saves[save];

export const idFor = (slice: PfState, base: string): string => {
	let id = base;

	for (let n = 2; slice.creatures.some((c) => c.id === id); n += 1) {
		id = `${base}-${n}`;
	}

	return id;
};

const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";

const lettersOf = (name: string): string =>
	name
		.normalize("NFKD")
		.toLowerCase()
		.replaceAll(/[^a-z0-9]/gu, "");

export const marksOf = (
	creatures: ReadonlyArray<PfCreature>
): ReadonlyMap<string, string> => {
	const taken = new Set<string>();
	const marks = new Map<string, string>();

	for (const c of creatures) {
		const letters = lettersOf(c.name);
		const first = letters[0] ?? "x";
		const lead = c.side === "party" ? first.toUpperCase() : first;
		const digit = /(?<n>\d+)$/u.exec(c.id)?.groups?.n;

		const opener = digit === undefined ? lead : `${lead}${digit.slice(-1)}`;

		const candidates = [
			opener,
			lead,
			...charsOf(letters.slice(1)).map((ch) => `${lead}${ch}`),
			...charsOf("23456789").map((d) => `${lead}${d}`),
			...charsOf(ALNUM).flatMap((a) => charsOf(ALNUM).map((b) => `${a}${b}`)),
		];

		const mark = candidates.find((m) => !taken.has(m)) ?? "??";

		taken.add(mark);
		marks.set(c.id, mark);
	}

	return marks;
};

export const resolveCreature = (
	slice: PfState,
	typed: string
): PfCreature | Refused => {
	const q = typed.trim().toLowerCase();

	const exact = slice.creatures.find(
		(c) => c.id === q || c.name.toLowerCase() === q
	);

	if (exact !== undefined) {
		return exact;
	}

	for (const [id, mark] of marksOf(slice.creatures)) {
		const marked = mark === typed.trim() ? findCreature(slice, id) : undefined;

		if (marked !== undefined) {
			return marked;
		}
	}

	return pick(
		slice.creatures,
		(c) => [c.id, c.name],
		(c) => c.name,
		typed,
		`Nobody at the table is called '${quote(typed)}'.`
	);
};

export const completeCreatures = (
	slice: PfState,
	partial: string,
	actor: string,
	keep: (c: PfCreature) => boolean = () => true
): Array<string> => {
	const own = creatureOf(slice, actor)?.id;
	const shown = slice.creatures.filter(keep);

	return matching(
		[
			...shown.filter((c) => c.id === own),
			...shown.filter((c) => c.id !== own),
		],
		(c) => c.id,
		(c) => [c.id, c.name],
		partial
	);
};

export const occupantsOf =
	(slice: PfState, except?: string): Occupants =>
	(square): Occupant | undefined => {
		const there = slice.creatures.find((c) => {
			if (c.id === except || isDead(c) || c.at === undefined) {
				return false;
			}

			const { footprint } = spaceOfCreature(c);

			return (
				square.x >= c.at.x &&
				square.x < c.at.x + footprint &&
				square.y >= c.at.y &&
				square.y < c.at.y + footprint
			);
		});

		if (there === undefined) {
			return undefined;
		}

		const space = spaceOfCreature(there);

		return {
			id: there.id,
			side: mapSide(there),
			footprint: space.footprint,
			tiny: space.tiny,
		};
	};

export const acting = (slice: PfState): PfCreature | undefined => {
	const id = slice.combat?.turn?.id;

	return id === undefined ? undefined : findCreature(slice, id);
};

export const hasReacted = (slice: PfState, id: string): boolean =>
	(slice.combat?.reacted ?? []).includes(id);

export const withCreature = (
	slice: PfState,
	id: string,
	change: (c: PfCreature) => PfCreature
): PfState => ({
	...slice,
	creatures: slice.creatures.map((c) => (c.id === id ? change(c) : c)),
});

export const partyLevel = (slice: PfState): number => {
	const party = slice.creatures.filter((c) => c.kind === "pc");

	if (party.length === 0) {
		return 1;
	}

	return Math.round(
		party.reduce((n, c) => n + c.sheet.level, 0) / party.length
	);
};
