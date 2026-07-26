/* oxlint-disable promise/avoid-new -- a reader parked on the next envelope is an event, not a promise-returning API. */
/**
 * The gateway's per-Room fold and the per-session views over it (ADR-0012,
 * NQ-5; ADR-0018). One Room, one upstream feed: the fold reads the Host's
 * stream as fast as the Host writes it, derives one optional checkpoint, and
 * holds only a bounded contiguous Envelope tail for every session.
 *
 * Memory only (NQ-11). Checkpoint, tail, cursors, and cached room info live
 * here and touch no disk, DB, or log line. A gateway restart or Room detach
 * discards all of them.
 */
import type {
	Envelope,
	RoomCheckpointProducer,
	RoomCommand,
	RoomReplay,
	RoomSubmission,
} from "@supervillain/core";

import type { RoomInfo } from "./messages.js";
import { mintSubmissionId } from "./submissions.js";

/** How many Envelopes a session may fall behind before only its view drops. */
export const DEFAULT_SESSION_BUDGET = 512;

/** The raw contiguous tail kept after the shared checkpoint (ADR-0018). */
export const DEFAULT_FOLD_TAIL = 512;

/** The upstream stream has no backlog marker. A quiet loopback gap this wide
 * means the fold has caught the Host's current end before a replay cursor is
 * captured; ordinary human-paced live events naturally leave a wider gap. */
const CHECKPOINT_QUIET_MS = 25;

/** A RoomStore reached across a pipe, plus the room's identity card. */
export interface PipeRoomStore {
	readonly submit: (command: RoomCommand) => Promise<RoomSubmission>;
	readonly stream: (fromSeq: number) => AsyncIterable<Envelope>;
	readonly replay: () => Promise<RoomReplay>;
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

/** One session's own request/response channel to the Host. */
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

export interface RoomFoldCheckpointOptions {
	/** Created from Room metadata at the composition root; `room-wire` never
	 * interprets the producer's game/table-owned payload. */
	readonly create: (info: RoomInfo) => RoomCheckpointProducer | undefined;
	/** Must be at least the session lag budget. Default 512 (ADR-0018). */
	readonly tail?: number;
}

export interface RoomFoldOptions {
	readonly source: RoomFoldSource;
	/** Envelopes one view may lag by. Default {@link DEFAULT_SESSION_BUDGET}. */
	readonly sessionBudget?: number;
	readonly checkpoint?: RoomFoldCheckpointOptions;
	readonly onEvent?: (event: RoomFoldEvent) => void;
}

export interface RoomFold {
	readonly openView: () => RoomView;
	/** Atomically holds one of `capacity` view slots. A failed attempt changes
	 * nothing; a successful reservation must be opened or released. */
	readonly reserveView: (capacity: number) => RoomViewReservation | undefined;
	readonly views: () => number;
	/** Raw Envelopes this fold currently holds; checkpoint state is separate. */
	readonly length: () => number;
	readonly close: () => Promise<void>;
}

interface FoldReader {
	/** The next Log sequence this reader has not yet received. */
	nextSeq: number;
	dropped: boolean;
	readonly onDrop: () => void;
	wake: (() => void) | undefined;
}

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

const wake = (reader: FoldReader): void => {
	const resume = reader.wake;
	reader.wake = undefined;
	resume?.();
};

const positiveSafeInteger = (value: number, name: string): void => {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new RangeError(`${name} must be a positive safe integer.`);
	}
};

