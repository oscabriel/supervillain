import { quote } from "../../text.ts";
import type { Square } from "../board/grid.ts";
import type { Occupants } from "../board/movement.ts";
import { GM } from "../core/module.ts";
import { matching, pick } from "../drawSteel/state.ts";
import type { Refused } from "../engine.ts";

export const RULES_STAMP = "set-world-0-15-0-dungeon-initiative-2";

export const ATTRIBUTES = [
	"maxHealth",
	"stamina",
	"initiative",
	"walkSpeed",
	"physicalDamage",
	"magicalDamage",
	"physicalDamageReduction",
	"magicalDamageReduction",
	"globalResistance",
	"dodgeRate",
	"criticalHitChance",
	"clarity",
] as const;

export type Attribute = (typeof ATTRIBUTES)[number];

export interface Gear {
	readonly slot: string;
	readonly name: string;
}

export interface SetCharacter {
	readonly seed: number;
	readonly contentVersion: string;
	readonly className: string;
	readonly flavor: string;
	readonly mainhand: string;
	readonly powerRating: number;
	readonly finalStats: Readonly<Record<string, number>>;
	readonly attributes: Readonly<Record<Attribute, number>> &
		Readonly<Record<string, number>>;
	readonly gear: ReadonlyArray<Gear>;
}

export type SetSide = "party" | "foes";

export interface Fighter {
	readonly id: string;
	readonly name: string;
	readonly side: SetSide;
	readonly character: SetCharacter;
	readonly health: number;
	readonly stamina: number;
	readonly player?: string;
	readonly at?: Square;
}

export interface Turn {
	readonly id: string;
	readonly moved: number;
	readonly attacked: boolean;
}

export interface Fight {
	readonly clock: number;
	readonly turns: number;
	readonly next: Readonly<Record<string, number>>;
	readonly turn?: Turn;
}

export interface SetMap {
	readonly id: string;
	readonly name: string;
	readonly terrain: ReadonlyArray<string>;
	readonly dressing?: ReadonlyArray<string>;
}

export interface SetState {
	readonly fighters: ReadonlyArray<Fighter>;
	readonly map?: SetMap;
	readonly fight?: Fight;
}

export const initial: SetState = { fighters: [] };

export const ATTACK_STAMINA = 20;

export const RECOVERY_PER_SECOND = 10;

export const maxHealth = (c: SetCharacter): number =>
	Math.floor(c.attributes.maxHealth);

export const maxStamina = (c: SetCharacter): number =>
	Math.floor(c.attributes.stamina);

export const shownStamina = (f: Fighter): number => Math.floor(f.stamina);

export const intervalOf = (c: SetCharacter): number =>
	1000 / c.attributes.initiative;

export const speedOf = (c: SetCharacter): number =>
	Math.max(2, Math.round(5 * c.attributes.walkSpeed));

export const isDown = (f: Fighter): boolean => f.health <= 0;

export const living = (
	slice: SetState,
	side?: SetSide
): ReadonlyArray<Fighter> =>
	slice.fighters.filter(
		(f) => !isDown(f) && (side === undefined || f.side === side)
	);

export const fighterOf = (
	slice: SetState,
	actor: string
): Fighter | undefined => slice.fighters.find((f) => f.player === actor);

export const findFighter = (slice: SetState, id: string): Fighter | undefined =>
	slice.fighters.find((f) => f.id === id);

export const controls = (actor: string, f: Fighter): boolean =>
	actor === GM || (f.player !== undefined && f.player === actor);

export const mapSide = (f: Fighter): "heroes" | "director" =>
	f.side === "party" ? "heroes" : "director";

export const idFor = (slice: SetState, name: string): string => {
	const base =
		name
			.normalize("NFKD")
			.toLowerCase()
			.replaceAll(/[^a-z0-9]+/gu, "-")
			.replaceAll(/^-+|-+$/gu, "")
			.slice(0, 24) || "fighter";

	let id = base;

	for (let n = 2; slice.fighters.some((f) => f.id === id); n += 1) {
		id = `${base}-${n}`;
	}

	return id;
};

export const marksOf = (
	fighters: ReadonlyArray<Fighter>
): ReadonlyMap<string, string> => {
	const taken = new Set<string>();
	const marks = new Map<string, string>();
	const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";

	for (const f of fighters) {
		const letters = f.name
			.normalize("NFKD")
			.toLowerCase()
			.replaceAll(/[^a-z0-9]/gu, "");

		const first = letters[0] ?? "x";
		const lead = f.side === "party" ? first.toUpperCase() : first;

		const candidates = [
			lead,
			...letters
				.slice(1)
				.split("")
				.map((c) => `${lead}${c}`),
			..."23456789".split("").map((d) => `${lead}${d}`),
			...ALNUM.split("").flatMap((a) => ALNUM.split("").map((b) => `${a}${b}`)),
		];

		const mark = candidates.find((m) => !taken.has(m)) ?? "??";
		taken.add(mark);
		marks.set(f.id, mark);
	}

	return marks;
};

export const resolveFighter = (
	slice: SetState,
	typed: string
): Fighter | Refused => {
	const q = typed.trim().toLowerCase();

	const exact = slice.fighters.find(
		(f) => f.id === q || f.name.toLowerCase() === q
	);

	if (exact !== undefined) {
		return exact;
	}

	for (const [id, mark] of marksOf(slice.fighters)) {
		const marked = mark === typed.trim() ? findFighter(slice, id) : undefined;

		if (marked !== undefined) {
			return marked;
		}
	}

	return pick(
		slice.fighters,
		(f) => [f.id, f.name],
		(f) => f.name,
		typed,
		`Nobody at the table is called '${quote(typed)}'.`
	);
};

export const completeFighters = (
	slice: SetState,
	partial: string,
	actor: string,
	keep: (f: Fighter) => boolean = () => true
): Array<string> => {
	const own = fighterOf(slice, actor)?.id;
	const shown = slice.fighters.filter(keep);

	const ordered = [
		...shown.filter((f) => f.id === own),
		...shown.filter((f) => f.id !== own),
	];

	return matching(
		ordered,
		(f) => f.id,
		(f) => [f.id, f.name],
		partial
	);
};

export const occupants =
	(slice: SetState, except?: string): Occupants =>
	(square) => {
		const there = slice.fighters.find(
			(f) =>
				f.id !== except &&
				!isDown(f) &&
				f.at !== undefined &&
				f.at.x === square.x &&
				f.at.y === square.y
		);

		return there === undefined
			? undefined
			: { id: there.id, side: mapSide(there) };
	};

export const nextOf = (fight: Fight, id: string): number | undefined =>
	Object.hasOwn(fight.next, id) ? fight.next[id] : undefined;

export const soonest = (slice: SetState, fight: Fight): Fighter | undefined => {
	let best: Fighter | undefined;

	for (const f of [...living(slice, "party"), ...living(slice, "foes")]) {
		const at = nextOf(fight, f.id);

		const bestAt = best === undefined ? undefined : nextOf(fight, best.id);

		if (at !== undefined && (bestAt === undefined || at < bestAt)) {
			best = f;
		}
	}

	return best;
};
