import { describe, expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect, Layer, Option, Schema } from "effect";
import { TestClock } from "effect/testing";

import {
	addKey,
	claimHandle,
	everLinked,
	forgetHandle,
	HANDLE_POLICY,
	HandlesError,
	judgeHandle,
	readHandles,
	retireLegacyRooms,
	touchHandle,
} from "../../src/relay/handles.ts";
import {
	codeOf,
	pairingCodes,
	PAIRING_LIMITS,
} from "../../src/relay/pairings.ts";
import { claimProof, isPairingCode } from "../../src/relay/protocol.ts";
import { effect } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";

const GM_A = `SHA256:${"A".repeat(43)}`;

const GM_A2 = `SHA256:${"a".repeat(43)}`;

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

const StoredHandles = Schema.fromJsonString(
	Schema.Record(
		Schema.String,
		Schema.Struct({
			keys: Schema.Array(Schema.String),
			claimed: Schema.String,
			seen: Schema.String,
		})
	)
);

const readStored = (file: string) =>
	Effect.promise(async () => await readFile(file, "utf-8")).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(StoredHandles))
	);

const modeOf = (file: string) =>
	Effect.promise(async () => await stat(file)).pipe(
		Effect.map(({ mode }) => mode % 0o1000)
	);

const writeText = (file: string, text: string) =>
	Effect.promise(async () => {
		await writeFile(file, text);
	});

const exists = (file: string) =>
	Effect.promise(async () => {
		try {
			await stat(file);

			return true;
		} catch {
			return false;
		}
	});

const claim = (keys: ReadonlyArray<string>, claimed: number, seen: number) => ({
	keys,
	claimed,
	seen,
});

const DAMAGED = [
	["garbage", "not json"],
	["array", "[]"],
	["v1", JSON.stringify({ den: { key: GM_A, linked: "2026-10-01" } })],
	[
		"bad-handle",
		JSON.stringify({
			"Bad Handle": { keys: [GM_A], claimed: "2026-10-01", seen: "2026-10-01" },
		}),
	],
	[
		"bad-key",
		JSON.stringify({
			ana: {
				keys: ["ssh-ed25519 AAAA"],
				claimed: "2026-10-01",
				seen: "2026-10-01",
			},
		}),
	],
	[
		"no-keys",
		JSON.stringify({
			ana: { keys: [], claimed: "2026-10-01", seen: "2026-10-01" },
		}),
	],
	[
		"bad-time",
		JSON.stringify({
			ana: { keys: [GM_A], claimed: "last tuesday", seen: "2026-10-01" },
		}),
	],
] as const;

const later = (ms: number) => TestClock.adjust(ms);

const LEGACY_ROOMS = JSON.stringify({ den: GM_A });

