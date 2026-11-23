import { describe, expect } from "bun:test";

import { Effect, Layer } from "effect";

import { SetName, Undo } from "../src/commands/core.ts";
import { DsJoinHero, DsLoadMap, DsPlay } from "../src/commands/drawSteel.ts";
import { SwRecruit } from "../src/commands/setWorld.ts";
import { MapWriteFailed, SheetNotFound } from "../src/external/content.ts";
import { MapForge } from "../src/external/MapForge.external.ts";
import { Seating } from "../src/external/Seating.external.ts";
import { SetWorld, SetWorldError } from "../src/external/SetWorld.external.ts";
import { Sheets } from "../src/external/Sheets.external.ts";
import { intake } from "../src/intake.ts";
import { Refused } from "../src/Refused.rejection.ts";
import { initial, rules } from "../src/table.ts";
import type { TableState } from "../src/table.ts";
import { effect } from "./effect.ts";
import {
	ALICE,
	ARI,
	BOB,
	character,
	FIELD,
	GM,
	GNASHER,
	VEX,
} from "./fixtures.ts";

const ports = Layer.mergeAll(
	Sheets.toLayer(
		Effect.succeed({
			hero: ({ query }) =>
				query === "vex"
					? Effect.succeed(VEX)
					: Effect.fail(
							new SheetNotFound({
								kind: "hero",
								query,
								message: `No hero sheet in heroes/ is called '${query}'.`,
							})
						),
			monster: ({ query }) =>
				Effect.fail(
					new SheetNotFound({
						kind: "monster",
						query,
						message: `No stat block in monsters/ is called '${query}'.`,
					})
				),
			pfHero: ({ query }) =>
				query === "ari"
					? Effect.succeed(ARI)
					: Effect.fail(
							new SheetNotFound({
								kind: "hero",
								query,
								message: `No hero sheet in heroes/ is called '${query}'.`,
							})
						),
			pfMonster: ({ query }) =>
				query === "gnasher"
					? Effect.succeed(GNASHER)
					: Effect.fail(
							new SheetNotFound({
								kind: "monster",
								query,
								message: `No stat block in monsters/ is called '${query}'.`,
							})
						),
			map: ({ query }) => Effect.succeed({ id: query, grid: FIELD }),
		})
	),
	Seating.toLayer(Effect.succeed({ here: () => Effect.succeed([ALICE, BOB]) })),
	SetWorld.toLayer(
		Effect.succeed({
			roll: ({ seed }) =>
				seed === 13
					? Effect.fail(new SetWorldError({ seed, message: "it timed out" }))
					: Effect.succeed(character("sword", seed ?? 99)),
		})
	),
	MapForge.toLayer(
		Effect.succeed({
			generate: ({ kind, seed }) =>
				seed === 1
					? Effect.fail(
							new MapWriteFailed({
								reason: "exists",
								id: `${kind}-1`,
								message: "it's there",
							})
						)
					: Effect.succeed({ id: `${kind}-${seed ?? 7}` }),
		})
	)
);

const run = <A, E, R>(body: Effect.Effect<A, E, R>) =>
	Layer.build(ports).pipe(
		Effect.flatMap((context) => Effect.provideContext(body, context))
	);

const withAlice: TableState = rules.apply(initial, {
	actor: ALICE,
	seq: 1,
	timestamp: "2026-01-01T00:00:00.000Z",
	type: "core.name-set",
	payload: { name: "Alice" },
});

describe("intake", () => {
	effect("a name is checked against who is seated and who is in play", () =>
		run(
			Effect.gen(function* () {
				const command = yield* intake(
					BOB,
					{ type: "name", name: "Bo" },
					initial
				);

				expect(command).toEqual(
					new SetName({ name: "Bo", seated: [ALICE, BOB], cast: [] })
				);
			})
		)
	);

	effect("an undo naming someone finds them by the label the table shows", () =>
		run(
			Effect.gen(function* () {
				const found = yield* intake(
					GM,
					{ type: "undo", who: "alice" },
					withAlice
				);

				const gm = yield* intake(GM, { type: "undo", who: "GM" }, withAlice);

				const nobody = yield* intake(
					GM,
					{ type: "undo", who: "Zed" },
					withAlice
				);

				expect(found).toEqual(new Undo({ who: "alice", whose: ALICE }));
				expect(gm).toEqual(new Undo({ who: "GM", whose: GM }));
				expect(nobody).toEqual(new Undo({ who: "Zed" }));
			})
		)
	);

	effect("the GM's /hero carries the sheet the host found", () =>
		run(
			Effect.gen(function* () {
				const command = yield* intake(
					GM,
					{ type: "hero", hero: "vex" },
					initial
				);

				const missing = yield* intake(
					GM,
					{ type: "hero", hero: "zed" },
					initial
				).pipe(Effect.flip);

				expect(command).toEqual(new DsJoinHero({ hero: "vex", sheet: VEX }));
				expect(missing).toEqual(
					new Refused({ message: "No hero sheet in heroes/ is called 'zed'." })
				);
			})
		)
	);

	effect("nothing is read for a GM-only command a player sent", () =>
		run(
			Effect.gen(function* () {
				const command = yield* intake(
					ALICE,
					{ type: "hero", hero: "vex" },
					initial
				);

				expect(command).toEqual(new DsJoinHero({ hero: "vex" }));
			})
		)
	);

	effect("a play carries who is seated, and the player the GM named", () =>
		run(
			Effect.gen(function* () {
				const command = yield* intake(
					GM,
					{ type: "play", hero: "vex", player: "alice" },
					withAlice
				);

				expect(command).toEqual(
					new DsPlay({
						hero: "vex",
						player: "alice",
						playerActor: ALICE,
						seated: [ALICE, BOB],
					})
				);
			})
		)
	);

	effect("/map new is generated into maps/, then loaded as /map <id> is", () =>
		run(
			Effect.gen(function* () {
				const command = yield* intake(
					GM,
					{ type: "map", generate: { kind: "keep", seed: 4 } },
					initial
				);

				const taken = yield* intake(
					GM,
					{ type: "map", generate: { kind: "keep", seed: 1 } },
					initial
				).pipe(Effect.flip);

				expect(command).toEqual(new DsLoadMap({ id: "keep-4", grid: FIELD }));
				expect(taken).toEqual(
					new Refused({
						message:
							"There's already a map called keep-1 in maps/: /map keep-1 loads it.",
					})
				);
			})
		)
	);

	effect(
		"a set.world fighter is rolled by its seed, or refused saying why",
		() =>
			run(
				Effect.gen(function* () {
					const command = yield* intake(
						GM,
						{ type: "set-recruit", name: "Ada", seed: 5 },
						initial
					);

					const failed = yield* intake(
						GM,
						{ type: "set-recruit", name: "Ada", seed: 13 },
						initial
					).pipe(Effect.flip);

					expect(command).toEqual(
						new SwRecruit({
							name: "Ada",
							seed: 5,
							character: character("sword", 5),
						})
					);
					expect(failed).toEqual(
						new Refused({
							message: "No roll from set.world for seed 13: it timed out.",
						})
					);
				})
			)
	);
});
