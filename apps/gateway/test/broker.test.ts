import { describe, expect, test } from "bun:test";
/* oxlint-disable vitest/prefer-importing-vitest-globals, eslint/require-await, eslint/class-methods-use-this, promise/avoid-new, eslint/no-await-in-loop -- Bun-only suite: the gateway is Bun-bound by bun:sqlite, the fake store is interface-shaped, and the waits here are timers. */
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
	Envelope,
	RoomCommand,
	RoomStore,
	RoomSubmission,
} from "@supervillain/core";
import { loadOrCreateIdentity } from "@supervillain/identity";
import {
	openGatewayLink,
	openHostPipe,
	REVOKED_HOST_KEY_MESSAGE,
	serveHostPipes,
} from "@supervillain/room-wire";
import type { GatewayPipeEvent, HostPipeServer } from "@supervillain/room-wire";
import { openWsDialer } from "@supervillain/transport-ws";
import { startWsListener } from "@supervillain/transport-ws/server";

import { noticeForMissingRoom } from "../src/index.js";
import { createOfflineMetrics } from "../src/offline-metrics.js";
import { openRoomRegistry } from "../src/registry.js";
import { holdRoom, HOST_OFFLINE_NOTICE } from "../src/room-hold.js";

const DOOR = { sshHost: "supervillain.test", sshPort: 2222 } as const;

/** A string no gateway path may ever write down: it stands in for every line
 * of chat, every roll, and every sheet a table produces (ADR-0012, NQ-11). */
const GAME_CONTENT = "aardvark-sigil-77";

const envelope = (seq: number, text: string): Envelope => ({
	actor: "gm-key",
	payload: { text },
	seq,
	timestamp: "2026-07-25T00:00:00.000Z",
	type: "core.chat-posted",
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
		const next = envelope(this.envelopes.length + 1, GAME_CONTENT);
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

const untilLive = async (
	pipes: HostPipeServer,
	name: string,
	present: boolean
): Promise<void> => {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if ((pipes.live(name) !== undefined) === present) {
			return;
		}
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 5);
		});
	}
	throw new Error(`Room '${name}' never went ${present ? "live" : "offline"}.`);
};

/** Unwraps an iterator result — one place to read a field off the protocol's
 * answer, rather than naming a variable at every call. */
const valueOf = async (
	pending: Promise<IteratorResult<Envelope>>
): Promise<Envelope | undefined> => {
	const result = await pending;
	return result.value;
};

const secretKeyIn = async (folder: string): Promise<string> => {
	const identity = await loadOrCreateIdentity(path.join(folder, randomUUID()));
	return identity.secretKeyHex;
};

/** Every byte the gateway wrote under its state directory. */
const stateBytes = async (folder: string): Promise<string> => {
	const entries = await readdir(folder, {
		recursive: true,
		withFileTypes: true,
	});
	const files = entries.filter((entry) => entry.isFile());
	const contents = await Promise.all(
		files.map((entry) =>
			readFile(path.join(entry.parentPath, entry.name), "latin1")
		)
	);
	return contents.join("\n");
};

describe("the gateway holds game state in memory and nowhere else", () => {
	test("no path writes a payload to disk, to the DB, or to its exhaust", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "supervillain-broker-"));
		const events: GatewayPipeEvent[] = [];
		const written: string[] = [];
		const listener = await startWsListener({
			secretKeyHex: await secretKeyIn(folder),
		});
		const registry = openRoomRegistry({
			path: path.join(folder, "registry.db"),
		});
		const pipes = serveHostPipes({
			checkpoint: {
				create: () => {
					let derived = "";
					return {
						apply: (next) => {
							const payload = next.payload as { readonly text?: unknown };
							if (derived === "" && typeof payload.text === "string") {
								derived = payload.text;
							}
						},
						capture: () => ({ derived }),
					};
				},
			},
			door: DOOR,
			listener,
			onEvent: (event) => events.push(event),
			ownership: registry,
		});
		const store = new FakeRoomStore([
			envelope(1, GAME_CONTENT),
			...Array.from({ length: 513 }, (_, index) =>
				envelope(index + 2, "ordinary-room-content")
			),
		]);
		const host = openHostPipe({
			dialer: openWsDialer({
				secretKeyHex: await secretKeyIn(folder),
				url: listener.url,
			}),
			rooms: [
				{ info: { gameId: "fake", label: "the keep" }, name: "keep", store },
			],
		});
		await host.attached;
		await untilLive(pipes, "keep", true);

		const write = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: unknown): boolean => {
			written.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		try {
			const starter = pipes.live("keep")?.openStore();
			if (starter === undefined) {
				throw new Error("no live room");
			}
			const reader = starter.stream(1)[Symbol.asyncIterator]();
			for (let seq = 1; seq <= 514; seq += 1) {
				expect(await valueOf(reader.next())).toMatchObject({ seq });
			}
			const late = pipes.live("keep")?.openStore();
			if (late === undefined) {
				throw new Error("no live room");
			}
			const replay = await late.replay();
			expect(replay.checkpoint).toMatchObject({
				payload: { derived: GAME_CONTENT },
				throughSeq: 2,
			});
			await late.submit({
				actor: "guest:abcdef123456",
				command: { text: "ordinary-room-content", type: "core.chat" },
			});
			await starter.close();
			await late.close();
		} finally {
			process.stdout.write = write;
		}

		await host.close();
		await pipes.close();
		await listener.close();
		registry.close();

		// The durable store holds the pinned list and nothing else: a name, an
		// owner. Not one word of what was said at the table.
		const onDisk = await stateBytes(folder);
		expect(onDisk).toContain("keep");
		expect(onDisk).not.toContain(GAME_CONTENT);
		// The exhaust is metadata: lifecycle, room names, error codes (NQ-11).
		expect(JSON.stringify(events)).not.toContain(GAME_CONTENT);
		expect(written.join("")).not.toContain(GAME_CONTENT);

		await rm(folder, { force: true, recursive: true });
	});
});

