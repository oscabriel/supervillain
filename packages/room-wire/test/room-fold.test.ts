/* oxlint-disable vitest/prefer-importing-vitest-globals, eslint/require-await, promise/avoid-new, eslint/no-await-in-loop -- dual-lane fold suite: interface-shaped async fakes and deliberately sequential reads. */
import type { Envelope, RoomCommand, RoomSubmission } from "@supervillain/core";

import { createRoomFold } from "../src/index.js";
import type { RoomFoldSource, RoomSubmitChannel } from "../src/index.js";
import { describe, expect, test } from "./harness.js";

const envelope = (seq: number): Envelope => ({
	actor: "gm-key",
	payload: { text: `line ${seq}` },
	seq,
	timestamp: "2026-07-25T00:00:00.000Z",
	type: "core.said",
});

const settle = async (turns = 4): Promise<void> => {
	for (let turn = 0; turn < turns; turn += 1) {
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 1);
		});
	}
};
/** Unwraps an iterator result — one place to read a field off the protocol's
 * answer, rather than naming a variable at every call. */
const valueOf = async (
	pending: Promise<IteratorResult<Envelope>>
): Promise<Envelope | undefined> => {
	const result = await pending;
	return result.value;
};

const doneOf = async (
	pending: Promise<IteratorResult<Envelope>>
): Promise<boolean | undefined> => {
	const result = await pending;
	return result.done;
};

interface SourceProbe {
	readonly source: RoomFoldSource;
	readonly push: (...next: readonly Envelope[]) => void;
	readonly endFeed: () => void;
	readonly feeds: () => number;
	readonly infoAsks: () => number;
	readonly channels: () => number;
	readonly submissionIds: () => readonly string[];
	readonly commands: () => readonly RoomCommand[];
	readonly closed: () => boolean;
}

const fakeSource = (): SourceProbe => {
	const envelopes: Envelope[] = [];
	const submissionIds: string[] = [];
	const commands: RoomCommand[] = [];
	let wake: (() => void) | undefined;
	let feeds = 0;
	let infoAsks = 0;
	let channels = 0;
	let closed = false;
	let ended = false;
	const nudged = (): Promise<void> =>
		new Promise<void>((resolve) => {
			wake = resolve;
		});
	const nudge = (): void => {
		const resume = wake;
		wake = undefined;
		resume?.();
	};
	const feed = async function* feed(fromSeq: number): AsyncGenerator<Envelope> {
		feeds += 1;
		let index = fromSeq - 1;
		for (;;) {
			while (index < envelopes.length) {
				const next = envelopes[index];
				index += 1;
				if (next !== undefined) {
					yield next;
				}
			}
			if (ended) {
				return;
			}
			await nudged();
		}
	};
	return {
		channels: () => channels,
		closed: () => closed,
		commands: () => commands,
		endFeed() {
			ended = true;
			nudge();
		},
		feeds: () => feeds,
		infoAsks: () => infoAsks,
		push(...next) {
			envelopes.push(...next);
			nudge();
		},
		source: {
			close: async () => {
				closed = true;
			},
			info: async () => {
				infoAsks += 1;
				return { gameId: "fake", label: "the table" };
			},
			openSubmit: (): RoomSubmitChannel => {
				channels += 1;
				return {
					close: () => {},
					send: async (
						command: RoomCommand,
						submissionId: string
					): Promise<RoomSubmission> => {
						commands.push(command);
						submissionIds.push(submissionId);
						return { accepted: true, envelopes: [] };
					},
				};
			},
			stream: (fromSeq: number) => feed(fromSeq),
		},
		submissionIds: () => submissionIds,
	};
};

