import { quote } from "../../text.ts";
import type { Square } from "../board/grid.ts";
import type { Occupants } from "../board/movement.ts";
import { GM } from "../core/module.ts";
import { matching, pick } from "../drawSteel/state.ts";
import type { Refused } from "../engine.ts";
import type { FfSheet } from "./schema.ts";

export type FfSide = "party" | "foes";

export interface FfFigure {
	readonly id: string;
	readonly name: string;
	readonly side: FfSide;
	readonly sheet: FfSheet;
	readonly values: Readonly<Record<string, number>>;
	readonly tags: ReadonlyArray<string>;
	readonly player?: string;
	readonly at?: Square;
}

export interface FfMap {
	readonly id: string;
	readonly name: string;
	readonly terrain: ReadonlyArray<string>;
	readonly dressing?: ReadonlyArray<string>;
}

export interface FfOrder {
	readonly ids: ReadonlyArray<string>;
	readonly turn: number;
	readonly round: number;
}

export interface FfState {
	readonly figures: ReadonlyArray<FfFigure>;
	readonly map?: FfMap;
	readonly order?: FfOrder;
}

export const initial: FfState = { figures: [] };

export const ADD_MAX = 12;

export const DEFAULT_DICE = "d20";

export const findFigure = (slice: FfState, id: string): FfFigure | undefined =>
	slice.figures.find((f) => f.id === id);

export const figureOf = (slice: FfState, actor: string): FfFigure | undefined =>
	slice.figures.find((f) => f.player === actor);

export const controls = (actor: string, f: FfFigure): boolean =>
	actor === GM || (f.player !== undefined && f.player === actor);

export const mapSide = (f: FfFigure): "heroes" | "director" =>
	f.side === "party" ? "heroes" : "director";

export const actingId = (order: FfOrder | undefined): string | undefined =>
	order === undefined || order.turn < 0 ? undefined : order.ids[order.turn];

export const valuesOf = (
	sheet: FfSheet,
	was?: Pick<FfFigure, "sheet" | "values">
): Readonly<Record<string, number>> => {
	const held = was?.values ?? {};
	const before = was?.sheet.stats ?? {};

	const stats = Object.entries(sheet.stats ?? {}).map(
		([key, value]): readonly [string, number] => [
			key,
			Object.hasOwn(held, key) && before[key] === value
				? (held[key] ?? value)
				: value,
		]
	);

	const resources = Object.entries(sheet.resources ?? {}).map(
		([key, max]): readonly [string, number] => [
			key,
			Object.hasOwn(held, key) ? Math.min(max, held[key] ?? max) : max,
		]
	);

	return Object.fromEntries([...stats, ...resources]);
};

export const maxOf = (f: FfFigure, key: string): number | undefined => {
	const resources = f.sheet.resources ?? {};

	return Object.hasOwn(resources, key) ? resources[key] : undefined;
};

export const valueOf = (f: FfFigure, key: string): number | undefined =>
	Object.hasOwn(f.values, key) ? f.values[key] : undefined;

export const marksOf = (
	figures: ReadonlyArray<FfFigure>
): ReadonlyMap<string, string> => {
	const taken = new Set<string>();
	const marks = new Map<string, string>();
	const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";

	for (const f of figures) {
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

export const resolveFigure = (
	slice: FfState,
	typed: string
): FfFigure | Refused => {
	const q = typed.trim().toLowerCase();

	const exact = slice.figures.find(
		(f) => f.id === q || f.name.toLowerCase() === q
	);

	if (exact !== undefined) {
		return exact;
	}

	for (const [id, mark] of marksOf(slice.figures)) {
		const marked = mark === typed.trim() ? findFigure(slice, id) : undefined;

		if (marked !== undefined) {
			return marked;
		}
	}

	return pick(
		slice.figures,
		(f) => [f.id, f.name],
		(f) => f.name,
		typed,
		`Nobody at the table is called '${quote(typed)}'.`
	);
};

export const completeFigures = (
	slice: FfState,
	partial: string,
	actor: string,
	keep: (f: FfFigure) => boolean = () => true
): Array<string> => {
	const own = figureOf(slice, actor)?.id;
	const shown = slice.figures.filter(keep);

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
	(slice: FfState, except?: string): Occupants =>
	(square) => {
		const there = slice.figures.find(
			(f) =>
				f.id !== except &&
				f.at !== undefined &&
				f.at.x === square.x &&
				f.at.y === square.y
		);

		return there === undefined
			? undefined
			: { id: there.id, side: mapSide(there) };
	};

export const freeIds = (
	slice: FfState,
	base: string,
	count: number
): ReadonlyArray<string> => {
	const taken = new Set(slice.figures.map((f) => f.id));

	if (count === 1 && !taken.has(base)) {
		return [base];
	}

	const ids: Array<string> = [];

	for (let n = 1; ids.length < count; n += 1) {
		const id = `${base}-${n}`;

		if (!taken.has(id)) {
			ids.push(id);
		}
	}

	return ids;
};
