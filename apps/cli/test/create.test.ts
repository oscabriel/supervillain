/* oxlint-disable promise/avoid-new, eslint/no-await-in-loop, vitest/prefer-importing-vitest-globals -- timed PTY writes and sequential cleanup are required by the Bun-lane E2E protocol. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const folders: string[] = [];
const sleep = (milliseconds: number) =>
	new Promise((resolve) => {
		setTimeout(resolve, milliseconds);
	});
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const runCli = async (
	campaign: string,
	config: string,
	inputs: readonly string[]
): Promise<{ readonly code: number; readonly output: string }> => {
	const cli = path.resolve(import.meta.dir, "../dist/index.js");
	const command = `stty cols 100 rows 30; env XDG_CONFIG_HOME=${quote(config)} bun ${quote(cli)} create ${quote(campaign)}`;
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
	for (const folder of folders.splice(0)) {
		await rm(folder, { force: true, recursive: true });
	}
});

describe("supervillain create", () => {
	test("serves a local table, persists its door, and resumes its Log", async () => {
		const scratch = await mkdtemp(path.join(tmpdir(), "supervillain-cli-"));
		folders.push(scratch);
		const campaign = path.join(scratch, "campaign");
		const config = path.join(scratch, "config");
		const first = await runCli(campaign, config, [
			"hello table\r",
			"/roll 2d6+1\r",
			"/quit\r",
		]);
		expect(first.code).toBe(0);
		expect(first.output).toContain(
			"your table is live. summon your players:\r\n\r\n  supervillain join "
		);
		const door = await readFile(path.join(campaign, "door.txt"), "utf-8");
		expect(door.endsWith("\n")).toBe(true);
		expect(door.trim().length).toBeGreaterThan(40);

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
			"core.chat-posted",
			"core.dice-rolled",
		]);
		expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
		expect(events.every((event) => event.actor === identity.publicKeyHex)).toBe(
			true
		);
		expect(events[0].payload).toEqual({ gameId: "fake" });
		expect(events[1].payload).toEqual({ seatId: "gm" });
		expect(events[2].payload).toEqual({ text: "hello table" });
		const dice = events[3].payload;
		expect(dice.rolls).toHaveLength(2);
		expect(dice.rolls.every((roll: number) => roll >= 1 && roll <= 6)).toBe(
			true
		);
		expect(dice.total).toBe(dice.rolls[0] + dice.rolls[1] + 1);

		const resumed = await runCli(campaign, config, ["/quit\r"]);
		expect(resumed.code).toBe(0);
		expect(await readFile(path.join(campaign, "events.jsonl"))).toEqual(bytes);
	}, 40_000);
});
