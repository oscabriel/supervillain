/* oxlint-disable vitest/prefer-importing-vitest-globals, eslint/require-await, eslint/max-classes-per-file, eslint/class-methods-use-this, promise/avoid-new, eslint/no-await-in-loop -- dual-lane broker suite: interface-shaped async fakes, a hand-rolled raw gateway, and deliberately sequential wire exchanges. */
import type {
	Envelope,
	RoomCommand,
	RoomStore,
	RoomSubmission,
} from "@supervillain/core";

import {
	createSubmissionMemory,
	decodeFrame,
	digestRoomCommand,
	encodeFrame,
	encodePipeHandshakeOutcome,
	encodeSubmitRequest,
	isControlFrame,
	openHostPipe,
	parsePipeHello,
	parseSubmitRequest,
	PIPE_PROTOCOL_VERSION,
	serveHostPipes,
	SubmissionUncertainError,
} from "../src/index.js";
import type {
	ClaimOutcome,
	HostPipeServer,
	PipeFrame,
	RoomOwnership,
	RoomView,
	TransportListener,
} from "../src/index.js";
import { createMemoryTransportHub, describe, expect, test } from "./harness.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const DOOR = { sshHost: "supervillain.test", sshPort: 2222 } as const;

const said = (text: string): RoomCommand => ({
	actor: "guest:abcdef123456",
	command: { text, type: "core.said" },
});

const envelope = (seq: number, actor = "gm-key"): Envelope => ({
	actor,
	payload: { text: `line ${seq}` },
	seq,
	timestamp: "2026-07-25T00:00:00.000Z",
	type: "core.said",
});

class FakeRoomStore implements RoomStore {
	readonly submissions: RoomCommand[] = [];
	readonly envelopes: Envelope[] = [];
	onSubmit: (() => Promise<void>) | undefined;
	#waiters: (() => void)[] = [];

	async submit(command: RoomCommand): Promise<RoomSubmission> {
		this.submissions.push(command);
		const next = envelope(this.envelopes.length + 1, command.actor);
		this.envelopes.push(next);
		for (const wake of this.#waiters.splice(0)) {
			wake();
		}
		await this.onSubmit?.();
		return { accepted: true, envelopes: [next] };
	}

	async *stream(fromSeq: number): AsyncGenerator<Envelope> {
		let index = fromSeq - 1;
		for (;;) {
			while (index < this.envelopes.length) {
				const next = this.envelopes[index];
				index += 1;
				if (next !== undefined) {
					yield next;
				}
			}
			await new Promise<void>((resolve) => {
				this.#waiters.push(resolve);
			});
		}
	}
}

class MemoryOwnership implements RoomOwnership {
	async claim(hostKey: string, _name: string): Promise<ClaimOutcome> {
		return { accepted: true, ownerId: `identity:${hostKey}` };
	}
}

const settle = async (turns = 6): Promise<void> => {
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

const untilLive = async (
	server: HostPipeServer,
	name: string,
	present: boolean
): Promise<void> => {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if ((server.live(name) !== undefined) === present) {
			return;
		}
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 5);
		});
	}
	throw new Error(
		`Room '${name}' never became ${present ? "live" : "offline"}.`
	);
};

const openView = (server: HostPipeServer, name: string): RoomView => {
	const live = server.live(name);
	if (live === undefined) {
		throw new Error(`Room '${name}' is not live.`);
	}
	return live.openStore();
};

/**
 * A gateway that speaks the wire by hand. The submission-id dedupe lives on the
 * Host, and the only way to watch it work is to replay an id the Host has
 * already answered — which the real gateway's channel mints, never repeats.
 */
