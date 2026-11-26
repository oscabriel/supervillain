import { describe, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { Effect, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";

import { TableRoom } from "../../src/host/TableRoom.ts";
import { openCampaign } from "./campaign.ts";
import { effect } from "./effect.ts";
import { tempDir } from "./tempDir.ts";

const alice = "key:SHA256:aliceAAAAkey";

const bob = "key:SHA256:bobBBBBBkey";

const using = <ROut, E1, RIn, A, E2, R2>(
	layer: Layer.Layer<ROut, E1, RIn>,
	body: Effect.Effect<A, E2, R2>
) =>
	Effect.scoped(
		Effect.flatMap(Layer.build(layer), (context) =>
			Effect.provideContext(body, context)
		)
	);

const withTable = <A, E>(
	dir: string,
	body: (room: TableRoom["Service"]) => Effect.Effect<A, E>
) => using(TableRoom.layer(dir), Effect.flatMap(TableRoom, body));

const LogLine = Schema.fromJsonString(
	Schema.Struct({ seq: Schema.Int, actor: Schema.String, type: Schema.String })
);

const Rolled = Schema.Struct({
	rolls: Schema.Array(Schema.Int),
	total: Schema.Int,
});

const logLines = (dir: string) =>
	Effect.promise(
		async () => await readFile(path.join(dir, "events.jsonl"), "utf-8")
	).pipe(
		Effect.flatMap((text) =>
			Effect.forEach(
				text.split("\n").filter((l) => l !== ""),
				(l) => Schema.decodeEffect(LogLine)(l),
				{ concurrency: 1 }
			)
		)
	);

const spam = (room: TableRoom["Service"], actor: string) =>
	room.submit(actor, { type: "say", text: "spam" });

const spamFrom = (room: TableRoom["Service"], actor: string) =>
	room.submit(actor, { type: "say", text: "spam" }, "address:203.0.113.7");

const times = (n: number) => Array.from({ length: n });

describe("TableRoom", () => {
	effect(
		"writes accepted commands to the campaign log and folds them into the state",
		() =>
			Effect.gen(function* () {
				const dir = yield* openCampaign;
				yield* withTable(dir, (room) =>
					Effect.gen(function* () {
						yield* room.submit(alice, { type: "name", name: "Vex" });

						const { events, seqs } = yield* room.submit(alice, {
							type: "roll",
							notation: "2d6",
						});

						expect(seqs).toEqual([3]);
						const [rolled] = events;

						const payload = yield* Schema.decodeUnknownEffect(Rolled)(rolled);

						expect(payload.rolls).toHaveLength(2);

						for (const face of payload.rolls) {
							expect(face).toBeWithin(1, 7);
						}

						const state = yield* room.state;
						expect(state.core.names).toEqual({ [alice]: "Vex" });
						expect(state.feed.map((f) => f.kind)).toEqual([
							"member",
							"name",
							"roll",
						]);
					})
				);
				const lines = yield* logLines(dir);
				expect(lines.map((l) => [l.seq, l.actor, l.type])).toEqual([
					[1, "gm", "core.door-set"],
					[2, alice, "core.name-set"],
					[3, alice, "core.dice-rolled"],
				]);
			})
	);

	effect("refuses what the rules refuse, and writes nothing", () =>
		Effect.gen(function* () {
			const dir = yield* openCampaign;

			const refusal = yield* withTable(dir, (room) =>
				Effect.flip(room.submit(alice, { type: "narrate", text: "It rains." }))
			);

			expect(refusal.message).toBe("Only the GM can use /narrate.");
			expect((yield* logLines(dir)).map((l) => l.type)).toEqual([
				"core.door-set",
			]);
		})
	);

	effect("refuses a player the GM hasn't let in, and writes nothing", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;

			const refusal = yield* withTable(dir, (room) =>
				Effect.flip(room.submit(alice, { type: "say", text: "hello?" }))
			);

			expect(refusal.message).toBe("Knock first: the GM hasn't let you in.");
			expect(yield* logLines(dir)).toEqual([]);
		})
	);

	effect(
		"replays the campaign when reopened, and remembers the last few envelopes",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;
				yield* withTable(dir, (room) =>
					Effect.gen(function* () {
						for (const text of ["one", "two", "three"]) {
							yield* room.submit("gm", { type: "say", text });
						}
					})
				);
				yield* withTable(dir, (room) =>
					Effect.gen(function* () {
						expect((yield* room.state).feed.map((f) => f.text)).toEqual([
							"one",
							"two",
							"three",
						]);
						expect((yield* room.recent(8)).map((e) => e.seq)).toEqual([
							1, 2, 3,
						]);
						yield* room.submit("gm", { type: "say", text: "four" });
						expect((yield* room.recent(8)).map((e) => e.seq)).toEqual([
							1, 2, 3, 4,
						]);
					})
				);
			})
	);

	effect(
		"a player sending faster than a few lines a second is refused; others and the GM aren't",
		() =>
			using(
				TestClock.layer(),
				Effect.gen(function* () {
					const dir = yield* openCampaign;
					yield* withTable(dir, (room) =>
						Effect.gen(function* () {
							for (const _n of times(10)) {
								yield* spam(room, alice);
							}

							expect((yield* Effect.flip(spam(room, alice))).message).toBe(
								"You're sending lines too fast; wait a moment."
							);
							yield* spam(room, bob);

							for (const _n of times(20)) {
								yield* spam(room, "gm");
							}

							yield* TestClock.adjust("600 millis");
							yield* spam(room, alice);
						})
					);
					expect(
						(yield* logLines(dir)).filter((l) => l.actor === alice)
					).toHaveLength(11);
				})
			)
	);

	effect("actors sent under one rate key share its rate", () =>
		Effect.gen(function* () {
			const dir = yield* openCampaign;
			yield* withTable(dir, (room) =>
				Effect.gen(function* () {
					for (const _n of times(5)) {
						yield* spamFrom(room, "guest:one");
					}

					for (const _n of times(5)) {
						yield* spamFrom(room, "guest:two");
					}

					expect(
						(yield* Effect.flip(spamFrom(room, "guest:three"))).message
					).toBe("You're sending lines too fast; wait a moment.");
					yield* room.submit("guest:three", { type: "say", text: "alone" });
				})
			);
		})
	);
});
