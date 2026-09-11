/* oxlint-disable vitest/prefer-importing-vitest-globals -- CLI tests run in Bun's native test lane. */
import { afterEach, describe, expect, test } from "bun:test";
import {
	access,
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
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
	test("--version prints the CLI version and exits 0", async () => {
		const result = await runCli(["--version"]);
		expect(result.code).toBe(0);
		expect(result.error).toBe("");
		expect(result.output).toMatch(/^\d+\.\d+\.\d+\n$/u);
		// CLI_VERSION is hand-mirrored from package.json (a compiled binary has
		// no package.json to read); this is what keeps the two from drifting.
		const pkg = JSON.parse(
			await readFile(path.resolve(import.meta.dir, "../package.json"), "utf-8")
		) as { version: string };
		expect(result.output).toBe(`${pkg.version}\n`);
	});

	test("key link needs a gateway, and takes at most one code", async () => {
		const config = await makeCampaign();
		const cli = path.resolve(import.meta.dir, "../dist/index.js");
		const run = async (
			args: readonly string[]
		): Promise<{ readonly code: number; readonly error: string }> => {
			const childProcess = Bun.spawn(["bun", cli, ...args], {
				env: {
					...process.env,
					SUPERVILLAIN_GATEWAY: "",
					XDG_CONFIG_HOME: config,
				},
				stderr: "pipe",
				stdout: "pipe",
			});
			const error = new Response(childProcess.stderr).text();
			return { code: await childProcess.exited, error: await error };
		};
		expect(await run(["key", "link"])).toEqual({
			code: 1,
			error:
				"key link needs a gateway: pass --gateway <addr> or set SUPERVILLAIN_GATEWAY.\n",
		});
		expect(await run(["key", "link", "ONE", "TWO"])).toEqual({
			code: 1,
			error: "key link takes at most one code.\n",
		});
		expect(await run(["key", "sever"])).toEqual({
			code: 1,
			error: "key requires show, link, or revoke.\n",
		});
	});

	test("key revoke needs a gateway, and exactly one key", async () => {
		const config = await makeCampaign();
		const cli = path.resolve(import.meta.dir, "../dist/index.js");
		const run = async (
			args: readonly string[]
		): Promise<{ readonly code: number; readonly error: string }> => {
			const childProcess = Bun.spawn(["bun", cli, ...args], {
				env: {
					...process.env,
					SUPERVILLAIN_GATEWAY: "",
					XDG_CONFIG_HOME: config,
				},
				stderr: "pipe",
				stdout: "pipe",
			});
			const error = new Response(childProcess.stderr).text();
			return { code: await childProcess.exited, error: await error };
		};
		// The key to retire is never guessed: naming it is the whole request.
		expect(await run(["key", "revoke"])).toEqual({
			code: 1,
			error: "key revoke takes exactly one key.\n",
		});
		expect(await run(["key", "revoke", "ONE", "TWO"])).toEqual({
			code: 1,
			error: "key revoke takes exactly one key.\n",
		});
		expect(await run(["key", "revoke", "abc123"])).toEqual({
			code: 1,
			error:
				"key revoke needs a gateway: pass --gateway <addr> or set SUPERVILLAIN_GATEWAY.\n",
		});
	});

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

	test("rejects character names with no filename-safe characters", async () => {
		const campaign = await makeCampaign();
		const results = await Promise.all(
			["---", "英雄"].map((name) =>
				runCli(["character", "new", campaign, name])
			)
		);
		for (const result of results) {
			expect(result).toEqual({
				code: 1,
				error:
					"Character name has no filename-safe characters; pass an ASCII name.\n",
				output: "",
			});
		}
		await expect(
			access(path.join(campaign, "characters"))
		).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	test("reports a missing character file as not found", async () => {
		const campaign = await makeCampaign();
		const result = await runCli([
			"character",
			"check",
			campaign,
			"missing.json",
		]);
		expect(result).toEqual({
			code: 1,
			error: "",
			output: "missing.json: file not found.\n",
		});
	});

	test.skipIf(process.getuid?.() === 0)(
		"does not report a permission error as file not found",
		async () => {
			const campaign = await makeCampaign();
			const created = await runCli(["character", "new", campaign, "Private"]);
			expect(created.code).toBe(0);
			const filePath = path.join(campaign, "characters", "private.json");
			await chmod(filePath, 0o000);
			try {
				const result = await runCli([
					"character",
					"check",
					campaign,
					"private.json",
				]);
				expect(result.code).toBe(1);
				expect(result.error).toBe("");
				expect(result.output).toStartWith("private.json:");
				expect(result.output).toMatch(/EACCES|permission denied/iu);
				expect(result.output).not.toContain("file not found.");
			} finally {
				await chmod(filePath, 0o600);
			}
		}
	);

	test("atomically rejects concurrent creation of the same character", async () => {
		const campaign = await makeCampaign();
		const filePath = path.join(campaign, "characters", "coda.json");
		const results = await Promise.all([
			runCli(["character", "new", campaign, "Coda"]),
			runCli(["character", "new", campaign, "Coda"]),
		]);
		expect(results.filter((result) => result.code === 0)).toHaveLength(1);
		expect(results.filter((result) => result.code === 1)).toEqual([
			{ code: 1, error: `${filePath} already exists.\n`, output: "" },
		]);
		expect(JSON.parse(await readFile(filePath, "utf-8"))).toEqual({
			abilities: [],
			ancestry: "Human",
			characteristics: {
				agility: 1,
				intuition: 0,
				might: 2,
				presence: 0,
				reason: 1,
			},
			class: "Tactician",
			heroicResource: "Focus",
			kit: "Sword and Board",
			name: "Coda",
			recoveries: 8,
			stamina: 21,
			surges: 0,
			victories: 0,
		});
	});

	test("rejects invalid UTF-8 character bytes", async () => {
		const campaign = await makeCampaign();
		const directory = path.join(campaign, "characters");
		await mkdir(directory, { recursive: true });
		await writeFile(
			path.join(directory, "broken.json"),
			new Uint8Array([255, 254])
		);

		const result = await runCli(["character", "check", campaign]);
		expect(result).toEqual({
			code: 1,
			error: "",
			output: "broken.json: Character file must contain valid UTF-8 JSON.\n",
		});
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

	test("campaign pull copies a room log one way, for seated identities only", async () => {
		const scratch = await makeCampaign();
		const cli = path.resolve(import.meta.dir, "../dist/index.js");
		const runAs = async (
			config: string,
			args: readonly string[]
		): Promise<{
			readonly code: number;
			readonly error: string;
			readonly output: string;
		}> => {
			const childProcess = Bun.spawn(["bun", cli, ...args], {
				env: { ...process.env, XDG_CONFIG_HOME: config },
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
		// Two machines, two identities: the CLI's key is the one asking to pull.
		const gmConfig = path.join(scratch, "gm-config");
		const strangerConfig = path.join(scratch, "stranger-config");
		const shown = await runAs(gmConfig, ["key", "show"]);
		const gmKey = /^key:\s+(?<key>[0-9a-f]{64})$/mu.exec(shown.output)?.groups
			?.key;
		expect(gmKey).toBeDefined();

		const source = path.join(scratch, "source");
		await mkdir(source, { recursive: true });
		const logBytes = `${[
			{ actor: gmKey, payload: { gameId: "fake" }, type: "core.room-created" },
			{ actor: gmKey, payload: { seatId: "gm" }, type: "core.seat-claimed" },
			{ actor: gmKey, payload: { text: "hi" }, type: "core.chat-posted" },
		]
			.map((line, index) =>
				JSON.stringify({
					...line,
					seq: index + 1,
					timestamp: "2026-01-01T00:00:00.000Z",
				})
			)
			.join("\n")}\n`;
		await writeFile(path.join(source, "events.jsonl"), logBytes);

		const refusedInto = path.join(scratch, "refused");
		expect(
			await runAs(strangerConfig, ["campaign", "pull", source, refusedInto])
		).toEqual({
			code: 1,
			error:
				"Only an identity that holds or has held a seat in this room can pull its log.\n",
			output: "",
		});
		await expect(access(refusedInto)).rejects.toThrow();

		const pulledInto = path.join(scratch, "pulled");
		const pulled = await runAs(gmConfig, [
			"campaign",
			"pull",
			source,
			pulledInto,
		]);
		expect(pulled.code).toBe(0);
		expect(pulled.error).toBe("");
		expect(pulled.output).toStartWith(
			`pulled 3 events into ${path.join(pulledInto, "events.jsonl")}\n`
		);
		expect(await readFile(path.join(pulledInto, "events.jsonl"), "utf-8")).toBe(
			logBytes
		);
		expect(await runAs(gmConfig, ["campaign", "info", pulledInto])).toEqual({
			code: 0,
			error: "",
			output: "game: fake\nevents: 3\ncharacters: 0\n",
		});

		// Never twice into the same folder, and never with a missing argument.
		expect(
			await runAs(gmConfig, ["campaign", "pull", source, pulledInto])
		).toEqual({
			code: 1,
			error: `${pulledInto} is not empty. pull writes only into a fresh campaign folder.\n`,
			output: "",
		});
		expect(await runAs(gmConfig, ["campaign", "pull", source])).toEqual({
			code: 1,
			error: "campaign pull requires a room and a fresh campaign folder.\n",
			output: "",
		});
		expect(await runAs(gmConfig, ["campaign", "push", source])).toEqual({
			code: 1,
			error: "campaign requires info or pull.\n",
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