const rawGateway = async (
	listener: TransportListener,
	room: string
): Promise<{
	readonly submit: (
		stream: number,
		command: RoomCommand,
		submissionId?: string
	) => Promise<RoomSubmission>;
	/** Sends a hand-crafted wire payload verbatim, for byte-order tests. */
	readonly submitRaw: (stream: number, wire: string) => Promise<RoomSubmission>;
	readonly close: () => Promise<void>;
}> => {
	const connection = await listener.accept();
	const hello = parsePipeHello(await connection.receive());
	expect(hello.versions).toContain(PIPE_PROTOCOL_VERSION);
	await connection.send(
		encodePipeHandshakeOutcome({
			accepted: true,
			version: PIPE_PROTOCOL_VERSION,
		})
	);
	/** The next whole message. Heartbeats and the stream-end frames the Host
	 * sends when it finishes an exchange are not messages. */
	const nextFrame = async (): Promise<PipeFrame> => {
		for (;;) {
			const frame = decodeFrame(await connection.receive());
			if (!isControlFrame(frame) && frame.kind === "last") {
				return frame;
			}
		}
	};
	const registration = await nextFrame();
	expect(registration.channel).toBe("register");
	await connection.send(
		encodeFrame({
			channel: "register",
			kind: "last",
			payload: encoder.encode(JSON.stringify({ accepted: true, ...DOOR })),
			room,
			stream: registration.stream,
		})
	);
	const submitRaw = async (
		stream: number,
		wire: string
	): Promise<RoomSubmission> => {
		await connection.send(
			encodeFrame({
				channel: "submit",
				kind: "last",
				payload: encoder.encode(wire),
				room,
				stream,
			})
		);
		const answer = await nextFrame();
		return JSON.parse(decoder.decode(answer.payload)) as RoomSubmission;
	};
	return {
		close: () => connection.close(),
		submit: (stream, command, submissionId) =>
			submitRaw(
				stream,
				JSON.stringify(
					submissionId === undefined
						? command
						: { ...command, id: submissionId }
				)
			),
		submitRaw,
	};
};

describe("the submission memory", () => {
	test("answers a remembered id and forgets the oldest past its limit", () => {
		const memory = createSubmissionMemory(2);
		const accepted: RoomSubmission = { accepted: true, envelopes: [] };

		memory.remember("one", "digest-one", accepted);
		memory.remember("two", "digest-two", accepted);
		expect(memory.recall("one")).toEqual({
			digest: "digest-one",
			submission: accepted,
		});

		memory.remember("three", "digest-three", accepted);
		expect(memory.size()).toBe(2);
		expect(memory.recall("one")).toBeUndefined();
		expect(memory.recall("three")).toEqual({
			digest: "digest-three",
			submission: accepted,
		});
	});

	test("binds an id to its command's canonical digest, not its wire shape", async () => {
		const command: RoomCommand = {
			actor: "guest:abcdef123456",
			command: { text: "one", type: "core.said" },
		};

		// Hand-built JSON with the keys in a different order: the same command.
		const reserialized = JSON.parse(
			'{"command":{"type":"core.said","text":"one"},"actor":"guest:abcdef123456"}'
		) as RoomCommand;
		expect(digestRoomCommand(command)).toBe(digestRoomCommand(reserialized));
		expect(digestRoomCommand(command)).not.toBe(
			digestRoomCommand({
				...command,
				command: { text: "two", type: "core.said" },
			})
		);
	});
});

describe("the submit request", () => {
	test("carries its id on the wire and survives a sender that mints none", () => {
		const command: RoomCommand = {
			actor: "guest:abcdef123456",
			command: { type: "core.claim-seat" },
		};

		expect(
			parseSubmitRequest(
				JSON.parse(
					decoder.decode(
						encodeSubmitRequest({ command, submissionId: "submission-1" })
					)
				)
			)
		).toEqual({ command, submissionId: "submission-1" });
		expect(
			parseSubmitRequest(
				JSON.parse(decoder.decode(encodeSubmitRequest({ command })))
			)
		).toEqual({ command });
	});
});

