import { describe, expect } from "bun:test";

import { Platform } from "@alchemy.run/domain/Platform";
import type { AggregateStore, ModelHost } from "@alchemy.run/domain/Platform";
import type { FileSystem } from "effect";
import {
	Cause,
	DateTime,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Option,
	Predicate,
	Schema,
	Stream,
} from "effect";
import { SecureRandom } from "effect/crypto";
import { TestClock } from "effect/testing";

import {
	CampaignLog,
	JsonlPlatform,
	LogError,
	parseLog,
} from "../src/index.ts";
import { diskTakes, sameDisk } from "./disk.ts";
import { effect, readLog, tempDir, writeLog } from "./effect.ts";
import { line, text } from "./lines.ts";
import { Add, Double, Poison, Table, Tally } from "./toy.ts";

const using = <ROut, E1, RIn, A, E2, R2>(
	layer: Layer.Layer<ROut, E1, RIn>,
	body: Effect.Effect<A, E2, R2>
) =>
	Effect.scoped(
		Effect.flatMap(Layer.build(layer), (context) =>
			Effect.provideContext(body, context)
		)
	);

const capture = (stores: Deferred.Deferred<AggregateStore>) =>
	Layer.effect(
		Platform,
		Effect.gen(function* () {
			const inner = yield* Platform;

			return Platform.of({
				model: (hosted) =>
					Effect.map(inner.model(hosted), (host): ModelHost => ({
						...host,
						aggregate: (aggregate, kit) =>
							Effect.tap(host.aggregate(aggregate, kit), (store) =>
								Deferred.succeed(stores, store)
							),
					})),
			});
		})
	);

const tableOn = (
	disk: Layer.Layer<FileSystem.FileSystem, never, FileSystem.FileSystem>,
	dir: string,
	stores: Deferred.Deferred<AggregateStore>
) =>
	Table.layer(Layer.empty).pipe(
		Layer.provide(capture(stores)),
		Layer.provideMerge(
			JsonlPlatform.layer({ dir, tableId: "table" }).pipe(Layer.provide(disk))
		),
		Layer.provide(SecureRandom.layerWebCrypto)
	);

const withTableOn = <A, E, R>(
	disk: Layer.Layer<FileSystem.FileSystem, never, FileSystem.FileSystem>,
	dir: string,
	body: (store: AggregateStore) => Effect.Effect<A, E, R>
) =>
	Effect.gen(function* () {
		const stores = yield* Deferred.make<AggregateStore>();

		return yield* using(
			tableOn(disk, dir, stores),
			Effect.flatMap(Deferred.await(stores), body)
		);
	});

const withTable = <A, E, R>(
	dir: string,
	body: (store: AggregateStore) => Effect.Effect<A, E, R>
) => withTableOn(sameDisk, dir, body);

const onDisk = (dir: string) => Effect.map(readLog(dir), parseLog);

const decodeAdded = Schema.decodeUnknownEffect(
	Schema.Struct({ actor: Schema.String, n: Schema.Int })
);

const add = (n: number, actor = "gm") => new Add({ actor, n });

