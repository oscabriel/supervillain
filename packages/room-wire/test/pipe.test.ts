/* oxlint-disable vitest/prefer-importing-vitest-globals, eslint/require-await, eslint/max-classes-per-file, eslint/class-methods-use-this, promise/avoid-new, eslint/no-await-in-loop -- dual-lane pipe suite: interface-shaped async fakes, a hand-rolled raw Host, and sequential wire exchanges. */
import type {
	Envelope,
	RoomCommand,
	RoomStore,
	RoomSubmission,
} from "@supervillain/core";

import {
	chunkPayload,
	decodeFrame,
	encodeFrame,
	encodePipeHello,
	isControlFrame,
	MAX_FRAME_PAYLOAD_BYTES,
	negotiatePipeVersion,
	openHostPipe,
	parsePipeHandshakeOutcome,
	PIPE_PROTOCOL_VERSION,
	serveHostPipes,
	SUPPORTED_PIPE_PROTOCOL_VERSIONS,
} from "../src/index.js";
import type {
	ClaimOutcome,
	HostPipeServer,
	PipeFrame,
	RoomOwnership,
	TransportDialer,
} from "../src/index.js";
import { createMemoryTransportHub, describe, expect, test } from "./harness.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const DOOR = { sshHost: "supervillain.test", sshPort: 2222 } as const;
const FAST_RECONNECT = (): number => 1;

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
	#waiters: (() => void)[] = [];

	constructor(seeded: readonly Envelope[] = []) {
		this.envelopes.push(...seeded);
	}

	async submit(command: RoomCommand): Promise<RoomSubmission> {
		this.submissions.push(command);
		const next = envelope(this.envelopes.length + 1, command.actor);
		this.envelopes.push(next);
		for (const wake of this.#waiters.splice(0)) {
			wake();
		}
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
	readonly names = new Map<string, string>();
	readonly identities = new Map<string, string>();

	async claim(hostKey: string, name: string): Promise<ClaimOutcome> {
		const ownerId = this.identities.get(hostKey) ?? `identity:${hostKey}`;
		this.identities.set(hostKey, ownerId);
		const existing = this.names.get(name);
		if (existing !== undefined && existing !== ownerId) {
			return {
				message: `The name '${name}' is already claimed by another key.`,
				rejected: true,
			};
		}
		this.names.set(name, ownerId);
		return { accepted: true, ownerId };
	}
}

const settle = async (turns = 6): Promise<void> => {
	for (let turn = 0; turn < turns; turn += 1) {
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 1);
		});
	}
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

/** A Host that speaks the wire by hand: it can register and then fall silent,
 * which is the only way to watch a heartbeat go unanswered. */
const rawHost = async (
	dialer: TransportDialer,
	name: string
): Promise<{ readonly close: () => Promise<void> }> => {
	const connection = await dialer.dial();
	await connection.send(
		encodePipeHello({ versions: SUPPORTED_PIPE_PROTOCOL_VERSIONS })
	);
	const outcome = parsePipeHandshakeOutcome(await connection.receive());
	expect(outcome).toEqual({ accepted: true, version: PIPE_PROTOCOL_VERSION });
	await connection.send(
		encodeFrame({
			channel: "register",
			kind: "last",
			payload: encoder.encode(JSON.stringify({ name })),
			room: name,
			stream: 1,
		})
	);
	for (;;) {
		const frame = decodeFrame(await connection.receive());
		if (!isControlFrame(frame) && frame.kind === "last") {
			expect(JSON.parse(decoder.decode(frame.payload))).toMatchObject({
				accepted: true,
			});
			break;
		}
	}
	return { close: () => connection.close() };
};

describe("frame protocol", () => {
	test("round-trips a frame's room, channel, stream, and payload", () => {
		const frame: PipeFrame = {
			channel: "submit",
			kind: "last",
			payload: encoder.encode("hello"),
			room: "iron-keep",
			stream: 7,
		};
		const decoded = decodeFrame(encodeFrame(frame));
		expect(isControlFrame(decoded)).toBe(false);
		expect(decoded).toMatchObject({
			channel: "submit",
			kind: "last",
			room: "iron-keep",
			stream: 7,
		});
		if (!isControlFrame(decoded)) {
			expect(decoder.decode(decoded.payload)).toBe("hello");
		}
	});

	test("chunks a large payload into bounded frames", () => {
		const payload = new Uint8Array(MAX_FRAME_PAYLOAD_BYTES * 2 + 17);
		const chunks = chunkPayload(payload);
		expect(chunks.length).toBe(3);
		for (const chunk of chunks) {
			expect(chunk.byteLength).toBeLessThanOrEqual(MAX_FRAME_PAYLOAD_BYTES);
		}
		expect(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)).toBe(
			payload.byteLength
		);
	});

	test("refuses an unknown version instead of downgrading", () => {
		expect(negotiatePipeVersion([PIPE_PROTOCOL_VERSION])).toBe(
			PIPE_PROTOCOL_VERSION
		);
		expect(negotiatePipeVersion([99])).toBe(undefined);
		expect(negotiatePipeVersion([])).toBe(undefined);
	});
});

