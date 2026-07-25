/* oxlint-disable promise/avoid-new, eslint/no-await-in-loop, vitest/prefer-importing-vitest-globals -- bounded PTY polling and sequential live actions are the E2E protocol. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { utils } from "ssh2";

import { startGateway } from "../src/index.js";
import type { RunningGateway } from "../src/index.js";

const ROOM = "iron-keep";

const folders: string[] = [];
const processes: Bun.Subprocess[] = [];
const gateways: RunningGateway[] = [];

const sleep = (milliseconds: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, milliseconds);
	});

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

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

const waitFor = async <T>(
	label: string,
	read: () => Promise<T | undefined>,
	timeoutMs = 45_000
): Promise<T> => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (value !== undefined) {
			return value;
		}
		if (Date.now() >= deadline) {
			throw new Error(`Timed out waiting for ${label}.`);
		}
		await sleep(100);
	}
};

const readIfExists = async (file: string): Promise<string | undefined> => {
	try {
		return await readFile(file, "utf-8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
};

const spawnPty = (
	args: string,
	env: Record<string, string>,
	transcript: string
): Bun.Subprocess => {
	const cli = path.resolve(import.meta.dir, "../../cli/dist/index.js");
	const exports = Object.entries(env)
		.map(([name, value]) => `${name}=${quote(value)}`)
		.join(" ");
	const command = `stty cols 100 rows 30; env ${exports} ${process.execPath} ${quote(cli)} ${args}`;
	const childProcess = Bun.spawn(["script", "-qec", command, transcript], {
		stderr: "ignore",
		stdin: "pipe",
		stdout: "ignore",
	});
	processes.push(childProcess);
	return childProcess;
};

interface Envelope {
	readonly actor: string;
	readonly payload: Record<string, unknown>;
	readonly type: string;
}

const readEvents = async (file: string): Promise<Envelope[] | undefined> => {
	const text = await readIfExists(file);
	if (text === undefined || text.trim() === "") {
		return undefined;
	}
	return text
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Envelope);
};

const eventsMatching = async (
	file: string,
	matches: (event: Envelope) => boolean
): Promise<Envelope[] | undefined> => {
	const events = await readEvents(file);
	return events?.some(matches) ? events : undefined;
};

/** Pre-trusts the gateway's host key so `join` never meets an interactive TOFU
 * prompt. `join` points ssh at the CLI's own known_hosts, never `~/.ssh`. */
const trustHostKey = async (
	stateDir: string,
	configFolder: string,
	sshPort: number
): Promise<void> => {
	const hostKey = utils.parseKey(
		await readFile(path.join(stateDir, "ssh_host_ed25519_key"), "utf-8")
	);
	if (hostKey instanceof Error) {
		throw hostKey;
	}
	const encoded = Buffer.from(hostKey.getPublicSSH()).toString("base64");
	await mkdir(configFolder, { recursive: true });
	await writeFile(
		path.join(configFolder, "known_hosts"),
		`[127.0.0.1]:${sshPort} ssh-ed25519 ${encoded}\n`
	);
};

interface LiveDoor {
	readonly attached: Set<string>;
	readonly gateway: RunningGateway;
	readonly playerConfig: string;
	readonly scratch: string;
	readonly sshPort: number;
}

/** One gateway on loopback, with the player's config already trusting its host
 * key — everything a `join` needs and nothing a Host does. */
const openDoor = async (): Promise<LiveDoor> => {
	const scratch = await mkdtemp(path.join(tmpdir(), "supervillain-join-live-"));
	folders.push(scratch);
	const stateDir = path.join(scratch, "gateway");
	const playerConfig = path.join(scratch, "player-config");
	await mkdir(stateDir, { recursive: true });
	const sshPort = await freePort();
	const attached = new Set<string>();
	const gateway = await startGateway({
		bindHost: "127.0.0.1",
		brokerPort: await freePort(),
		onEvent: (event) => {
			if (event.kind === "room-attached") {
				attached.add(event.room);
			}
		},
		sshHost: "127.0.0.1",
		sshPort,
		stateDir,
	});
	gateways.push(gateway);
	await trustHostKey(
		stateDir,
		path.join(playerConfig, "supervillain"),
		sshPort
	);
	// The gateway mints a self-signed certificate by default (ADR-0014), so the
	// Host has to be handed the pairing code, not the bare URL — the fingerprint
	// on the end is what it pins.
	const pipeAddress = gateway.pairingCode ?? gateway.url;
	return { attached, gateway, pipeAddress, playerConfig, scratch, sshPort };
};