describe("the per-Room fold", () => {
	test("reads the Host's feed once however many sessions watch it", async () => {
		const probe = fakeSource();
		const fold = createRoomFold({ source: probe.source });
		const views = [fold.openView(), fold.openView(), fold.openView()];
		const readers = views.map((view) => view.stream(1)[Symbol.asyncIterator]());
		const first = readers.map((reader) => reader.next());
		await settle();
		probe.push(envelope(1));

		for (const pending of first) {
			expect(await valueOf(pending)).toMatchObject({ seq: 1 });
		}
		expect(probe.feeds()).toBe(1);
		expect(fold.views()).toBe(3);
		expect(fold.length()).toBe(1);

		await Promise.all(views.map((view) => view.close()));
		expect(fold.views()).toBe(0);
		await fold.close();
		expect(probe.closed()).toBe(true);
	});

	test("reserves one remaining view atomically and releases abandoned reservations", async () => {
		const probe = fakeSource();
		const fold = createRoomFold({ source: probe.source });
		const open = Array.from({ length: 31 }, () => fold.openView());

		const attempts = Array.from({ length: 20 }, () => fold.reserveView(32));
		const admitted = attempts.filter(
			(reservation) => reservation !== undefined
		);
		expect(admitted).toHaveLength(1);
		expect(fold.views()).toBe(31);
		const last = admitted[0]?.open();
		expect(last).toBeDefined();
		expect(fold.views()).toBe(32);

		await last?.close();
		const abandoned = fold.reserveView(32);
		expect(abandoned).toBeDefined();
		abandoned?.release();
		expect(fold.reserveView(32)).toBeDefined();

		await Promise.all(open.map((view) => view.close()));
		await fold.close();
	});

	test("invalidates an unconsumed reservation when the fold closes", async () => {
		const probe = fakeSource();
		const fold = createRoomFold({ source: probe.source });
		const reservation = fold.reserveView(1);
		expect(reservation).toBeDefined();

		await fold.close();
		expect(reservation?.open()).toBeUndefined();
		expect(fold.views()).toBe(0);
	});

	test("compacts a prefix into one opaque checkpoint and atomically replays its tail", async () => {
		const probe = fakeSource();
		let folded = 0;
		const fold = createRoomFold({
			checkpoint: {
				create: () => ({
					apply: (next) => {
						folded += next.seq;
					},
					capture: () => ({ folded }),
				}),
				tail: 2,
			},
			sessionBudget: 2,
			source: probe.source,
		});
		const starter = fold.openView();
		await settle();
		probe.push(...Array.from({ length: 6 }, (_, index) => envelope(index + 1)));
		await settle();

		expect(fold.length()).toBe(2);
		const late = fold.openView();
		const replay = await late.replay();
		expect(replay.checkpoint).toEqual({
			payload: { folded: 10 },
			throughSeq: 4,
		});
		const reader = replay.stream[Symbol.asyncIterator]();
		expect(await valueOf(reader.next())).toMatchObject({ seq: 5 });
		expect(await valueOf(reader.next())).toMatchObject({ seq: 6 });
		expect(() => late.stream(1)).toThrow("compacted");

		await starter.close();
		await late.close();
		await fold.close();
		expect(fold.length()).toBe(0);
	});

	test("a refused reservation adds no checkpoint, info, channel, or feed work", async () => {
		const probe = fakeSource();
		let producers = 0;
		const fold = createRoomFold({
			checkpoint: {
				create: () => {
					producers += 1;
					return { apply: () => {}, capture: () => ({}) };
				},
			},
			source: probe.source,
		});
		await settle();
		const before = {
			channels: probe.channels(),
			feeds: probe.feeds(),
			infoAsks: probe.infoAsks(),
			producers,
		};

		expect(fold.reserveView(0)).toBeUndefined();
		expect({
			channels: probe.channels(),
			feeds: probe.feeds(),
			infoAsks: probe.infoAsks(),
			producers,
		}).toEqual(before);
		expect(fold.length()).toBe(0);
		await fold.close();
	});

	test("hands a session that arrives late the history it missed", async () => {
		const probe = fakeSource();
		const fold = createRoomFold({ source: probe.source });
		const early = fold.openView();
		const reader = early.stream(1)[Symbol.asyncIterator]();
		const pending = reader.next();
		await settle();
		probe.push(envelope(1), envelope(2));
		expect(await valueOf(pending)).toMatchObject({ seq: 1 });
		await settle();

		const late = fold.openView();
		const lateReader = late.stream(1)[Symbol.asyncIterator]();
		expect(await valueOf(lateReader.next())).toMatchObject({ seq: 1 });
		expect(await valueOf(lateReader.next())).toMatchObject({ seq: 2 });
		expect(probe.feeds()).toBe(1);

		await early.close();
		await late.close();
		await fold.close();
	});

	test("drops only the slow reader: the fast one keeps up and the feed keeps folding", async () => {
		const probe = fakeSource();
		const fold = createRoomFold({ sessionBudget: 2, source: probe.source });
		const fast = fold.openView();
		const slow = fold.openView();
		const fastReader = fast.stream(1)[Symbol.asyncIterator]();
		const slowReader = slow.stream(1)[Symbol.asyncIterator]();
		let pendingFast = fastReader.next();
		const pendingSlow = slowReader.next();
		await settle();

		let dropped = false;
		void slow.dropped.then(() => {
			dropped = true;
		});

		for (let seq = 1; seq <= 6; seq += 1) {
			probe.push(envelope(seq));
			expect(await valueOf(pendingFast)).toMatchObject({ seq });
			pendingFast = fastReader.next();
		}
		// The slow reader took exactly one envelope and then stopped reading.
		expect(await valueOf(pendingSlow)).toMatchObject({ seq: 1 });
		await settle();

		expect(dropped).toBe(true);
		expect(await doneOf(slowReader.next())).toBe(true);
		expect(fold.length()).toBe(6);

		// The Room is untouched: the fast reader still gets what lands next.
		probe.push(envelope(7));
		expect(await valueOf(pendingFast)).toMatchObject({ seq: 7 });

		await fast.close();
		await slow.close();
		await fold.close();
	});

	test("asks the Host for the room's identity card once and shares the answer", async () => {
		const probe = fakeSource();
		const fold = createRoomFold({ source: probe.source });
		const first = fold.openView();
		const second = fold.openView();

		expect(await first.info()).toEqual({ gameId: "fake", label: "the table" });
		expect(await second.info()).toEqual({ gameId: "fake", label: "the table" });
		expect(probe.infoAsks()).toBe(1);

		await first.close();
		await second.close();
		await fold.close();
	});

	test("gives every session its own submit channel and a fresh submission id", async () => {
		const probe = fakeSource();
		const fold = createRoomFold({ source: probe.source });
		const first = fold.openView();
		const second = fold.openView();

		await first.submit({ actor: "a", command: { type: "core.claim-seat" } });
		await second.submit({ actor: "b", command: { type: "core.claim-seat" } });

		expect(probe.channels()).toBe(2);
		const ids = probe.submissionIds();
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(2);
		expect(probe.commands().map((command) => command.actor)).toEqual([
			"a",
			"b",
		]);

		await first.close();
		await second.close();
		await fold.close();
	});

	test("ends every view's feed when the Host's feed ends", async () => {
		const probe = fakeSource();
		const fold = createRoomFold({ source: probe.source });
		const view = fold.openView();
		const reader = view.stream(1)[Symbol.asyncIterator]();
		const pending = reader.next();
		await settle();

		probe.endFeed();
		expect(await doneOf(pending)).toBe(true);

		await view.close();
		await fold.close();
	});

	test("refuses to submit through a closed view", async () => {
		const probe = fakeSource();
		const fold = createRoomFold({ source: probe.source });
		const view = fold.openView();
		await view.close();

		await expect(
			view.submit({ actor: "a", command: { type: "core.claim-seat" } })
		).rejects.toThrow("closed");
		await fold.close();
	});
});
