/* oxlint-disable promise/avoid-new, eslint/no-await-in-loop, vitest/prefer-importing-vitest-globals -- bounded PTY polling and sequential live-relay actions are the E2E protocol. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const folders: string[] = [];
const processes: Bun.Subprocess[] = [];
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

const spawnPty = (
	args: string,
	config: string,
	transcript: string
): Bun.Subprocess => {
	const cli = path.resolve(import.meta.dir, "../dist/index.js");
	const command = `stty cols 100 rows 30; env XDG_CONFIG_HOME=${quote(config)} bun ${quote(cli)} ${args}`;
	const process = Bun.spawn(["script", "-qec", command, transcript], {
		stderr: "ignore",
		stdin: "pipe",
		stdout: "ignore",
	});
	processes.push(process);
	return process;
};

const readEvents = async (file: string): Promise<unknown[] | undefined> => {
	const bytes = await readIfExists(file);
	if (bytes === undefined) {
		return undefined;
	}
	return bytes.trim().split("\n").map(JSON.parse);
};

afterEach(async () => {
	for (const process of processes.splice(0)) {
		if (process.exitCode === null) {
			process.kill();
			await process.exited;
		}
	}
	for (const folder of folders.splice(0)) {
		await rm(folder, { force: true, recursive: true });
	}
});

describe("supervillain join over the direct door", () => {
	test("joins with a distinct key and exchanges live table commands", async () => {
		const scratch = await mkdtemp(
			path.join(tmpdir(), "supervillain-cli-live-")
		);
		folders.push(scratch);
		const campaign = path.join(scratch, "campaign");
		const gmConfig = path.join(scratch, "gm-config");
		const playerConfig = path.join(scratch, "player-config");
		const gmTranscript = path.join(scratch, "gm-screen.txt");
		const playerTranscript = path.join(scratch, "player-screen.txt");
		const gm = spawnPty(`create ${quote(campaign)}`, gmConfig, gmTranscript);
		const door = await waitFor("door.txt", async () => {
			const value = await readIfExists(path.join(campaign, "door.txt"));
			return value?.trim() ? value.trim() : undefined;
		});
		const player = spawnPty(
			`join ${quote(door)}`,
			playerConfig,
			playerTranscript
		);
		const logFile = path.join(campaign, "events.jsonl");
		const joined = await waitFor("player seat claim", async () => {
			const events = await readEvents(logFile);
			return events?.some(
				(event) =>
					typeof event === "object" &&
					event !== null &&
					"type" in event &&
					event.type === "core.seat-claimed" &&
					"payload" in event &&
					typeof event.payload === "object" &&
					event.payload !== null &&
					"seatId" in event.payload &&
					event.payload.seatId === "player-1"
			)
				? events
				: undefined;
		});
		const playerIdentity = JSON.parse(
			await readFile(
				path.join(playerConfig, "supervillain", "identity.json"),
				"utf-8"
			)
		);
		const playerSeat = joined.find(
			(event) =>
				typeof event === "object" &&
				event !== null &&
				"type" in event &&
				event.type === "core.seat-claimed" &&
				"payload" in event &&
				typeof event.payload === "object" &&
				event.payload !== null &&
				"seatId" in event.payload &&
				event.payload.seatId === "player-1"
		) as { readonly actor: string };
		expect(playerSeat.actor).toBe(playerIdentity.publicKeyHex);

		player.stdin.write("hello from player\r");
		await waitFor("player chat envelope", async () => {
			const events = (await readEvents(logFile)) as
				| {
						readonly actor: string;
						readonly payload: unknown;
						readonly type: string;
				  }[]
				| undefined;
			return events?.some(
				(event) =>
					event.type === "core.chat-posted" &&
					event.actor === playerIdentity.publicKeyHex &&
					typeof event.payload === "object" &&
					event.payload !== null &&
					"text" in event.payload &&
					event.payload.text === "hello from player"
			)
				? events
				: undefined;
		});
		gm.stdin.write("/roll 2d6\r");
		await waitFor("GM dice envelope", async () => {
			const events = (await readEvents(logFile)) as
				| { readonly type: string }[]
				| undefined;
			return events?.some((event) => event.type === "core.dice-rolled")
				? events
				: undefined;
		});

		player.stdin.write("/quit\r");
		gm.stdin.write("/quit\r");
		player.stdin.end();
		gm.stdin.end();
		expect(await player.exited).toBe(0);
		expect(await gm.exited).toBe(0);
		expect(await readFile(gmTranscript, "utf-8")).toContain(
			"hello from player"
		);
		expect(await readFile(playerTranscript, "utf-8")).toContain("rolled 2d6");
	}, 120_000);
});
