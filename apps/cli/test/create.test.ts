/* oxlint-disable promise/avoid-new, eslint/no-await-in-loop, vitest/prefer-importing-vitest-globals -- timed PTY writes and sequential cleanup are required by the Bun-lane E2E protocol. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { startGateway } from "@supervillain/gateway";
import type { RunningGateway } from "@supervillain/gateway";
import { isValidRoomName } from "@supervillain/room-wire";

import { generateRoomName, registerGeneratedName } from "../src/room-names.js";

const folders: string[] = [];
const gateways: RunningGateway[] = [];
const sleep = (milliseconds: number) =>
	new Promise((resolve) => {
		setTimeout(resolve, milliseconds);
	});
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const reserveLoopbackPort = async (): Promise<number> => {
	const server = Bun.serve({
		fetch: () => new Response(),
		hostname: "127.0.0.1",
		port: 0,
	});
	const { port } = server;
	await server.stop(true);
	return port;
};
const runCli = async (
	campaign: string,
	config: string,
	inputs: readonly string[],
	createArgs: readonly string[]
): Promise<{ readonly code: number; readonly output: string }> => {
	const cli = path.resolve(import.meta.dir, "../dist/index.js");
	const quotedCreateArgs = createArgs.map(quote).join(" ");
	const command = `stty cols 100 rows 30; env XDG_CONFIG_HOME=${quote(config)} bun ${quote(cli)} create ${quote(campaign)} ${quotedCreateArgs}`;
	const process = Bun.spawn(["script", "-qec", command, "/dev/null"], {
		stderr: "ignore",
		stdin: "pipe",
		stdout: "pipe",
	});
	const output = new Response(process.stdout).text();
	await sleep(1200);
	for (const input of inputs) {
		process.stdin.write(input);
		await sleep(700);
	}
	process.stdin.end();
	return { code: await process.exited, output: await output };
};

afterEach(async () => {
	for (const gateway of gateways.splice(0)) {
		await gateway.close();
	}
	for (const folder of folders.splice(0)) {
		await rm(folder, { force: true, recursive: true });
	}
});

describe("room name generation", () => {
	test("every generated two-word name satisfies the room-name rule", () => {
		for (let draw = 0; draw < 5000; draw += 1) {
			const name = generateRoomName();
			expect(name.split("-")).toHaveLength(2);
			expect(name).not.toMatch(/\d/u);
			expect(isValidRoomName(name)).toBe(true);
		}
	});

	test("regenerates a generated name when registration reports a collision", async () => {
		const names = ["amber-badger", "brisk-cobra"];
		const attempted: string[] = [];
		const result = await registerGeneratedName({
			generate: () => names.shift() ?? "calm-dingo",
			register: (name) => {
				attempted.push(name);
				return Promise.resolve(
					name === "amber-badger"
						? {
								failed:
									"The name 'amber-badger' is already claimed by another key.",
							}
						: { value: "attached" }
				);
			},
		});

		expect(attempted).toEqual(["amber-badger", "brisk-cobra"]);
		expect(result).toEqual({ name: "brisk-cobra", value: "attached" });
	});

	test("stops after a bounded number of generated-name collisions", async () => {
		let attempts = 0;
		const result = await registerGeneratedName({
			generate: () => "amber-badger",
			register: (name) => {
				attempts += 1;
				return Promise.resolve({
					failed: `The name '${name}' is already claimed by another key.`,
				});
			},
		});

		expect(attempts).toBe(5);
		expect(result).toEqual({
			failed: "Could not find an available room name after 5 attempts.",
		});
	});
});

describe("supervillain create", () => {
	test("creates with a generated room name and no gateway", async () => {
		const scratch = await mkdtemp(path.join(tmpdir(), "supervillain-cli-"));
		folders.push(scratch);
		// ADR-0030: Message is opt-in — bare printables route to the focused
		// pane (Feed on these mapless tables), so every typed line below leads
		// with Shift+Tab (\x1b[Z), the reverse-ring Feed → Message gesture. A
		// send returns focus to the pane it came from, so the per-line gesture
		// is idempotent (#132).
		const result = await runCli(
			path.join(scratch, "campaign"),
			path.join(scratch, "config"),
			["\u001B[Z/quit\r"],
			[]
		);

		expect(result.code).toBe(0);
		const match = /this room is called:\s+(?<name>[a-z]+-[a-z]+)/u.exec(
			result.output
		);
		expect(match).not.toBeNull();
		expect(isValidRoomName(match?.groups?.name ?? "")).toBe(true);
		expect(result.output).toContain(
			"no room is registered, so this table is local to this machine."
		);
	}, 15_000);

	test("registers its generated name when a gateway is configured", async () => {
		const scratch = await mkdtemp(path.join(tmpdir(), "supervillain-cli-"));
		folders.push(scratch);
		const gateway = await startGateway({
			bindHost: "127.0.0.1",
			brokerPort: 0,
			sshHost: "127.0.0.1",
			sshPort: 0,
			stateDir: path.join(scratch, "gateway"),
		});
		gateways.push(gateway);
		const result = await runCli(
			path.join(scratch, "campaign"),
			path.join(scratch, "config"),
			["\u001B[Z/quit\r"],
			["--gateway", gateway.pairingCode ?? gateway.url]
		);

		expect(result.code).toBe(0);
		const name = /this room is called:\s+(?<name>[a-z]+-[a-z]+)/u.exec(
			result.output
		)?.groups?.name;
		expect(name).toBeDefined();
		expect(result.output).toContain(`${name}@127.0.0.1`);
		expect(result.output).toContain(`supervillain join ${name}`);
	}, 15_000);

	test("reports an unreachable gateway and attaches when it becomes reachable", async () => {
		const scratch = await mkdtemp(path.join(tmpdir(), "supervillain-cli-"));
		folders.push(scratch);
		const campaign = path.join(scratch, "campaign");
		const config = path.join(scratch, "config");
		const brokerPort = await reserveLoopbackPort();
		const gatewayAddress = `ws://127.0.0.1:${brokerPort}/`;
		const cli = path.resolve(import.meta.dir, "../dist/index.js");
		const command = `stty cols 100 rows 30; env XDG_CONFIG_HOME=${quote(config)} bun ${quote(cli)} create ${quote(campaign)} --name retry-room --gateway ${quote(gatewayAddress)}`;
		const process = Bun.spawn(["script", "-qec", command, "/dev/null"], {
			stderr: "ignore",
			stdin: "pipe",
			stdout: "pipe",
		});
		let output = "";
		const outputDone = (async (): Promise<void> => {
			for await (const chunk of process.stdout) {
				output += Buffer.from(chunk).toString();
			}
		})();
		const waitForOutput = async (expected: string): Promise<void> => {
			for (let attempt = 0; attempt < 200; attempt += 1) {
				if (output.includes(expected)) {
					return;
				}
				// oxlint-disable-next-line eslint/no-await-in-loop -- polling bounded process output is the test protocol.
				await sleep(25);
			}
			throw new Error(`Timed out waiting for '${expected}'. Output: ${output}`);
		};

		await waitForOutput("dialing 127.0.0.1…");
		const gateway = await startGateway({
			bindHost: "127.0.0.1",
			brokerPort,
			sshHost: "127.0.0.1",
			sshPort: 0,
			stateDir: path.join(scratch, "gateway"),
			tls: { mode: "terminated-upstream" },
		});
		gateways.push(gateway);
		await waitForOutput("your table is live. summon your players:");
		process.stdin.write("\u001B[Z/quit\r");
		process.stdin.end();
		expect(await process.exited).toBe(0);
		await outputDone;
		expect(output).toContain("retry-room@127.0.0.1");
		expect(output).not.toContain("still trying");
	}, 15_000);

	test("registers a room at the gateway and resumes its Log", async () => {
		const scratch = await mkdtemp(path.join(tmpdir(), "supervillain-cli-"));
		folders.push(scratch);
		const campaign = path.join(scratch, "campaign");
		const config = path.join(scratch, "config");
		const characters = path.join(campaign, "characters");
		await mkdir(characters, { recursive: true });
		await writeFile(
			path.join(characters, "coda.json"),
			JSON.stringify({
				ancestry: "Human",
				characteristics: {
					agility: 1,
					intuition: 1,
					might: 2,
					presence: 2,
					reason: 0,
				},
				class: "Troubadour",
				heroicResource: "Drama",
				name: "Coda",
				recoveries: 8,
				stamina: 20,
			})
		);
		await writeFile(path.join(characters, "invalid.json"), "not json");
		const gateway = await startGateway({
			bindHost: "127.0.0.1",
			brokerPort: 0,
			sshHost: "127.0.0.1",
			sshPort: 0,
			stateDir: path.join(scratch, "gateway"),
		});
		gateways.push(gateway);
		const gatewayAddress = gateway.pairingCode ?? gateway.url;
		const createArgs = ["--name", "test-room", "--gateway", gatewayAddress];
		const first = await runCli(
			campaign,
			config,
			["\u001B[Zhello table\r", "\u001B[Z/roll 2d6+1\r", "\u001B[Z/quit\r"],
			createArgs
		);
		expect(first.code).toBe(0);
		expect(first.output).toContain("your table is live. summon your players:");
		expect(first.output).toContain("test-room@127.0.0.1");
		expect(first.output).toContain("supervillain join test-room");
		expect(first.output).toContain(
			"invalid.json: Character file must contain valid UTF-8 JSON."
		);
		const bytes = await readFile(path.join(campaign, "events.jsonl"));
		const events = bytes.toString().trim().split("\n").map(JSON.parse);
		const identity = JSON.parse(
			await readFile(
				path.join(config, "supervillain", "identity.json"),
				"utf-8"
			)
		);
		expect(events.map((event) => event.type)).toEqual([
			"core.room-created",
			"core.seat-claimed",
			"ds.character-entered",
			"core.chat-posted",
			"core.dice-rolled",
		]);
		expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
		expect(events.every((event) => event.actor === identity.publicKeyHex)).toBe(
			true
		);
		expect(events[0].payload).toEqual({ gameId: "draw-steel" });
		expect(events[1].payload).toEqual({ seatId: "gm" });
		expect(events[2].payload).toMatchObject({
			sheet: {
				ancestry: "Human",
				className: "Troubadour",
				heroicResource: "Drama",
				name: "Coda",
			},
		});
		expect(events[3].payload).toEqual({ text: "hello table" });
		const dice = events[4].payload;
		expect(dice.rolls).toHaveLength(2);
		expect(dice.rolls.every((roll: number) => roll >= 1 && roll <= 6)).toBe(
			true
		);
		expect(dice.total).toBe(dice.rolls[0] + dice.rolls[1] + 1);

		const resumed = await runCli(
			campaign,
			config,
			["\u001B[Z/quit\r"],
			createArgs
		);
		expect(resumed.code).toBe(0);
		expect(await readFile(path.join(campaign, "events.jsonl"))).toEqual(bytes);
	}, 40_000);
});
