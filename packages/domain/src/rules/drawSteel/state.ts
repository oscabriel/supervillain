import { orList, quote } from "../../text.ts";
import { footprintOf } from "../board/footprint.ts";
import type { Footprint } from "../board/footprint.ts";
import type { Square } from "../board/grid.ts";
import { GM } from "../core/module.ts";
import type { Refused } from "../engine.ts";
import { marksOf } from "./marks.ts";
import type { Ability, ActionKind, HeroSheet, StatBlock } from "./sheets.ts";

export type Side = "heroes" | "director";

export const CONDITIONS = [
	"bleeding",
	"dazed",
	"frightened",
	"grabbed",
	"prone",
	"restrained",
	"slowed",
	"taunted",
	"weakened",
] as const;

export type ConditionName = (typeof CONDITIONS)[number];

export type Duration = "eot" | "save" | "end";

export const DURATIONS: ReadonlyArray<Duration> = ["eot", "save", "end"];

export const HELD: ReadonlyArray<ConditionName> = [
	"frightened",
	"grabbed",
	"taunted",
];

export interface Condition {
	readonly name: ConditionName;
	readonly duration: Duration;
	readonly by?: string;
}

export interface Hero {
	readonly id: string;
	readonly sheet: HeroSheet;
	readonly stamina: number;
	readonly temp: number;
	readonly recoveries: number;
	readonly resource: number;
	readonly surges: number;
	readonly victories: number;
	readonly xp: number;
	readonly conditions: ReadonlyArray<Condition>;
	readonly player?: string;
}

export interface Creature {
	readonly id: string;
	readonly name: string;
	readonly block: string;
	readonly stamina: number;
	readonly max: number;
	readonly temp: number;
	readonly conditions: ReadonlyArray<Condition>;
	readonly squad?: number;
}

export interface Combat {
	readonly active: boolean;
	readonly round: number;
	readonly roll?: number;
	readonly first?: Side;
	readonly acted: ReadonlyArray<string>;
	readonly acting?: string;
	readonly moved?: {
		readonly id: string;
		readonly spent: number;
		readonly main: boolean;
	};
	readonly actions?: TurnActions;
	readonly triggered?: ReadonlyArray<string>;
}

export interface TurnActions {
	readonly id: string;
	readonly main: number;
	readonly maneuver: number;
	readonly move: number;
	readonly extra: number;
}

export interface Budget {
	readonly main: number;
	readonly maneuver: number;
	readonly move: number;
	readonly triggered: boolean;
	readonly dazed: boolean;
}

export interface Board {
	readonly id: string;
	readonly name: string;
	readonly terrain: ReadonlyArray<string>;
	readonly dressing?: ReadonlyArray<string>;
	readonly tokens: Readonly<Record<string, Square>>;
}

export interface DrawSteelState {
	readonly heroes: ReadonlyArray<Hero>;
	readonly creatures: ReadonlyArray<Creature>;
	readonly blocks: Readonly<Record<string, StatBlock>>;
	readonly combat: Combat;
	readonly malice: number;
	readonly tokens: number;
	readonly map?: Board;
}

export const NO_COMBAT: Combat = { active: false, round: 0, acted: [] };

export const initial: DrawSteelState = {
	heroes: [],
	creatures: [],
	blocks: {},
	combat: NO_COMBAT,
	malice: 0,
	tokens: 0,
};

export type Who =
	| {
			readonly kind: "hero";
			readonly id: string;
			readonly name: string;
			readonly hero: Hero;
	  }
	| {
			readonly kind: "creature";
			readonly id: string;
			readonly name: string;
			readonly creature: Creature;
	  };

export const everyone = (slice: DrawSteelState): ReadonlyArray<Who> => [
	...slice.heroes.map((hero): Who => ({
		kind: "hero",
		id: hero.id,
		name: hero.sheet.name,
		hero,
	})),
	...slice.creatures.map((creature): Who => ({
		kind: "creature",
		id: creature.id,
		name: creature.name,
		creature,
	})),
];

export const findWho = (slice: DrawSteelState, id: string): Who | undefined =>
	everyone(slice).find((w) => w.id === id);

