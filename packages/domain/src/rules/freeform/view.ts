import type { TokenAction } from "../../actions.ts";
import { playerOf } from "../../party.ts";
import type { EncounterSpec, PartyMember } from "../../party.ts";
import { partyFirst, prepMaps, prepSteps } from "../../prep.ts";
import type { PrepCatalog, PrepItem, PrepView } from "../../prep.ts";
import { ifDefined, listIf, listIfDefined, when } from "../../present.ts";
import { proseLines } from "../../prose.ts";
import type { MapToken, MapView } from "../board/view.ts";
import type { Combatant, CombatView } from "../drawSteel/view.ts";
import { isRefused } from "../engine.ts";
import type { Refused } from "../engine.ts";
import {
	actingId,
	ADD_MAX,
	controls,
	DEFAULT_DICE,
	figureOf,
	findFigure,
	mapSide,
	marksOf,
	maxOf,
	resolveFigure,
} from "./state.ts";
import type { FfFigure, FfState } from "./state.ts";

const resourceOf = (
	f: FfFigure
):
	| { readonly key: string; readonly value: number; readonly max: number }
	| undefined => {
	const [key] = Object.keys(f.sheet.resources ?? {});
	const max = key === undefined ? undefined : maxOf(f, key);

	return key === undefined || max === undefined
		? undefined
		: { key, value: f.values[key] ?? 0, max };
};

const statsText = (f: FfFigure): string =>
	Object.keys(f.sheet.stats ?? {})
		.map((key) => `${key} ${f.values[key] ?? 0}`)
		.join(" · ");

const isDown = (f: FfFigure): boolean => {
	const resource = resourceOf(f);

	return resource !== undefined && resource.max > 0 && resource.value <= 0;
};

export const ffBand = (
	slice: FfState,
	actor: string,
	labelOf?: (actor: string) => string
): CombatView | undefined => {
	const { order } = slice;

	if (order === undefined && !slice.figures.some((f) => f.side === "party")) {
		return undefined;
	}

	const marks = slice.map === undefined ? undefined : marksOf(slice.figures);
	const acting = actingId(order);

	const shown =
		order === undefined
			? slice.figures.filter((f) => f.side === "party")
			: order.ids.flatMap((id) =>
					listIfDefined(findFigure(slice, id), (f) => [f])
				);

	const combatant = (f: FfFigure): Combatant => {
		const resource = resourceOf(f);

		const player =
			f.player !== undefined && f.player !== actor
				? labelOf?.(f.player)
				: undefined;

		const mark = f.at === undefined ? undefined : marks?.get(f.id);
		const at = order?.ids.indexOf(f.id) ?? -1;

		return {
			id: f.id,
			name: player === undefined ? f.name : `${f.name} (${player})`,
			side: mapSide(f),
			stamina: resource?.value ?? 0,
			max: resource?.max ?? 0,
			temp: 0,
			...when(isDown(f), () => ({ health: "dead" as const })),
			conditions: f.tags,
			resource: [statsText(f), f.sheet.concept ?? ""]
				.filter((t) => t !== "")
				.join(" · "),
			acted: order !== undefined && at >= 0 && at < order.turn,
			acting: acting === f.id,
			mine: f.player === actor,
			...when(f.side === "party" && f.player === undefined, () => ({
				free: true,
			})),
			...ifDefined(mark, (value) => ({ mark: value })),
		};
	};

	const turn = acting === undefined ? undefined : findFigure(slice, acting);
	const turnText = turn === undefined ? "" : `: ${turn.name}`;

	return {
		round: order?.round ?? 0,
		active: order !== undefined,
		malice: 0,
		heroTokens: 0,
		title:
			order === undefined ? " party " : ` round ${order.round}${turnText} `,
		combatants: shown.map(combatant),
	};
};

export const ffMap = (slice: FfState, actor: string): MapView | undefined => {
	const { map } = slice;

	if (map === undefined) {
		return undefined;
	}

	const marks = marksOf(slice.figures);
	const acting = actingId(slice.order);

	const tokens = slice.figures.flatMap((f): Array<MapToken> =>
		f.at === undefined
			? []
			: [
					{
						id: f.id,
						mark: marks.get(f.id) ?? "??",
						name: f.name,
						x: f.at.x,
						y: f.at.y,
						side: mapSide(f),
						mine: f.player === actor,
						acting: acting === f.id,
						dead: isDown(f),
					},
				]
	);

	return {
		name: map.name,
		width: map.terrain[0]?.length ?? 0,
		height: map.terrain.length,
		terrain: map.terrain,
		...ifDefined(map.dressing, (value) => ({ dressing: value })),
		tokens: [...tokens.filter((t) => t.dead), ...tokens.filter((t) => !t.dead)],
		reach: [],
	};
};

