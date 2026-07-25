/* oxlint-disable vitest/prefer-importing-vitest-globals -- CLI tests run in Bun's native test lane. */
import { describe, expect, test } from "bun:test";
import path from "node:path";

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

describe("the gateway role selector", () => {
	test("the CLI's usage names the gateway role as an operator surface", async () => {
		const result = await runCli(["--help"]);
		expect(result.code).toBe(0);
		expect(result.output).toContain("supervillain gateway serve");
		expect(result.output).toContain("Operator role");
	});

	test("`gateway --help` reaches the gateway's own usage through the one door", async () => {
		// This is the load-bearing assertion for "one binary, two roles": the
		// client entry can pull the server half in on demand (ADR-0015).
		const result = await runCli(["gateway", "--help"]);
		expect(result.code).toBe(0);
		expect(result.output).toContain("supervillain gateway serve [options]");
		expect(result.output).toContain("--state <dir>");
	});

	test("`gateway` alone asks for the one subcommand it has", async () => {
		const result = await runCli(["gateway"]);
		expect(result.code).toBe(1);
		expect(result.error).toContain("gateway requires serve.");
	});

	test("an unknown gateway subcommand is refused", async () => {
		const result = await runCli(["gateway", "publish"]);
		expect(result.code).toBe(1);
		expect(result.error).toContain("gateway requires serve.");
	});

	test("a bad serve flag is refused before anything binds", async () => {
		const result = await runCli(["gateway", "serve", "--ssh-port", "nope"]);
		expect(result.code).toBe(1);
		expect(result.error).toContain("--ssh-port");
	});
});
