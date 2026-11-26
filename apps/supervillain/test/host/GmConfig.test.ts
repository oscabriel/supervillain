import { describe, expect } from "bun:test";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";

import { GmConfig } from "../../src/launcher/GmConfig.ts";
import { effect } from "./effect.ts";
import { tempDir } from "./tempDir.ts";

const modeOf = (mode: number): string => mode.toString(8).slice(-3);

describe("gm.json", () => {
	effect(
		"a save swaps a whole new file into place and leaves nothing else behind",
		() =>
			Effect.gen(function* () {
				const folder = path.join(yield* tempDir, "config");
				const config = yield* GmConfig.make(folder);

				yield* config.save({ handle: "ana" });

				const first = yield* Effect.promise(
					async () => await stat(config.path)
				);

				yield* config.save({ handle: "ana", relay: "relay.example:2201" });

				const second = yield* Effect.promise(
					async () => await stat(config.path)
				);

				expect(second.ino).not.toBe(first.ino);
				expect(modeOf(second.mode)).toBe("600");
				expect(yield* config.read).toEqual({
					handle: "ana",
					relay: "relay.example:2201",
				});
				expect(
					yield* Effect.promise(async () => await readdir(folder))
				).toEqual(["gm.json"]);
			})
	);
});
