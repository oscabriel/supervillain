import { describe, expect, test } from "bun:test";

import { Effect, Layer } from "effect";

import { ActorId } from "../src/Actor.context.ts";
import { Admit, SetName, Undo } from "../src/commands/core.ts";
import { DsJoinHero, DsLoadMap, DsPlay } from "../src/commands/drawSteel.ts";
import { FfJoinPc } from "../src/commands/freeform.ts";
import { SwRecruit } from "../src/commands/setWorld.ts";
import { ShowCard, SyncContent } from "../src/commands/stage.ts";
import {
	CardNotFound,
	MapWriteFailed,
	SheetNotFound,
} from "../src/external/content.ts";
import { Knocks } from "../src/external/Knocks.external.ts";
import { MapForge } from "../src/external/MapForge.external.ts";
import { Seating } from "../src/external/Seating.external.ts";
import { SetWorld, SetWorldError } from "../src/external/SetWorld.external.ts";
import { Sheets } from "../src/external/Sheets.external.ts";
import { intake, knockerNamed, shortFingerprint } from "../src/intake.ts";
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
	MARA_CARD,
	ROOK,
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
			ffHero: ({ query }) =>
				query === "rook"
					? Effect.succeed(ROOK)
					: Effect.fail(
							new SheetNotFound({
								kind: "hero",
								query,
								message: `No sheet in party/ is called '${query}'.`,
							})
						),
			ffMonster: ({ query }) =>
				Effect.fail(
					new SheetNotFound({
						kind: "monster",
						query,
						message: `No sheet in monsters/ is called '${query}'.`,
					})
				),
			map: ({ query }) => Effect.succeed({ id: query, grid: FIELD }),
			card: ({ query }) =>
				query === "mara"
					? Effect.succeed(MARA_CARD)
					: Effect.fail(
							new CardNotFound({
								query,
								message: `No card is called '${query}'.`,
							})
						),
			cards: ({ keys }) =>
				Effect.succeed(keys.includes(MARA_CARD.key) ? [MARA_CARD] : []),
		})
	),
	Seating.toLayer(Effect.succeed({ here: () => Effect.succeed([ALICE, BOB]) })),
	Knocks.toLayer(
		Effect.succeed({
			pending: () =>
				Effect.succeed([
					{
						actor: CARA,
						name: "Cara",
						fingerprint: "SHA256:cara1234Cara1234cara1234Cara1234cara1234abc",
					},
				]),
		})
	),
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

const CARA = ActorId.make(
	"key:SHA256:cara1234Cara1234cara1234Cara1234cara1234abc"
);

const OTHER_CARA = ActorId.make(
	"key:SHA256:zzzz9876Cara1234cara1234Cara1234cara1234abc"
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

	effect(
		"the GM's /admit finds the knocker by name, key or the start of its fingerprint; a player's finds none",
		() =>
			run(
				Effect.gen(function* () {
					const byName = yield* intake(
						GM,
						{ type: "admit", who: "cara" },
						initial
					);

					const byPrint = yield* intake(
						GM,
						{ type: "admit", who: "cara1234" },
						initial
					);

					const byActor = yield* intake(
						GM,
						{ type: "admit", who: CARA },
						initial
					);

					const nobody = yield* intake(
						GM,
						{ type: "admit", who: "Zed" },
						initial
					);

					const asPlayer = yield* intake(
						ALICE,
						{ type: "admit", who: "Cara" },
						withAlice
					);

					const found = new Admit({ who: "cara", member: CARA, name: "Cara" });
					expect(byName).toEqual(found);
					expect(byPrint).toEqual(
						new Admit({ who: "cara1234", member: CARA, name: "Cara" })
					);
					expect(byActor).toEqual(
						new Admit({ who: CARA, member: CARA, name: "Cara" })
					);
					expect(nobody).toEqual(new Admit({ who: "Zed" }));
					expect(asPlayer).toEqual(new Admit({ who: "Cara" }));
				})
			)
	);

	effect(
		"the GM's /admit of a name two knockers share is refused with their fingerprints, never the first one",
		() =>
			run(
				Effect.gen(function* () {
					const twins = Knocks.toLayer(
						Effect.succeed({
							pending: () =>
								Effect.succeed([
									{
										actor: CARA,
										name: "Cara",
										fingerprint:
											"SHA256:cara1234Cara1234cara1234Cara1234cara1234abc",
									},
									{
										actor: OTHER_CARA,
										name: "cara",
										fingerprint:
											"SHA256:zzzz9876Cara1234cara1234Cara1234cara1234abc",
									},
								]),
						})
					);

					const withTwins = yield* Layer.build(twins);

					const refused = yield* Effect.flip(
						intake(GM, { type: "admit", who: "Cara" }, initial).pipe(
							Effect.provideContext(withTwins)
						)
					);

					expect(refused).toBeInstanceOf(Refused);
					expect(refused.message).toBe(
						'2 people knocking go by "Cara": Cara (cara1234), cara (zzzz9876). Name one by the start of its fingerprint, e.g. /admit cara1234.'
					);

					const picked = yield* intake(
						GM,
						{ type: "admit", who: "zzzz9876" },
						initial
					).pipe(Effect.provideContext(withTwins));

					expect(picked).toEqual(
						new Admit({ who: "zzzz9876", member: OTHER_CARA, name: "cara" })
					);
				})
			)
	);

	test("a knocker is named by name first, never by a fingerprint stub under four characters", () => {
		const knockers = [
			{
				actor: CARA,
				name: "Cara",
				fingerprint: "SHA256:cara1234Cara1234cara1234Cara1234cara1234abc",
			},
		];

		expect(knockerNamed(knockers, "CARA")?.actor).toBe(CARA);
		expect(knockerNamed(knockers, "car")).toBeUndefined();
		expect(knockerNamed(knockers, "cara12")?.actor).toBe(CARA);
		expect(shortFingerprint("SHA256:cara1234Cara")).toBe("cara1234");
	});

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

	effect("the GM's freeform /pc carries the sheet from party/", () =>
		run(
			Effect.gen(function* () {
				const command = yield* intake(
					GM,
					{ type: "ff-pc", id: "rook" },
					initial
				);

				expect(command).toEqual(new FfJoinPc({ id: "rook", sheet: ROOK }));
			})
		)
	);

	effect("/show carries the player-safe card the host found", () =>
		run(
			Effect.gen(function* () {
				const command = yield* intake(
					GM,
					{ type: "show", ref: "mara" },
					initial
				);

				const missing = yield* intake(
					GM,
					{ type: "show", ref: "nobody" },
					initial
				).pipe(Effect.flip);

				expect(command).toEqual(new ShowCard({ ref: "mara", card: MARA_CARD }));
				expect(missing).toEqual(
					new Refused({ message: "No card is called 'nobody'." })
				);
			})
		)
	);

	effect("/sync reads again only the cards on the stage", () =>
		run(
			Effect.gen(function* () {
				const shown = rules.apply(initial, {
					actor: GM,
					seq: 1,
					timestamp: "2026-01-01T00:00:00.000Z",
					type: "core.stage-pinned",
					payload: { card: MARA_CARD },
				});

				const command = yield* intake(GM, { type: "sync" }, shown);
				const empty = yield* intake(GM, { type: "sync" }, initial);

				expect(command).toEqual(new SyncContent({ cards: [MARA_CARD] }));
				expect(empty).toEqual(new SyncContent({ cards: [] }));
			})
		)
	);
});
