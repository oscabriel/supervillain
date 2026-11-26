import {
	charsOf,
	ifDefined,
	listIf,
	listIfDefined,
} from "@supervillain/domain";

import { mapRowsWanted } from "./map.ts";
import { clip, proseLines, wrap } from "./prose.ts";
import type { ProseLine } from "./prose.ts";
import type {
	CodexEntry,
	MapGrid,
	MapView,
	Prose,
	StageCardView,
	StageView,
	TrackerView,
} from "./view.ts";

export type Peek = "stage" | "board";

export const STAGE_FRAME = { width: 5, height: 2 } as const;

export const CARD_FRAME = { width: 4, height: 2 } as const;

export const RECAP_SHOWN = 3;

export const PINNED_COLUMN_MIN = 38;

export const CARD_MAP_MOST = 14;

export const hasStage = (stage: StageView | undefined): boolean =>
	stage !== undefined &&
	(stage.scene !== undefined ||
		stage.pinned.length > 0 ||
		stage.trackers.length > 0 ||
		stage.recap.length > 0);

export interface CampaignInput {
	readonly stage: StageView | undefined;
	readonly mapLoaded: boolean;
	readonly peek: Peek | undefined;
	readonly prepping: boolean;
}

export const campaignShown = (input: CampaignInput): boolean => {
	const { stage } = input;

	if (stage === undefined || input.peek === "board") {
		return false;
	}

	if (input.peek === "stage") {
		return true;
	}

	if (stage.mode === "encounter" || !hasStage(stage)) {
		return false;
	}

	return !input.mapLoaded || stage.override || !input.prepping;
};

export const gridView = (grid: MapGrid): MapView => ({
	name: grid.name,
	width: Math.max(0, ...grid.terrain.map((row) => charsOf(row).length)),
	height: grid.terrain.length,
	terrain: grid.terrain,
	...ifDefined(grid.dressing, (dressing) => ({ dressing })),
	tokens: [],
	reach: [],
});

export interface CardPlan {
	readonly card: StageCardView;
	readonly head: string;
	readonly tags?: string;
	readonly readAloud: ReadonlyArray<ProseLine>;
	readonly body: ReadonlyArray<ProseLine>;
	readonly art: ReadonlyArray<string>;
	readonly map?: MapView;
	readonly mapRows: number;
	readonly notes: ReadonlyArray<ProseLine>;
	readonly height: number;
}

const boxed = (lines: ReadonlyArray<unknown>): number =>
	lines.length === 0 ? 0 : lines.length + 2;

export const cardPlan = (
	card: StageCardView,
	width: number,
	notes?: Prose
): CardPlan => {
	const inner = Math.max(8, width - CARD_FRAME.width);

	const head = clip(
		card.subtitle === undefined
			? card.title
			: `${card.title} — ${card.subtitle}`,
		inner
	);

	const tags =
		card.tags.length === 0 ? undefined : clip(card.tags.join(" · "), inner);

	const readAloud =
		card.readAloud === undefined ? [] : proseLines(card.readAloud, inner - 4);

	const body = proseLines(card.body, inner);
	const art = (card.art ?? []).map((line) => clip(line, inner));
	const map = card.map === undefined ? undefined : gridView(card.map);

	const mapRows =
		map === undefined ? 0 : Math.min(CARD_MAP_MOST, mapRowsWanted(map));

	const told = notes === undefined ? [] : proseLines(notes, inner - 4);

	const parts = [
		1,
		tags === undefined ? 0 : 1,
		boxed(readAloud),
		body.length,
		art.length,
		mapRows,
		boxed(told),
	];

	const gaps = parts.slice(2).filter((n) => n > 0).length;

	return {
		card,
		head,
		...ifDefined(tags, (value) => ({ tags: value })),
		readAloud,
		body,
		art,
		...ifDefined(map, (value) => ({ map: value })),
		mapRows,
		notes: told,
		height: parts.reduce((a, b) => a + b, 0) + gaps + CARD_FRAME.height,
	};
};

export const pinnedColumns = (width: number): 1 | 2 =>
	width >= PINNED_COLUMN_MIN * 2 ? 2 : 1;

export const rowsOfCards = <A>(
	cards: ReadonlyArray<A>,
	columns: 1 | 2
): ReadonlyArray<ReadonlyArray<A>> =>
	columns === 1
		? cards.map((c) => [c])
		: Array.from({ length: Math.ceil(cards.length / 2) }, (_, i) =>
				cards.slice(i * 2, i * 2 + 2)
			);

const QUARTERS = ["○", "◔", "◑", "◕", "●"] as const;

export const clockFace = (value: number, max: number): string => {
	const share = max <= 0 ? 0 : Math.max(0, Math.min(1, value / max));

	return QUARTERS[Math.round(share * 4)] ?? "○";
};

export const clockSegments = (value: number, max: number): string =>
	Array.from({ length: max }, (_, i) => (i < value ? "●" : "○")).join("");

const SEGMENTS_MOST = 12;