describe("a key the GM retired", () => {
	/* The broker suite's revoked-key leg (ADR-0012, NQ-12 lists it beside
	 * challenge-signature auth). It runs against the real store, because the
	 * whole claim of ADR-0013 is that this refusal is a **local read**: no
	 * backend exists in this test, and none is asked. */
	test("loses its live pipe at once and is refused when it dials back", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "supervillain-revoke-"));
		const events: GatewayPipeEvent[] = [];
		const listener = await startWsListener({
			secretKeyHex: await secretKeyIn(folder),
		});
		const registry = openRoomRegistry({
			path: path.join(folder, "registry.db"),
		});
		const pipes = serveHostPipes({
			door: DOOR,
			keys: registry,
			listener,
			onEvent: (event) => events.push(event),
			ownership: registry,
		});
		const deskSecret = await secretKeyIn(folder);
		const homelabSecret = await secretKeyIn(folder);

		// The homelab box hosts, and it is linked into the GM's identity.
		const homelab = openHostPipe({
			dialer: openWsDialer({ secretKeyHex: homelabSecret, url: listener.url }),
			reconnectDelayMs: () => 60_000,
			rooms: [
				{
					info: { gameId: "fake", label: "the keep" },
					name: "keep",
					store: new FakeRoomStore(),
				},
			],
		});
		const attachment = await homelab.attached;
		await untilLive(pipes, "keep", true);
		const homelabKey = pipes.live("keep")?.hostKey;
		if (homelabKey === undefined) {
			throw new Error("no live room");
		}
		expect(attachment.sshHost).toBe(DOOR.sshHost);

		// The GM links their desk to the box's identity — the box already holds
		// the room, so the fresh key is the one that joins.
		const box = await openGatewayLink({
			dialer: openWsDialer({ secretKeyHex: homelabSecret, url: listener.url }),
		});
		const code = await box.mintDeviceCode();
		if ("rejected" in code) {
			throw new Error(code.message);
		}
		await box.close();
		const desk = await openGatewayLink({
			dialer: openWsDialer({ secretKeyHex: deskSecret, url: listener.url }),
		});
		expect(await desk.redeem(code.code)).toMatchObject({ accepted: true });

		// The box is compromised; the GM retires it from the desk.
		const retired = await desk.revoke(homelabKey);
		expect(retired).toMatchObject({ accepted: true, revoked: homelabKey });
		await desk.close();

		// Immediately, not at next login: the room is offline.
		await untilLive(pipes, "keep", false);
		expect(events).toContainEqual({ key: homelabKey, kind: "key-revoked" });
		await homelab.close();

		// And the redial is refused with the retired-key line, not the
		// name-is-taken one.
		const again = openHostPipe({
			dialer: openWsDialer({ secretKeyHex: homelabSecret, url: listener.url }),
			rooms: [
				{
					info: { gameId: "fake", label: "the keep" },
					name: "keep",
					store: new FakeRoomStore(),
				},
			],
		});
		await expect(again.attached).rejects.toThrow(REVOKED_HOST_KEY_MESSAGE);
		await again.close();

		// The identity kept its room and its other key.
		const identity = registry.identityOf(homelabKey);
		expect(identity).toBeDefined();
		expect(registry.ownerOf("keep")).toBe(identity);
		expect(registry.liveActorsOf(identity ?? "")).not.toContain(homelabKey);

		await pipes.close();
		await listener.close();
		registry.close();
		await rm(folder, { force: true, recursive: true });
	});
});

