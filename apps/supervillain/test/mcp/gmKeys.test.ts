import { describe, expect } from "bun:test";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect, Logger, Ref } from "effect";

import {
	GM_KEYS_BYTES,
	GM_KEYS_FILE,
	readGmKeys,
	warnGmKeys,
} from "../../src/mcp/gmKeys.ts";
import { effect } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";

const FINGERPRINT = "SHA256:vexVEXvexVEXvexVEXvexVEXvexVEXvexVEXvexVEXv";

const written = (dir: string, text: string, mode = 0o600) =>
	Effect.promise(async () => {
		const file = path.join(dir, GM_KEYS_FILE);
		await writeFile(file, text);
		await chmod(file, mode);
	});

describe("gm_keys", () => {
	effect("a private plain gm_keys lists its fingerprints", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;

			yield* written(dir, `${FINGERPRINT}\nnot a key\n`);

			const keys = yield* readGmKeys(dir);

			expect(keys.problem).toBeUndefined();
			expect([...keys.fingerprints]).toEqual([FINGERPRINT]);
		})
	);

	effect(
		"a symlinked, loose, oversized or non-UTF-8 gm_keys gives no keys and says why",
		() =>
			Effect.gen(function* () {
				const linked = yield* tempDir;
				const target = path.join(yield* tempDir, "keys");

				yield* Effect.promise(async () => {
					await writeFile(target, `${FINGERPRINT}\n`);
					await chmod(target, 0o600);
					await symlink(target, path.join(linked, GM_KEYS_FILE));
				});

				const viaLink = yield* readGmKeys(linked);

				expect(viaLink.fingerprints.size).toBe(0);
				expect(viaLink.problem).toContain("isn't a plain file");

				const folder = yield* tempDir;

				yield* Effect.promise(async () => {
					await mkdir(path.join(folder, GM_KEYS_FILE));
				});

				expect((yield* readGmKeys(folder)).problem).toContain(
					"isn't a plain file"
				);

				const loose = yield* tempDir;

				yield* written(loose, `${FINGERPRINT}\n`, 0o620);

				const looseKeys = yield* readGmKeys(loose);

				expect(looseKeys.fingerprints.size).toBe(0);
				expect(looseKeys.problem).toContain("written by others");

				const big = yield* tempDir;

				yield* written(
					big,
					`${FINGERPRINT}\n`.repeat(GM_KEYS_BYTES / FINGERPRINT.length + 1)
				);

				const bigKeys = yield* readGmKeys(big);

				expect(bigKeys.fingerprints.size).toBe(0);
				expect(bigKeys.problem).toContain("KB");

				const binary = yield* tempDir;

				yield* Effect.promise(async () => {
					const file = path.join(binary, GM_KEYS_FILE);
					await writeFile(file, new Uint8Array([0xff, 0xfe, 0xfd]));
					await chmod(file, 0o600);
				});

				expect((yield* readGmKeys(binary)).problem).toContain("text;");
			})
	);

	effect(
		"a gm_keys problem is warned once until it changes, not on every connection",
		() =>
			Effect.gen(function* () {
				const logs: Array<string> = [];

				const logger = Logger.make(({ message }) => {
					logs.push(
						(Array.isArray(message) ? message : [message]).map(String).join(" ")
					);
				});

				const warned = yield* Ref.make<string | undefined>(undefined);
				const loose = { fingerprints: new Set<string>(), problem: "loose" };
				const other = { fingerprints: new Set<string>(), problem: "other" };
				const fine = { fingerprints: new Set<string>() };

				yield* Effect.forEach(
					[loose, loose, loose, other, other, fine, loose],
					(keys) => warnGmKeys(warned, keys),
					{ concurrency: 1, discard: true }
				).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])));

				expect(logs).toEqual([
					"agents: loose",
					"agents: other",
					"agents: loose",
				]);
			})
	);
});
