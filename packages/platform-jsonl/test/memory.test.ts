import { describe, expect } from "bun:test";

import { Effect, FileSystem, Layer, PlatformError } from "effect";
import { SecureRandom } from "effect/crypto";

import { CampaignLog, JsonlPlatform, MEMORY_PATH } from "../src/index.ts";
import { effect } from "./effect.ts";
import { line } from "./lines.ts";
import { Add, Table, Tally } from "./toy.ts";

const refusingDisk = Layer.succeed(
	FileSystem.FileSystem,
	FileSystem.makeNoop({
		open: () =>
			Effect.fail(
				PlatformError.badArgument({
					module: "FileSystem",
					method: "open",
					description: "a memory log touched the disk",
				})
			),
		writeFile: () =>
			Effect.fail(
				PlatformError.badArgument({
					module: "FileSystem",
					method: "writeFile",
					description: "a memory log touched the disk",
				})
			),
	})
);

const usingLog = <A, E>(
	cap: number,
	body: (log: CampaignLog["Service"]) => Effect.Effect<A, E>
) =>
	Effect.scoped(
		Effect.flatMap(Layer.build(CampaignLog.layerMemory(cap)), (context) =>
			Effect.provideContext(
				Effect.flatMap(Effect.service(CampaignLog), body),
				context
			)
		)
	);

describe("CampaignLog.memory", () => {
	effect("keeps its lines in memory, reads them back, and has no path", () =>
		usingLog(8, (log) =>
			Effect.gen(function* () {
				expect(log.path).toBe(MEMORY_PATH);
				const first = line(1, "added", { n: 2 });
				const second = line(2, "added", { n: 3 });
				yield* log.append([first, second]);
				expect(yield* log.lines(0)).toEqual([first, second]);
				expect(yield* log.lines(1)).toEqual([second]);
				expect(yield* log.recent(1)).toEqual([second]);
				expect(yield* log.recent(0)).toEqual([]);
			})
		)
	);

	effect(
		"refuses a batch out of order, and one past its cap, writing nothing",
		() =>
			usingLog(3, (log) =>
				Effect.gen(function* () {
					const skipped = yield* Effect.flip(
						log.append([line(2, "added", { n: 1 })])
					);

					expect(skipped.message).toContain("seq 2 after seq 0");

					yield* log.append([
						line(1, "added", { n: 1 }),
						line(2, "added", { n: 2 }),
					]);

					const over = yield* Effect.flip(
						log.append([line(3, "added", { n: 3 }), line(4, "added", { n: 4 })])
					);

					expect(over.message).toBe(
						"append: this log holds at most 3 lines; nothing written"
					);
					expect(yield* log.lines(0)).toHaveLength(2);
					yield* log.append([line(3, "added", { n: 3 })]);
					expect(yield* log.lines(0)).toHaveLength(3);
				})
			)
	);

	effect(
		"a platform on it plays commands with no disk, and halts at the cap",
		() =>
			Effect.gen(function* () {
				const table = Table.layer(Layer.empty).pipe(
					Layer.provideMerge(
						JsonlPlatform.layerMemory({ tableId: "table", cap: 2 })
					),
					Layer.provide(SecureRandom.layerWebCrypto),
					Layer.provide(refusingDisk)
				);

				const sent = yield* Effect.scoped(
					Effect.flatMap(Layer.build(table), (context) =>
						Effect.provideContext(
							Effect.gen(function* () {
								const tally = yield* Tally;
								yield* tally.send("table", new Add({ actor: "gm", n: 2 }));
								yield* tally.send("table", new Add({ actor: "gm", n: 3 }));

								const third = yield* Effect.flip(
									tally.send("table", new Add({ actor: "gm", n: 4 }))
								);

								const log = yield* CampaignLog;

								return {
									total: yield* tally.get("table"),
									third,
									lines: yield* log.lines(0),
								};
							}),
							context
						)
					)
				);

				expect(sent.total).toEqual({ total: 5 });
				expect(sent.lines).toHaveLength(2);
				expect(sent.third.message).toBe(
					"Log write failed, room halted: append: this log holds at most 2 lines; nothing written"
				);
			})
	);
});
