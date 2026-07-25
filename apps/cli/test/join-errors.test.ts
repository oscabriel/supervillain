/* oxlint-disable vitest/prefer-importing-vitest-globals -- CLI tests run in Bun's native test lane. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadOrCreateIdentity } from "@supervillain/identity";
import { startWsListener } from "@supervillain/transport-ws/server";

const DEAD_ROOM = "Could not reach that room. Is the GM's table live?";
const SELF_DIAL =
	"that's your own table — you're already hosting it. to sit as a player, use the ssh door.";
const folders: string[] = [];
const listeners: { readonly close: () => Promise<void> }[] = [];

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

/** A live listener wearing the caller's own key — dialing it is dialing yourself. */
const ownTableAddress = async (config: string): Promise<string> => {
	const identity = await loadOrCreateIdentity(
		path.join(config, "supervillain")
	);
	const listener = await startWsListener({
		secretKeyHex: identity.secretKeyHex,
	});
	listeners.push(listener);
	return listener.url;
};

/** A URL nothing is listening on: the port is bound, then given back. */
const unreachableAddress = async (): Promise<string> => {
	const listener = await startWsListener({
		secretKeyHex: `${"0".repeat(63)}1`,
	});
	const { url } = listener;
	await listener.close();
	return url;
};

const makeConfig = async (): Promise<string> => {
	const scratch = await mkdtemp(path.join(tmpdir(), "supervillain-cli-join-"));
	folders.push(scratch);
	return path.join(scratch, "config");
};

afterEach(async () => {
	await Promise.all(listeners.splice(0).map((listener) => listener.close()));
	await Promise.all(
		folders
			.splice(0)
			.map((folder) => rm(folder, { force: true, recursive: true }))
	);
});

describe("supervillain join failures", () => {
	test("explains that the room reference points to the caller's own table", async () => {
		const config = await makeConfig();
		const result = await runJoin(config, await ownTableAddress(config));
		expect(result).toEqual({ code: 1, error: `${SELF_DIAL}\n` });
	});

	test("keeps the dead-room copy for an address nothing answers on", async () => {
		const config = await makeConfig();
		const result = await runJoin(config, await unreachableAddress());
		expect(result.code).toBe(1);
		expect(result.error.startsWith(`${DEAD_ROOM}\n`)).toBe(true);
	}, 20_000);

	test("shows an unexpected connection error below the dead-room copy", async () => {
		const config = await makeConfig();
		const result = await runJoin(config, "not-a-ws-address");
		expect(result).toEqual({
			code: 1,
			error: `${DEAD_ROOM}\nTransport address 'not-a-ws-address' is not a ws:// or wss:// URL.\n`,
		});
	});
});
