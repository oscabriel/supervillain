import { describe, expect } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";

import {
	claimRoom,
	forgetRoom,
	judgeClaim,
	readRooms,
	RoomsError,
	touchRoom,
} from "../../src/relay/rooms.ts";
import { effect } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";

const GM_A = `SHA256:${"A".repeat(43)}`;

const GM_B = `SHA256:${"B".repeat(43)}`;

const GM_C = `SHA256:${"C".repeat(43)}`;

const DAY = 24 * 60 * 60 * 1000;

const T0 = Date.parse("2026-10-01T12:00:00.000Z");

const using = <ROut, E1, RIn, A, E2, R2>(
	layer: Layer.Layer<ROut, E1, RIn>,
	body: Effect.Effect<A, E2, R2>
) =>
	Effect.scoped(
		Effect.flatMap(Layer.build(layer), (context) =>
			Effect.provideContext(body, context)
		)
	);

const atT0 = <A, E, R>(body: Effect.Effect<A, E, R>) =>
	using(
		TestClock.layer(),
		Effect.gen(function* () {
			yield* TestClock.setTime(T0);

			return yield* body;
		})
	);

const StoredRooms = Schema.fromJsonString(
	Schema.Record(
		Schema.String,
		Schema.Struct({ key: Schema.String, linked: Schema.String })
	)
);

const readStored = (file: string) =>
	Effect.promise(async () => await readFile(file, "utf-8")).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(StoredRooms))
	);

const modeOf = (file: string) =>
	Effect.promise(async () => await stat(file)).pipe(
		Effect.map(({ mode }) => mode % 0o1000)
	);

const writeText = (file: string, text: string) =>
	Effect.promise(async () => {
		await writeFile(file, text);
	});

const OLD_REGISTRY = JSON.stringify({ den: GM_A });

const DAMAGED = [
	["garbage", "not json"],
	["array", "[]"],
	["bad-room", JSON.stringify({ "Bad Room": GM_A })],
	["bad-key", JSON.stringify({ den: "ssh-ed25519 AAAA" })],
	[
		"bad-claim-key",
		JSON.stringify({ den: { key: "nope", linked: "2026-10-01" } }),
	],
	["bad-time", JSON.stringify({ den: { key: GM_A, linked: "last tuesday" } })],
	["no-time", JSON.stringify({ den: { key: GM_A } })],
] as const;

const later = (ms: number) => TestClock.adjust(ms);