describe("the handle registry", () => {
	effect(
		"the first GM key to claim a handle holds it; another is told which keys do",
		() =>
			atT0(
				Effect.gen(function* () {
					const file = path.join(yield* tempDir, "handles.json");
					expect(yield* readHandles(file)).toEqual({});
					expect(yield* claimHandle(file, "ana", GM_A)).toEqual({
						keys: [GM_A],
						claimed: true,
						dropped: [],
					});
					expect(yield* claimHandle(file, "ana", GM_A)).toMatchObject({
						keys: [GM_A],
						claimed: false,
					});
					expect(yield* claimHandle(file, "ana", GM_B)).toMatchObject({
						keys: [GM_A],
						claimed: false,
					});
					yield* later(1000);
					expect(yield* claimHandle(file, "bo", GM_B)).toMatchObject({
						keys: [GM_B],
						claimed: true,
					});
					expect(yield* readHandles(file)).toEqual({
						ana: claim([GM_A], T0, T0),
						bo: claim([GM_B], T0 + 1000, T0 + 1000),
					});
					expect(yield* readStored(file)).toEqual({
						ana: {
							keys: [GM_A],
							claimed: "2026-10-01T12:00:00.000Z",
							seen: "2026-10-01T12:00:00.000Z",
						},
						bo: {
							keys: [GM_B],
							claimed: "2026-10-01T12:00:01.000Z",
							seen: "2026-10-01T12:00:01.000Z",
						},
					});
					expect(yield* modeOf(file)).toBe(0o600);
				})
			)
	);

	effect(
		"a handle holds a few keys, one for each of a GM's machines, added one by one",
		() =>
			atT0(
				Effect.gen(function* () {
					const file = path.join(yield* tempDir, "handles.json");
					expect(yield* addKey(file, "ana", GM_A2)).toEqual({
						kind: "unclaimed",
					});
					yield* claimHandle(file, "ana", GM_A);
					expect(yield* addKey(file, "ana", GM_A2)).toEqual({
						kind: "added",
						keys: [GM_A, GM_A2],
					});
					expect(yield* addKey(file, "ana", GM_A2)).toEqual({
						kind: "already",
						keys: [GM_A, GM_A2],
					});
					expect(yield* claimHandle(file, "ana", GM_A2)).toMatchObject({
						claimed: false,
					});
					yield* addKey(file, "ana", GM_B);
					yield* addKey(file, "ana", GM_C);
					expect(
						yield* addKey(file, "ana", `SHA256:${"D".repeat(43)}`)
					).toEqual({
						kind: "full",
						keys: [GM_A, GM_A2, GM_B, GM_C],
					});
					expect(HANDLE_POLICY.maxKeysPerHandle).toBe(4);
				})
			)
	);

	effect(
		"a table's link renews its handle's time, and marks it as having linked",
		() =>
			atT0(
				Effect.gen(function* () {
					const file = path.join(yield* tempDir, "handles.json");
					yield* claimHandle(file, "ana", GM_A);
					expect(everLinked(must((yield* readHandles(file)).ana))).toBe(false);
					yield* touchHandle(file, "ana", GM_A);
					const touched = must((yield* readHandles(file)).ana);
					expect(everLinked(touched)).toBe(true);
					expect(touched.seen).toBe(T0 + 1);
					yield* later(DAY);
					yield* touchHandle(file, "ana", GM_A);
					expect((yield* readHandles(file)).ana?.seen).toBe(T0 + DAY);
					yield* later(DAY);
					yield* touchHandle(file, "ana", GM_B);
					expect((yield* readHandles(file)).ana?.seen).toBe(T0 + DAY);
					yield* forgetHandle(file, "ana");
					yield* touchHandle(file, "ana", GM_A);
					expect(yield* readHandles(file)).toEqual({});
				})
			)
	);

	effect(
		"a handle that never linked a table lapses after 30 days, one that did after 180",
		() =>
			atT0(
				Effect.gen(function* () {
					const file = path.join(yield* tempDir, "handles.json");
					yield* claimHandle(file, "idle", GM_A);
					yield* claimHandle(file, "used", GM_A);
					yield* touchHandle(file, "used", GM_A);
					yield* later(30 * DAY + 2);
					expect(yield* claimHandle(file, "idle", GM_B)).toEqual({
						keys: [GM_B],
						claimed: true,
						dropped: [{ handle: "idle", keys: [GM_A], claimed: T0, seen: T0 }],
					});
					expect(yield* claimHandle(file, "used", GM_B)).toMatchObject({
						keys: [GM_A],
						claimed: false,
					});
					yield* later(150 * DAY);
					expect(yield* claimHandle(file, "used", GM_B)).toMatchObject({
						keys: [GM_B],
						claimed: true,
					});
					expect(Object.keys(yield* readHandles(file))).toEqual(["used"]);
				})
			)
	);

	effect("a GM linked now keeps its handle however long ago it began", () =>
		atT0(
			Effect.gen(function* () {
				const file = path.join(yield* tempDir, "handles.json");
				yield* claimHandle(file, "ana", GM_A);
				yield* later(400 * DAY);
				const policy = { linked: new Set(["ana"]) };
				expect(yield* claimHandle(file, "ana", GM_B, policy)).toMatchObject({
					keys: [GM_A],
					claimed: false,
				});
			})
		)
	);

	effect("forget releases a handle, and the next GM key claims it", () =>
		atT0(
			Effect.gen(function* () {
				const file = path.join(yield* tempDir, "handles.json");
				yield* claimHandle(file, "ana", GM_A);
				yield* addKey(file, "ana", GM_A2);
				expect(yield* forgetHandle(file, "ana")).toEqual([GM_A, GM_A2]);
				expect(yield* forgetHandle(file, "ana")).toBeUndefined();
				expect(yield* claimHandle(file, "ana", GM_B)).toMatchObject({
					keys: [GM_B],
					claimed: true,
				});
			})
		)
	);

	effect(
		"claims and forgets in flight together lose nothing, as from a relay and its forget",
		() =>
			Effect.gen(function* () {
				const file = path.join(yield* tempDir, "handles.json");
				yield* claimHandle(file, "attic", GM_A);
				const handles = Array.from({ length: 12 }, (_, i) => `gm-${i}`);
				yield* Effect.all(
					[
						...handles.map((handle) => claimHandle(file, handle, GM_B)),
						...handles.map(() => forgetHandle(file, "attic")),
					],
					{ concurrency: "unbounded" }
				);
				const after = yield* readHandles(file);
				expect(Object.keys(after).toSorted()).toEqual([...handles].toSorted());
			})
	);

	effect(
		"a full registry refuses new handles, and only lapsed handles make way",
		() =>
			atT0(
				Effect.gen(function* () {
					const file = path.join(yield* tempDir, "handles.json");
					yield* claimHandle(file, "ana", GM_A);
					yield* later(DAY);
					yield* claimHandle(file, "bo", GM_B);
					yield* later(DAY);
					yield* claimHandle(file, "cy", GM_C);
					yield* later(DAY);
					const policy = { maxHandles: 3 };
					expect(yield* claimHandle(file, "dee", GM_C, policy)).toEqual({
						full: true,
					});
					expect(Object.keys(yield* readHandles(file)).toSorted()).toEqual([
						"ana",
						"bo",
						"cy",
					]);
					yield* later(31 * DAY);
					yield* touchHandle(file, "ana", GM_A);
					yield* touchHandle(file, "cy", GM_C);
					expect(yield* claimHandle(file, "dee", GM_C, policy)).toEqual({
						keys: [GM_C],
						claimed: true,
						dropped: [
							{ handle: "bo", keys: [GM_B], claimed: T0 + DAY, seen: T0 + DAY },
						],
					});
					expect(yield* claimHandle(file, "eve", GM_B, policy)).toEqual({
						full: true,
					});
				})
			)
	);

	test("judgeHandle says what a claim would do, without writing", () => {
		const handles = {
			ana: claim([GM_A, GM_A2], T0, T0 + 1),
			bo: claim([GM_B], T0 + DAY, T0 + DAY),
		};

		const now = T0 + 40 * DAY;
		expect(judgeHandle(handles, "ana", GM_A2, now)).toEqual({ kind: "holds" });
		expect(judgeHandle(handles, "ana", GM_B, now)).toEqual({
			kind: "held",
			keys: [GM_A, GM_A2],
		});
		expect(judgeHandle(handles, "bo", GM_C, now)).toEqual({
			kind: "free",
			drop: ["bo"],
		});
		expect(judgeHandle(handles, "cy", GM_C, now, { maxHandles: 2 })).toEqual({
			kind: "free",
			drop: ["bo"],
		});
		expect(
			judgeHandle(handles, "cy", GM_C, T0, {
				maxHandles: 2,
				linked: new Set(["ana", "bo"]),
			})
		).toEqual({ kind: "full" });
		expect(
			judgeHandle(handles, "cy", GM_C, T0 + 2 * DAY, { maxHandles: 2 })
		).toEqual({ kind: "full" });
		expect(HANDLE_POLICY).toEqual({
			maxHandles: 4096,
			maxKeysPerHandle: 4,
			claimDays: 180,
			unlinkedDays: 30,
		});
	});

	effect(
		"a damaged file is an error, never an empty registry that hands handles out",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;

				for (const [name, text] of DAMAGED) {
					const file = path.join(dir, `${name}.json`);
					yield* writeText(file, text);
					const error = yield* Effect.flip(readHandles(file));
					expect(error).toBeInstanceOf(HandlesError);
					expect(error.message).toContain(file);
					expect(
						yield* Effect.flip(claimHandle(file, "ana", GM_B))
					).toBeInstanceOf(HandlesError);
				}
			})
	);

	effect(
		"a protocol 1 rooms.json is set aside as rooms.json.legacy, never over an older one",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;
				expect(yield* retireLegacyRooms(dir)).toEqual(Option.none());
				yield* writeText(path.join(dir, "rooms.json"), LEGACY_ROOMS);
				expect(yield* retireLegacyRooms(dir)).toEqual(
					Option.some(path.join(dir, "rooms.json.legacy"))
				);
				expect(yield* exists(path.join(dir, "rooms.json"))).toBe(false);
				expect(yield* exists(path.join(dir, "rooms.json.legacy"))).toBe(true);
				expect(yield* retireLegacyRooms(dir)).toEqual(Option.none());
				yield* writeText(path.join(dir, "rooms.json"), LEGACY_ROOMS);
				const again = Option.getOrUndefined(yield* retireLegacyRooms(dir));
				expect(again).toStartWith(path.join(dir, "rooms.json.legacy."));
				expect(yield* exists(must(again))).toBe(true);
				expect(yield* exists(path.join(dir, "rooms.json.legacy"))).toBe(true);
				expect(yield* exists(path.join(dir, "rooms.json"))).toBe(false);
			})
	);
});