describe("JsonlPlatform", () => {
	effect(
		"writes an accepted command as a JSONL line, and moves the state and its changes",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;

				const result = yield* withTable(dir, (store) =>
					Effect.gen(function* () {
						const tally = yield* Tally;
						const watching = yield* Deferred.make<boolean>();

						const changes = yield* Effect.forkChild(
							store.changes("table").pipe(
								Stream.tap(() => Deferred.succeed(watching, true)),
								Stream.take(2),
								Stream.runCollect
							)
						);

						yield* Deferred.await(watching);
						const receipt = yield* tally.send("table", add(4, "key:alice"));

						return {
							receipt,
							total: yield* tally.get("table"),
							stored: yield* store.state("table"),
							seen: yield* Fiber.join(changes),
						};
					})
				);

				expect(result.receipt.reply).toEqual({ total: 4 });
				expect(result.receipt.version).toBe(1);
				expect(result.total).toEqual({ total: 4 });
				expect(result.stored).toEqual({ state: { total: 4 }, version: 1 });
				expect(result.seen).toEqual([
					{ state: null, version: 0 },
					{ state: { total: 4 }, version: 1 },
				]);
				const written = yield* readLog(dir);
				const parsed = parseLog(written);
				const [first] = parsed.lines;
				expect(parsed.lines).toHaveLength(1);
				expect(first).toMatchObject({
					actor: "key:alice",
					seq: 1,
					type: "Added",
					payload: { n: 4 },
				});
				expect(text(...parsed.lines)).toBe(written);
				const stamp = first?.timestamp ?? "not a time";
				expect(Option.map(DateTime.make(stamp), DateTime.formatIso)).toEqual(
					Option.some(stamp)
				);
			})
	);

	effect(
		"replays the log when it reopens, keeping each command's batch and timestamp",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;
				yield* withTable(dir, () =>
					Effect.gen(function* () {
						const tally = yield* Tally;
						yield* tally.send("table", add(1));
						yield* tally.send("table", new Double({ actor: "key:bob", n: 2 }));
					})
				);
				const before = yield* onDisk(dir);

				const reopened = yield* withTable(dir, (store) =>
					Effect.gen(function* () {
						const tally = yield* Tally;
						const total = yield* tally.get("table");

						const replayed = yield* store
							.tail("table", 0)
							.pipe(Stream.take(3), Stream.runCollect);

						const fields = yield* Effect.forEach(
							replayed,
							(stored) => decodeAdded(stored.event),
							{ concurrency: 1 }
						);

						const next = yield* tally.send("table", add(10));

						return { total, replayed, fields, next };
					})
				);

				expect(reopened.total).toEqual({ total: 5 });
				expect(reopened.next.version).toBe(4);
				expect(
					reopened.replayed.map((stored) => stored.envelope.commandId)
				).toEqual(["log:1", "log:2", "log:2"]);
				expect(reopened.replayed.map((stored) => stored.envelope.at)).toEqual(
					before.lines.map((entry) => Date.parse(entry.timestamp))
				);
				expect(
					reopened.replayed.every((stored) =>
						Predicate.isTagged(stored.event, "Added")
					)
				).toBe(true);
				expect(reopened.fields).toEqual([
					{ actor: "gm", n: 1 },
					{ actor: "key:bob", n: 2 },
					{ actor: "key:bob", n: 2 },
				]);
				const after = yield* onDisk(dir);
				const stamps = after.lines.map((entry) => Date.parse(entry.timestamp));
				expect(after.lines.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
				expect(stamps[1]).toBe(stamps[2]);
				expect((stamps[3] ?? 0) > (stamps[2] ?? 0)).toBe(true);
			})
	);

	effect(
		"stamps each command later than the last, even when the clock stands still",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;
				yield* writeLog(
					dir,
					text({
						...line(1, "Added", { n: 1 }),
						timestamp: "1970-01-01T00:00:05.000Z",
					})
				);
				yield* withTable(dir, () =>
					Effect.gen(function* () {
						const tally = yield* Tally;
						yield* tally.send("table", add(1));
						yield* tally.send("table", add(1));
						yield* TestClock.adjust("10 seconds");
						yield* tally.send("table", add(1));
					}).pipe((clocked) => using(TestClock.layer(), clocked))
				);
				const written = yield* onDisk(dir);
				expect(written.lines.map((entry) => entry.timestamp)).toEqual([
					"1970-01-01T00:00:05.000Z",
					"1970-01-01T00:00:05.001Z",
					"1970-01-01T00:00:05.002Z",
					"1970-01-01T00:00:10.000Z",
				]);
			})
	);

	effect("refuses to open over an event its rules don't know", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			yield* writeLog(
				dir,
				text(line(1, "Added", { n: 1 }), line(2, "Teleported", { to: "moon" }))
			);
			const exit = yield* Effect.exit(withTable(dir, () => Effect.void));
			expect(Exit.isFailure(exit)).toBe(true);
			const halt = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
			expect(halt).toBeInstanceOf(LogError);
			expect(halt instanceof LogError ? halt.message : "").toStartWith(
				"Replay halted at seq 2:"
			);
		})
	);

	effect("refuses to open over a payload that names its own tag or actor", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			yield* writeLog(
				dir,
				text(line(1, "Added", { n: 1, actor: "key:mallory" }))
			);
			const error = yield* Effect.flip(withTable(dir, () => Effect.void));
			expect(error).toBeInstanceOf(LogError);
			expect(error.message).toBe("seq 1: payload carries actor");
		})
	);

	effect(
		"writes nothing when a rule throws or refuses, and keeps the room open",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;

				const outcome = yield* withTable(dir, () =>
					Effect.gen(function* () {
						const tally = yield* Tally;
						yield* tally.send("table", add(2));

						const thrown = yield* Effect.flip(
							tally.send("table", new Poison({ actor: "gm" }))
						);

						const refused = yield* Effect.flip(tally.send("table", add(-1)));
						const total = yield* tally.get("table");
						const next = yield* tally.send("table", add(1));

						return { thrown, refused, total, next };
					})
				);

				expect(outcome.thrown.message).toBe(
					"Rule error, nothing written: evolve blew up"
				);
				expect(outcome.refused.message).toBe("not today");
				expect(outcome.total).toEqual({ total: 2 });
				expect(outcome.next.version).toBe(2);
				const written = yield* onDisk(dir);
				expect(written.lines.map((entry) => entry.seq)).toEqual([1, 2]);
			})
	);

	effect("halts after a failed write and refuses everything after it", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;

			const outcome = yield* withTableOn(diskTakes(0, false), dir, () =>
				Effect.gen(function* () {
					const tally = yield* Tally;
					const first = yield* Effect.flip(tally.send("table", add(1)));
					const second = yield* Effect.flip(tally.send("table", add(1)));
					const total = yield* tally.get("table");

					return { first, second, total };
				})
			);

			expect(outcome.first.message).toBe(
				"Log write failed, room halted: append: the disk took nothing"
			);
			expect(outcome.second.message).toBe(
				"The room is halted: append: the disk took nothing"
			);
			expect(outcome.total).toEqual({ total: 0 });
			expect(yield* readLog(dir)).toBe("");
		})
	);

	effect(
		"answers a repeated command id with its first receipt, written once",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;

				const outcome = yield* withTable(dir, () =>
					Effect.gen(function* () {
						const tally = yield* Tally;

						const first = yield* tally.send("table", add(3), {
							commandId: "c-1",
						});

						const again = yield* tally.send("table", add(3), {
							commandId: "c-1",
						});

						const total = yield* tally.get("table");

						return { first, again, total };
					})
				);

				expect(outcome.again).toEqual(outcome.first);
				expect(outcome.total).toEqual({ total: 3 });
				const written = yield* onDisk(dir);
				expect(written.lines).toHaveLength(1);
			})
	);

	effect("tails the log then the live events, each seq once", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			yield* withTable(dir, () =>
				Effect.gen(function* () {
					const tally = yield* Tally;
					yield* tally.send("table", add(1));
					yield* tally.send("table", add(2));
				})
			);

			const seen = yield* withTable(dir, (store) =>
				Effect.gen(function* () {
					const tally = yield* Tally;
					yield* tally.send("table", add(3));

					const tail = yield* Effect.forkChild(
						store.tail("table", 1).pipe(Stream.take(4), Stream.runCollect)
					);

					yield* tally.send("table", add(4));
					yield* tally.send("table", add(5));

					return yield* Fiber.join(tail);
				})
			);

			expect(seen.map((stored) => stored.envelope.seq)).toEqual([2, 3, 4, 5]);
			expect(seen.map((stored) => stored.envelope.stream)).toEqual([
				"Tally/table",
				"Tally/table",
				"Tally/table",
				"Tally/table",
			]);
		})
	);

	effect("refuses a command for another instance than its table", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;

			const refused = yield* withTable(dir, () =>
				Effect.gen(function* () {
					const tally = yield* Tally;

					return yield* Effect.flip(tally.send("other", add(1)));
				})
			);

			expect(refused.message).toBe(
				"JsonlPlatform hosts the instance table, not other"
			);
			expect(yield* readLog(dir)).toBe("");
		})
	);

	effect("keeps the campaign log available beside the platform", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;

			const recent = yield* withTable(dir, () =>
				Effect.gen(function* () {
					const tally = yield* Tally;
					const log = yield* CampaignLog;
					yield* tally.send("table", add(1));
					yield* tally.send("table", add(2));

					return yield* log.recent(1);
				})
			);

			expect(recent.map((entry) => entry.payload)).toEqual([{ n: 2 }]);
		})
	);
});