describe("submission-id dedupe", () => {
	test("a replayed id appends once and answers what it answered before", async () => {
		const hub = createMemoryTransportHub();
		const store = new FakeRoomStore();
		const host = openHostPipe({
			dialer: hub.dialer("host-key"),
			heartbeatIntervalMs: 0,
			rooms: [
				{ info: { gameId: "fake", label: "the table" }, name: "keep", store },
			],
		});
		const gateway = await rawGateway(hub.listener, "keep");
		await host.attached;

		const command: RoomCommand = {
			actor: "guest:abcdef123456",
			command: { type: "core.claim-seat" },
		};
		const first = await gateway.submit(2, command, "submission-1");
		// The answer was lost in flight, so the same id is written again on a
		// fresh stream. It must not append twice.
		const replay = await gateway.submit(4, command, "submission-1");

		expect(first).toMatchObject({ accepted: true });
		expect(replay).toEqual(first);
		expect(store.submissions).toHaveLength(1);

		const fresh = await gateway.submit(6, command, "submission-2");
		expect(fresh).toMatchObject({ accepted: true });
		expect(store.submissions).toHaveLength(2);

		await gateway.close();
		await host.close();
		await hub.listener.close();
	});

	test("a submission carrying no id is applied every time it arrives", async () => {
		const hub = createMemoryTransportHub();
		const store = new FakeRoomStore();
		const host = openHostPipe({
			dialer: hub.dialer("host-key"),
			heartbeatIntervalMs: 0,
			rooms: [
				{ info: { gameId: "fake", label: "the table" }, name: "keep", store },
			],
		});
		const gateway = await rawGateway(hub.listener, "keep");
		await host.attached;

		const command: RoomCommand = {
			actor: "guest:abcdef123456",
			command: { type: "core.claim-seat" },
		};
		await gateway.submit(2, command);
		await gateway.submit(4, command);
		expect(store.submissions).toHaveLength(2);

		await gateway.close();
		await host.close();
		await hub.listener.close();
	});

	test("a replayed id carrying a different command is refused and never applied", async () => {
		const hub = createMemoryTransportHub();
		const store = new FakeRoomStore();
		const host = openHostPipe({
			dialer: hub.dialer("host-key"),
			heartbeatIntervalMs: 0,
			rooms: [
				{ info: { gameId: "fake", label: "the table" }, name: "keep", store },
			],
		});
		const gateway = await rawGateway(hub.listener, "keep");
		await host.attached;

		const first = await gateway.submit(2, said("one"), "submission-1");
		expect(first).toMatchObject({ accepted: true });

		// The same id arrives wearing a different command: a hijacked or
		// corrupted resend. It must be refused on the submit channel, never
		// answered from memory, and never applied.
		const hijack = await gateway.submit(4, said("two"), "submission-1");
		expect(hijack.rejected).toBe(true);
		expect(store.submissions).toHaveLength(1);

		// The refusal leaves the id's own memory untouched: the original
		// command still dedupes to the answer it first got.
		const stillOriginal = await gateway.submit(6, said("one"), "submission-1");
		expect(stillOriginal).toEqual(first);
		expect(store.submissions).toHaveLength(1);

		await gateway.close();
		await host.close();
		await hub.listener.close();
	});

	test("a replayed id whose command only differs in key order is answered from memory", async () => {
		const hub = createMemoryTransportHub();
		const store = new FakeRoomStore();
		const host = openHostPipe({
			dialer: hub.dialer("host-key"),
			heartbeatIntervalMs: 0,
			rooms: [
				{ info: { gameId: "fake", label: "the table" }, name: "keep", store },
			],
		});
		const gateway = await rawGateway(hub.listener, "keep");
		await host.attached;

		const command: RoomCommand = {
			actor: "guest:abcdef123456",
			command: { text: "one", type: "core.said" },
		};
		const first = await gateway.submit(2, command, "submission-1");
		expect(first).toMatchObject({ accepted: true });

		// A reserializer rewrote the JSON on its way through: same command,
		// different byte order. The answer must still be the remembered one.
		const replay = await gateway.submitRaw(
			4,
			'{"id":"submission-1","actor":"guest:abcdef123456","command":{"type":"core.said","text":"one"}}'
		);
		expect(replay).toEqual(first);
		expect(store.submissions).toHaveLength(1);

		await gateway.close();
		await host.close();
		await hub.listener.close();
	});

	test("a different id carrying the same command is applied again", async () => {
		const hub = createMemoryTransportHub();
		const store = new FakeRoomStore();
		const host = openHostPipe({
			dialer: hub.dialer("host-key"),
			heartbeatIntervalMs: 0,
			rooms: [
				{ info: { gameId: "fake", label: "the table" }, name: "keep", store },
			],
		});
		const gateway = await rawGateway(hub.listener, "keep");
		await host.attached;

		// Duplicate commands are legal; only ids are unique.
		const command: RoomCommand = {
			actor: "guest:abcdef123456",
			command: { type: "core.claim-seat" },
		};
		const one = await gateway.submit(2, command, "submission-1");
		const two = await gateway.submit(4, command, "submission-2");
		expect(one).toMatchObject({ accepted: true });
		expect(two).toMatchObject({ accepted: true });
		expect(store.submissions).toHaveLength(2);

		await gateway.close();
		await host.close();
		await hub.listener.close();
	});

	test("an id evicted from memory is reusable for a new command, with no evidence it was ever used", async () => {
		const hub = createMemoryTransportHub();
		const store = new FakeRoomStore();
		// One slot: the next remember evicts the first id. This is the accepted
		// NQ-11 window, memory-only and bounded, not a bug.
		const host = openHostPipe({
			dialer: hub.dialer("host-key"),
			heartbeatIntervalMs: 0,
			rooms: [
				{ info: { gameId: "fake", label: "the table" }, name: "keep", store },
			],
			submissionMemory: 1,
		});
		const gateway = await rawGateway(hub.listener, "keep");
		await host.attached;

		await gateway.submit(2, said("one"), "submission-1");
		// The next remember evicts submission-1.
		await gateway.submit(4, said("two"), "submission-2");
		const afterEviction = await gateway.submit(
			6,
			said("three"),
			"submission-1"
		);
		expect(afterEviction).toMatchObject({ accepted: true });
		expect(store.submissions).toHaveLength(3);

		await gateway.close();
		await host.close();
		await hub.listener.close();
	});
});