const bytes = (n: number) => new Uint8Array(13).fill(n);

const must = <A>(value: A | undefined): A => {
	if (value === undefined) {
		throw new Error("expected a value");
	}

	return value;
};

describe("claim codes", () => {
	test("look like sv- and 20 Crockford letters and digits", () => {
		expect(isPairingCode(codeOf(bytes(7)))).toBe(true);
		expect(codeOf(bytes(0))).toBe(`sv-${"0".repeat(20)}`);
	});

	test("are minted for a handle, proven bound to one key, spent once, and run out after 15 minutes", () => {
		const pairings = pairingCodes();
		const minted = pairings.mint("ana", GM_A, bytes(1), T0);
		expect(minted.kind).toBe("minted");

		if (minted.kind !== "minted") {
			return;
		}

		const proof = claimProof(minted.code, GM_B);
		expect(minted.until).toBe(T0 + 15 * 60_000);
		expect(pairings.check(proof, "bo", GM_B, "203.0.113.7", T0)).toBe("bad");
		expect(pairings.check(proof, "ana", GM_C, "203.0.113.8", T0)).toBe("bad");
		expect(pairings.check(minted.code, "ana", GM_B, "203.0.113.9", T0)).toBe(
			"bad"
		);
		expect(pairings.check(proof, "ana", GM_B, "203.0.113.7", T0)).toBe("ok");
		expect(pairings.find(proof, "bo", GM_B, T0)).toBeUndefined();
		expect(pairings.find(proof, "ana", GM_C, T0)).toBeUndefined();
		expect(pairings.find(proof, "ana", GM_B, T0)).toBe(minted.code);
		expect(pairings.find(proof, "ana", GM_B, T0)).toBe(minted.code);
		pairings.spend(minted.code);
		expect(pairings.find(proof, "ana", GM_B, T0)).toBeUndefined();

		const late = pairings.mint("ana", GM_A, bytes(2), T0);

		if (late.kind === "minted") {
			expect(
				pairings.find(claimProof(late.code, GM_B), "ana", GM_B, late.until)
			).toBeUndefined();
		}

		expect(pairings.live(late.kind === "minted" ? late.until : T0)).toBe(0);
	});

	test("a key holds at most 3 live codes, and the relay at most 256", () => {
		const pairings = pairingCodes();

		for (const n of [1, 2, 3]) {
			expect(pairings.mint("ana", GM_A, bytes(n), T0).kind).toBe("minted");
		}

		expect(pairings.mint("ana", GM_A, bytes(4), T0)).toMatchObject({
			kind: "refused",
		});
		expect(pairings.mint("ana", GM_A2, bytes(5), T0).kind).toBe("minted");

		const small = pairingCodes({ ...PAIRING_LIMITS, live: 1 });
		small.mint("ana", GM_A, bytes(1), T0);
		expect(small.mint("bo", GM_B, bytes(2), T0)).toMatchObject({
			kind: "refused",
		});
		expect(PAIRING_LIMITS).toMatchObject({
			ttlMs: 900_000,
			live: 256,
			perKey: 3,
		});
	});

	test("an address guessing codes is slowed after a few misses", () => {
		const pairings = pairingCodes();
		const minted = pairings.mint("ana", GM_A, bytes(9), T0);
		const code = minted.kind === "minted" ? minted.code : "";

		const proofOf = (guess: string) => claimProof(guess, GM_B);

		for (const n of [1, 2, 3, 4, 5]) {
			expect(
				pairings.check(
					proofOf(codeOf(bytes(100 + n))),
					"ana",
					GM_B,
					"198.51.100.4",
					T0
				)
			).toBe("bad");
		}

		expect(pairings.check(proofOf(code), "ana", GM_B, "198.51.100.4", T0)).toBe(
			"slow"
		);
		expect(pairings.check(proofOf(code), "ana", GM_B, "203.0.113.9", T0)).toBe(
			"ok"
		);
	});
});
