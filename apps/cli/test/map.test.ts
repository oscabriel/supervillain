/* oxlint-disable vitest/prefer-importing-vitest-globals -- CLI tests run in Bun's native test lane. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
	const scratch = await mkdtemp(path.join(tmpdir(), "supervillain-cli-maps-"));
	folders.push(scratch);
	return path.join(scratch, "campaign");
};

const writeMap = async (
	campaign: string,
	name: string,
	text: string
): Promise<void> => {
	await mkdir(path.join(campaign, "maps"), { recursive: true });
	await writeFile(path.join(campaign, "maps", `${name}.map`), text);
};

afterEach(async () => {
	await Promise.all(
		folders
			.splice(0)
			.map((folder) => rm(folder, { force: true, recursive: true }))
	);
});

describe("supervillain map", () => {
	test("checks and lists the map files in a campaign folder", async () => {
		const campaign = await makeCampaign();
		await writeMap(
			campaign,
			"cavern",
			"name: Cavern Mouth\n---\n###\n#.#\n###\n"
		);
		await writeMap(
			campaign,
			"bog",
			"name: Bog\nlegend: o floor\nlegend: X wall\n---\nXXXX\nXooX\nXXXX\n"
		);

		expect(await runCli(["map", "check", campaign])).toEqual({
			code: 0,
			error: "",
			output: "bog.map: ok\ncavern.map: ok\n",
		});
		expect(await runCli(["map", "list", campaign])).toEqual({
			code: 0,
			error: "",
			output: "Bog — bog.map (4×3)\nCavern Mouth — cavern.map (3×3)\n",
		});
	});

	test("reports every issue in an invalid map file", async () => {
		const campaign = await makeCampaign();
		await writeMap(campaign, "broken", "legend: . floor\n---\n..\n.\n");

		const checked = await runCli(["map", "check", campaign, "broken"]);
		expect(checked.code).toBe(1);
		expect(checked.error).toBe("");
		expect(checked.output).toBe(
			"broken.map: Header must declare a 'name'.\nbroken.map: Row 2 is 1 cells wide; row 1 is 2. Every row must be the same width.\n"
		);
		expect(await runCli(["map", "list", campaign])).toEqual({
			code: 0,
			error: "",
			output: "invalid — broken.map\n",
		});
	});

	test("reports an empty maps folder and a missing file", async () => {
		const campaign = await makeCampaign();
		expect(await runCli(["map", "list", campaign])).toEqual({
			code: 0,
			error: "",
			output: "no map files.\n",
		});
		expect(await runCli(["map", "check", campaign])).toEqual({
			code: 0,
			error: "",
			output: "no map files.\n",
		});
		expect(await runCli(["map", "check", campaign, "absent"])).toEqual({
			code: 1,
			error: "",
			output: "absent.map: file not found.\n",
		});
	});

	test("requires a known subcommand and a campaign folder", async () => {
		const campaign = await makeCampaign();
		expect(await runCli(["map"])).toEqual({
			code: 1,
			error: "map requires check or list.\n",
			output: "",
		});
		expect(await runCli(["map", "list"])).toEqual({
			code: 1,
			error: "map list requires a campaign folder.\n",
			output: "",
		});
		expect(await runCli(["map", "publish", campaign])).toEqual({
			code: 1,
			error: "map requires check or list.\n",
			output: "",
		});
	});
});
