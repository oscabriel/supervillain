import { describe, expect } from "bun:test";

import { Effect, FileSystem, Layer, Path } from "effect";

import { CampaignLog } from "../src/index.ts";
import { diskTakes, sameDisk } from "./disk.ts";
import {
	appendLog,
	effect,
	lockPath,
	readLog,
	tempDir,
	writeLog,
} from "./effect.ts";
import { line, text } from "./lines.ts";

const using = <ROut, E1, RIn, A, E2, R2>(
	layer: Layer.Layer<ROut, E1, RIn>,
	body: Effect.Effect<A, E2, R2>
) =>
	Effect.scoped(
		Effect.flatMap(Layer.build(layer), (context) =>
			Effect.provideContext(body, context)
		)
	);

const withLogOn = <A, E, R>(
	disk: Layer.Layer<FileSystem.FileSystem, never, FileSystem.FileSystem>,
	dir: string,
	body: (log: CampaignLog["Service"]) => Effect.Effect<A, E, R>
) =>
	using(
		CampaignLog.layer(dir).pipe(Layer.provide(disk)),
		Effect.flatMap(Effect.service(CampaignLog), body)
	);

const withLog = <A, E, R>(
	dir: string,
	body: (log: CampaignLog["Service"]) => Effect.Effect<A, E, R>
) => withLogOn(sameDisk, dir, body);

const linesOf = (log: CampaignLog["Service"]) => log.lines(0);

