/* oxlint-disable vitest/prefer-importing-vitest-globals, promise/avoid-new, promise/prefer-await-to-callbacks, eslint/no-await-in-loop -- Bun-only suite; a live SSH door is event-shaped and polled. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client, utils } from "ssh2";
import type { ClientChannel } from "ssh2";

import { startGateway } from "../src/index.js";
import type { RunningGateway } from "../src/index.js";

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

interface DoorVisit {
	readonly transcript: () => string;
	readonly promptedKeyboard: boolean;
	readonly send: (data: string) => void;
	readonly closed: () => boolean;
	readonly disconnect: () => void;
}

interface VisitOptions {
	readonly room: string;
	/** Omit to arrive keyless — the guest door. */
	readonly privateKey?: string;
	/** Never read from the channel; the caller drains it later, or never. */
	readonly slowReader?: boolean;
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
				{ cols: 120, rows: 40, term: "xterm-256color" },
				(error, stream: ClientChannel) => {
					if (error) {
						reject(error);
						return;
					}
					stream.on("close", () => {
						closed = true;
					});
					if (options.slowReader === true) {
						stream.pause();
					} else {
						stream.on("data", (chunk: Buffer) => {
							transcript += chunk.toString("utf-8");
						});
					}
					resolve({
						closed: () => closed,
						disconnect,
						promptedKeyboard,
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
		await sleep(50);
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
	let sshPort = 0;

	beforeAll(async () => {
		stateDir = await mkdtemp(path.join(tmpdir(), "supervillain-door-"));
		sshPort = await freePort();
		gateway = await startGateway({
			bindHost: "127.0.0.1",
			sshHost: "127.0.0.1",
			sshPort,
			stateDir,
		});
	});

	afterAll(async () => {
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

	test("a reader that never reads stalls only itself", async () => {
		const key = utils.generateKeyPairSync("ed25519");
		const slow = await visitDoor(sshPort, {
			privateKey: key.private,
			room: "no-such-table",
			slowReader: true,
		});
		try {
			const other = await visitAndLeave(sshPort, { room: "another-table" });
			expect(other.transcript()).toContain("no table named 'another-table'");
		} finally {
			slow.disconnect();
		}
	}, 60_000);
});