export const trackerText = (t: TrackerView): string => {
	const hidden = t.hidden ? " (only you)" : "";

	if (t.kind === "clock" && t.max !== undefined) {
		const segments =
			t.max <= SEGMENTS_MOST ? ` ${clockSegments(t.value, t.max)}` : "";

		return `${clockFace(t.value, t.max)} ${t.label}${segments} ${t.value}/${t.max}${hidden}`;
	}

	if (t.kind === "quest") {
		const done = t.max !== undefined && t.value >= t.max;
		const of = t.max === undefined ? `${t.value}` : `${t.value}/${t.max}`;

		return `${done ? "✓" : "◇"} ${t.label} ${of}${hidden}`;
	}

	const of = t.max === undefined ? `${t.value}` : `${t.value}/${t.max}`;

	return `# ${t.label} ${of}${hidden}`;
};

export const trackerLines = (
	trackers: ReadonlyArray<TrackerView>,
	width: number
): ReadonlyArray<string> => {
	const lines: Array<string> = [];
	let current = "";

	for (const text of trackers.map((t) => clip(trackerText(t), width))) {
		const joined = current === "" ? text : `${current}   ${text}`;

		if (Bun.stringWidth(joined) <= width) {
			current = joined;
		} else {
			lines.push(current);
			current = text;
		}
	}

	return current === "" ? lines : [...lines, current];
};

export const recapLines = (
	stage: StageView,
	width: number
): ReadonlyArray<string> =>
	stage.recap
		.slice(-RECAP_SHOWN)
		.flatMap((r) =>
			wrap(r.text, width - 2).map((line, i) => `${i === 0 ? "•" : " "} ${line}`)
		);

export interface StagePlan {
	readonly scene?: CardPlan;
	readonly pinned: ReadonlyArray<ReadonlyArray<CardPlan>>;
	readonly trackers: ReadonlyArray<string>;
	readonly recap: ReadonlyArray<string>;
	readonly rows: number;
}

const rowHeight = (row: ReadonlyArray<CardPlan>): number =>
	Math.max(0, ...row.map((c) => c.height));

export const stagePlan = (
	stage: StageView,
	width: number,
	notes?: (key: string) => Prose | undefined
): StagePlan => {
	const inner = Math.max(10, width - STAGE_FRAME.width);
	const columns = pinnedColumns(inner);
	const cardWidth = columns === 1 ? inner : Math.floor((inner - 1) / 2);

	const scene =
		stage.scene === undefined
			? undefined
			: cardPlan(stage.scene, inner, notes?.(stage.scene.key));

	const pinned = rowsOfCards(
		stage.pinned.map((c) => cardPlan(c, cardWidth, notes?.(c.key))),
		columns
	);

	const trackers = trackerLines(stage.trackers, inner);
	const recap = recapLines(stage, inner);

	const rows =
		(stage.codex.length > 0 ? 1 : 0) +
		(scene?.height ?? 0) +
		pinned.reduce((n, row) => n + rowHeight(row), 0) +
		(trackers.length === 0 ? 0 : trackers.length + 1) +
		(recap.length === 0 ? 0 : recap.length + 1);

	return {
		...ifDefined(scene, (value) => ({ scene: value })),
		pinned,
		trackers,
		recap,
		rows,
	};
};

export const stageWanted = (plan: StagePlan): number =>
	Math.max(3, plan.rows) + STAGE_FRAME.height;

const KIND_MARK: Readonly<Record<CodexEntry["kind"], string>> = {
	scene: "◈",
	npc: "☺",
	handout: "✉",
	item: "◆",
	ancestry: "◇",
	class: "◇",
	ability: "✦",
	party: "●",
	monster: "▲",
};

export const codexLabel = (entry: CodexEntry, width: number): string => {
	const where = entry.tier === "on-table" ? "  on the table" : "";
	const sub = entry.subtitle === undefined ? "" : ` — ${entry.subtitle}`;
	const lead = `${KIND_MARK[entry.kind]} `;

	return `${clip(`${lead}${entry.title}${sub}`, Math.max(1, width - Bun.stringWidth(where)))}${where}`;
};

export const codexFind = (
	codex: ReadonlyArray<CodexEntry>,
	typed: string
): CodexEntry | undefined => {
	const wanted = typed.trim().toLowerCase();

	return (
		codex.find((e) => e.key === wanted) ??
		codex.find((e) => e.key.slice(e.kind.length + 1) === wanted) ??
		codex.find((e) => e.title.toLowerCase() === wanted)
	);
};

export const stageTitle = (stage: StageView): string =>
	[
		" stage",
		...listIfDefined(stage.scene, (s) => [` · ${s.title}`]),
		...listIf(stage.codex.length > 0, () => [` · codex ${stage.codex.length}`]),
		" ",
	].join("");

export interface CodexState {
	readonly key?: string;
}

export const codexWanted = (
	stage: StageView,
	codex: CodexState,
	width: number,
	notes?: (key: string) => Prose | undefined
): number => {
	const inner = width - STAGE_FRAME.width;

	const entry =
		codex.key === undefined
			? undefined
			: stage.codex.find((e) => e.key === codex.key);

	const card =
		entry === undefined
			? 0
			: cardPlan(entry.card, inner, notes?.(entry.key)).height + 1;

	return 1 + stage.codex.length + card + STAGE_FRAME.height;
};
