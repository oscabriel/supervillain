import {
	bandOf,
	feedLines,
	GM,
	mapOf,
	nameOf,
	partyOf,
	prepOf,
	shortFingerprint,
	stageOf,
	tableLabel,
} from "@supervillain/domain";
import type {
	CombatView,
	MapView,
	PartyMember,
	PrepCatalog,
	PrepView,
	RulesetName,
	StageView,
	TableState,
} from "@supervillain/domain";
import type { Line } from "@supervillain/platform-jsonl";
import { DateTime, Effect, Option } from "effect";

import { CampaignContent, gmNotesFor, keyedDocs } from "../content/index.ts";
import type { ContentIndex } from "../content/index.ts";
import { shownState } from "../host/check.ts";
import type { ShownState } from "../host/check.ts";
import { ContentWatch } from "../host/ContentWatch.ts";
import { Knocks } from "../host/Knocks.ts";
import type { Knock } from "../host/Knocks.ts";
import { Presence } from "../host/Presence.ts";
import { TableRoom } from "../host/TableRoom.ts";
import type { McpSeat } from "./seat.ts";

export const FEED_DEFAULT = 50;

export const FEED_MOST = 500;

export interface ViewLine {
	readonly seq: number;
	readonly who: string;
	readonly kind: string;
	readonly text: string;
}

export const feedOf = (
	state: TableState,
	ruleset: RulesetName,
	after = 0,
	limit = FEED_MOST
): ReadonlyArray<ViewLine> =>
	feedLines(state, tableLabel(state, ruleset))
		.filter((line) => line.seq > after)
		.slice(-Math.max(0, Math.min(limit, FEED_MOST)))
		.map(({ seq, who, kind, text }) => ({ seq, who, kind, text }));

export interface Present {
	readonly name: string;
	readonly gm: boolean;
	readonly me: boolean;
}

export interface PlayerView {
	readonly seq: number;
	readonly ruleset: RulesetName;
	readonly myName: string | null;
	readonly present: ReadonlyArray<Present>;
	readonly party: ReadonlyArray<PartyMember>;
	readonly stage: StageView;
	readonly band: CombatView | null;
	readonly map: MapView | null;
	readonly feed: ReadonlyArray<ViewLine>;
}

export interface KnockView {
	readonly name: string;
	readonly actor: string;
	readonly fingerprint: string;
	readonly since: string;
}

export interface GmView extends PlayerView {
	readonly prep: PrepView | null;
	readonly shownState: ShownState;
	readonly recent: ReadonlyArray<Line>;
	readonly catalog: PrepCatalog | null;
	readonly gmNotes: Readonly<Record<string, string>>;
	readonly contentProblems: ReadonlyArray<string>;
	readonly knocks: ReadonlyArray<KnockView>;
}

export type SeatView = PlayerView | GmView;

const presentOf = (
	state: TableState,
	ruleset: RulesetName,
	actor: string,
	here: ReadonlyArray<string>
): ReadonlyArray<Present> => {
	const label = tableLabel(state, ruleset);

	return here.map((who) => ({
		name: label(who),
		gm: who === GM,
		me: who === actor,
	}));
};

const playerView = (
	state: TableState,
	actor: string,
	ruleset: RulesetName,
	here: ReadonlyArray<string>,
	feedLimit: number
): PlayerView => ({
	seq: state.seq,
	ruleset,
	myName: nameOf(state, actor) ?? null,
	present: presentOf(state, ruleset, actor, here),
	party: partyOf(state, actor, ruleset),
	stage: stageOf(state, actor, ruleset),
	band: bandOf(state, actor, ruleset) ?? null,
	map: mapOf(state, actor, ruleset) ?? null,
	feed: feedOf(state, ruleset, 0, feedLimit),
});

interface GmExtras {
	readonly catalog: PrepCatalog | undefined;
	readonly recent: ReadonlyArray<Line>;
	readonly index: ContentIndex | undefined;
	readonly problems: ReadonlyArray<string>;
	readonly knocks: ReadonlyArray<Knock>;
}

const notesOf = (
	index: ContentIndex | undefined
): Readonly<Record<string, string>> => {
	if (index === undefined) {
		return {};
	}

	return Object.fromEntries(
		keyedDocs(index).flatMap((k) => {
			const notes = gmNotesFor(index, k.key);

			return notes === undefined ? [] : [[k.key, notes] as const];
		})
	);
};

const gmView = (
	state: TableState,
	ruleset: RulesetName,
	here: ReadonlyArray<string>,
	feedLimit: number,
	extras: GmExtras
): GmView => ({
	...playerView(state, GM, ruleset, here, feedLimit),
	prep:
		extras.catalog === undefined
			? null
			: prepOf(state, extras.catalog, ruleset),
	shownState: shownState(state),
	recent: extras.recent,
	catalog: extras.catalog ?? null,
	gmNotes: notesOf(extras.index),
	contentProblems: extras.problems,
	knocks: extras.knocks.map((k) => ({
		name: k.name,
		actor: k.actor,
		fingerprint: shortFingerprint(k.fingerprint),
		since: DateTime.formatIso(DateTime.makeUnsafe(k.at)),
	})),
});

const RECENT = 16;

export const viewOf = Effect.fn("mcp.viewOf")(function* (
	seat: McpSeat,
	feedLimit: number
): Effect.fn.Return<
	SeatView,
	never,
	TableRoom | CampaignContent | Presence | ContentWatch | Knocks
> {
	const room = yield* TableRoom;
	const content = yield* CampaignContent;
	const { ruleset } = content;
	const state = yield* room.state;
	const here = yield* (yield* Presence).here.get;

	if (seat.role !== "gm") {
		return playerView(state, seat.actor, ruleset, here, feedLimit);
	}

	const watch = yield* ContentWatch;

	const recent = yield* room
		.recent(RECENT)
		.pipe(Effect.orElseSucceed((): ReadonlyArray<Line> => []));

	const catalog = yield* content.catalog.pipe(Effect.option);

	return gmView(state, ruleset, here, feedLimit, {
		catalog: Option.getOrUndefined(catalog),
		recent,
		index: yield* watch.index.get,
		problems: yield* watch.problems.get,
		knocks: yield* (yield* Knocks).pending.get,
	});
});
