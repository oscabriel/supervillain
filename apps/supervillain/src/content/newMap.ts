import {
	ID,
	MAP_SEED_MAX,
	MAP_WORDS,
	MapForge,
	MapWriteFailed,
} from "@supervillain/domain";
import type { MapKind, MapWriteReason } from "@supervillain/domain";
import { Effect, FileSystem, Option, Path, Predicate } from "effect";
import { SecureRandom } from "effect/crypto";

import { CampaignContent } from "./CampaignContent.ts";
import { generateMap, mapFileText } from "./mapgen.ts";
import type { GeneratedMap } from "./mapgen.ts";

export interface WrittenMap {
	readonly id: string;
	readonly file: string;
	readonly kind: MapKind;
	readonly seed: number;
	readonly map: GeneratedMap;
}

const generated = (
	kind: MapKind,
	seed: number,
	failed: (why: string) => MapWriteFailed
) =>
	Effect.try({
		try: () => generateMap(kind, seed),
		catch: (cause) =>
			failed(Predicate.isError(cause) ? cause.message : String(cause)),
	});

export const mapWriter = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	return Effect.fn("writeGeneratedMap")(function* (
		campaignDir: string,
		kind: MapKind,
		seed: number,
		id?: string
	) {
		const mapId = (id ?? `${kind}-${seed}`).toLowerCase();

		const failed = (reason: MapWriteReason, message: string) =>
			new MapWriteFailed({ reason, id: mapId, message });

		if (!Number.isInteger(seed) || seed < 0 || seed > MAP_SEED_MAX) {
			return yield* failed(
				"bad-seed",
				`a map's seed is a whole number from 0 to ${MAP_SEED_MAX}`
			);
		}

		if (!ID.test(mapId)) {
			return yield* failed(
				"bad-id",
				`a map id is up to 40 of a-z, 0-9 and -, not ${mapId}`
			);
		}

		if (MAP_WORDS.includes(mapId)) {
			return yield* failed(
				"bad-id",
				`a map can't be called ${mapId}, since /map ${mapId} means that`
			);
		}

		const map = yield* generated(kind, seed, (why) => failed("generate", why));
		const file = `maps/${mapId}.txt`;
		const folder = path.join(campaignDir, "maps");
		const target = path.join(campaignDir, file);

		const exists = failed(
			"exists",
			`there's already a map called ${mapId} in maps/`
		);

		const writeFailed = (message: string) =>
			failed("write", `can't write ${file}: ${message}`);

		yield* fs.stat(campaignDir).pipe(
			Effect.catchReason("PlatformError", "NotFound", () =>
				Effect.fail(
					failed("no-campaign", `there's no campaign at ${campaignDir}`)
				)
			),
			Effect.catchTag("PlatformError", (cause) =>
				Effect.fail(writeFailed(cause.message))
			)
		);

		const taken = yield* fs.readDirectory(folder).pipe(
			Effect.map((names) =>
				Option.fromNullishOr(
					names.find((name) => name.toLowerCase() === `${mapId}.txt`)
				)
			),
			Effect.catchReason("PlatformError", "NotFound", () =>
				Effect.succeed(Option.none<string>())
			),
			Effect.mapError((cause) => writeFailed(cause.message))
		);

		if (Option.isSome(taken)) {
			return yield* exists;
		}

		yield* fs
			.makeDirectory(folder, { recursive: true })
			.pipe(Effect.mapError((cause) => writeFailed(cause.message)));

		yield* fs.writeFileString(target, mapFileText(map), { flag: "wx" }).pipe(
			Effect.catchReason("PlatformError", "AlreadyExists", () =>
				Effect.fail(exists)
			),
			Effect.catchTag("PlatformError", (cause) =>
				fs
					.remove(target)
					.pipe(
						Effect.ignore,
						Effect.andThen(Effect.fail(writeFailed(cause.message)))
					)
			)
		);

		const written: WrittenMap = { id: mapId, file, kind, seed, map };

		return written;
	});
});

export const writeGeneratedMap = (
	campaignDir: string,
	kind: MapKind,
	seed: number,
	id?: string
) => Effect.flatMap(mapWriter, (write) => write(campaignDir, kind, seed, id));

export const MapForgeLive = MapForge.toLayer(
	Effect.gen(function* () {
		const content = yield* CampaignContent;
		const random = yield* SecureRandom.SecureRandom;
		const write = yield* mapWriter;

		return {
			generate: Effect.fn("MapForge.generate")(function* (input: {
				readonly kind: MapKind;
				readonly seed?: number;
			}) {
				const seed = input.seed ?? (yield* random.intBetween(0, MAP_SEED_MAX));

				const written = yield* write(content.dir, input.kind, seed);

				return { id: written.id };
			}),
		};
	})
);
