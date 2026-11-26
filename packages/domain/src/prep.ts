import type { EncounterSpec } from "./party.ts";
import { ifDefined, listIf, listIfDefined, orEmpty } from "./present.ts";
import { MAP_KINDS } from "./rules/board/grid.ts";
import { trackerLabelWords } from "./rules/core/stage.ts";

export interface PrepEntry {
	readonly id: string;
	readonly name: string;
}

export interface PrepScene extends PrepEntry {
	readonly encounter?: EncounterSpec;
}

export interface PrepTracker {
	readonly id: string;
	readonly label: string;
	readonly kind: "clock" | "counter" | "quest";
	readonly max?: number;
	readonly value?: number;
	readonly scene?: string;
}

export interface PrepCatalog {
	readonly heroes: ReadonlyArray<PrepEntry>;
	readonly monsters: ReadonlyArray<PrepEntry>;
	readonly maps: ReadonlyArray<PrepEntry>;
	readonly scenes?: ReadonlyArray<PrepScene>;
	readonly npcs?: ReadonlyArray<PrepEntry>;
	readonly handouts?: ReadonlyArray<PrepEntry>;
	readonly items?: ReadonlyArray<PrepEntry>;
	readonly trackers?: ReadonlyArray<PrepTracker>;
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
	readonly lines?: ReadonlyArray<string>;
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

export interface StagePrepInput {
	readonly cards: Readonly<Record<string, { readonly tier: string }>>;
	readonly trackers: ReadonlyArray<{ readonly id: string }>;
}

const cardItems = (
	stage: StagePrepInput,
	kind: string,
	entry: PrepEntry
): ReadonlyArray<PrepItem> => {
	const key = `${kind}:${entry.id}`;
	const shown = stage.cards[key];

	if (shown === undefined) {
		return [
			{ kind: "send", label: `Show ${entry.name}`, line: `/show ${key}` },
			{ kind: "send", label: `Codex ${entry.name}`, line: `/reveal ${key}` },
		];
	}

	return [
		...listIf(shown.tier !== "on-table", () => [
			{
				kind: "send" as const,
				label: `Show ${entry.name}`,
				line: `/show ${key}`,
			},
		]),
		{
			kind: "send",
			label: `Hide ${entry.name}`,
			line: `/hide ${key}`,
			note: shown.tier === "on-table" ? "on the table" : "in the codex",
		},
	];
};

const fightItem = (
	scene: PrepScene,
	fightLines: (encounter: EncounterSpec) => ReadonlyArray<string>
): ReadonlyArray<PrepItem> => {
	const lines =
		scene.encounter === undefined ? [] : fightLines(scene.encounter);

	const [first] = lines;

	return first === undefined
		? []
		: [
				{
					kind: "send",
					label: `Start fight: ${scene.name}`,
					line: first,
					lines,
				},
			];
};

const trackerLine = (t: PrepTracker): string =>
	[
		`/tracker ${t.id} ${t.kind}`,
		...listIfDefined(t.max, (max) => [String(max)]),
		...listIfDefined(t.value, (value) => [`=${value}`]),
		trackerLabelWords(t.label),
	].join(" ");

export const prepStage = (
	stage: StagePrepInput,
	catalog: PrepCatalog,
	fightLines: (encounter: EncounterSpec) => ReadonlyArray<string>
): ReadonlyArray<PrepSection> => {
	const kinds = [
		["scenes", "scene", orEmpty(catalog.scenes)],
		["npcs", "npc", orEmpty(catalog.npcs)],
		["handouts", "handout", orEmpty(catalog.handouts)],
		["items", "item", orEmpty(catalog.items)],
	] as const;

	const sections = kinds.flatMap(
		([title, kind, entries]): ReadonlyArray<PrepSection> =>
			entries.length === 0
				? []
				: [
						{
							title,
							items: entries.flatMap((entry) => [
								...cardItems(stage, kind, entry),
								...listIf(kind === "scene", () => fightItem(entry, fightLines)),
							]),
						},
					]
	);

	const tracked = new Set(stage.trackers.map((t) => t.id));
	const trackers = orEmpty(catalog.trackers).filter((t) => !tracked.has(t.id));

	return [
		...sections,
		...listIf(trackers.length > 0, () => [
			{
				title: "trackers",
				items: trackers.map((t): PrepItem => ({
					kind: "send",
					label: `Track ${t.label}`,
					line: trackerLine(t),
				})),
			},
		]),
	];
};
