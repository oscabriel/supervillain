/* oxlint-disable promise/avoid-new -- a reader parked on the next envelope is an event, not a promise-returning API. */
/**
 * The gateway's per-Room fold and the per-session views over it (ADR-0012,
 * NQ-5). One Room, one upstream feed: the fold reads the Host's stream as fast
 * as the Host writes it and holds the envelopes in memory, and every session
 * reads that one history through its own cursor.
 *
 * The isolation this exists for: a session that stops reading falls behind its
 * own cursor and nobody else's. When its lag passes its budget the fold drops
 * that view — the Room keeps folding, the fast readers keep up, and the Host
 * pipe never blocks. That is what pays for multiplexing every Room over one
 * connection.
 *
 * Memory only (NQ-11). The history, the cursors, and the cached room info live
 * here and touch no disk, no DB, and no log line. A gateway restart loses live
 * sessions and nothing else.
 */
import type { Envelope, RoomCommand, RoomSubmission } from "@supervillain/core";

import type { RoomInfo } from "./messages.js";
import { mintSubmissionId } from "./submissions.js";

/**
 * How many envelopes a session may fall behind before the fold drops its view.
 * A cost ceiling and an abuse floor, not capacity policy: the number is
 * R9-gated (ADR-0012, NQ-10), the isolation it buys is the decision.
 */
export const DEFAULT_SESSION_BUDGET = 512;

/** A RoomStore reached across a pipe, plus the room's identity card. */
export interface PipeRoomStore {
	readonly submit: (command: RoomCommand) => Promise<RoomSubmission>;
	readonly stream: (fromSeq: number) => AsyncIterable<Envelope>;
	readonly info: () => Promise<RoomInfo>;
	readonly close: () => Promise<void>;
}

/** One session's view over the shared fold. */
export interface RoomView extends PipeRoomStore {
	/** Resolves if this seat fell further behind than its budget allows and the
	 * fold dropped it. Only ever this seat: the Room and its other views are
	 * untouched (ADR-0012, NQ-5). */
	readonly dropped: Promise<void>;
}

/** One capacity slot held before its view is opened. The reservation is
 * one-shot: opening consumes it, and release is idempotent. */
export interface RoomViewReservation {
	readonly open: () => RoomView | undefined;
	readonly release: () => void;
}

/** One session's own request/response channel to the Host. Opened per view, so
 * a slow answer delays that seat's next command and nobody else's. */
export interface RoomSubmitChannel {
	readonly send: (
		command: RoomCommand,
		submissionId: string
	) => Promise<RoomSubmission>;
	readonly close: () => void;
}

/** The Room as the Host serves it — the one upstream a fold reads. */
export interface RoomFoldSource {
	readonly info: () => Promise<RoomInfo>;
	readonly stream: (fromSeq: number) => AsyncIterable<Envelope>;
	readonly openSubmit: () => RoomSubmitChannel;
	readonly close: () => Promise<void>;
}

/** Metadata only (NQ-11): counts and lifecycle, never a payload. */
export type RoomFoldEvent =
	| { readonly kind: "feed-ended" }
	| { readonly kind: "view-closed"; readonly views: number }
	| { readonly kind: "view-dropped"; readonly views: number }
	| { readonly kind: "view-opened"; readonly views: number };

export interface RoomFoldOptions {
	readonly source: RoomFoldSource;
	/** Envelopes one view may lag by. Default {@link DEFAULT_SESSION_BUDGET}. */
	readonly sessionBudget?: number;
	readonly onEvent?: (event: RoomFoldEvent) => void;
}

export interface RoomFold {
	readonly openView: () => RoomView;
	/** Atomically holds one of `capacity` view slots. A failed attempt changes
	 * nothing; a successful reservation must be opened or released. */
	readonly reserveView: (capacity: number) => RoomViewReservation | undefined;
	readonly views: () => number;
	/** Envelopes this fold holds — in memory, and nowhere else. */
	readonly length: () => number;
	readonly close: () => Promise<void>;
}

interface FoldReader {
	/** Index into the shared history this reader has not yet handed over. */
	next: number;
	dropped: boolean;
	readonly onDrop: () => void;
	wake: (() => void) | undefined;
}

/** A one-shot signal. Nothing here rejects: a dropped seat is a fact, not a
 * failure of this fold. */
interface FoldSignal {
	readonly fired: Promise<void>;
	readonly fire: () => void;
}

const createSignal = (): FoldSignal => {
	let fire: (() => void) | undefined;
	const fired = new Promise<void>((resolve) => {
		fire = resolve;
	});
	return { fire: () => fire?.(), fired };
};

/** Resumes a reader parked on the next envelope. */
const wake = (reader: FoldReader): void => {
	const resume = reader.wake;
	reader.wake = undefined;
	resume?.();
};

