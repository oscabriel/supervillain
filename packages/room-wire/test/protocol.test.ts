/* oxlint-disable vitest/prefer-importing-vitest-globals, eslint/no-await-in-loop, promise/avoid-new, eslint/no-loop-func, unicorn/no-await-expression-member, eslint/no-promise-executor-return -- dual-lane protocol suite uses ordered stream reads, explicit controllable promises, and direct envelope sequence assertions. */
import type {
	Envelope,
	NamespacedType,
	RoomCommand,
	RoomStore,
	RoomSubmission,
} from "@supervillain/core";

import { connectRoomStore, serveRoomStore } from "../src/index.js";
import type { RemoteRoomStoreOptions } from "../src/index.js";
import { createMemoryEndpointPair, describe, expect, test } from "./harness.js";

interface Waiter {
	readonly afterSeq: number;
	readonly push: (envelope: Envelope) => void;
}

class TestRoomStore implements RoomStore {
	readonly envelopes: Envelope[] = [];
	readonly submissions: RoomCommand[] = [];
	readonly #waiters = new Set<Waiter>();
	blockSubmit: Promise<void> | undefined;

	async submit(command: RoomCommand): Promise<RoomSubmission> {
		this.submissions.push(command);
		await this.blockSubmit;
		const envelope = this.append(
			"test.commanded",
			command.command,
			command.actor
		);
		return { accepted: true, envelopes: [envelope] };
	}

	stream(fromSeq: number): AsyncIterable<Envelope> {
		const { envelopes } = this;
		const waiters = this.#waiters;
		return {
			async *[Symbol.asyncIterator]() {
				const pending: Envelope[] = [];
				let wake: (() => void) | undefined;
				const waiter: Waiter = {
					afterSeq: envelopes.length,
					push: (envelope) => {
						pending.push(envelope);
						wake?.();
					},
				};
				waiters.add(waiter);
				try {
					for (const envelope of envelopes) {
						if (envelope.seq >= fromSeq && envelope.seq <= waiter.afterSeq) {
							yield envelope;
						}
					}
					for (;;) {
						if (pending.length === 0) {
							await new Promise<void>((resolve) => {
								wake = resolve;
							});
							wake = undefined;
						}
						const envelope = pending.shift();
						if (envelope !== undefined && envelope.seq >= fromSeq) {
							yield envelope;
						}
					}
				} finally {
					waiters.delete(waiter);
				}
			},
		};
	}

	append(
		type: NamespacedType,
		payload: unknown,
		actor = "server-id"
	): Envelope {
		const envelope: Envelope = {
			actor,
			payload,
			seq: this.envelopes.length + 1,
			timestamp: "2026-01-01T00:00:00.000Z",
			type,
		};
		this.envelopes.push(envelope);
		for (const waiter of this.#waiters) {
			waiter.push(envelope);
		}
		return envelope;
	}
}

const nextEnvelope = async (
	iterator: AsyncIterator<Envelope>
): Promise<Envelope> => {
	const result = await iterator.next();
	if (result.done === true) {
		throw new Error("RoomStore stream ended early.");
	}
	return result.value;
};

const openFixture = async (options: RemoteRoomStoreOptions = {}) => {
	const endpoints = createMemoryEndpointPair();
	const local = new TestRoomStore();
	const server = serveRoomStore(endpoints.server, local, {
		info: { gameId: "test", label: "Test Room" },
	});
	const remote = await connectRoomStore(
		endpoints.client,
		endpoints.server.address,
		{
			reconnectDelayMs: () => 1,
			...options,
		}
	);
	return { endpoints, local, remote, server };
};