describe("the Host pipe", () => {
	test("claims a name, attaches, and answers info, submit, and stream", async () => {
		const hub = createMemoryTransportHub("gateway-key");
		const ownership = new MemoryOwnership();
		const server = serveHostPipes({
			door: DOOR,
			listener: hub.listener,
			ownership,
		});
		const store = new FakeRoomStore([envelope(1)]);
		const host = openHostPipe({
			dialer: hub.dialer("gm-key"),
			rooms: [
				{
					info: { gameId: "fake", label: "the table" },
					name: "iron-keep",
					store,
				},
			],
		});
		const attachment = await host.attached;
		expect(attachment).toEqual({
			gatewayId: "gateway-key",
			sshHost: "supervillain.test",
			sshPort: 2222,
		});
		await untilLive(server, "iron-keep", true);
		const live = server.live("iron-keep");
		expect(live?.hostKey).toBe("gm-key");
		expect(live?.ownerId).toBe("identity:gm-key");

		const view = live?.openStore();
		if (view === undefined) {
			throw new Error("no live room");
		}
		expect(await view.info()).toEqual({ gameId: "fake", label: "the table" });
		const submission = await view.submit({
			actor: "guest:abc123",
			command: { type: "core.claim-seat" },
		});
		expect(submission).toMatchObject({ accepted: true });
		expect(store.submissions).toEqual([
			{ actor: "guest:abc123", command: { type: "core.claim-seat" } },
		]);
		const seen: Envelope[] = [];
		for await (const one of view.stream(1)) {
			seen.push(one);
			if (seen.length === 2) {
				break;
			}
		}
		expect(seen.map((one) => one.seq)).toEqual([1, 2]);
		await view.close();
		await host.close();
		await server.close();
	});

	test("multiplexes two rooms over one pipe, correctly tagged", async () => {
		const hub = createMemoryTransportHub("gateway-key");
		const server = serveHostPipes({
			door: DOOR,
			listener: hub.listener,
			ownership: new MemoryOwnership(),
		});
		const keep = new FakeRoomStore();
		const cellar = new FakeRoomStore();
		const host = openHostPipe({
			dialer: hub.dialer("gm-key"),
			rooms: [
				{
					info: { gameId: "fake", label: "keep" },
					name: "iron-keep",
					store: keep,
				},
				{
					info: { gameId: "fake", label: "cellar" },
					name: "wine-cellar",
					store: cellar,
				},
			],
		});
		await host.attached;
		await untilLive(server, "wine-cellar", true);
		const keepView = server.live("iron-keep")?.openStore();
		const cellarView = server.live("wine-cellar")?.openStore();
		if (keepView === undefined || cellarView === undefined) {
			throw new Error("both rooms should be live");
		}
		const [keepInfo, cellarInfo] = await Promise.all([
			keepView.info(),
			cellarView.info(),
		]);
		expect(keepInfo.label).toBe("keep");
		expect(cellarInfo.label).toBe("cellar");
		await Promise.all([
			keepView.submit({ actor: "a", command: { type: "core.claim-seat" } }),
			cellarView.submit({ actor: "b", command: { type: "core.claim-seat" } }),
		]);
		expect(keep.submissions.map((one) => one.actor)).toEqual(["a"]);
		expect(cellar.submissions.map((one) => one.actor)).toEqual(["b"]);
		await keepView.close();
		await cellarView.close();
		await host.close();
		await server.close();
	});

	test("carries a payload larger than one frame", async () => {
		const hub = createMemoryTransportHub("gateway-key");
		const server = serveHostPipes({
			door: DOOR,
			listener: hub.listener,
			ownership: new MemoryOwnership(),
		});
		const label = "x".repeat(MAX_FRAME_PAYLOAD_BYTES * 2 + 5);
		const host = openHostPipe({
			dialer: hub.dialer("gm-key"),
			rooms: [
				{
					info: { gameId: "fake", label },
					name: "iron-keep",
					store: new FakeRoomStore(),
				},
			],
		});
		await host.attached;
		await untilLive(server, "iron-keep", true);
		const view = server.live("iron-keep")?.openStore();
		if (view === undefined) {
			throw new Error("no live room");
		}
		const info = await view.info();
		expect(info.label).toBe(label);
		await view.close();
		await host.close();
		await server.close();
	});

	test("rejects a name another identity owns, and does not redial into it", async () => {
		const hub = createMemoryTransportHub("gateway-key");
		const ownership = new MemoryOwnership();
		const server = serveHostPipes({
			door: DOOR,
			listener: hub.listener,
			ownership,
		});
		const first = openHostPipe({
			dialer: hub.dialer("gm-key"),
			rooms: [
				{
					info: { gameId: "fake", label: "keep" },
					name: "iron-keep",
					store: new FakeRoomStore(),
				},
			],
		});
		await first.attached;
		const thief = openHostPipe({
			dialer: hub.dialer("thief-key"),
			reconnectDelayMs: FAST_RECONNECT,
			rooms: [
				{
					info: { gameId: "fake", label: "keep" },
					name: "iron-keep",
					store: new FakeRoomStore(),
				},
			],
		});
		await expect(thief.attached).rejects.toThrow(
			"already claimed by another key"
		);
		expect(server.live("iron-keep")?.hostKey).toBe("gm-key");
		await thief.close();
		await first.close();
		await server.close();
	});

	test("lets the same identity supersede its own live registration", async () => {
		const hub = createMemoryTransportHub("gateway-key");
		const ownership = new MemoryOwnership();
		const server = serveHostPipes({
			door: DOOR,
			listener: hub.listener,
			ownership,
		});
		const room = {
			info: { gameId: "fake", label: "keep" },
			name: "iron-keep",
			store: new FakeRoomStore(),
		};
		const first = openHostPipe({ dialer: hub.dialer("gm-key"), rooms: [room] });
		await first.attached;
		const second = openHostPipe({
			dialer: hub.dialer("gm-key"),
			rooms: [room],
		});
		await second.attached;
		await untilLive(server, "iron-keep", true);
		expect(server.liveNames()).toEqual(["iron-keep"]);
		await first.close();
		await settle();
		// The superseded pipe closing must not take the live registration with it.
		expect(server.live("iron-keep")).toBeDefined();
		await second.close();
		await server.close();
	});

	test("redials after the gateway drops the pipe", async () => {
		const hub = createMemoryTransportHub("gateway-key");
		const server = serveHostPipes({
			door: DOOR,
			listener: hub.listener,
			ownership: new MemoryOwnership(),
		});
		const host = openHostPipe({
			dialer: hub.dialer("gm-key"),
			reconnectDelayMs: FAST_RECONNECT,
			rooms: [
				{
					info: { gameId: "fake", label: "keep" },
					name: "iron-keep",
					store: new FakeRoomStore(),
				},
			],
		});
		await host.attached;
		await untilLive(server, "iron-keep", true);
		await hub.listener.dropConnections();
		await untilLive(server, "iron-keep", false);
		await untilLive(server, "iron-keep", true);
		await host.close();
		await server.close();
	});

	test("clean shutdown from the Host leaves no live registration", async () => {
		const hub = createMemoryTransportHub("gateway-key");
		const server = serveHostPipes({
			door: DOOR,
			listener: hub.listener,
			ownership: new MemoryOwnership(),
		});
		const host = openHostPipe({
			dialer: hub.dialer("gm-key"),
			rooms: [
				{
					info: { gameId: "fake", label: "keep" },
					name: "iron-keep",
					store: new FakeRoomStore(),
				},
			],
		});
		await host.attached;
		await untilLive(server, "iron-keep", true);
		await host.close();
		await untilLive(server, "iron-keep", false);
		expect(server.liveNames()).toEqual([]);
		await server.close();
	});

	test("clean shutdown from the gateway leaves no live registration", async () => {
		const hub = createMemoryTransportHub("gateway-key");
		const server = serveHostPipes({
			door: DOOR,
			listener: hub.listener,
			ownership: new MemoryOwnership(),
		});
		const host = openHostPipe({
			dialer: hub.dialer("gm-key"),
			reconnectDelayMs: FAST_RECONNECT,
			rooms: [
				{
					info: { gameId: "fake", label: "keep" },
					name: "iron-keep",
					store: new FakeRoomStore(),
				},
			],
		});
		await host.attached;
		await untilLive(server, "iron-keep", true);
		await server.close();
		expect(server.liveNames()).toEqual([]);
		await host.close();
	});

	test("refuses a protocol version it does not speak", async () => {
		const hub = createMemoryTransportHub("gateway-key");
		const events: string[] = [];
		const server = serveHostPipes({
			door: DOOR,
			listener: hub.listener,
			onEvent: (event) => events.push(event.kind),
			ownership: new MemoryOwnership(),
		});
		const connection = await hub.dialer("gm-key").dial();
		await connection.send(encodePipeHello({ versions: [99] }));
		const outcome = parsePipeHandshakeOutcome(await connection.receive());
		expect(outcome).toMatchObject({ rejected: true });
		expect(events).toContain("pipe-refused");
		await connection.close();
		await server.close();
	});

	test("marks a room offline when the heartbeat goes unanswered", async () => {
		const hub = createMemoryTransportHub("gateway-key");
		const offline: string[] = [];
		const server = serveHostPipes({
			door: DOOR,
			heartbeatIntervalMs: 5,
			heartbeatMisses: 2,
			listener: hub.listener,
			onEvent: (event) => {
				if (event.kind === "room-offline") {
					offline.push(event.room);
				}
			},
			ownership: new MemoryOwnership(),
		});
		const silent = await rawHost(hub.dialer("gm-key"), "iron-keep");
		await untilLive(server, "iron-keep", true);
		await untilLive(server, "iron-keep", false);
		expect(offline).toEqual(["iron-keep"]);
		await silent.close();
		await server.close();
	});
});
