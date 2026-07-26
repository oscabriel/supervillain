/* oxlint-disable vitest/prefer-importing-vitest-globals, promise/avoid-new, promise/prefer-await-to-callbacks, eslint/no-await-in-loop, eslint/require-await, eslint/class-methods-use-this -- Bun-only suite; a live SSH seat is event-shaped and polled, and the fake store is interface-shaped. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
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

const ROOM = "the-kitchen";
const LABEL = "The Kitchen";
// oxlint-disable-next-line eslint/no-control-regex -- terminal frames use ANSI CSI cursor positions.
const CURSOR_POSITION = /\u001B\[(?<row>\d+);(?<column>\d+)H/gu;

/** Every actor the door stamped a command with, in arrival order. */
const stamped: string[] = [];

/** A room that accepts everything and rarely speaks: enough for the table to
 * open, which is all this suite is asking about. */
class QuietRoomStore implements RoomStore {
	readonly envelopes: Envelope[] = [];
	#waiters: (() => void)[] = [];

	async submit(command: RoomCommand): Promise<RoomSubmission> {
		stamped.push(command.actor);
		return { accepted: true, envelopes: [] };
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

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

/** A port the OS just handed back — good enough for a single test run. */
const freePort = (): Promise<number> =>
	new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => resolve(port));
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
		await sleep(50);
	}
};

interface Seat {
	readonly transcript: () => string;
	readonly send: (data: string) => void;
	readonly resize: (cols: number, rows: number) => void;
	readonly close: () => void;
	readonly closed: () => boolean;
	/** The actor this seat's key resolves to; undefined for the guest door. */
	readonly actor: string | undefined;
}

interface SeatOptions {
	readonly cols: number;
	readonly rows: number;
	/** Arrive without a key — the guest door. */
	readonly keyless?: boolean;
}

const takeSeat = (port: number, options: SeatOptions): Promise<Seat> =>
	new Promise((resolve, reject) => {
		const client = new Client();
		const key = utils.generateKeyPairSync("ed25519");
		const parsed = utils.parseKey(key.private);
		if (parsed instanceof Error || Array.isArray(parsed)) {
			reject(new TypeError("could not generate a test key"));
			return;
		}
		const actor = parsed.getPublicSSH().subarray(-32).toString("hex");
		let transcript = "";
		let closed = false;
		client.on("error", reject);
		client.on("keyboard-interactive", (_n, _i, _l, _p, finish) => finish([]));
		client.on("ready", () => {
			client.shell(
				{ cols: options.cols, rows: options.rows, term: "xterm-256color" },
				(error, stream: ClientChannel) => {
					if (error) {
						reject(error);
						return;
					}
					stream.on("data", (chunk: Buffer) => {
						transcript += chunk.toString("utf-8");
					});
					stream.on("close", () => {
						closed = true;
					});
					resolve({
						actor: options.keyless === true ? undefined : actor,
						close: () => client.end(),
						closed: () => closed,
						resize: (cols, rows) => stream.setWindow(rows, cols, 0, 0),
						send: (data) => stream.write(data),
						transcript: () => transcript,
					});
				}
			);
		});
		client.connect({
			host: "127.0.0.1",
			port,
			...(options.keyless === true
				? { tryKeyboard: true }
				: { privateKey: key.private }),
			username: ROOM,
		});
	});

describe("a live seat at the door", () => {
	let stateDir = "";
	let gateway: RunningGateway | undefined;
	let host: HostPipe | undefined;
	let sshPort = 0;

	beforeAll(async () => {
		stateDir = await mkdtemp(path.join(tmpdir(), "supervillain-seat-"));
		sshPort = await freePort();
		gateway = await startGateway({
			bindHost: "127.0.0.1",
			sshHost: "127.0.0.1",
			sshPort,
			stateDir,
			// Plaintext on loopback: the seat is what this suite is about, and
			// the TLS story has its own tests.
			tls: { mode: "terminated-upstream" },
		});
		// The Host dials in, exactly as a GM's `create` does (ADR-0012).
		const hostIdentity = await loadOrCreateIdentity(
			path.join(stateDir, "host-identity")
		);
		host = openHostPipe({
			dialer: openWsDialer({
				secretKeyHex: hostIdentity.secretKeyHex,
				url: gateway.url,
			}),
			rooms: [
				{
					info: { gameId: "fake", label: LABEL },
					name: ROOM,
					store: new QuietRoomStore(),
				},
			],
		});
		await host.attached;
	});

	afterAll(async () => {
		await host?.close();
		await gateway?.close();
		await rm(stateDir, { force: true, recursive: true });
	});

	test("an oversized terminal is told the truth, then drawn at the cap", async () => {
		const seat = await takeSeat(sshPort, { cols: 400, rows: 150 });
		await waitFor("the oversize notice", () =>
			seat.transcript().includes("400x150")
		);
		expect(seat.transcript()).toContain("300x100");
		expect(seat.transcript()).not.toContain(LABEL);
		// The notice is a notice, not a refusal: one key and the table opens.
		seat.send(" ");
		await waitFor("the table", () => seat.transcript().includes(LABEL));
		seat.close();
		await waitFor("teardown", () => seat.closed());
	}, 60_000);

	test("post-connect window changes keep rendering inside the cap", async () => {
		const seat = await takeSeat(sshPort, { cols: 120, rows: 40 });
		await waitFor("the table", () => seat.transcript().includes(LABEL));
		const beforeResize = seat.transcript().length;

		seat.resize(500, 200);
		await waitFor("the resized frame", () =>
			seat.transcript().slice(beforeResize).includes("\u001B[")
		);
		const resizedFrame = seat.transcript().slice(beforeResize);
		const cursorPositions = [...resizedFrame.matchAll(CURSOR_POSITION)];
		expect(cursorPositions.length).toBeGreaterThan(0);
		for (const position of cursorPositions) {
			expect(Number(position.groups?.row)).toBeLessThanOrEqual(100);
			expect(Number(position.groups?.column)).toBeLessThanOrEqual(300);
		}
		seat.close();
		await waitFor("teardown", () => seat.closed());
	}, 60_000);

	test("a terminal inside the cap goes straight to the table, keyed", async () => {
		const seat = await takeSeat(sshPort, { cols: 120, rows: 40 });
		await waitFor("the table", () => seat.transcript().includes(LABEL));
		expect(seat.transcript()).not.toContain("you arrive without a key.");
		// The seat was claimed under the key itself — no enrolment, no prompt.
		expect(stamped).toContain(seat.actor ?? "");
		seat.close();
		await waitFor("teardown", () => seat.closed());
	}, 60_000);

	test("a keyless guest is warned, then seated under a freshly minted guest actor", async () => {
		const before = stamped.length;
		const seat = await takeSeat(sshPort, {
			cols: 120,
			keyless: true,
			rows: 40,
		});
		await waitFor("the upgrade box", () =>
			seat.transcript().includes("you arrive without a key.")
		);
		expect(seat.transcript()).not.toContain(LABEL);
		seat.send(" ");
		await waitFor("the table", () => seat.transcript().includes(LABEL));
		expect(stamped.slice(before).at(0)).toMatch(/^guest:[0-9a-f]{12}$/u);
		seat.close();
		await waitFor("teardown", () => seat.closed());
	}, 60_000);
});