export const createRoomFold = (options: RoomFoldOptions): RoomFold => {
	const budget = options.sessionBudget ?? DEFAULT_SESSION_BUDGET;
	const tailCapacity = options.checkpoint?.tail ?? DEFAULT_FOLD_TAIL;
	positiveSafeInteger(budget, "sessionBudget");
	if (options.checkpoint !== undefined) {
		positiveSafeInteger(tailCapacity, "checkpoint tail");
		if (tailCapacity < budget) {
			throw new RangeError(
				"checkpoint tail must be at least the session budget."
			);
		}
	}
	const onEvent = options.onEvent ?? ((): void => undefined);
	const history: Envelope[] = [];
	const readers = new Set<FoldReader>();
	const reservations = new Set<{ held: boolean }>();
	let producer: RoomCheckpointProducer | undefined;
	let compactedThrough = 0;
	let latestSeq = 0;
	let revision = 0;
	const initialized = Promise.withResolvers<boolean>();
	let checkpointInvalid = false;
	let openViews = 0;
	let feedEnded = false;
	let closed = false;
	let reading = false;
	let info: Promise<RoomInfo> | undefined;

	const historyStartSeq = (): number => history[0]?.seq ?? compactedThrough + 1;

	const append = (envelope: Envelope): void => {
		if (envelope.seq !== latestSeq + 1) {
			checkpointInvalid = true;
			throw new Error("Room fold stream sequence is not contiguous.");
		}
		history.push(envelope);
		latestSeq = envelope.seq;
		revision += 1;
		for (const reader of readers) {
			const lag = latestSeq - reader.nextSeq + 1;
			if (!reader.dropped && lag > budget) {
				reader.dropped = true;
				reader.onDrop();
			}
		}
		if (producer !== undefined && history.length > tailCapacity) {
			const [oldest] = history;
			if (oldest !== undefined) {
				try {
					producer.apply(oldest);
				} catch (error) {
					checkpointInvalid = true;
					throw new Error("Room fold checkpoint producer failed.", {
						cause: error,
					});
				}
				history.shift();
				compactedThrough = oldest.seq;
			}
		}
		for (const reader of readers) {
			wake(reader);
		}
	};

	const endFeed = (): void => {
		feedEnded = true;
		for (const reader of readers) {
			wake(reader);
		}
	};

	const askInfo = async (): Promise<RoomInfo> => {
		try {
			return await options.source.info();
		} catch (error) {
			info = undefined;
			throw error;
		}
	};
	const roomInfo = (): Promise<RoomInfo> => (info ??= askInfo());

	/** The one reader of the Host's feed. It never waits on a session. */
	const read = async (): Promise<void> => {
		try {
			if (options.checkpoint !== undefined) {
				const identified = await roomInfo();
				if (closed) {
					return;
				}
				producer = options.checkpoint.create(identified);
			}
			if (closed) {
				return;
			}
			initialized.resolve(true);
			for await (const envelope of options.source.stream(1)) {
				if (closed) {
					return;
				}
				append(envelope);
			}
		} catch {
			// A dead pipe or invalid checkpoint ends this derived fold. The Host
			// remains the source from which a replacement attachment rebuilds.
		} finally {
			initialized.resolve(true);
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

	const openView = (): RoomView => {
		const channel = options.source.openSubmit();
		const dropped = createSignal();
		const own = new Set<FoldReader>();
		let viewClosed = false;
		let tail: Promise<unknown> = Promise.resolve();
		openViews += 1;
		onEvent({ kind: "view-opened", views: openViews });
		startReading();

		const makeReader = (fromSeq: number): FoldReader => {
			positiveSafeInteger(fromSeq, "fromSeq");
			if (fromSeq < historyStartSeq()) {
				throw new RangeError(
					"Requested history was compacted; use replay() to restore its checkpoint."
				);
			}
			const reader: FoldReader = {
				dropped: false,
				nextSeq: fromSeq,
				onDrop: () => {
					dropped.fire();
					onEvent({ kind: "view-dropped", views: openViews });
				},
				wake: undefined,
			};
			readers.add(reader);
			own.add(reader);
			return reader;
		};

		const readFrom = async function* readFrom(
			reader: FoldReader,
			initial: readonly Envelope[] = []
		): AsyncGenerator<Envelope> {
			try {
				for (const envelope of initial) {
					yield envelope;
					if (reader.dropped || viewClosed || closed) {
						return;
					}
				}
				for (;;) {
					while (reader.nextSeq <= latestSeq && !reader.dropped) {
						const index = reader.nextSeq - historyStartSeq();
						if (index < 0) {
							throw new Error("Room view fell behind the compacted tail.");
						}
						const envelope = history[index];
						if (envelope === undefined) {
							break;
						}
						reader.nextSeq += 1;
						yield envelope;
						if (viewClosed) {
							return;
						}
					}
					if (reader.dropped || viewClosed || feedEnded || closed) {
						return;
					}
					// oxlint-disable-next-line eslint/no-await-in-loop -- one park per quiet gap in the Room feed is the point.
					await new Promise<void>((resolve) => {
						reader.wake = resolve;
					});
				}
			} finally {
				readers.delete(reader);
				own.delete(reader);
			}
		};

		const replay = async (): Promise<RoomReplay> => {
			await initialized.promise;
			for (;;) {
				const observed = revision;
				// oxlint-disable-next-line eslint/no-await-in-loop -- each quiet probe must observe the revision after the previous one.
				await new Promise<void>((resolve) => {
					setTimeout(resolve, CHECKPOINT_QUIET_MS);
				});
				if (revision === observed || feedEnded || closed) {
					break;
				}
			}
			if (checkpointInvalid) {
				throw new Error("Room fold checkpoint is invalid.");
			}
			const throughSeq = compactedThrough;
			const checkpoint =
				throughSeq === 0 || producer === undefined
					? undefined
					: { payload: producer.capture(), throughSeq };
			// Freeze the bounded tail for this view and register its live cursor at
			// the same turn. New Envelopes may compact the shared tail while this
			// session consumes its copy without dropping or skipping it.
			const initial = [...history];
			const reader = makeReader(latestSeq + 1);
			return {
				checkpoint,
				stream: readFrom(reader, initial),
				throughSeq: latestSeq,
			};
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
			replay,
			stream: (fromSeq) => readFrom(makeReader(fromSeq)),
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

	// A checkpoint is a per-Room artifact, not a per-view cache. Start at
	// attachment so the first late join does not become the Room's full replay
	// worker; reservations and refused arrivals still cause no additional work.
	startReading();

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
			history.splice(0);
			producer = undefined;
			info = undefined;
			await options.source.close();
		},
		length: () => history.length,
		openView,
		reserveView,
		views: () => openViews,
	};
};
