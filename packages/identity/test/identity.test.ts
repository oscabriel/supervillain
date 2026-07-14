/* oxlint-disable eslint/no-await-in-loop, eslint/no-bitwise, unicorn/no-await-expression-member, vitest/prefer-importing-vitest-globals -- sequential cleanup and POSIX mode assertion are intentional. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadOrCreateIdentity } from "../src/index.js";

const folders: string[] = [];
const makeFolder = async (): Promise<string> => {
	const folder = await mkdtemp(path.join(tmpdir(), "supervillain-identity-"));
	folders.push(folder);
	return folder;
};

afterEach(async () => {
	for (const folder of folders.splice(0)) {
		await rm(folder, { force: true, recursive: true });
	}
});

describe("loadOrCreateIdentity", () => {
	test("creates a private ed25519 identity and returns it stably", async () => {
		const folder = path.join(await makeFolder(), "nested");
		const first = await loadOrCreateIdentity(folder);
		expect(first.publicKeyHex).toMatch(/^[0-9a-f]{64}$/u);
		expect(first.secretKeyHex).toMatch(/^[0-9a-f]{64}$/u);
		expect((await stat(path.join(folder, "identity.json"))).mode & 0o777).toBe(
			0o600
		);
		expect(await loadOrCreateIdentity(folder)).toEqual(first);
	});

	test("throws rather than replacing a corrupt identity", async () => {
		const folder = await makeFolder();
		await writeFile(path.join(folder, "identity.json"), "not json");
		await expect(loadOrCreateIdentity(folder)).rejects.toThrow("Identity file");
		expect(await readFile(path.join(folder, "identity.json"), "utf-8")).toBe(
			"not json"
		);
	});
});
