import type { PartyMember } from "./party.ts";
import { ifDefined, listIf, listIfDefined } from "./present.ts";
import { proseLines } from "./prose.ts";
import type { Prose } from "./prose.ts";
import { inCombatAny } from "./rules/compose.ts";
import type { TableState } from "./rules/compose.ts";
import { GM } from "./rules/core/module.ts";
import { modeOf, stagedRef } from "./rules/core/stage.ts";
import type {
	CardKind,
	Recap,
	StageCard,
	StagedCard,
	StageMode,
	StageState,
	Tier,
	TrackerKind,
} from "./rules/core/stage.ts";
import { isRefused } from "./rules/engine.ts";
import type { Refused } from "./rules/engine.ts";
import { RULESETS } from "./Ruleset.ts";
import type { RulesetName, TableView } from "./Ruleset.ts";

export type StageInput = TableView & Pick<TableState, "stage">;

export interface StageCardView {
	readonly key: string;
	readonly kind: CardKind;
	readonly title: string;
	readonly subtitle?: string;
	readonly readAloud?: Prose;
	readonly body: Prose;
	readonly art?: ReadonlyArray<string>;
	readonly map?: StageCard["map"];
	readonly tags: ReadonlyArray<string>;
	readonly tier: Tier;
	readonly since: number;
}

export interface CodexEntry {
	readonly key: string;
	readonly kind: CardKind;
	readonly title: string;
	readonly subtitle?: string;
	readonly tier: Tier;
	readonly card: StageCardView;
}

export interface TrackerView {
	readonly id: string;
	readonly label: string;
	readonly kind: TrackerKind;
	readonly value: number;
	readonly max?: number;
	readonly hidden: boolean;
}

export interface StageView {
	readonly mode: StageMode;
	readonly override: boolean;
	readonly combat: boolean;
	readonly scene?: StageCardView;
	readonly pinned: ReadonlyArray<StageCardView>;
	readonly codex: ReadonlyArray<CodexEntry>;
	readonly trackers: ReadonlyArray<TrackerView>;
	readonly recap: ReadonlyArray<Recap>;
	readonly party: ReadonlyArray<PartyMember>;
}

export const stageModeOf = (
	state: Pick<TableState, "ds" | "sw" | "pf" | "ff" | "stage">
): StageMode => modeOf(state.stage, inCombatAny(state));

const cardView = (staged: StagedCard): StageCardView => {
	const { card } = staged;

	return {
		key: card.key,
		kind: card.kind,
		title: card.title,
		...ifDefined(card.subtitle, (subtitle) => ({ subtitle })),
		...ifDefined(card.readAloud, (readAloud) => ({ readAloud })),
		body: card.body,
		...ifDefined(card.art, (art) => ({ art })),
		...ifDefined(card.map, (map) => ({ map })),
		tags: card.tags ?? [],
		tier: staged.tier,
		since: staged.since,
	};
};

const bySince = (a: StagedCard, b: StagedCard): number => a.since - b.since;

const byTitle = (a: CodexEntry, b: CodexEntry): number =>
	a.kind === b.kind
		? a.title.localeCompare(b.title)
		: a.kind.localeCompare(b.kind);

const shownStage = (stage: StageState) => Object.values(stage.cards);

export const stageOf = (
	state: StageInput,
	actor: string,
	ruleset: RulesetName
): StageView => {
	const { stage } = state;
	const combat = inCombatAny(state);
	const staged = shownStage(stage);

	const scene =
		stage.scene === undefined ? undefined : stage.cards[stage.scene];

	return {
		mode: modeOf(stage, combat),
		override: stage.override !== undefined && stage.override.combat === combat,
		combat,
		...ifDefined(scene?.tier === "on-table" ? scene : undefined, (s) => ({
			scene: cardView(s),
		})),
		pinned: staged
			.filter((s) => s.tier === "on-table" && s.card.key !== stage.scene)
			.toSorted(bySince)
			.map(cardView),
		codex: staged
			.map((s): CodexEntry => ({
				key: s.card.key,
				kind: s.card.kind,
				title: s.card.title,
				...ifDefined(s.card.subtitle, (subtitle) => ({ subtitle })),
				tier: s.tier,
				card: cardView(s),
			}))
			.toSorted(byTitle),
		trackers: stage.trackers
			.filter((t) => actor === GM || t.tier === "revealed")
			.map((t): TrackerView => ({
				id: t.id,
				label: t.label,
				kind: t.kind,
				value: t.value,
				...ifDefined(t.max, (max) => ({ max })),
				hidden: t.tier === "gm-only",
			})),
		recap: stage.recap.map((r) => ({ seq: r.seq, text: r.text })),
		party: RULESETS[ruleset].party(state, actor),
	};
};

export const cardLines = (card: StageCard): ReadonlyArray<string> => [
	[card.title, ...listIfDefined(card.subtitle, (s) => [`— ${s}`])].join(" "),
	...listIfDefined(card.readAloud, (prose) =>
		prose.length === 0 ? [] : ["", ...proseLines(prose).map((l) => `“ ${l}`)]
	),
	...listIf(card.body.length > 0, () => ["", ...proseLines(card.body)]),
	...listIfDefined(card.art, (art) => (art.length === 0 ? [] : ["", ...art])),
	...listIfDefined(card.tags, (tags) =>
		tags.length === 0 ? [] : ["", `Tags: ${tags.join(", ")}`]
	),
];

export const codexText = (
	state: Pick<TableState, "stage">,
	ref: string | undefined
): string | Refused => {
	if (ref !== undefined) {
		const staged = stagedRef(state.stage, ref);

		return isRefused(staged) ? staged : cardLines(staged.card).join("\n");
	}

	const all = shownStage(state.stage).toSorted(bySince);

	if (all.length === 0) {
		return "The codex is empty: the GM hasn't shown the table anything yet.";
	}

	return [
		"The codex: /codex <card> reads one.",
		...all.map(
			(s) =>
				`${s.card.key.padEnd(24)}  ${s.card.title}${s.tier === "on-table" ? " (on the table)" : ""}`
		),
	].join("\n");
};

export const stagedCardOf = (
	state: Pick<TableState, "stage">,
	ref: string
): StageCard | undefined => {
	const staged = stagedRef(state.stage, ref);

	return isRefused(staged) ? undefined : staged.card;
};
