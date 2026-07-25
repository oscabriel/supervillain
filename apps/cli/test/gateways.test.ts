/* oxlint-disable vitest/prefer-importing-vitest-globals, unicorn/no-await-expression-member, eslint/prefer-destructuring -- Bun-only suite: the CLI is Bun-bound, and reading one field off a freshly-read pin store is the assertion. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { InvalidPairingCodeError } from "@supervillain/transport-ws";

import {
	PinnedGatewayChangedError,
	pinFilePath,
	pinGateway,
	plaintextWarning,
	readGatewayPins,
	resolveGatewayTarget,
} from "../src/gateways.js";

const folders: string[] = [];

const configFolder = async (): Promise<string> => {
	const folder = await mkdtemp(path.join(tmpdir(), "supervillain-pins-"));
	folders.push(folder);
	return folder;
};

afterEach(async () => {
	await Promise.all(
		folders
			.splice(0)
			.map((folder) => rm(folder, { force: true, recursive: true }))
	);
});

const FINGERPRINT = "ab".repeat(32);
const OTHER = "cd".repeat(32);
const CODE = `wss://box.example:8443#fp=sha256:${FINGERPRINT}`;

describe("resolving a gateway address", () => {
	test("takes a pairing code's fingerprint on first use and pins on success", async () => {
		const folder = await configFolder();
		const target = await resolveGatewayTarget(folder, CODE);
		expect(target).toEqual({
			fingerprint: FINGERPRINT,
			origin: "wss://box.example:8443",
			pinOnSuccess: true,
			url: "wss://box.example:8443/",
		});
		expect(await readGatewayPins(folder)).toEqual({});
		await pinGateway(folder, target.origin, FINGERPRINT);
		expect((await readGatewayPins(folder))[target.origin]?.fingerprint).toBe(
			FINGERPRINT
		);
	});

	test("reconnects against the pin without the code, and without re-pairing", async () => {
		const folder = await configFolder();
		await pinGateway(folder, "wss://box.example:8443", FINGERPRINT);
		expect(
			await resolveGatewayTarget(folder, "wss://box.example:8443")
		).toEqual({
			fingerprint: FINGERPRINT,
			origin: "wss://box.example:8443",
			pinOnSuccess: false,
			url: "wss://box.example:8443/",
		});
		// The same code again is the same decision, not a second one.
		expect((await resolveGatewayTarget(folder, CODE)).pinOnSuccess).toBe(false);
	});

	test("refuses a code whose fingerprint is not the pinned one", async () => {
		const folder = await configFolder();
		await pinGateway(folder, "wss://box.example:8443", FINGERPRINT);
		const changed = `wss://box.example:8443#fp=sha256:${OTHER}`;
		let refusal: unknown;
		try {
			await resolveGatewayTarget(folder, changed);
		} catch (error) {
			refusal = error;
		}
		expect(refusal).toBeInstanceOf(PinnedGatewayChangedError);
		const message = (refusal as Error).message;
		expect(message).toContain("Refused");
		expect(message).toContain(FINGERPRINT);
		expect(message).toContain(OTHER);
		expect(message).toContain(pinFilePath(folder));
	});

	test("a bare URL never downgrades a pinned gateway to CA trust", async () => {
		const folder = await configFolder();
		await pinGateway(folder, "wss://box.example:8443", FINGERPRINT);
		expect(
			(await resolveGatewayTarget(folder, "wss://box.example:8443/pipe"))
				.fingerprint
		).toBe(FINGERPRINT);
	});

	test("leaves an unpinned CA-checked gateway unpinned", async () => {
		const folder = await configFolder();
		expect(
			await resolveGatewayTarget(folder, "wss://supervillain.example/pipe")
		).toEqual({
			fingerprint: undefined,
			origin: "wss://supervillain.example",
			pinOnSuccess: false,
			url: "wss://supervillain.example/pipe",
		});
	});

	test("refuses a fragment that is not a fingerprint rather than ignoring it", async () => {
		const folder = await configFolder();
		await expect(
			resolveGatewayTarget(folder, "wss://box.example#token=hunter2")
		).rejects.toBeInstanceOf(InvalidPairingCodeError);
	});

	test("writes the pin store readable only by its owner", async () => {
		const folder = await configFolder();
		await pinGateway(folder, "wss://box.example:8443", FINGERPRINT);
		const stored = JSON.parse(await readFile(pinFilePath(folder), "utf-8"));
		expect(stored.version).toBe(1);
		expect(stored.gateways["wss://box.example:8443"].pinnedAt).toBeString();
	});

	test("refuses to guess at a damaged pin store", async () => {
		const folder = await configFolder();
		await writeFile(pinFilePath(folder), "{not json");
		await expect(readGatewayPins(folder)).rejects.toBeInstanceOf(TypeError);
	});
});

describe("the plaintext warning", () => {
	test("fires for a plaintext pipe to another machine", () => {
		expect(plaintextWarning("ws://box.example:8443")).toContain("plaintext");
	});

	test("stays quiet for loopback development and for wss", () => {
		expect(plaintextWarning("ws://127.0.0.1:8443")).toBeUndefined();
		expect(plaintextWarning("ws://localhost:8443")).toBeUndefined();
		expect(plaintextWarning("wss://box.example:8443")).toBeUndefined();
	});
});