afterEach(async () => {
	for (const childProcess of processes.splice(0)) {
		if (childProcess.exitCode === null) {
			childProcess.kill();
			await childProcess.exited;
		}
	}
	for (const gateway of gateways.splice(0)) {
		// A killed `script` can orphan its ssh child, and an open connection holds
		// the listener open; the run is over either way, so don't hang on it.
		await Promise.race([gateway.close(), sleep(3000)]);
	}
	for (const folder of folders.splice(0)) {
		await rm(folder, { force: true, recursive: true });
	}
});

describe("supervillain join through a live gateway", () => {
	test("reaches a created room over ssh and exchanges live table commands", async () => {
		const { attached, gateway, pipeAddress, playerConfig, scratch, sshPort } =
			await openDoor();
		const campaign = path.join(scratch, "campaign");
		const gmConfig = path.join(scratch, "gm-config");
		const gmTranscript = path.join(scratch, "gm-screen.txt");
		const playerTranscript = path.join(scratch, "player-screen.txt");

		const gm = spawnPty(
			`create ${quote(campaign)} --name ${ROOM} --gateway ${quote(pipeAddress)}`,
			{ XDG_CONFIG_HOME: gmConfig },
			gmTranscript
		);
		// The gateway's own lifecycle exhaust says when the name went live — the
		// PTY transcript is block-buffered until exit and cannot be polled.
		await waitFor("the room attaching at the gateway", async () => {
			await sleep(0);
			return attached.has(ROOM) ? ROOM : undefined;
		});

		const player = spawnPty(
			`join ${ROOM} --ssh-port ${sshPort}`,
			{ SUPERVILLAIN_GATEWAY: gateway.url, XDG_CONFIG_HOME: playerConfig },
			playerTranscript
		);
		const logFile = path.join(campaign, "events.jsonl");
		await waitFor("the player's seat claim", () =>
			eventsMatching(
				logFile,
				(event) =>
					event.type === "core.seat-claimed" &&
					event.payload.seatId === "player-1"
			)
		);
		const playerIdentity = JSON.parse(
			await readFile(
				path.join(playerConfig, "supervillain", "identity.json"),
				"utf-8"
			)
		) as { readonly publicKeyHex: string };
		const seated = await readEvents(logFile);
		expect(
			seated?.find(
				(event) =>
					event.type === "core.seat-claimed" &&
					event.payload.seatId === "player-1"
			)?.actor
			// The SSH key is the account: the gateway stamps the key it verified.
		).toBe(playerIdentity.publicKeyHex);

		player.stdin.write("hello through the door\r");
		await waitFor("the player's chat envelope", () =>
			eventsMatching(
				logFile,
				(event) =>
					event.type === "core.chat-posted" &&
					event.actor === playerIdentity.publicKeyHex &&
					event.payload.text === "hello through the door"
			)
		);
		gm.stdin.write("/roll 2d6\r");
		await waitFor("the GM's dice envelope", () =>
			eventsMatching(logFile, (event) => event.type === "core.dice-rolled")
		);
		player.stdin.write("/quit\r");
		gm.stdin.write("/quit\r");
		player.stdin.end();
		gm.stdin.end();
		// A clean quit is a clean exit on both sides: the gateway sends an
		// explicit channel exit status, so `join` hands back 0 rather than ssh's
		// 255-for-no-status.
		expect(await player.exited).toBe(0);
		expect(await gm.exited).toBe(0);
		// Transcripts are block-buffered by `script`, so they are only whole once
		// the processes are gone.
		expect(await readFile(gmTranscript, "utf-8")).toContain(
			"hello through the door"
		);
		expect(await readFile(playerTranscript, "utf-8")).toContain("rolled 2d6");
	}, 120_000);

	test("answers an unregistered name with the gateway's own copy", async () => {
		const { gateway, playerConfig, scratch, sshPort } = await openDoor();
		const transcript = path.join(scratch, "player-screen.txt");
		const player = spawnPty(
			`join ghost-keep --ssh-port ${sshPort}`,
			{ SUPERVILLAIN_GATEWAY: gateway.url, XDG_CONFIG_HOME: playerConfig },
			transcript
		);
		// The lobby is a TUI, so leaving is a keypress; the transcript stays
		// unreadable until the process is gone, hence the blind retry.
		for (
			let attempt = 0;
			attempt < 60 && player.exitCode === null;
			attempt += 1
		) {
			player.stdin.write("q");
			await sleep(500);
		}
		// No dial error, no disconnect: the lobby said it, and the door closed
		// cleanly (ADR-0008, ADR-0012).
		expect(await player.exited).toBe(0);
		const screen = await readFile(transcript, "utf-8");
		expect(screen).toContain("no table named 'ghost-keep' is registered here.");
		expect(screen).toContain("the gate closes behind you.");
	}, 120_000);
});
