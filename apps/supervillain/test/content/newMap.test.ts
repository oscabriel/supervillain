import { describe, expect } from "bun:test";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";

import { writeGeneratedMap } from "../../src/content/newMap.ts";
import { effect } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";

const NEW_MAP = path.join(import.meta.dir, "../../src/content/newMap.ts");

const WRITE = `
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { writeGeneratedMap } from ${JSON.stringify(NEW_MAP)};
const failure = await Effect.runPromise(Effect.flip(writeGeneratedMap(process.env.DIR, "keep", 7)).pipe(Effect.provide(BunServices.layer)));
console.log(failure.reason);
`;

const whereNoFileGrows = (code: string, dir: string) =>
	Effect.promise(async () => {
		const proc = Bun.spawn(
			[
				"sh",
				"-c",
				`trap '' XFSZ; ulimit -f 0; exec "$0" -e "$1"`,
				process.execPath,
				code,
			],
			{
				cwd: path.join(import.meta.dir, "../.."),
				env: { ...process.env, DIR: dir },
				stdout: "pipe",
				stderr: "pipe",
			}
		);

		const [out, err] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		await proc.exited;

		return { out: out.trim(), err };
	});

describe("writing a generated map", () => {
	effect("a write that fails leaves no file holding the map's id", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const { out, err } = yield* whereNoFileGrows(WRITE, dir);
			expect(err).toBe("");
			expect(out).toBe("write");
			expect(
				yield* Effect.promise(async () => await readdir(path.join(dir, "maps")))
			).toEqual([]);
			expect((yield* writeGeneratedMap(dir, "keep", 7)).file).toBe(
				"maps/keep-7.txt"
			);
		})
	);
});
