import {
	MAP_SEED_MAX,
	MapForge,
	MapWriteFailed,
	SetWorld,
	SetWorldError,
	Sheets,
} from "@supervillain/domain";
import type { MapKind } from "@supervillain/domain";
import { Context, Effect, Layer, Option, Predicate, Ref } from "effect";
import { SecureRandom } from "effect/crypto";

import { CampaignContent, decodeMap } from "../content/index.ts";
import type { LoadedMap } from "../content/index.ts";
import { generateMap, mapFileText } from "../content/mapgen.ts";
import type { GeneratedMap } from "../content/mapgen.ts";

const MEMORY_MAPS = 16;

const SANDBOX_SET_WORLD =
	"this table is a sandbox, so it doesn't call set.world";

export class MemoryMaps extends Context.Service<
	MemoryMaps,
	{
		readonly most: number;
		readonly find: (id: string) => Effect.Effect<Option.Option<LoadedMap>>;
		readonly room: (id: string) => Effect.Effect<"ok" | "exists" | "full">;
		readonly keep: (map: LoadedMap) => Effect.Effect<boolean>;
	}
>()("supervillain/host/MemoryMaps") {
	static readonly make = (most: number) =>
		Effect.gen(function* () {
			const maps = yield* Ref.make<ReadonlyMap<string, LoadedMap>>(new Map());

			const find = Effect.fn("MemoryMaps.find")(function* (id: string) {
				const held = yield* Ref.get(maps);

				return Option.fromNullishOr(held.get(id.toLowerCase()));
			});

			const room = Effect.fn("MemoryMaps.room")(function* (id: string) {
				const held = yield* Ref.get(maps);

				if (held.has(id.toLowerCase())) {
					return "exists" as const;
				}

				return held.size >= most ? ("full" as const) : ("ok" as const);
			});

			const keep = Effect.fn("MemoryMaps.keep")(function* (map: LoadedMap) {
				return yield* Ref.modify(maps, (held) => {
					if (held.has(map.id) || held.size >= most) {
						return [false, held] as const;
					}

					return [true, new Map([...held, [map.id, map]])] as const;
				});
			});

			return MemoryMaps.of({ most, find, room, keep });
		});

	static readonly layer = (most: number = MEMORY_MAPS) =>
		Layer.effect(MemoryMaps, MemoryMaps.make(most));
}

type Generate = (kind: MapKind, seed: number) => GeneratedMap;

const refusedRoom = (id: string, why: "exists" | "full", most: number) =>
	new MapWriteFailed({
		reason: why === "exists" ? "exists" : "write",
		id,
		message:
			why === "exists"
				? `there's already a map called ${id}`
				: `this sandbox holds at most ${most} new maps`,
	});

const generated = (
	generate: Generate,
	kind: MapKind,
	seed: number,
	id: string
) =>
	Effect.try({
		try: () => generate(kind, seed),
		catch: (cause) =>
			new MapWriteFailed({
				reason: "generate",
				id,
				message: Predicate.isError(cause) ? cause.message : String(cause),
			}),
	});

export const mapForgeMemory = (generate: Generate = generateMap) =>
	MapForge.toLayer(
		Effect.gen(function* () {
			const maps = yield* MemoryMaps;
			const random = yield* SecureRandom.SecureRandom;

			return {
				generate: Effect.fn("MapForge.generate")(function* (input: {
					readonly kind: MapKind;
					readonly seed?: number;
				}) {
					const seed =
						input.seed ?? (yield* random.intBetween(0, MAP_SEED_MAX));

					const id = `${input.kind}-${seed}`;

					const before = yield* maps.room(id);

					if (before !== "ok") {
						return yield* refusedRoom(id, before, maps.most);
					}

					const map = yield* generated(generate, input.kind, seed, id);
					const file = `maps/${id}.txt`;

					const grid = yield* decodeMap(
						file,
						id,
						new TextEncoder().encode(mapFileText(map))
					).pipe(
						Effect.mapError(
							(cause) =>
								new MapWriteFailed({
									reason: "generate",
									id,
									message: cause.message,
								})
						)
					);

					const kept = yield* maps.keep({ id, grid });

					if (!kept) {
						const after = yield* maps.room(id);

						return yield* refusedRoom(
							id,
							after === "exists" ? "exists" : "full",
							maps.most
						);
					}

					return { id };
				}),
			};
		})
	);

export const MapForgeMemory = mapForgeMemory();

export const SheetsMemory = Sheets.toLayer(
	Effect.gen(function* () {
		const content = yield* CampaignContent;
		const maps = yield* MemoryMaps;

		return {
			hero: Effect.fn("Sheets.hero")(function* ({
				query,
			}: {
				readonly query: string;
			}) {
				return yield* content.hero(query);
			}),
			monster: Effect.fn("Sheets.monster")(function* ({
				query,
			}: {
				readonly query: string;
			}) {
				return yield* content.monster(query);
			}),
			pfHero: Effect.fn("Sheets.pfHero")(function* ({
				query,
			}: {
				readonly query: string;
			}) {
				return yield* content.pfHero(query);
			}),
			pfMonster: Effect.fn("Sheets.pfMonster")(function* ({
				query,
			}: {
				readonly query: string;
			}) {
				return yield* content.pfMonster(query);
			}),
			map: Effect.fn("Sheets.map")(function* ({
				query,
			}: {
				readonly query: string;
			}) {
				const kept = yield* maps.find(query);

				return Option.isSome(kept) ? kept.value : yield* content.map(query);
			}),
			ffHero: Effect.fn("Sheets.ffHero")(function* ({
				query,
			}: {
				readonly query: string;
			}) {
				return yield* content.ffHero(query);
			}),
			ffMonster: Effect.fn("Sheets.ffMonster")(function* ({
				query,
			}: {
				readonly query: string;
			}) {
				return yield* content.ffMonster(query);
			}),
			card: Effect.fn("Sheets.card")(function* ({
				query,
			}: {
				readonly query: string;
			}) {
				return yield* content.card(query);
			}),
			cards: Effect.fn("Sheets.cards")(function* ({
				keys,
			}: {
				readonly keys: ReadonlyArray<string>;
			}) {
				return yield* content.cards(keys);
			}),
		};
	})
);

export const SetWorldRefusing = SetWorld.toLayer(
	Effect.succeed({
		roll: Effect.fn("SetWorld.roll")(function* (input: {
			readonly seed?: number;
		}) {
			return yield* new SetWorldError({
				seed: input.seed ?? 0,
				message: SANDBOX_SET_WORLD,
			});
		}),
	})
);
