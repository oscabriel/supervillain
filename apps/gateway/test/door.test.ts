/* oxlint-disable vitest/prefer-importing-vitest-globals, promise/avoid-new, promise/prefer-await-to-callbacks, eslint/no-await-in-loop -- Bun-only suite; a live SSH door is event-shaped and polled. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
	Envelope,
	RoomCommand,
	RoomStore,
	RoomSubmission,
} from "@supervillain/core";
import { loadOrCreateIdentity } from "@supervillain/identity";
import { openHostPipe } from "@supervillain/room-wire";
import type { HostPipe } from "@supervillain/room-wire";
import { openWsDialer } from "@supervillain/transport-ws";
import { Client, utils } from "ssh2";
import type { ClientChannel } from "ssh2";

import { startGateway } from "../src/index.js";
import type { RunningGateway } from "../src/index.js";

const ROOM = "backpressure-room";
const ROOM_LABEL = "Backpressure Room";

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

class ChatRoomStore implements RoomStore {
	readonly envelopes: Envelope[] = [];
	readonly submissions: RoomCommand[] = [];
	#waiters: (() => void)[] = [];

	submit(command: RoomCommand): Promise<RoomSubmission> {
		this.submissions.push(command);
		const text =
			"text" in command.command && typeof command.command.text === "string"
				? command.command.text
				: "seat claimed";
		const envelope: Envelope = {
			actor: command.actor,
			payload: { text },
			seq: this.envelopes.length + 1,
			timestamp: "2026-07-25T00:00:00.000Z",
			type: "core.chat-posted",
		};
		this.envelopes.push(envelope);
		for (const wake of this.#waiters.splice(0)) {
			wake();
		}
		return Promise.resolve({ accepted: true, envelopes: [envelope] });
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

interface DoorVisit {
	readonly bufferedBytes: () => number;
	readonly transcript: () => string;
	readonly promptedKeyboard: boolean;
	readonly send: (data: string) => void;
	readonly closed: () => boolean;
	readonly disconnect: () => void;
	readonly pause: () => void;
	readonly resume: () => void;
}

interface VisitOptions {
	readonly cols?: number;
	readonly rows?: number;
	readonly room: string;
	/** Omit to arrive keyless — the guest door. */
	readonly privateKey?: string;
}

const visitDoor = (port: number, options: VisitOptions): Promise<DoorVisit> =>
	// oxlint-disable-next-line promise/avoid-new -- ssh2's client is event-shaped.
	new Promise((resolve, reject) => {
		const client = new Client();
		let promptedKeyboard = false;
		let transcript = "";
		let closed = false;
		const disconnect = (): void => client.end();
		client.on("keyboard-interactive", (_n, _i, _l, _p, finish) => {
			promptedKeyboard = true;
			finish([]);
		});
		client.on("error", reject);
		client.on("ready", () => {
			client.shell(
				{
					cols: options.cols ?? 120,
					rows: options.rows ?? 40,
					term: "xterm-256color",
				},
				(error, stream: ClientChannel) => {
					if (error) {
						reject(error);
						return;
					}
					stream.on("close", () => {
						closed = true;
					});
					stream.on("data", (chunk: Buffer) => {
						transcript += chunk.toString("utf-8");
					});
					resolve({
						bufferedBytes: () => stream.readableLength,
						closed: () => closed,
						disconnect,
						pause: () => stream.pause(),
						promptedKeyboard,
						resume: () => stream.resume(),
						send: (data) => stream.write(data),
						transcript: () => transcript,
					});
				}
			);
		});
		client.connect({
			host: "127.0.0.1",
			port,
			...(options.privateKey === undefined
				? { tryKeyboard: true }
				: { privateKey: options.privateKey }),
			username: options.room,
		});
	});

const waitFor = async (
	label: string,
	predicate: () => boolean,
	timeoutMs = 30_000
): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(`Timed out waiting for ${label}.`);
		}
		await sleep(10);
	}
};

/** Lands in the lobby (ADR-0008: an unknown name is a notice, never a
 * disconnect), reads the notice, then leaves with `q`. */
const visitAndLeave = async (
	port: number,
	options: VisitOptions
): Promise<DoorVisit> => {
	const visit = await visitDoor(port, options);
	await waitFor(`the lobby's ${options.room} notice`, () =>
		visit.transcript().includes(`no table named '${options.room}'`)
	);
	// The lobby is a held session; leaving is a keypress, and the retry covers
	// a `q` that lands before the key handler is attached.
	for (let attempt = 0; attempt < 60 && !visit.closed(); attempt += 1) {
		visit.send("q");
		await sleep(250);
	}
	await waitFor("the door closing", () => visit.closed());
	return visit;
};

