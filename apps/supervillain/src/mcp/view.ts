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
	PrepCatalog,
	RulesetName,
	TableState,
} from "@supervillain/domain";
import type { Line } from "@supervillain/platform-jsonl";
import { DateTime, Effect, Option } from "effect";

import { CampaignContent, gmNotesFor, keyedDocs } from "../content/index.ts";
import type { ContentIndex } from "../content/index.ts";
import { shownState } from "../host/check.ts";
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

const presentOf = (
	state: TableState,
	ruleset: RulesetName,
	actor: string,
	here: ReadonlyArray<string>
) => {
	const label = tableLabel(state, ruleset);

	return here.map((who) => ({
		name: label(who),
		gm: who === GM,
		me: who === actor,
	}));
};

export const playerView = (
	state: TableState,
	actor: string,
	ruleset: RulesetName,
	here: ReadonlyArray<string>,
	feedLimit: number
) => ({
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

export interface GmExtras {
	readonly catalog: PrepCatalog | undefined;
	readonly recent: ReadonlyArray<Line>;
	readonly index: ContentIndex | undefined;
	readonly problems: ReadonlyArray<string>;
	readonly knocks: ReadonlyArray<Knock>;
}

const notesOf = (index: ContentIndex | undefined) =>
	index === undefined
		? {}
		: Object.fromEntries(
				keyedDocs(index).flatMap((k) => {
					const notes = gmNotesFor(index, k.key);

					return notes === undefined ? [] : [[k.key, notes] as const];
				})
			);

export const gmView = (
	state: TableState,
	ruleset: RulesetName,
	here: ReadonlyArray<string>,
	feedLimit: number,
	extras: GmExtras
) => ({
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

export type SeatView =
	| ReturnType<typeof playerView>
	| ReturnType<typeof gmView>;

export const viewOf = Effect.fn("mcp.viewOf")(function* (
	seat: McpSeat,
	feedLimit: number
) {
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