describe("the room registry", () => {
	effect(
		"the first host key to claim a room holds it; another is told who does",
		() =>
			atT0(
				Effect.gen(function* () {
					const file = path.join(yield* tempDir, "rooms.json");
					expect(yield* readRooms(file)).toEqual({});
					expect(yield* claimRoom(file, "den", GM_A)).toEqual({
						holder: GM_A,
						claimed: true,
						dropped: [],
					});
					expect(yield* claimRoom(file, "den", GM_A)).toMatchObject({
						holder: GM_A,
						claimed: false,
					});
					expect(yield* claimRoom(file, "den", GM_B)).toMatchObject({
						holder: GM_A,
						claimed: false,
					});
					yield* later(1000);
					expect(yield* claimRoom(file, "attic", GM_B)).toMatchObject({
						holder: GM_B,
						claimed: true,
					});
					expect(yield* readRooms(file)).toEqual({
						den: { key: GM_A, linked: T0 },
						attic: { key: GM_B, linked: T0 + 1000 },
					});
					expect(yield* readStored(file)).toEqual({
						attic: { key: GM_B, linked: "2026-10-01T12:00:01.000Z" },
						den: { key: GM_A, linked: "2026-10-01T12:00:00.000Z" },
					});
					expect(yield* modeOf(file)).toBe(0o600);
				})
			)
	);

	effect(
		"a claim's holder linking again, or its link ending, renews its time",
		() =>
			atT0(
				Effect.gen(function* () {
					const file = path.join(yield* tempDir, "rooms.json");
					yield* claimRoom(file, "den", GM_A);
					yield* later(DAY);
					yield* claimRoom(file, "den", GM_A);
					expect((yield* readRooms(file)).den).toEqual({
						key: GM_A,
						linked: T0 + DAY,
					});
					yield* later(DAY);
					yield* touchRoom(file, "den", GM_A);
					expect((yield* readRooms(file)).den).toEqual({
						key: GM_A,
						linked: T0 + 2 * DAY,
					});
					yield* later(DAY);
					yield* touchRoom(file, "den", GM_B);
					expect((yield* readRooms(file)).den?.linked).toBe(T0 + 2 * DAY);
					yield* forgetRoom(file, "den");
					yield* touchRoom(file, "den", GM_A);
					expect(yield* readRooms(file)).toEqual({});
				})
			)
	);

	effect(
		"a claim no GM has linked for the expiry lapses, and the next host key claims it",
		() =>
			atT0(
				Effect.gen(function* () {
					const file = path.join(yield* tempDir, "rooms.json");
					const policy = { expireMs: 30 * DAY };
					yield* claimRoom(file, "den", GM_A, policy);
					yield* claimRoom(file, "attic", GM_A, policy);
					yield* later(30 * DAY);
					expect(yield* claimRoom(file, "den", GM_B, policy)).toMatchObject({
						holder: GM_A,
						claimed: false,
					});
					yield* later(1);
					expect(yield* claimRoom(file, "den", GM_B, policy)).toEqual({
						holder: GM_B,
						claimed: true,
						dropped: [
							{ room: "attic", key: GM_A, linked: T0 },
							{ room: "den", key: GM_A, linked: T0 },
						],
					});
					expect(Object.keys(yield* readRooms(file))).toEqual(["den"]);
				})
			)
	);

	effect("a GM linked now keeps its room however long ago its link began", () =>
		atT0(
			Effect.gen(function* () {
				const file = path.join(yield* tempDir, "rooms.json");
				yield* claimRoom(file, "den", GM_A);
				yield* later(90 * DAY);
				const policy = { expireMs: 30 * DAY, linked: new Set(["den"]) };
				expect(yield* claimRoom(file, "den", GM_B, policy)).toMatchObject({
					holder: GM_A,
					claimed: false,
				});
				expect(yield* claimRoom(file, "attic", GM_B, policy)).toMatchObject({
					dropped: [],
				});
				expect(Object.keys(yield* readRooms(file)).toSorted()).toEqual([
					"attic",
					"den",
				]);
			})
		)
	);

	effect("forget releases a claim, and the next host key claims it", () =>
		atT0(
			Effect.gen(function* () {
				const file = path.join(yield* tempDir, "rooms.json");
				yield* claimRoom(file, "den", GM_A);
				expect(yield* forgetRoom(file, "den")).toBe(GM_A);
				expect(yield* forgetRoom(file, "den")).toBeUndefined();
				expect(yield* claimRoom(file, "den", GM_B)).toMatchObject({
					holder: GM_B,
					claimed: true,
				});
			})
		)
	);

	effect(
		"claims and forgets in flight together lose nothing, as from a relay and its forget",
		() =>
			Effect.gen(function* () {
				const file = path.join(yield* tempDir, "rooms.json");
				yield* claimRoom(file, "attic", GM_A);
				const rooms = Array.from({ length: 12 }, (_, i) => `room-${i}`);
				yield* Effect.all(
					[
						...rooms.map((room) => claimRoom(file, room, GM_B)),
						...rooms.map(() => forgetRoom(file, "attic")),
					],
					{ concurrency: "unbounded" }
				);
				const after = yield* readRooms(file);
				expect(Object.keys(after).toSorted()).toEqual([...rooms].toSorted());
			})
	);

	effect(
		"a full registry makes way by dropping its stalest claim with no GM linked now",
		() =>
			atT0(
				Effect.gen(function* () {
					const file = path.join(yield* tempDir, "rooms.json");
					yield* claimRoom(file, "den", GM_A);
					yield* later(DAY);
					yield* claimRoom(file, "attic", GM_B);
					yield* later(DAY);
					yield* claimRoom(file, "loft", GM_C);
					yield* later(DAY);
					const policy = { maxRooms: 3, linked: new Set(["den"]) };
					expect(yield* claimRoom(file, "cellar", GM_C, policy)).toEqual({
						holder: GM_C,
						claimed: true,
						dropped: [{ room: "attic", key: GM_B, linked: T0 + DAY }],
					});
					expect(yield* claimRoom(file, "den", GM_B, policy)).toMatchObject({
						holder: GM_A,
						claimed: false,
					});
					expect(Object.keys(yield* readRooms(file)).toSorted()).toEqual([
						"cellar",
						"den",
						"loft",
					]);

					const allLinked = {
						maxRooms: 3,
						linked: new Set(["cellar", "den", "loft"]),
					};

					expect(yield* claimRoom(file, "attic", GM_B, allLinked)).toEqual({
						full: true,
					});
					expect(Object.keys(yield* readRooms(file)).toSorted()).toEqual([
						"cellar",
						"den",
						"loft",
					]);
				})
			)
	);

	effect("judgeClaim says what a claim would do, without writing", () =>
		Effect.sync(() => {
			const rooms = {
				den: { key: GM_A, linked: T0 },
				attic: { key: GM_B, linked: T0 + DAY },
			};

			const now = T0 + 40 * DAY;
			expect(judgeClaim(rooms, "den", GM_A, now, {})).toEqual({
				kind: "holds",
			});
			expect(
				judgeClaim(rooms, "den", GM_A, now, { expireMs: 30 * DAY })
			).toEqual({
				kind: "holds",
			});
			expect(judgeClaim(rooms, "den", GM_B, now, {})).toEqual({
				kind: "held",
				holder: GM_A,
			});
			expect(
				judgeClaim(rooms, "den", GM_B, now, { expireMs: 30 * DAY })
			).toEqual({
				kind: "free",
				drop: ["den", "attic"],
			});
			expect(judgeClaim(rooms, "loft", GM_C, now, { maxRooms: 2 })).toEqual({
				kind: "free",
				drop: ["den"],
			});
			expect(
				judgeClaim(rooms, "loft", GM_C, now, {
					maxRooms: 2,
					linked: new Set(["den", "attic"]),
				})
			).toEqual({ kind: "full" });
		})
	);

	effect(
		"a registry from before claims had times starts their clocks now",
		() =>
			atT0(
				Effect.gen(function* () {
					const file = path.join(yield* tempDir, "rooms.json");
					yield* writeText(file, OLD_REGISTRY);
					expect(yield* readRooms(file)).toEqual({
						den: { key: GM_A, linked: T0 },
					});
					yield* claimRoom(file, "attic", GM_B);
					expect((yield* readStored(file)).den).toEqual({
						key: GM_A,
						linked: "2026-10-01T12:00:00.000Z",
					});
				})
			)
	);

	effect(
		"a damaged file is an error, never an empty registry that hands rooms out",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;

				for (const [name, text] of DAMAGED) {
					const file = path.join(dir, `${name}.json`);
					yield* writeText(file, text);
					const error = yield* Effect.flip(readRooms(file));
					expect(error).toBeInstanceOf(RoomsError);
					expect(error.message).toContain(file);
					expect(
						yield* Effect.flip(claimRoom(file, "den", GM_B))
					).toBeInstanceOf(RoomsError);
				}
			})
	);
});