describe("RoomStore wire protocol", () => {
	test("round-trips authenticated submissions and room info", async () => {
		const fixture = await openFixture();
		try {
			expect(await fixture.remote.info()).toEqual({
				gameId: "test",
				label: "Test Room",
			});
			expect(
				await fixture.remote.submit({
					actor: "client-id",
					command: { type: "test.command" },
				})
			).toMatchObject({ accepted: true, envelopes: [{ seq: 1 }] });
			expect(fixture.local.submissions).toHaveLength(1);
		} finally {
			await fixture.remote.close();
			await fixture.server.close();
		}
	});

	test("rejects an actor mismatch without submitting to the store", async () => {
		const fixture = await openFixture();
		try {
			expect(
				await fixture.remote.submit({
					actor: "forged-id",
					command: { type: "test.command" },
				})
			).toEqual({
				message: "Actor does not match the connection identity.",
				rejected: true,
			});
			expect(fixture.local.submissions).toHaveLength(0);
			expect(fixture.local.envelopes).toHaveLength(0);
		} finally {
			await fixture.remote.close();
			await fixture.server.close();
		}
	});

	test("streams from the beginning and the middle of a Log", async () => {
		const fixture = await openFixture();
		fixture.local.append("test.first", {});
		fixture.local.append("test.second", {});
		fixture.local.append("test.third", {});
		try {
			const all = fixture.remote.stream(1)[Symbol.asyncIterator]();
			const middle = fixture.remote.stream(2)[Symbol.asyncIterator]();
			expect([
				(await nextEnvelope(all)).seq,
				(await nextEnvelope(all)).seq,
				(await nextEnvelope(all)).seq,
			]).toEqual([1, 2, 3]);
			expect([
				(await nextEnvelope(middle)).seq,
				(await nextEnvelope(middle)).seq,
			]).toEqual([2, 3]);
			await all.return?.();
			await middle.return?.();
		} finally {
			await fixture.remote.close();
			await fixture.server.close();
		}
	});

	test("reconnects a dropped stream without a gap or repeat", async () => {
		const fixture = await openFixture();
		fixture.local.append("test.first", {});
		fixture.local.append("test.second", {});
		const iterator = fixture.remote.stream(1)[Symbol.asyncIterator]();
		try {
			const sequences = [(await nextEnvelope(iterator)).seq];
			await fixture.endpoints.client.dropConnections();
			fixture.local.append("test.third", {});
			sequences.push(
				(await nextEnvelope(iterator)).seq,
				(await nextEnvelope(iterator)).seq
			);
			expect(sequences).toEqual([1, 2, 3]);
		} finally {
			await iterator.return?.();
			await fixture.remote.close();
			await fixture.server.close();
		}
	});

	test("redials submit after a drop but never retries a mid-flight submission", async () => {
		const fixture = await openFixture();
		try {
			await fixture.endpoints.client.dropConnections();
			expect(
				await fixture.remote.submit({
					actor: "client-id",
					command: { number: 1 },
				})
			).toMatchObject({ accepted: true });

			let release!: () => void;
			fixture.local.blockSubmit = new Promise<void>((resolve) => {
				release = resolve;
			});
			const pending = fixture.remote.submit({
				actor: "client-id",
				command: { number: 2 },
			});
			while (fixture.local.submissions.length < 2) {
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
			await fixture.endpoints.client.dropConnections();
			await expect(pending).rejects.toThrow();
			release();
			fixture.local.blockSubmit = undefined;
			expect(fixture.local.submissions).toHaveLength(2);
		} finally {
			await fixture.remote.close();
			await fixture.server.close();
		}
	});

	test("times out a submit, discards its connection, and never retries it", async () => {
		const fixture = await openFixture({ submitTimeoutMs: 10 });
		let release!: () => void;
		fixture.local.blockSubmit = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			await expect(
				fixture.remote.submit({
					actor: "client-id",
					command: { number: 1 },
				})
			).rejects.toThrow("RoomStore submit timed out.");
			expect(fixture.local.submissions).toHaveLength(1);

			release();
			fixture.local.blockSubmit = undefined;
			await expect(
				fixture.remote.submit({
					actor: "client-id",
					command: { number: 2 },
				})
			).resolves.toMatchObject({ accepted: true });
			expect(
				fixture.local.submissions.map((submission) => submission.command)
			).toEqual([{ number: 1 }, { number: 2 }]);
		} finally {
			release();
			await fixture.remote.close();
			await fixture.server.close();
		}
	});

	test("closes idempotently and ends or rejects operations with the pinned error", async () => {
		const fixture = await openFixture();
		const iterator = fixture.remote.stream(1)[Symbol.asyncIterator]();
		const pending = iterator.next();
		await new Promise((resolve) => setTimeout(resolve, 1));
		await fixture.remote.close();
		await fixture.remote.close();
		expect((await pending).done).toBe(true);
		await expect(
			fixture.remote.submit({ actor: "client-id", command: {} })
		).rejects.toThrow("Remote RoomStore is closed.");
		await expect(
			fixture.remote.stream(1)[Symbol.asyncIterator]().next()
		).rejects.toThrow("Remote RoomStore is closed.");
		await fixture.server.close();
	});
});
