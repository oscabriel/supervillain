import { GM } from "@supervillain/domain";
import type { RulesetName, StageCard, TableState } from "@supervillain/domain";
import {
	Context,
	Effect,
	Equal,
	FileSystem,
	Layer,
	Path,
	Ref,
	Semaphore,
	Stream,
	SubscriptionRef,
} from "effect";

import { campaignConfigWith } from "../content/campaignFile.ts";
import {
	CampaignContent,
	gmOnly,
	keyedDocs,
	playerSafe,
	problemLine,
} from "../content/index.ts";
import type { ContentIndex, LoadError } from "../content/index.ts";
import { FOLDERS, TABLE_FILE } from "../content/kinds.ts";
import { TableRoom } from "./TableRoom.ts";
import type { View } from "./View.ts";

const DEBOUNCE = "250 millis";

const SYNC_RATE_KEY = "content-watch";

const ROOT_FILES: ReadonlySet<string> = new Set([TABLE_FILE, "campaign.yaml"]);

const CONTENT_FOLDERS: ReadonlySet<string> = new Set([
	...Object.values(FOLDERS),
	"heroes",
	"monsters",
	"maps",
	"art",
]);

const TEMP_FILE = /(?:\.sw[a-z]|~|\.tmp|\.bak)$/u;

const SEP = /[\\/]/u;

export const watched = (relative: string): boolean => {
	const parts = relative.split(SEP).filter((p) => p !== "" && p !== ".");
	const [first] = parts;
	const base = parts.at(-1);

	if (
		first === undefined ||
		base === undefined ||
		parts.some((p) => p.startsWith(".") || p === "..") ||
		TEMP_FILE.test(base) ||
		base === "4913"
	) {
		return false;
	}

	return parts.length === 1
		? ROOT_FILES.has(first)
		: CONTENT_FOLDERS.has(first);
};

export interface InPlaySheet {
	readonly id: string;
	readonly sheet: unknown;
}

const sheetsInPlay = (
	state: TableState,
	ruleset: RulesetName
): ReadonlyArray<InPlaySheet> => {
	switch (ruleset) {
		case "draw-steel": {
			return state.ds.heroes.map((h) => ({ id: h.id, sheet: h.sheet }));
		}

		case "pf2e": {
			return state.pf.creatures
				.filter((c) => c.kind === "pc")
				.map((c) => ({ id: c.id, sheet: c.sheet }));
		}

		case "freeform": {
			return state.ff.figures
				.filter((f) => f.side === "party")
				.map((f) => ({ id: f.id, sheet: f.sheet }));
		}

		case "set-world": {
			return [];
		}

		default: {
			return [];
		}
	}
};

export const staleOf = (
	inPlay: ReadonlyArray<InPlaySheet>,
	fresh: ReadonlyMap<string, unknown>
): ReadonlyArray<string> =>
	inPlay.flatMap((s) => {
		const disk = fresh.get(s.id);

		return disk === undefined || Equal.equals(disk, s.sheet) ? [] : [s.id];
	});

export const changedCards = (
	state: Pick<TableState, "stage">,
	fresh: ReadonlyArray<StageCard>
): ReadonlyArray<StageCard> =>
	fresh.filter((card) => {
		const was = state.stage.cards[card.key];

		return was !== undefined && !Equal.equals(was.card, card);
	});

const heldBack = (
	before: ContentIndex,
	after: ContentIndex,
	keys: ReadonlyArray<string>
): ReadonlyArray<string> => {
	const was = new Map(keyedDocs(before).map((k) => [k.key, k.doc] as const));
	const now = new Map(keyedDocs(after).map((k) => [k.key, k.doc] as const));

	return keys.filter((key) => {
		const old = was.get(key);
		const fresh = now.get(key);

		return (
			old !== undefined &&
			fresh !== undefined &&
			gmOnly(fresh.sections).length < gmOnly(old.sections).length &&
			playerSafe(fresh.sections).length > playerSafe(old.sections).length
		);
	});
};

const sameList = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
	a.length === b.length && a.every((x, i) => x === b[i]);

const publish = (
	ref: SubscriptionRef.SubscriptionRef<ReadonlyArray<string>>,
	next: ReadonlyArray<string>
) =>
	Effect.flatMap(SubscriptionRef.get(ref), (was) =>
		sameList(was, next) ? Effect.void : SubscriptionRef.set(ref, next)
	);

const viewOf = <A>(ref: SubscriptionRef.SubscriptionRef<A>): View<A> => ({
	get: SubscriptionRef.get(ref),
	changes: SubscriptionRef.changes(ref),
});

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export interface ContentWatchOptions {
	readonly watch?: boolean;
}

export class ContentWatch extends Context.Service<
	ContentWatch,
	{
		readonly index: View<ContentIndex>;
		readonly problems: View<ReadonlyArray<string>>;
		readonly stale: View<ReadonlyArray<string>>;
		readonly held: View<ReadonlyArray<string>>;
		readonly recheck: Effect.Effect<void>;
	}