export const abilitiesOf = (
	slice: DrawSteelState,
	who: Who
): ReadonlyArray<Ability> =>
	who.kind === "hero"
		? who.hero.sheet.abilities
		: (slice.blocks[who.creature.block]?.abilities ?? []);

export { CHARACTERISTICS } from "./sheets.ts";

export const capitalized = (s: string): string =>
	`${s.charAt(0).toUpperCase()}${s.slice(1)}`;

export const plural = (n: number, one: string, many = `${one}s`): string =>
	`${n} ${Math.abs(n) === 1 ? one : many}`;

export const andList = (items: ReadonlyArray<string>): string =>
	items.length <= 1
		? (items[0] ?? "")
		: `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

const beginsWord = (key: string, typed: string): boolean => {
	const k = key.toLowerCase();

	for (let i = 0; i < k.length; i += 1) {
		if (
			(i === 0 || k[i - 1] === " " || k[i - 1] === "-") &&
			k.startsWith(typed, i)
		) {
			return true;
		}
	}

	return false;
};

export const pick = <T>(
	items: ReadonlyArray<T>,
	keys: (item: T) => ReadonlyArray<string>,
	label: (item: T) => string,
	typed: string,
	none: string
): T | Refused => {
	const q = typed.trim().toLowerCase();

	const exact = items.find((item) =>
		keys(item).some((k) => k.toLowerCase() === q)
	);

	if (exact !== undefined) {
		return exact;
	}

	if (q === "") {
		return { refusal: none };
	}

	for (const matches of [
		(k: string) => k.toLowerCase().startsWith(q),
		(k: string) => beginsWord(k, q),
	]) {
		const begun = items.filter((item) => keys(item).some(matches));

		const [only] = begun;

		if (begun.length === 1 && only !== undefined) {
			return only;
		}

		if (begun.length > 1) {
			return {
				refusal: `'${quote(typed)}' could be ${orList(begun.map(label))}.`,
			};
		}
	}

	return { refusal: none };
};

export const matching = <T>(
	items: ReadonlyArray<T>,
	id: (item: T) => string,
	keys: (item: T) => ReadonlyArray<string>,
	typed: string
): Array<string> => {
	const q = typed.trim().toLowerCase();
	const begun = items.filter((item) => id(item).toLowerCase().startsWith(q));

	if (begun.length > 0 || q === "") {
		return begun.map(id);
	}

	return items.flatMap((item) =>
		keys(item).some((k) => beginsWord(k, q)) ? [id(item)] : []
	);
};

export const marks = (slice: DrawSteelState): ReadonlyMap<string, string> =>
	marksOf(everyone(slice));

export const byMark = (
	slice: DrawSteelState,
	typed: string
): Who | undefined => {
	const q = typed.trim();

	for (const [id, mark] of marks(slice)) {
		if (mark === q) {
			return findWho(slice, id);
		}
	}

	return undefined;
};

export const resolve = (
	slice: DrawSteelState,
	typed: string
): Who | Refused => {
	const all = everyone(slice);
	const q = typed.trim().toLowerCase();

	const exact = all.find(
		(w) => w.id.toLowerCase() === q || w.name.toLowerCase() === q
	);

	if (exact !== undefined) {
		return exact;
	}

	return (
		byMark(slice, typed) ??
		pick(
			all,
			(w) => [w.id, w.name],
			(w) => w.name,
			typed,
			`Nobody at the table is called '${quote(typed)}'.`
		)
	);
};

export const windedAt = (max: number): number => Math.floor(max / 2);

export type Health = "winded" | "dying" | "dead";

export const heroHealth = (hero: Hero): Health | undefined => {
	const max = hero.sheet.stamina;

	if (hero.stamina <= -windedAt(max)) {
		return "dead";
	}

	if (hero.stamina <= 0) {
		return "dying";
	}

	if (hero.stamina <= windedAt(max)) {
		return "winded";
	}

	return undefined;
};

export const perMinion = (creature: Creature): number =>
	creature.max / (creature.squad ?? 1);

export const minionsLeft = (creature: Creature): number => {
	if (creature.squad === undefined) {
		return creature.stamina > 0 ? 1 : 0;
	}

	if (creature.stamina <= 0) {
		return 0;
	}

	return (
		creature.squad -
		Math.floor((creature.max - creature.stamina) / perMinion(creature))
	);
};

export const creatureHealth = (creature: Creature): Health | undefined => {
	if (creature.stamina <= 0) {
		return "dead";
	}

	if (
		creature.squad === undefined &&
		creature.stamina <= windedAt(creature.max)
	) {
		return "winded";
	}

	return undefined;
};

const healthOf = (who: Who): Health | undefined =>
	who.kind === "hero" ? heroHealth(who.hero) : creatureHealth(who.creature);

export const isDead = (who: Who): boolean => healthOf(who) === "dead";

export const sideOf = (who: Who): Side =>
	who.kind === "hero" ? "heroes" : "director";

export const conditionsOf = (who: Who): ReadonlyArray<Condition> =>
	who.kind === "hero" ? who.hero.conditions : who.creature.conditions;

export const other = (side: Side): Side =>
	side === "heroes" ? "director" : "heroes";

export const controls = (actor: string, who: Who): boolean =>
	actor === GM || (who.kind === "hero" && who.hero.player === actor);

export const heroOf = (
	slice: DrawSteelState,
	actor: string
): Hero | undefined => slice.heroes.find((h) => h.player === actor);

export const waiting = (
	slice: DrawSteelState,
	side: Side
): ReadonlyArray<Who> =>
	everyone(slice).filter(
		(w) =>
			sideOf(w) === side && !isDead(w) && !slice.combat.acted.includes(w.id)
	);

export const nextSide = (slice: DrawSteelState): Side | undefined => {
	const { combat } = slice;

	if (!combat.active) {
		return undefined;
	}

	const last = combat.acted.at(-1);
	const lastWho = last === undefined ? undefined : findWho(slice, last);

	if (lastWho === undefined || roundOver(slice)) {
		const { first } = combat;

		const alive = (side: Side) =>
			everyone(slice).some((w) => sideOf(w) === side && !isDead(w));

		return first !== undefined && !alive(first) ? other(first) : first;
	}

	const side = sideOf(lastWho);

	return waiting(slice, other(side)).length > 0 ? other(side) : side;
};

export const roundOver = (slice: DrawSteelState): boolean =>
	waiting(slice, "heroes").length === 0 &&
	waiting(slice, "director").length === 0;

export const sizeOf = (slice: DrawSteelState, who: Who): string | undefined =>
	who.kind === "hero"
		? who.hero.sheet.size
		: slice.blocks[who.creature.block]?.size;

export const footprintOfWho = (slice: DrawSteelState, who: Who): Footprint =>
	footprintOf(sizeOf(slice, who));

export const hasCondition = (who: Who, name: ConditionName): boolean =>
	conditionsOf(who).some((c) => c.name === name);

export const causedBy = (who: Who, name: ConditionName): string | undefined =>
	conditionsOf(who).find((c) => c.name === name)?.by;

export const startedActions = (id: string): TurnActions => ({
	id,
	main: 0,
	maneuver: 0,
	move: 0,
	extra: 0,
});

export const budgetOf = (slice: DrawSteelState, who: Who): Budget => {
	const { combat } = slice;
	const dazed = hasCondition(who, "dazed");

	const triggered =
		combat.active && !dazed && !(combat.triggered ?? []).includes(who.id);

	if (!combat.active || combat.acting !== who.id) {
		return { main: 0, maneuver: 0, move: 0, triggered, dazed };
	}

	const spent =
		combat.actions?.id === who.id ? combat.actions : startedActions(who.id);

	if (dazed) {
		const left =
			spent.main + spent.maneuver + spent.move >= 1 + spent.extra ? 0 : 1;

		return { main: left, maneuver: left, move: left, triggered, dazed };
	}

	return {
		main: Math.max(0, 1 + spent.extra - spent.main),
		maneuver: Math.max(0, 1 - spent.maneuver),
		move: Math.max(0, 1 - spent.move),
		triggered,
		dazed,
	};
};

export const slotFor = (
	budget: Budget,
	kind: ActionKind
): ActionKind | undefined => {
	if (kind === "triggered") {
		return budget.triggered ? "triggered" : undefined;
	}

	if (budget[kind] > 0) {
		return kind;
	}

	return !budget.dazed && budget.main > 0 ? "main" : undefined;
};