describe("a Host that goes offline under a seated player", () => {
	/* The heartbeat leg — an unanswered ping marking a Room offline — is pinned
	 * in room-wire's pipe suite. This picks the chain up at the offline fact and
	 * carries it through the grace window to ADR-0008's lobby chrome. */
	test("holds the seat, then hands it to the lobby's offline notice", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "supervillain-grace-"));
		const listener = await startWsListener({
			secretKeyHex: await secretKeyIn(folder),
		});
		const registry = openRoomRegistry({ path: ":memory:" });
		const pipes = serveHostPipes({
			door: DOOR,
			heartbeatIntervalMs: 20,
			heartbeatMisses: 1,
			listener,
			ownership: registry,
		});
		const host = openHostPipe({
			dialer: openWsDialer({
				secretKeyHex: await secretKeyIn(folder),
				url: listener.url,
			}),
			rooms: [
				{
					info: { gameId: "fake", label: "the keep" },
					name: "keep",
					store: new FakeRoomStore(),
				},
			],
		});
		await host.attached;
		await untilLive(pipes, "keep", true);
		const attached = pipes.live("keep");
		const metrics = createOfflineMetrics();
		metrics.recordJoinAttempt(true);
		const notices: string[] = [];
		const hold = holdRoom({
			attached,
			graceMs: 40,
			live: () => pipes.live("keep"),
			onGraceExpiry: () => metrics.recordGraceExpiry(),
			onHostDrop: () => metrics.recordHostDrop(),
			pollMs: 2,
		});
		hold.onNotice((message) => notices.push(message));

		await host.close();
		await untilLive(pipes, "keep", false);
		await hold.until;

		expect(notices).toEqual([HOST_OFFLINE_NOTICE]);
		expect(hold.end()).toBe("grace-expired");
		expect(metrics.counts()).toEqual({
			graceExpiries: 1,
			hostDrops: 1,
			offlineJoinAttempts: 0,
			registeredJoinAttempts: 1,
		});
		// The name is still claimed, so the lobby says "offline", not "unknown".
		expect(noticeForMissingRoom("keep", registry)).toEqual({
			kind: "offline-room",
			roomName: "keep",
		});

		hold.stop();
		await pipes.close();
		await listener.close();
		registry.close();
		await rm(folder, { force: true, recursive: true });
	});

	test("re-seats the player when the Host reattaches inside the window", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "supervillain-return-"));
		const listener = await startWsListener({
			secretKeyHex: await secretKeyIn(folder),
		});
		const registry = openRoomRegistry({ path: ":memory:" });
		const pipes = serveHostPipes({
			door: DOOR,
			listener,
			ownership: registry,
		});
		const hostKey = await secretKeyIn(folder);
		const room = {
			info: { gameId: "fake", label: "the keep" },
			name: "keep",
			store: new FakeRoomStore(),
		};
		const first = openHostPipe({
			dialer: openWsDialer({ secretKeyHex: hostKey, url: listener.url }),
			rooms: [room],
		});
		await first.attached;
		await untilLive(pipes, "keep", true);
		const attached = pipes.live("keep");
		const metrics = createOfflineMetrics();
		const hold = holdRoom({
			attached,
			graceMs: 5000,
			live: () => pipes.live("keep"),
			onGraceExpiry: () => metrics.recordGraceExpiry(),
			onHostDrop: () => metrics.recordHostDrop(),
			pollMs: 2,
		});

		await first.close();
		await untilLive(pipes, "keep", false);
		// The same key comes back and supersedes its own registration (NQ-4).
		const second = openHostPipe({
			dialer: openWsDialer({ secretKeyHex: hostKey, url: listener.url }),
			rooms: [room],
		});
		await second.attached;
		await hold.until;

		expect(hold.end()).toBe("host-returned");
		expect(metrics.counts().hostDrops).toBe(1);
		expect(metrics.counts().graceExpiries).toBe(0);
		expect(pipes.live("keep")).toBeDefined();
		expect(pipes.live("keep")).not.toBe(attached);

		hold.stop();
		await second.close();
		await pipes.close();
		await listener.close();
		registry.close();
		await rm(folder, { force: true, recursive: true });
	});
});