describe("CampaignLog", () => {
	effect("reads back what it appended, one JSON object per line", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const first = [line(1, "added", { n: 2 }), line(2, "added", { n: 3 })];
			yield* withLog(dir, (log) => log.append(first));
			const reopened = yield* withLog(dir, linesOf);
			expect(reopened).toEqual(first);
			expect(yield* readLog(dir)).toBe(text(...first));
		})
	);

	effect("reads the lines after a seq, and the last few, for readers", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;

			const three = [
				line(1, "added", { n: 1 }),
				line(2, "added", { n: 2 }),
				line(3, "added", { n: 3 }),
			];

			const [after, recent, none] = yield* withLog(dir, (log) =>
				Effect.gen(function* () {
					yield* log.append(three);

					return [
						yield* log.lines(1),
						yield* log.recent(2),
						yield* log.recent(0),
					];
				})
			);

			expect(after?.map((entry) => entry.seq)).toEqual([2, 3]);
			expect(recent?.map((entry) => entry.seq)).toEqual([2, 3]);
			expect(none).toEqual([]);
		})
	);

	effect("cuts a half-written last line from the file when it opens", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const one = line(1, "added", { n: 2 });
			yield* writeLog(dir, `${text(one)}{"actor":"gm","se`);
			const opened = yield* withLog(dir, linesOf);
			expect(opened).toEqual([one]);
			expect(yield* readLog(dir)).toBe(text(one));
		})
	);

	effect(
		"keeps exact byte offsets when a log starts with a UTF-8 BOM or ends with a torn line",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const one = line(1, "added", { n: 2 });
				yield* writeLog(dir, `\uFEFF${text(one)}{"actor":"gm","se`);

				const error = yield* Effect.flip(withLog(dir, () => Effect.void));

				const fs = yield* FileSystem.FileSystem;
				const paths = yield* Path.Path;

				const raw = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
					yield* fs.readFile(paths.join(dir, "events.jsonl"))
				);

				expect(error._tag).toBe("LogError");
				expect(error.message).toContain("events.jsonl:1:");
				expect(raw).toBe(`\uFEFF${text(one)}`);
			})
	);

	effect(
		"refuses to open a log with a bad line, and says which line and what's wrong",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;
				yield* writeLog(
					dir,
					`${text(line(1, "added", { n: 2 }))}garbage\n${text(line(3, "added", { n: 1 }))}`
				);
				const error = yield* Effect.flip(withLog(dir, () => Effect.void));
				expect(error._tag).toBe("LogError");
				expect(error.message).toContain(
					"events.jsonl:2: expected a valid JSON string"
				);
			})
	);

	effect("lets one host at a time open a campaign", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const lock = yield* lockPath(dir);

			const second = yield* withLog(dir, () =>
				Effect.flip(withLog(dir, () => Effect.void))
			);

			expect(second.message).toContain(`another host (pid ${process.pid})`);
			expect(second.message).toContain(
				`if no host has it open, delete ${lock} and start again`
			);
			yield* withLog(dir, () => Effect.void);
		})
	);

	effect("takes over a lock whose host is gone", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const fs = yield* FileSystem.FileSystem;
			const gone = Bun.spawn(["true"]);
			yield* Effect.promise(async () => await gone.exited);
			yield* fs.writeFileString(yield* lockPath(dir), `${gone.pid}\n`);
			yield* withLog(dir, (log) => log.append([line(1, "added", { n: 1 })]));
			expect(yield* readLog(dir)).toBe(text(line(1, "added", { n: 1 })));
		})
	);

	effect("leaves a lock another host has taken since when it closes", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const fs = yield* FileSystem.FileSystem;
			const lock = yield* lockPath(dir);
			yield* withLog(dir, () => fs.writeFileString(lock, "1234567\n"));
			expect(yield* fs.readFileString(lock)).toBe("1234567\n");
		})
	);

	effect(
		"stops at a lock it can't read, rather than taking it for a stale one",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const fs = yield* FileSystem.FileSystem;
				const lock = yield* lockPath(dir);
				yield* fs.writeFileString(lock, "1234567\n");
				yield* fs.chmod(lock, 0o000);
				const error = yield* Effect.flip(withLog(dir, () => Effect.void));
				expect(error.message).toContain("lock campaign: PermissionDenied");
				yield* fs.chmod(lock, 0o600);
				expect(yield* fs.readFileString(lock)).toBe("1234567\n");
			})
	);

	effect("removes its lock when it closes", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			yield* withLog(dir, () => Effect.void);
			expect(yield* fs.readDirectory(dir)).toEqual(["events.jsonl"]);
			expect(yield* fs.exists(path.join(dir, "events.lock"))).toBe(false);
		})
	);

	effect("writes nothing once something else has written the log", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const one = line(1, "added", { n: 1 });
			const theirs = text(line(2, "added", { n: 5 }));

			const error = yield* withLog(dir, (log) =>
				Effect.gen(function* () {
					yield* log.append([one]);
					yield* appendLog(dir, theirs);

					return yield* Effect.flip(log.append([line(2, "added", { n: 2 })]));
				})
			);

			expect(error.message).toContain("something else wrote");
			expect(error.message).toContain("nothing written");
			expect(yield* readLog(dir)).toBe(text(one) + theirs);
		})
	);

	effect(
		"refuses an append whose seq doesn't follow the last line, and writes nothing",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;

				const error = yield* withLog(dir, (log) =>
					log
						.append([line(1, "added", { n: 1 })])
						.pipe(
							Effect.andThen(
								Effect.flip(log.append([line(3, "added", { n: 1 })]))
							)
						)
				);

				expect(error.message).toContain("seq 3 after seq 1");
				expect(yield* readLog(dir)).toBe(text(line(1, "added", { n: 1 })));
			})
	);

	effect("writes all of an append that the disk takes in pieces", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const two = [line(1, "added", { n: 1 }), line(2, "added", { n: 2 })];
			yield* withLogOn(diskTakes(10, false), dir, (log) => log.append(two));
			expect(yield* readLog(dir)).toBe(text(...two));
		})
	);

	effect(
		"leaves the log as it was when the disk fills part way through an append",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const one = line(1, "added", { n: 1 });
				yield* writeLog(dir, text(one));

				const error = yield* withLogOn(diskTakes(10, true), dir, (log) =>
					Effect.flip(log.append([line(2, "added", { n: 2 })]))
				);

				expect(error.message).toContain("no space left on device");
				expect(yield* readLog(dir)).toBe(text(one));

				const after = yield* withLog(dir, (log) =>
					Effect.gen(function* () {
						yield* log.append([line(2, "added", { n: 3 })]);

						return yield* log.lines(0);
					})
				);

				expect(after.map((entry) => entry.seq)).toEqual([1, 2]);
			})
	);

	effect(
		"reopens cleanly after its host is killed mid-append",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const path = yield* Path.Path;

				const host = Bun.spawn(
					[
						process.execPath,
						path.join(import.meta.dir, "fixtures/appender.ts"),
						dir,
					],
					{ stdout: "pipe" }
				);

				const reader = host.stdout.getReader();
				yield* Effect.promise(async () => await reader.read());
				yield* Effect.sleep("150 millis");
				host.kill("SIGKILL");
				yield* Effect.promise(async () => await host.exited);

				const count = yield* withLog(dir, (log) =>
					Effect.gen(function* () {
						const opened = yield* log.lines(0);
						expect(opened.length).toBeGreaterThan(0);
						expect(opened.map((entry) => entry.seq)).toEqual(
							opened.map((_, index) => index + 1)
						);
						yield* log.append([line(opened.length + 1, "added", { n: 1 })]);

						return opened.length + 1;
					})
				);

				const reread = yield* withLog(dir, linesOf);
				expect(reread).toHaveLength(count);
			}),
		10_000
	);
});
