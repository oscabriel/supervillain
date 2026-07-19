/* oxlint-disable vitest/prefer-importing-vitest-globals -- CLI tests run in Bun's native test lane. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadOrCreateIdentity } from "@supervillain/identity";
import { openIrohEndpoint } from "@supervillain/transport-iroh";
import type { TransportAddress } from "@supervillain/transport-iroh";

const DEAD_ROOM = "Could not reach that room. Is the GM's table live?";
const SELF_DIAL =
	"that's your own table — you're already hosting it. to sit as a player, use the ssh door.";
const folders: string[] = [];

const runJoin = async (
	config: string,
	address: string
): Promise<{ readonly code: number; readonly error: string }> => {
	const cli = path.resolve(import.meta.dir, "../dist/index.js");
	const childProcess = Bun.spawn(["bun", cli, "join", address], {
		env: { ...process.env, XDG_CONFIG_HOME: config },
		stderr: "pipe",
		stdout: "ignore",
	});
	const error = await new Response(childProcess.stderr).text();
	return { code: await childProcess.exited, error };
};

const unavailableAddress = async (
	config: string,
	self: boolean
): Promise<TransportAddress> => {
	const identity = await loadOrCreateIdentity(
		path.join(config, "supervillain")
	);
	const endpoint = await openIrohEndpoint({
		routing: "direct",
		secretKeyHex: self ? identity.secretKeyHex : undefined,
	});
	const { address } = endpoint;
	await endpoint.close();
	return address;
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

describe("supervillain join failures", () => {
	test("explains that the room reference points to the caller's own table", async () => {
		const config = await makeConfig();
		const result = await runJoin(
			config,
			await unavailableAddress(config, true)
		);
		expect(result).toEqual({ code: 1, error: `${SELF_DIAL}\n` });
	});

	test("keeps the dead-room copy for a dial timeout", async () => {
		const config = await makeConfig();
		const result = await runJoin(
			config,
			await unavailableAddress(config, false)
		);
		expect(result).toEqual({ code: 1, error: `${DEAD_ROOM}\n` });
	}, 20_000);

	test("shows an unexpected connection error below the dead-room copy", async () => {
		const config = await makeConfig();
		const result = await runJoin(config, "not-an-iroh-address");
		expect(result).toEqual({
			code: 1,
			error: `${DEAD_ROOM}\nInvalid transport address\n`,
		});
	});
});