export const ffSheetLines = (f: FfFigure): ReadonlyArray<string> => {
	const { sheet } = f;

	const head = [
		sheet.name,
		...listIfDefined(sheet.pronouns, (p) => [`(${p})`]),
		...listIfDefined(sheet.concept, (c) => [`· ${c}`]),
	].join(" ");

	const stats = Object.keys(sheet.stats ?? {}).map(
		(key) => `${key} ${f.values[key] ?? 0}`
	);

	const resources = Object.entries(sheet.resources ?? {}).map(
		([key, max]) => `${key} ${f.values[key] ?? 0}/${max}`
	);

	return [
		`${head} · ${f.side === "party" ? "of the party" : "a foe"}`,
		...listIf(stats.length > 0, () => [`Stats: ${stats.join(", ")}`]),
		...listIf(resources.length > 0, () => [
			`Resources: ${resources.join(", ")}`,
		]),
		`Checks roll ${sheet.dice ?? DEFAULT_DICE} plus the stat.`,
		...listIf(f.tags.length > 0, () => [`Tags: ${f.tags.join(", ")}`]),
		...listIfDefined(sheet.notes, (notes) =>
			notes.length === 0 ? [] : ["", ...proseLines(notes)]
		),
	];
};

export const ffSheet = (slice: FfState, typed: string): string | Refused => {
	const f = resolveFigure(slice, typed);

	return isRefused(f) ? f : ffSheetLines(f).join("\n");
};

export const withFigures =
	(slice: FfState, labelOf: (actor: string) => string) =>
	(actor: string): string => {
		const own = figureOf(slice, actor);

		return own === undefined
			? labelOf(actor)
			: `${labelOf(actor)} (${own.name})`;
	};

export const ffActions = (
	slice: FfState,
	actor: string,
	id: string
): ReadonlyArray<TokenAction> | undefined => {
	const f = findFigure(slice, id);

	if (f === undefined || !controls(actor, f)) {
		return undefined;
	}

	const spot: TokenAction =
		f.at === undefined
			? { label: "Place", pick: "square", line: `/place ${f.id}` }
			: { label: "Move", pick: "square", line: `/move ${f.id}` };

	const board: ReadonlyArray<TokenAction> =
		slice.map === undefined ? [] : [spot];

	return [
		...board,
		...listIf(actingId(slice.order) === f.id, () => [
			{ label: "Next", pick: "none" as const, line: "/next" },
		]),
	];
};

export const ffPrep = (slice: FfState, catalog: PrepCatalog): PrepView => {
	const inPlay = new Set(slice.figures.map((f) => f.id));
	const party = slice.figures.filter((f) => f.side === "party").length;
	const foes = slice.figures.length - party;

	const added = (id: string) =>
		slice.figures.filter((f) => f.sheet.id === id && f.side === "foes").length;

	return {
		steps: prepSteps(
			slice.map !== undefined,
			slice.figures.map((f) => ({
				side: mapSide(f),
				placed: f.at !== undefined,
			}))
		),
		maps: prepMaps(catalog, slice.map),
		place:
			slice.map === undefined
				? []
				: partyFirst(
						slice.figures
							.filter((f) => f.at === undefined)
							.map((f) => ({
								id: f.id,
								name: f.name,
								figure: { id: f.id, side: mapSide(f) },
							}))
					),
		sections: [
			{
				title: "party",
				items: catalog.heroes
					.filter((h) => !inPlay.has(h.id))
					.map((h): PrepItem => ({
						kind: "send",
						label: h.name,
						line: `/pc ${h.id}`,
					})),
				note: `${party} in the party`,
				all: catalog.heroes
					.filter((h) => !inPlay.has(h.id))
					.map((h) => `/pc ${h.id}`),
			},
			{
				title: "foes",
				items: catalog.monsters.map((m): PrepItem => {
					const n = added(m.id);

					return {
						kind: "count",
						label: m.name,
						line: `/add ${m.id}`,
						max: ADD_MAX,
						figure: { id: m.id, side: "director" },
						...when(n > 0, () => ({ note: `×${n}` })),
					};
				}),
				note: `${foes} ${foes === 1 ? "foe" : "foes"}`,
			},
		],
		start:
			slice.order === undefined
				? { line: "/start" }
				: { note: "turns are going" },
	};
};

export const ffParty = (
	slice: FfState,
	actor: string,
	label: (actor: string) => string
): ReadonlyArray<PartyMember> =>
	slice.figures
		.filter((f) => f.side === "party")
		.map((f): PartyMember => {
			const resource = resourceOf(f);

			return {
				id: f.id,
				name: f.name,
				...playerOf(f.player, actor, label),
				mine: f.player === actor,
				free: f.player === undefined,
				down: isDown(f),
				...ifDefined(resource, (r) => ({
					health: { label: r.key, value: r.value, max: r.max },
				})),
				summary: [f.sheet.concept ?? "", statsText(f)]
					.filter((t) => t !== "")
					.join(" · "),
				tags: f.tags,
			};
		});

export const ffFightLines = (
	encounter: EncounterSpec
): ReadonlyArray<string> => [
	...listIfDefined(encounter.map, (id) => [`/map ${id}`]),
	...encounter.monsters.map((m) =>
		(m.count ?? 1) === 1 ? `/add ${m.id}` : `/add ${m.count ?? 1} ${m.id}`
	),
];

export const ffResyncLines = (
	slice: FfState,
	changed: ReadonlyArray<string>
): ReadonlyArray<string> =>
	slice.figures
		.filter((f) => f.side === "party" && changed.includes(f.id))
		.map((f) => `/pc ${f.id}`);
