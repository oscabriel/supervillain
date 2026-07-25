/* oxlint-disable vitest/prefer-importing-vitest-globals -- CLI tests run in Bun's native test lane. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ROOM_NAME_RULE } from "@supervillain/room-wire";

const NO_GATEWAY =
	"join needs a gateway: pass --gateway <url> or set SUPERVILLAIN_GATEWAY.";
const folders: string[] = [];

const runJoin = async (
	args: readonly string[],
	env: Record<string, string>
): Promise<{ readonly code: number; readonly error: string }> => {
	const cli = path.resolve(import.meta.dir, "../dist/index.js");
	// Spawned by absolute interpreter path so a test may empty PATH.
	const childProcess = Bun.spawn([process.execPath, cli, "join", ...args], {
		env: { ...process.env, SUPERVILLAIN_GATEWAY: undefined, ...env },
		stderr: "pipe",
		stdout: "ignore",
	});
	const error = await new Response(childProcess.stderr).text();
	return { code: await childProcess.exited, error };
};

const makeConfig = async (): Promise<string> => {
	const scratch = await mkdtemp(path.join(tmpdir(), "supervillain-cli-join-"));
	folders.push(scratch);
	return path.join(scratch, "config");
};

afterEach(async () => {
	await Promise.all(
		folders
			.splice(0)
			.map((folder) => rm(folder, { force: true, recursive: true }))
	);
});

describe("supervillain join argument handling", () => {
	test("asks for a gateway when none is configured", async () => {
		const config = await makeConfig();
		const result = await runJoin(["iron-keep"], { XDG_CONFIG_HOME: config });
		expect(result).toEqual({ code: 1, error: `${NO_GATEWAY}\n` });
	});

	test("refuses a room name the gateway could never hold", async () => {
		const config = await makeConfig();
		const result = await runJoin(["Iron Keep", "--gateway", "ws://gateway"], {
			XDG_CONFIG_HOME: config,
		});
		expect(result).toEqual({ code: 1, error: `${ROOM_NAME_RULE}\n` });
	});

	test("refuses a gateway that is not a URL", async () => {
		const config = await makeConfig();
		const result = await runJoin(["iron-keep"], {
			SUPERVILLAIN_GATEWAY: "supervillain.app",
			XDG_CONFIG_HOME: config,
		});
		expect(result).toEqual({
			code: 1,
			error: "'supervillain.app' is not a gateway URL.\n",
		});
	});

	test("refuses an ssh port that is not a port", async () => {
		const config = await makeConfig();
		const result = await runJoin(
			["iron-keep", "--gateway", "ws://gateway:8080", "--ssh-port", "nope"],
			{ XDG_CONFIG_HOME: config }
		);
		expect(result).toEqual({
			code: 1,
			error: "--ssh-port must be a port number between 1 and 65535.\n",
		});
	});

	test("names the missing ssh client and prints the bare door", async () => {
		const config = await makeConfig();
		// An empty PATH is not enough: glibc's execvp falls back to a built-in
		// default path. A real directory holding no ssh is.
		const emptyPath = await mkdtemp(path.join(tmpdir(), "supervillain-nossh-"));
		folders.push(emptyPath);
		const result = await runJoin(
			[
				"iron-keep",
				"--gateway",
				"wss://supervillain.test",
				"--ssh-port",
				"2222",
			],
			{ PATH: emptyPath, XDG_CONFIG_HOME: config }
		);
		expect(result.code).toBe(1);
		expect(result.error).toContain("join needs an ssh client on PATH");
		expect(result.error).toContain("ssh -p 2222 iron-keep@supervillain.test");
		// The re-encoded key is written before the door is tried, and it is the
		// same per-machine credential the Host pipe signs with.
		const keyFile = path.join(config, "supervillain", "id_ed25519");
		const key = await readFile(keyFile, "utf-8");
		expect(key.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----\n")).toBe(true);
		const stats = await stat(keyFile);
		// oxlint-disable-next-line eslint/no-bitwise -- file modes are a bit field.
		expect(stats.mode & 0o777).toBe(0o600);
	});
});
