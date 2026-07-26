/* oxlint-disable vitest/prefer-importing-vitest-globals -- CLI tests run in Bun's native test lane. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { startGateway } from "@supervillain/gateway";
import type { RunningGateway } from "@supervillain/gateway";

import { pinFilePath, pinGateway, readGatewayPins } from "../src/gateways.js";

const folders: string[] = [];
const gateways: RunningGateway[] = [];

const runCli = async (
	config: string,
	args: readonly string[]
): Promise<{
	readonly code: number;
	readonly error: string;
	readonly output: string;
}> => {
	const cli = path.resolve(import.meta.dir, "../dist/index.js");
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

const makeFolder = async (): Promise<string> => {
	const folder = await mkdtemp(
		path.join(tmpdir(), "supervillain-cli-pairing-")
	);
	folders.push(folder);
	return folder;
};

afterEach(async () => {
	await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
	await Promise.all(
		folders
			.splice(0)
			.map((folder) => rm(folder, { force: true, recursive: true }))
	);
});

describe("pairing across CLI gateway consumers", () => {
	test("key verbs pair through self-signed TLS, forget, re-pair, and explain a wire mismatch", async () => {
		const scratch = await makeFolder();
		const firstConfig = path.join(scratch, "first-config");
		const secondConfig = path.join(scratch, "second-config");
		const gateway = await startGateway({
			bindHost: "127.0.0.1",
			brokerPort: 0,
			sshHost: "127.0.0.1",
			sshPort: 0,
			stateDir: path.join(scratch, "gateway"),
		});
		gateways.push(gateway);
		if (gateway.pairingCode === undefined) {
			throw new Error("the self-signed gateway must publish a pairing code");
		}

		const firstLink = await runCli(firstConfig, [
			"key",
			"link",
			"--gateway",
			gateway.pairingCode,
		]);
		expect(firstLink.code).toBe(0);
		expect(firstLink.output).toContain("link code:");
		const firstStore = path.join(firstConfig, "supervillain");
		expect(Object.keys(await readGatewayPins(firstStore))).toHaveLength(1);

		const forgotten = await runCli(firstConfig, [
			"gateway",
			"forget",
			gateway.pairingCode,
		]);
		expect(forgotten.code).toBe(0);
		expect(forgotten.output).toContain(new URL(gateway.url).host);
		expect(forgotten.output).toContain(
			`sha256:${gateway.certificateFingerprint}`
		);
		expect(await readGatewayPins(firstStore)).toEqual({});
		const absent = await runCli(firstConfig, [
			"gateway",
			"forget",
			gateway.url,
		]);
		expect(absent).toMatchObject({
			code: 1,
			error: `nothing pinned for ${new URL(gateway.url).host}.\n`,
		});

		const repaired = await runCli(firstConfig, [
			"key",
			"link",
			"--gateway",
			gateway.pairingCode,
		]);
		expect(repaired.code).toBe(0);
		const code = repaired.output.match(/link code: (?<code>\S+)/u)?.groups
			?.code;
		if (code === undefined) {
			throw new Error("key link did not print a link code");
		}

		const redeemed = await runCli(secondConfig, [
			"key",
			"link",
			code,
			"--gateway",
			gateway.pairingCode,
		]);
		expect(redeemed.code).toBe(0);
		const secondIdentity = JSON.parse(
			await readFile(
				path.join(secondConfig, "supervillain", "identity.json"),
				"utf-8"
			)
		) as { publicKeyHex: string };
		const revoked = await runCli(firstConfig, [
			"key",
			"revoke",
			secondIdentity.publicKeyHex,
			"--gateway",
			gateway.pairingCode,
		]);
		expect(revoked.code).toBe(0);
		expect(revoked.output).toContain(`retired: ${secondIdentity.publicKeyHex}`);

		await pinGateway(firstStore, new URL(gateway.url).origin, "ab".repeat(32));
		const mismatch = await runCli(firstConfig, [
			"key",
			"link",
			"--gateway",
			gateway.url,
		]);
		expect(mismatch.code).toBe(1);
		expect(mismatch.error).toContain("Refused:");
		expect(mismatch.error).toContain(pinFilePath(firstStore));
		expect(mismatch.error).toContain("supervillain gateway forget");
	}, 30_000);
});