describe("the door, live", () => {
	let stateDir = "";
	let gateway: RunningGateway | undefined;
	let host: HostPipe | undefined;
	let roomStore: ChatRoomStore;
	let sshPort = 0;

	beforeAll(async () => {
		stateDir = await mkdtemp(path.join(tmpdir(), "supervillain-door-"));
		gateway = await startGateway({
			bindHost: "127.0.0.1",
			sshHost: "127.0.0.1",
			sshPort: 0,
			stateDir,
			tls: { mode: "terminated-upstream" },
		});
		({ sshPort } = gateway);
		expect(sshPort).toBeGreaterThan(0);
		const hostIdentity = await loadOrCreateIdentity(
			path.join(stateDir, "host-identity")
		);
		roomStore = new ChatRoomStore();
		host = openHostPipe({
			dialer: openWsDialer({
				secretKeyHex: hostIdentity.secretKeyHex,
				url: gateway.url,
			}),
			rooms: [
				{
					info: { gameId: "fake", label: ROOM_LABEL },
					name: ROOM,
					store: roomStore,
				},
			],
		});
		const attachment = await host.attached;
		expect(attachment.sshPort).toBe(sshPort);
	});

	afterAll(async () => {
		await host?.close();
		await gateway?.close();
		await rm(stateDir, { force: true, recursive: true });
	});

	test("a keyed arrival is seated by signature and lands in the lobby", async () => {
		const key = utils.generateKeyPairSync("ed25519");
		const visit = await visitAndLeave(sshPort, {
			privateKey: key.private,
			room: "no-such-table",
		});
		expect(visit.transcript()).toContain("the gate closes behind you.");
	}, 60_000);

	test("a second, never-before-seen key is admitted just the same", async () => {
		const key = utils.generateKeyPairSync("ed25519");
		const visit = await visitAndLeave(sshPort, {
			privateKey: key.private,
			room: "still-no-table",
		});
		expect(visit.transcript()).toContain("no table named 'still-no-table'");
	}, 60_000);

	test("the keyless guest door asks nothing", async () => {
		const visit = await visitAndLeave(sshPort, { room: "no-such-table" });
		expect(visit.promptedKeyboard).toBe(false);
	}, 60_000);

	test("a reader that stops reading stalls only its own frame feed", async () => {
		const slowKey = utils.generateKeyPairSync("ed25519");
		const fastKey = utils.generateKeyPairSync("ed25519");
		const slow = await visitDoor(sshPort, {
			cols: 300,
			privateKey: slowKey.private,
			room: ROOM,
			rows: 100,
		});
		const fast = await visitDoor(sshPort, {
			cols: 300,
			privateKey: fastKey.private,
			room: ROOM,
			rows: 100,
		});
		try {
			const { submissions } = roomStore;
			await waitFor("both seats at the table", () =>
				[slow, fast].every((visit) => visit.transcript().includes(ROOM_LABEL))
			);
			slow.pause();
			const slowTranscriptAtPause = slow.transcript().length;
			let previousBuffered = -1;
			let stalledBatches = 0;
			let batch = 0;
			while (stalledBatches < 2 && batch < 1000) {
				const currentBatch = batch;
				const beforeSubmissions = submissions.length;
				const bufferedBefore = previousBuffered;
				const fastBefore = fast.transcript().length;
				const marker = `pressure-${currentBatch}-`.repeat(15);
				fast.send(`${marker}\r`);
				await waitFor(
					"a fast-seat submission",
					() => submissions.length > beforeSubmissions
				);
				await waitFor(
					`the fast seat repaint for batch ${currentBatch}`,
					() => fast.transcript().length > fastBefore
				);
				try {
					await waitFor(
						"the slow seat's buffered feed advancing",
						() => slow.bufferedBytes() !== bufferedBefore,
						1000
					);
					stalledBatches = 0;
				} catch {
					stalledBatches += 1;
				}
				previousBuffered = slow.bufferedBytes();
				batch += 1;
			}

			expect(stalledBatches).toBe(2);
			expect(slow.bufferedBytes()).toBeGreaterThanOrEqual(2 * 1024 * 1024);
			expect(slow.transcript().length).toBe(slowTranscriptAtPause);
			const fastBefore = fast.transcript().length;
			const submissionsBefore = submissions.length;
			fast.send("still-responsive\r");
			await waitFor(
				"the fast seat after the slow stall",
				() => submissions.length > submissionsBefore
			);
			await waitFor(
				"the fast seat's post-stall repaint",
				() => fast.transcript().length > fastBefore
			);
		} finally {
			slow.resume();
			slow.disconnect();
			fast.disconnect();
		}

		const healthy = await visitAndLeave(sshPort, {
			room: "healthy-after-stall",
		});
		expect(healthy.transcript()).toContain("healthy-after-stall");
	}, 120_000);
});