>()("supervillain/host/ContentWatch") {
	static readonly make = Effect.fn("ContentWatch.make")(function* (
		dir: string,
		options: ContentWatchOptions = {}
	) {
		const content = yield* CampaignContent;
		const room = yield* TableRoom;
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const { ruleset } = content;

		const index = yield* SubscriptionRef.make(yield* content.index);
		const problems = yield* SubscriptionRef.make<ReadonlyArray<string>>([]);
		const stale = yield* SubscriptionRef.make<ReadonlyArray<string>>([]);
		const held = yield* SubscriptionRef.make<ReadonlyArray<string>>([]);
		const one = yield* Semaphore.make(1);
		const fresh = yield* Ref.make<ReadonlyMap<string, unknown>>(new Map());

		const loadSheet = (id: string): Effect.Effect<unknown, LoadError> => {
			switch (ruleset) {
				case "draw-steel": {
					return content.hero(id);
				}

				case "pf2e": {
					return content.pfHero(id);
				}

				case "freeform": {
					return content.ffHero(id);
				}

				case "set-world": {
					return Effect.void;
				}

				default: {
					return Effect.void;
				}
			}
		};

		const stillHeld = Effect.gen(function* () {
			const state = yield* room.state;
			const was = yield* SubscriptionRef.get(held);
			const staged = was.filter((key) => state.stage.cards[key] !== undefined);
			const differ = changedCards(state, yield* content.cards(staged));

			yield* publish(
				held,
				staged.filter((key) => differ.some((c) => c.key === key))
			);
		});

		const restale = Effect.gen(function* () {
			const state = yield* room.state;
			const known = yield* Ref.get(fresh);

			yield* publish(stale, staleOf(sheetsInPlay(state, ruleset), known));
			yield* stillHeld;
		});

		const refreshSheets = Effect.gen(function* () {
			const state = yield* room.state;

			const loaded = yield* Effect.forEach(
				sheetsInPlay(state, ruleset),
				(s) =>
					loadSheet(s.id).pipe(
						Effect.match({
							onFailure: (): ReadonlyArray<readonly [string, unknown]> => [],
							onSuccess: (sheet) => [[s.id, sheet] as const],
						})
					),
				{ concurrency: 4 }
			);

			yield* Ref.set(fresh, new Map(loaded.flat()));
			yield* restale;
		});

		const autoSync = Effect.fn("ContentWatch.autoSync")(function* (
			before: ContentIndex,
			next: ContentIndex
		) {
			if (next.table?.front.sync === "manual") {
				return;
			}

			const state = yield* room.state;
			const keys = Object.keys(state.stage.cards);

			if (keys.length === 0) {
				return;
			}

			const changed = changedCards(state, yield* content.cards(keys));
			const was = yield* SubscriptionRef.get(held);

			const hold = new Set([
				...was,
				...heldBack(
					before,
					next,
					changed.map((c) => c.key)
				),
			]);

			const toSync = changed.filter((c) => !hold.has(c.key));
			const withheld = changed.filter((c) => hold.has(c.key));

			yield* publish(
				held,
				withheld.map((c) => c.key)
			);

			if (withheld.length > 0) {
				yield* Effect.logWarning(
					`content: held back ${withheld.map((c) => c.key).join(", ")}: GM notes shrank as player text grew, so /sync shows the players only when you say`
				);
			}

			if (toSync.length === 0) {
				return;
			}

			yield* room
				.submit(GM, { type: "sync", cards: toSync }, SYNC_RATE_KEY)
				.pipe(
					Effect.tap(() =>
						Effect.logInfo(
							`content: read ${plural(toSync.length, "card")} on the stage again`
						)
					),
					Effect.catchTag("Refusal", (refused) =>
						Effect.logWarning(
							`content: couldn't sync the stage: ${refused.message}`
						)
					)
				);
		});

		const rulesProblem = campaignConfigWith({ fs, path }, dir).pipe(
			Effect.match({
				onFailure: (failure): ReadonlyArray<string> => [failure.message],
				onSuccess: (config): ReadonlyArray<string> =>
					config.rules === ruleset
						? []
						: [
								`campaign.yaml: the campaign now plays ${config.rules}, but the table plays ${ruleset} until the host restarts`,
							],
			})
		);

		const check = Effect.gen(function* () {
			const next = yield* content.read;
			const rules = yield* rulesProblem;
			const lines = [...rules, ...next.problems.map(problemLine)];

			if (lines.length > 0) {
				yield* publish(problems, lines);
				yield* Effect.logWarning(
					`content: ${plural(lines.length, "problem")} in the campaign's files; keeping the last good ones`
				);

				return;
			}

			const before = yield* content.index;
			yield* content.accept(next);
			yield* SubscriptionRef.set(index, next.index);
			yield* publish(problems, []);
			yield* autoSync(before, next.index);
			yield* refreshSheets;
		}).pipe(
			one.withPermits(1),
			Effect.catchCause((cause) =>
				Effect.logError("content: couldn't read the campaign again", cause)
			),
			Effect.withSpan("ContentWatch.check")
		);

		yield* refreshSheets.pipe(
			Effect.catchCause((cause) =>
				Effect.logWarning("content: couldn't compare the party's sheets", cause)
			),
			Effect.forkScoped
		);

		yield* room.changes.pipe(
			Stream.runForEach(() => restale),
			Effect.forkScoped
		);

		if (options.watch !== false) {
			const relative = (p: string) =>
				path.isAbsolute(p) ? path.relative(dir, p) : p;

			yield* fs.watch(dir, { recursive: true }).pipe(
				Stream.filter((event) => watched(relative(event.path))),
				Stream.debounce(DEBOUNCE),
				Stream.runForEach(() => check),
				Effect.catchCause((cause) =>
					Effect.logWarning(
						"content: can't watch the campaign's files; /sync reads them again",
						cause
					)
				),
				Effect.forkScoped
			);
		}

		return ContentWatch.of({
			index: viewOf(index),
			problems: viewOf(problems),
			stale: viewOf(stale),
			held: viewOf(held),
			recheck: check,
		});
	});

	static readonly layer = (
		dir: string,
		options: ContentWatchOptions = {}
	): Layer.Layer<
		ContentWatch,
		never,
		CampaignContent | TableRoom | FileSystem.FileSystem | Path.Path
	> => Layer.effect(ContentWatch, ContentWatch.make(dir, options));
}
