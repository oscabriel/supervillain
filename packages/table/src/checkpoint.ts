import { isRecord } from "@supervillain/core";
import type {
	FeedLine,
	RoomCheckpointProducer,
	ViewEntry,
} from "@supervillain/core";

import { createTableFold } from "./fold.js";
import type { TableFoldCheckpoint } from "./fold.js";

/** Checkpoints are process-local, but an explicit version makes accidental
 * producer/consumer skew a refusal instead of a cast. */
export const TABLE_CHECKPOINT_VERSION = 1;

/** R9's production PTY ceiling is 100 rows. Keeping this many non-null lines
 * from the compacted prefix is enough to reproduce every initially visible
 * feed row while bounding late-join scrollback (ADR-0018). */
export const TABLE_CHECKPOINT_FEED_LINES = 100;

export interface TableCheckpointPayload<S = unknown> {
	readonly version: typeof TABLE_CHECKPOINT_VERSION;
	readonly feed: readonly FeedLine[];
	readonly fold: TableFoldCheckpoint<S>;
}

/** Builds the table-owned adapter injected into the game-blind RoomFold. The
 * sentinel actor is never captured: a joining Table overlays its own actor. */
export const createTableCheckpointProducer = <S, C, E>(
	entry: ViewEntry<S, C, E>,
	gameId: string
): RoomCheckpointProducer => {
	const fold = createTableFold(entry, gameId, "checkpoint");
	const feed: FeedLine[] = [];
	return {
		apply(envelope) {
			const line = fold.apply(envelope);
			if (line === null) {
				return;
			}
			feed.push(line);
			if (feed.length > TABLE_CHECKPOINT_FEED_LINES) {
				feed.shift();
			}
		},
		capture: () => ({
			feed: structuredClone(feed),
			fold: fold.checkpoint(),
			version: TABLE_CHECKPOINT_VERSION,
		}),
	};
};

/** Reads only a payload produced by this table build. A mismatch cannot be
 * repaired from a trimmed tail, so it is loud rather than guessed through. */
export const readTableCheckpoint = <S = unknown>(
	payload: unknown
): TableCheckpointPayload<S> => {
	if (
		!isRecord(payload) ||
		payload.version !== TABLE_CHECKPOINT_VERSION ||
		!Array.isArray(payload.feed) ||
		!isRecord(payload.fold)
	) {
		throw new Error("Table fold checkpoint version is unsupported.");
	}
	return payload as unknown as TableCheckpointPayload<S>;
};
