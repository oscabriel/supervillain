import { ifDefined, listIf } from "./present.ts";
import { MAP_KINDS } from "./rules/board/grid.ts";

export interface PrepEntry {
	readonly id: string;
	readonly name: string;
}

export interface PrepCatalog {
	readonly heroes: ReadonlyArray<PrepEntry>;
	readonly monsters: ReadonlyArray<PrepEntry>;
	readonly maps: ReadonlyArray<PrepEntry>;
}

export type PrepSide = "heroes" | "director";

export interface PrepFigure {
	readonly id: string;
	readonly side: PrepSide;
}

export type PrepKind = "send" | "fill" | "count";

export interface PrepItem {
	readonly kind: PrepKind;
	readonly label: string;
	readonly line: string;
	readonly note?: string;
	readonly max?: number;
	readonly figure?: PrepFigure;
}

export interface PrepSection {
	readonly title: string;
	readonly items: ReadonlyArray<PrepItem>;
	readonly note?: string;
	readonly all?: ReadonlyArray<string>;
}

export interface PrepToken {
	readonly id: string;
	readonly name: string;
	readonly figure: PrepFigure;
}

export interface PrepStep {
	readonly label: string;
	readonly done: boolean;
}

export interface PrepMaps {
	readonly loaded?: { readonly name: string; readonly again?: string };
	readonly items: ReadonlyArray<PrepItem>;
}

export interface PrepView {
	readonly steps: ReadonlyArray<PrepStep>;
	readonly maps: PrepMaps;
	readonly place: ReadonlyArray<PrepToken>;
	readonly sections: ReadonlyArray<PrepSection>;
	readonly start: { readonly line: string } | { readonly note: string };
}

const GENERATED = new RegExp(`^(?<kind>${MAP_KINDS.join("|")})-\\d+$`, "u");

export const prepMaps = (
	catalog: PrepCatalog,
	loaded: { readonly id: string; readonly name: string } | undefined
): PrepMaps => {
	const kind =
		loaded === undefined ? undefined : GENERATED.exec(loaded.id)?.groups?.kind;

	return {
		...ifDefined(loaded, (value) => ({
			loaded: {
				name: value.name,
				...ifDefined(kind, (k) => ({ again: `/map new ${k}` })),
			},
		})),
		items: [
			...catalog.maps
				.filter((m) => m.id !== loaded?.id)
				.map((m): PrepItem => ({
					kind: "send",
					label: m.name,
					line: `/map ${m.id}`,
				})),
			...listIf(loaded !== undefined, () => [
				{ kind: "send" as const, label: "Put away", line: "/map off" },
			]),
			...MAP_KINDS.map((k): PrepItem => ({
				kind: "send",
				label: `New ${k}`,
				line: `/map new ${k}`,
			})),
			{ kind: "fill", label: "New, by seed", line: "/map new " },
		],
	};
};

export const prepSteps = (
	mapLoaded: boolean,
	people: ReadonlyArray<{ readonly side: PrepSide; readonly placed: boolean }>
): ReadonlyArray<PrepStep> => {
	const side = (s: PrepSide) => {
		const of = people.filter((p) => p.side === s);

		return of.length > 0 && of.every((p) => p.placed);
	};

	return [
		{ label: "map", done: mapLoaded },
		{ label: "party", done: side("heroes") },
		{ label: "foes", done: side("director") },
	];
};

export const partyFirst = (
	tokens: ReadonlyArray<PrepToken>
): ReadonlyArray<PrepToken> => [
	...tokens.filter((t) => t.figure.side === "heroes"),
	...tokens.filter((t) => t.figure.side !== "heroes"),
];
