/* oxlint-disable promise/avoid-new, eslint/no-await-in-loop, vitest/prefer-importing-vitest-globals -- bounded PTY polling and sequential live actions are the E2E protocol. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const assertTranscript = async (
	file: string,
	assertions: (transcript: string) => void
): Promise<void> => {
	const transcript = (await readIfExists(file)) ?? "";
	try {
		assertions(transcript);
	} catch (error) {
		console.error(`----- BEGIN TRANSCRIPT ${file} -----`);
		console.error(JSON.stringify(transcript));
		console.error(`----- END TRANSCRIPT ${file} -----`);
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
	const attached = new Set<string>();
	const gateway = await startGateway({
		bindHost: "127.0.0.1",
		brokerPort: 0,
		onEvent: (event) => {
			if (event.kind === "room-attached") {
				attached.add(event.room);
			}
		},
		sshHost: "127.0.0.1",
		sshPort: 0,
		stateDir,
	});
	gateways.push(gateway);
	const { sshPort } = gateway;
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
		await gateway.close();
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

		// The seat claim is submitted by the gateway BEFORE the table starts
		// (runTable attaches the key handler after the claim lands), so give the
		// table a moment to come up — bytes typed before the keypress listener
		// attaches are dropped, not buffered.
		await sleep(2000);
		// ADR-0030: Message is opt-in — bare printables route to the focused
		// pane (Feed on this mapless table). The honest player gesture is
		// Shift+Tab (\x1b[Z): the reverse ring reaches Message from Feed in one
		// step, and a send returns focus to the pane it came from — so every
		// typed line below is the same idempotent Feed → Message gesture.
		player.stdin.write("\u001B[Zhello through the door\r");
		await waitFor("the player's chat envelope", () =>
			eventsMatching(
				logFile,
				(event) =>
					event.type === "core.chat-posted" &&
					event.actor === playerIdentity.publicKeyHex &&
					event.payload.text === "hello through the door"
			)
		);
		// Same gesture on the GM's table.
		gm.stdin.write("\u001B[Z/roll 2d6\r");
		await waitFor("the GM's dice envelope", () =>
			eventsMatching(logFile, (event) => event.type === "core.dice-rolled")
		);
		player.stdin.write("\u001B[Z/quit\r");
		gm.stdin.write("\u001B[Z/quit\r");
		player.stdin.end();
		gm.stdin.end();
		// A clean quit is a clean exit on both sides: the gateway sends an
		// explicit channel exit status, so `join` hands back 0 rather than ssh's
		// 255-for-no-status.
		expect(await player.exited).toBe(0);
		expect(await gm.exited).toBe(0);
		// Transcripts are block-buffered by `script`, so they are only whole once
		// the processes are gone.
		await assertTranscript(gmTranscript, (transcript) => {
			expect(transcript).toContain("hello through the door");
		});
		await assertTranscript(playerTranscript, (transcript) => {
			expect(transcript).toContain("rolled 2d6");
		});
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
		const exitCode = await player.exited;
		if (exitCode !== 0) {
			console.error(`player exited ${exitCode}; transcript follows:`);
			console.error(JSON.stringify(await readIfExists(transcript)));
		}
		// No dial error, no disconnect: the lobby said it, and the door closed
		// cleanly (ADR-0008, ADR-0012).
		expect(exitCode).toBe(0);
		await assertTranscript(transcript, (screen) => {
			expect(screen).toContain(
				"no table named 'ghost-keep' is registered here."
			);
			expect(screen).toContain("the gate closes behind you.");
		});
	}, 120_000);
});