export const createRoomFold = (options: RoomFoldOptions): RoomFold => {
	const budget = options.sessionBudget ?? DEFAULT_SESSION_BUDGET;
	const onEvent = options.onEvent ?? ((): void => undefined);
	const history: Envelope[] = [];
	const readers = new Set<FoldReader>();
	const reservations = new Set<{ held: boolean }>();
	let openViews = 0;
	let feedEnded = false;
	let closed = false;
	let reading = false;
	let info: Promise<RoomInfo> | undefined;

	const append = (envelope: Envelope): void => {
		history.push(envelope);
		for (const reader of readers) {
			if (!reader.dropped && history.length - reader.next > budget) {
				reader.dropped = true;
				reader.onDrop();
			}
			wake(reader);
		}
	};

	const endFeed = (): void => {
		feedEnded = true;
		for (const reader of readers) {
			wake(reader);
		}
	};

	/** The one reader of the Host's feed. It never waits on a session: a view
	 * that cannot keep up is dropped, and this loop keeps folding. */
	const read = async (): Promise<void> => {
		try {
			for await (const envelope of options.source.stream(history.length + 1)) {
				if (closed) {
					return;
				}
				append(envelope);
			}
		} catch {
			// The Room's feed ended — a dead pipe, or a Host that stopped serving
			// it. Every view sees the same end, and none of them re-dials.
		} finally {
			endFeed();
			onEvent({ kind: "feed-ended" });
		}
	};

	const startReading = (): void => {
		if (reading || closed) {
			return;
		}
		reading = true;
		void read();
	};

	const askInfo = async (): Promise<RoomInfo> => {
		try {
			return await options.source.info();
		} catch (error) {
			// A failed ask is not an answer: the next view may ask again.
			info = undefined;
			throw error;
		}
	};

	const roomInfo = (): Promise<RoomInfo> => (info ??= askInfo());

	const openView = (): RoomView => {
		const channel = options.source.openSubmit();
		const dropped = createSignal();
		const own = new Set<FoldReader>();
		let viewClosed = false;
		let tail: Promise<unknown> = Promise.resolve();
		openViews += 1;
		onEvent({ kind: "view-opened", views: openViews });
		startReading();

		const readFrom = async function* readFrom(
			fromSeq: number
		): AsyncGenerator<Envelope> {
			const reader: FoldReader = {
				dropped: false,
				next: Math.max(0, fromSeq - 1),
				onDrop: () => {
					dropped.fire();
					onEvent({ kind: "view-dropped", views: openViews });
				},
				wake: undefined,
			};
			readers.add(reader);
			own.add(reader);
			try {
				for (;;) {
					while (reader.next < history.length && !reader.dropped) {
						const envelope = history[reader.next];
						reader.next += 1;
						if (envelope !== undefined) {
							yield envelope;
						}
						if (viewClosed) {
							return;
						}
					}
					if (reader.dropped || viewClosed || feedEnded || closed) {
						return;
					}
					// oxlint-disable-next-line eslint/no-await-in-loop -- one park per quiet gap in the Room's feed is the point.
					await new Promise<void>((resolve) => {
						reader.wake = resolve;
					});
				}
			} finally {
				readers.delete(reader);
				own.delete(reader);
			}
		};

		const send = (command: RoomCommand): Promise<RoomSubmission> => {
			const previous = tail;
			const turn = Promise.withResolvers<boolean>();
			tail = turn.promise;
			return (async (): Promise<RoomSubmission> => {
				try {
					await previous;
					if (viewClosed) {
						throw new Error("Room view is closed.");
					}
					return await channel.send(command, mintSubmissionId());
				} finally {
					turn.resolve(true);
				}
			})();
		};

		return {
			close() {
				if (viewClosed) {
					return Promise.resolve();
				}
				viewClosed = true;
				openViews -= 1;
				channel.close();
				for (const reader of own) {
					wake(reader);
				}
				onEvent({ kind: "view-closed", views: openViews });
				return Promise.resolve();
			},
			dropped: dropped.fired,
			info: roomInfo,
			stream: (fromSeq) => readFrom(fromSeq),
			submit: send,
		};
	};

	const reserveView = (capacity: number): RoomViewReservation | undefined => {
		if (closed || openViews + reservations.size >= capacity) {
			return undefined;
		}
		const state = { held: true };
		reservations.add(state);
		const release = (): void => {
			if (!state.held) {
				return;
			}
			state.held = false;
			reservations.delete(state);
		};
		return {
			open() {
				if (!state.held || closed) {
					release();
					return;
				}
				release();
				return openView();
			},
			release,
		};
	};

	return {
		close: async () => {
			if (closed) {
				return;
			}
			closed = true;
			for (const reservation of reservations) {
				reservation.held = false;
			}
			reservations.clear();
			for (const reader of readers) {
				wake(reader);
			}
			await options.source.close();
		},
		length: () => history.length,
		openView,
		reserveView,
		views: () => openViews,
	};
};
