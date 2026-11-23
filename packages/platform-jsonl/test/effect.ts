import { test } from "bun:test";

import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Path } from "effect";
import type { Scope } from "effect";

const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

export const effect = <E>(
	name: string,
	body: () => Effect.Effect<
		unknown,
		E,
		FileSystem.FileSystem | Path.Path | Scope.Scope
	>,
	timeout?: number
) => {
	test(
		name,
		async () => {
			await Effect.runPromise(
				Effect.scoped(Effect.suspend(body)).pipe(Effect.provide(platform))
			);
		},
		timeout
	);
};

export const tempDir = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;

	return yield* fs.makeTempDirectoryScoped({ prefix: "sv-platform-jsonl-" });
});

const inCampaign = (dir: string, name: string) =>
	Effect.gen(function* () {
		const path = yield* Path.Path;

		return path.join(dir, name);
	});

export const logPath = (dir: string) => inCampaign(dir, "events.jsonl");

export const lockPath = (dir: string) => inCampaign(dir, "events.lock");

export const readLog = (dir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;

		return yield* fs.readFileString(yield* logPath(dir));
	});

export const writeLog = (dir: string, text: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		yield* fs.writeFileString(yield* logPath(dir), text);
	});

export const appendLog = (dir: string, text: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		yield* fs.writeFileString(yield* logPath(dir), text, { flag: "a" });
	});