describe("the gateway's per-Room fold", () => {
	test("multiplexes several sessions in several rooms over one pipe", async () => {
		const hub = createMemoryTransportHub();
		const keep = new FakeRoomStore();
		const vault = new FakeRoomStore();
		const pipes = serveHostPipes({
			door: DOOR,
			listener: hub.listener,
			ownership: new MemoryOwnership(),
		});
		const host = openHostPipe({
			dialer: hub.dialer("host-key"),
			heartbeatIntervalMs: 0,
			rooms: [
				{
					info: { gameId: "fake", label: "the keep" },
					name: "keep",
					store: keep,
				},
				{
					info: { gameId: "fake", label: "the vault" },
					name: "vault",
					store: vault,
				},
			],
		});
		await host.attached;
		await untilLive(pipes, "keep", true);
		await untilLive(pipes, "vault", true);

		const first = openView(pipes, "keep");
		const second = openView(pipes, "keep");
		const other = openView(pipes, "vault");
		const readers = [
			first.stream(1)[Symbol.asyncIterator](),
			second.stream(1)[Symbol.asyncIterator](),
		];
		const otherReader = other.stream(1)[Symbol.asyncIterator]();
		const pending = readers.map((reader) => reader.next());
		const pendingOther = otherReader.next();
		await settle();

		expect(await first.info()).toEqual({ gameId: "fake", label: "the keep" });
		expect(await other.info()).toEqual({ gameId: "fake", label: "the vault" });
		await first.submit({
			actor: "guest:abcdef123456",
			command: { type: "core.claim-seat" },
		});

		// Both seats in the keep see the keep's envelope; the vault sees nothing.
		for (const result of pending) {
			expect(await valueOf(result)).toMatchObject({ seq: 1 });
		}
		expect(keep.submissions).toHaveLength(1);
		expect(vault.submissions).toHaveLength(0);

		await other.submit({
			actor: "guest:beefbeefbeef",
			command: { type: "core.claim-seat" },
		});
		expect(await valueOf(pendingOther)).toMatchObject({
			actor: "guest:beefbeefbeef",
		});

		await first.close();
		await second.close();
		await other.close();
		await host.close();
		await pipes.close();
		await hub.listener.close();
	});

	test("a slow reader stalls only itself; the Room and the pipe keep going", async () => {
		const hub = createMemoryTransportHub();
		const store = new FakeRoomStore();
		const dropped: string[] = [];
		const pipes = serveHostPipes({
			door: DOOR,
			listener: hub.listener,
			onEvent: (event) => {
				if (event.kind === "view-dropped") {
					dropped.push(event.room);
				}
			},
			ownership: new MemoryOwnership(),
			sessionBudget: 2,
		});
		const host = openHostPipe({
			dialer: hub.dialer("host-key"),
			heartbeatIntervalMs: 0,
			rooms: [
				{ info: { gameId: "fake", label: "the keep" }, name: "keep", store },
			],
		});
		await host.attached;
		await untilLive(pipes, "keep", true);

		const fast = openView(pipes, "keep");
		const slow = openView(pipes, "keep");
		const fastReader = fast.stream(1)[Symbol.asyncIterator]();
		const slowReader = slow.stream(1)[Symbol.asyncIterator]();
		let pendingFast = fastReader.next();
		const pendingSlow = slowReader.next();
		await settle();

		let slowDropped = false;
		void slow.dropped.then(() => {
			slowDropped = true;
		});

		for (let turn = 1; turn <= 8; turn += 1) {
			await fast.submit({
				actor: "guest:abcdef123456",
				command: { text: `turn ${turn}`, type: "core.chat" },
			});
			expect(await valueOf(pendingFast)).toMatchObject({ seq: turn });
			pendingFast = fastReader.next();
		}
		expect(await valueOf(pendingSlow)).toMatchObject({ seq: 1 });
		await settle();

		expect(slowDropped).toBe(true);
		expect(await doneOf(slowReader.next())).toBe(true);
		expect(dropped).toContain("keep");
		// The Host pipe never blocked: the Room is still live and still serving.
		expect(pipes.live("keep")).toBeDefined();
		await fast.submit({
			actor: "guest:abcdef123456",
			command: { text: "still here", type: "core.chat" },
		});
		expect(await valueOf(pendingFast)).toMatchObject({ seq: 9 });

		await fast.close();
		await slow.close();
		await host.close();
		await pipes.close();
		await hub.listener.close();
	});

	test("surfaces a lost answer as uncertain and never resubmits it", async () => {
		const hub = createMemoryTransportHub();
		const dialer = hub.dialer("host-key");
		const store = new FakeRoomStore();
		const pipes = serveHostPipes({
			door: DOOR,
			listener: hub.listener,
			ownership: new MemoryOwnership(),
		});
		const host = openHostPipe({
			dialer,
			heartbeatIntervalMs: 0,
			reconnectDelayMs: () => 5,
			rooms: [
				{ info: { gameId: "fake", label: "the keep" }, name: "keep", store },
			],
		});
		await host.attached;
		await untilLive(pipes, "keep", true);
		const view = openView(pipes, "keep");
		// The command lands, and then the pipe dies before its answer can travel.
		store.onSubmit = () => dialer.dropConnections();

		await expect(
			view.submit({
				actor: "guest:abcdef123456",
				command: { type: "core.claim-seat" },
			})
		).rejects.toBeInstanceOf(SubmissionUncertainError);
		store.onSubmit = undefined;
		await settle();

		// Exactly once or not at all: nothing here retried on the player's behalf.
		expect(store.submissions).toHaveLength(1);

		await view.close();
		await host.close();
		await pipes.close();
		await hub.listener.close();
	});
});
