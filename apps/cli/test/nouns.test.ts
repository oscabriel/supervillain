/* oxlint-disable vitest/prefer-importing-vitest-globals -- CLI tests run in Bun's native test lane. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const folders: string[] = [];

const runCli = async (
	args: readonly string[]
): Promise<{
	readonly code: number;
	readonly error: string;
	readonly output: string;
}> => {
	const cli = path.resolve(import.meta.dir, "../dist/index.js");
	const childProcess = Bun.spawn(["bun", cli, ...args], {
		stderr: "pipe",
		stdout: "pipe",
	});
	const output = new Response(childProcess.stdout).text();
	const error = new Response(childProcess.stderr).text();
	return {
		code: await childProcess.exited,
		error: await error,
		output: await output,
	};
};

const makeCampaign = async (): Promise<string> => {
	const scratch = await mkdtemp(path.join(tmpdir(), "supervillain-cli-nouns-"));
	folders.push(scratch);
	return path.join(scratch, "campaign");
};

afterEach(async () => {
	await Promise.all(
		folders
			.splice(0)
			.map((folder) => rm(folder, { force: true, recursive: true }))
	);
});

describe("supervillain noun commands", () => {
	test("creates, validates, and never overwrites a character file", async () => {
		const campaign = await makeCampaign();
		const created = await runCli(["character", "new", campaign, "Coda Prime!"]);
		const filePath = path.join(campaign, "characters", "coda-prime.json");
		expect(created).toEqual({ code: 0, error: "", output: `${filePath}\n` });
		const original = await readFile(filePath, "utf-8");

		const checked = await runCli(["character", "check", campaign]);
		expect(checked).toEqual({
			code: 0,
			error: "",
			output: "coda-prime.json: ok\n",
		});

		const repeated = await runCli([
			"character",
			"new",
			campaign,
			"Coda Prime!",
		]);
		expect(repeated).toEqual({
			code: 1,
			error: `${filePath} already exists.\n`,
			output: "",
		});
		expect(await readFile(filePath, "utf-8")).toBe(original);
	});

	test("checks every character and reports field-level errors", async () => {
		const campaign = await makeCampaign();
		const created = await runCli(["character", "new", campaign, "Coda"]);
		expect(created.code).toBe(0);
		await writeFile(
			path.join(campaign, "characters", "broken.json"),
			JSON.stringify({ name: "Broken" })
		);

		const result = await runCli(["character", "check", campaign]);
		expect(result.code).toBe(1);
		expect(result.error).toBe("");
		expect(result.output).toContain(
			"broken.json: Field 'ancestry' must be a non-empty string of at most 60 characters.\n"
		);
		expect(result.output).toContain("coda.json: ok\n");
	});

	test("lists valid character names and file names", async () => {
		const campaign = await makeCampaign();
		await runCli(["character", "new", campaign, "Coda"]);
		await runCli(["character", "new", campaign, "Ajax"]);

		const result = await runCli(["character", "list", campaign]);
		expect(result).toEqual({
			code: 0,
			error: "",
			output: "Ajax — ajax.json\nCoda — coda.json\n",
		});
	});

	test("summarizes room logs and rejects a malformed first event", async () => {
		const campaign = await makeCampaign();
		await mkdir(campaign, { recursive: true });
		await writeFile(
			path.join(campaign, "events.jsonl"),
			`${JSON.stringify({ payload: { gameId: "draw-steel" } })}\n${JSON.stringify({ payload: {} })}\n`
		);
		const summary = await runCli(["campaign", "info", campaign]);
		expect(summary).toEqual({
			code: 0,
			error: "",
			output: "game: draw-steel\nevents: 2\ncharacters: 0\n",
		});

		await writeFile(path.join(campaign, "events.jsonl"), "not json\n");
		const malformed = await runCli(["campaign", "info", campaign]);
		expect(malformed).toEqual({
			code: 1,
			error: "events.jsonl is not a room log.\n",
			output: "",
		});
	});

	test("summarizes a campaign before a room exists", async () => {
		const campaign = await makeCampaign();
		const empty = await runCli(["campaign", "info", campaign]);
		expect(empty).toEqual({
			code: 0,
			error: "",
			output: "no room yet.\ncharacters: 0\n",
		});

		await runCli(["character", "new", campaign, "Coda"]);
		const populated = await runCli(["campaign", "info", campaign]);
		expect(populated).toEqual({
			code: 0,
			error: "",
			output: "no room yet.\ncharacters: 1\nCoda — coda.json\n",
		});
	});
});
