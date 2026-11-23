import {
	Catalog,
	ContentReadError,
	ID,
	MAP_WORDS,
	MapNotFound,
	SheetAmbiguous,
	SheetNotFound,
	Sheets,
} from "@supervillain/domain";
import type {
	HeroSheet,
	MapGrid,
	MapInvalid,
	PfSheet,
	PrepCatalog,
	PrepEntry,
	RulesetName,
	SheetInvalid,
	SheetKind,
	StatBlock,
} from "@supervillain/domain";
import { Context, Effect, FileSystem, Layer, Option, Path } from "effect";
import type { PlatformError } from "effect";

import { readCampaignConfig } from "./campaignFile.ts";
import type { CampaignConfigInvalid } from "./errors.ts";
import { decodeMap, MAP_BYTES, tooBig } from "./mapFiles.ts";
import { decodePfSheetFile } from "./pfSheetFiles.ts";
import { decodeHero, decodeMonster, idOf } from "./sheetFiles.ts";

export type LoadError =
	| SheetNotFound
	| SheetAmbiguous
	| SheetInvalid
	| ContentReadError;

export type MapLoadError = MapNotFound | MapInvalid | ContentReadError;

export interface LoadedMap {
	readonly id: string;
	readonly grid: MapGrid;
}

type Kind = SheetKind | "map";

const FOLDER: Readonly<Record<Kind, string>> = {
	hero: "heroes",
	monster: "monsters",
	map: "maps",
};

const EXTENSIONS: Readonly<Record<Kind, ReadonlyArray<RegExp>>> = {
	hero: [/\.yaml$/iu, /\.yml$/iu],
	monster: [/\.yaml$/iu, /\.yml$/iu],
	map: [/\.txt$/iu],
};

interface Entry {
	readonly id: string;
	readonly file: string;
}

interface Several {
	readonly several: ReadonlyArray<string>;
}

const byId = (a: Entry, b: Entry) => {
	if (a.id === b.id) {
		return 0;
	}

	return a.id < b.id ? -1 : 1;
};

const readError =
	(what: string) =>
	(cause: PlatformError.PlatformError): ContentReadError =>
		new ContentReadError({ message: `${what}: ${cause.message}`, cause });

const match = (all: ReadonlyArray<Entry>, query: string): Entry | Several => {
	const wanted = query.trim().toLowerCase();
	const exact = all.find((e) => e.id.toLowerCase() === wanted);

	if (exact !== undefined) {
		return exact;
	}

	const matches =
		wanted === ""
			? []
			: all.filter((e) => e.id.toLowerCase().startsWith(wanted));

	const [only] = matches;

	return matches.length === 1 && only !== undefined
		? only
		: { several: matches.map((e) => e.id) };
};

const isSeveral = (found: Entry | Several): found is Several =>
	"several" in found;

const have = (kind: Kind, all: ReadonlyArray<Entry>) =>
	all.length === 0
		? `it has no ${kind === "map" ? ".txt" : ".yaml"} files`
		: `there are: ${all.map((e) => e.id).join(", ")}`;

const find = (
	kind: SheetKind,
	all: ReadonlyArray<Entry>,
	query: string
): Effect.Effect<Entry, SheetNotFound | SheetAmbiguous> => {
	const found = match(all, query);

	if (!isSeveral(found)) {
		return Effect.succeed(found);
	}

	if (found.several.length > 1) {
		return Effect.fail(
			new SheetAmbiguous({
				kind,
				query,
				matches: found.several,
				message: `"${query}" could be any of these ${FOLDER[kind]}: ${found.several.join(", ")}`,
			})
		);
	}

	return Effect.fail(
		new SheetNotFound({
			kind,
			query,
			message: `no ${kind} "${query}" in ${FOLDER[kind]}/ (${have(kind, all)})`,
		})
	);
};

const textOf = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const pfName = (e: Entry, bytes: Uint8Array) =>
	Effect.map(decodePfSheetFile(e.file, textOf(bytes)), (h) => h.name);

const ids = (all: ReadonlyArray<Entry>) => all.map((e) => e.id);

export class CampaignContent extends Context.Service<
	CampaignContent,
	{
		readonly dir: string;
		readonly ruleset: RulesetName;
		readonly heroes: Effect.Effect<ReadonlyArray<string>, ContentReadError>;
		readonly monsters: Effect.Effect<ReadonlyArray<string>, ContentReadError>;
		readonly hero: (query: string) => Effect.Effect<HeroSheet, LoadError>;
		readonly monster: (query: string) => Effect.Effect<StatBlock, LoadError>;
		readonly pfHero: (query: string) => Effect.Effect<PfSheet, LoadError>;
		readonly pfMonster: (query: string) => Effect.Effect<PfSheet, LoadError>;
		readonly maps: Effect.Effect<ReadonlyArray<string>, ContentReadError>;
		readonly map: (query: string) => Effect.Effect<LoadedMap, MapLoadError>;
		readonly catalog: Effect.Effect<PrepCatalog, ContentReadError>;
	}
>()("supervillain/content/CampaignContent") {
	static readonly make = Effect.fn("CampaignContent.make")(function* (
		dir: string
	) {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const config = yield* readCampaignConfig(dir);

		const names = (kind: Kind) =>
			fs.readDirectoryEntries(path.join(dir, FOLDER[kind])).pipe(
				Effect.map((found) =>
					found
						.filter(
							(entry) =>
								entry.type !== "Directory" &&
								!entry.name.startsWith(".") &&
								EXTENSIONS[kind].some((x) => x.test(entry.name))
						)
						.map((entry) => entry.name)
				),
				Effect.catchReason("PlatformError", "NotFound", () =>
					Effect.succeed([])
				),
				Effect.mapError(readError(`can't list ${FOLDER[kind]}/`))
			);

		const entries = Effect.fn("CampaignContent.entries")(function* (
			kind: Kind
		) {
			const listed = yield* names(kind);
			const seen = new Map<string, Entry>();

			const inOrder = EXTENSIONS[kind].flatMap((x) =>
				listed.filter((name) => x.test(name))
			);

			for (const name of inOrder) {
				const id = idOf(name);

				if (!seen.has(id)) {
					seen.set(id, { id, file: `${FOLDER[kind]}/${name}` });
				}
			}

			return [...seen.values()].toSorted(byId);
		});

		const mapEntries = Effect.fn("CampaignContent.mapEntries")(function* () {
			const all = yield* entries("map");

			const usable = all
				.filter((e) => ID.test(e.id.toLowerCase()))
				.map((e) => ({ ...e, id: e.id.toLowerCase() }))
				.toSorted(byId);

			const unnamed = all
				.filter((e) => !ID.test(e.id.toLowerCase()))
				.map((e) => e.file.slice("maps/".length));

			return { usable, unnamed };
		});

		const map = Effect.fn("CampaignContent.map")(function* (query: string) {
			const { usable, unnamed } = yield* mapEntries();
			const found = match(usable, query);

			if (isSeveral(found)) {
				const skipped =
					unnamed.length === 0
						? ""
						: `; not maps, since a map's file name is its id (lower-case letters, digits and hyphens, at most 40): ${unnamed.join(", ")}`;

				return yield* new MapNotFound({
					query,
					message:
						found.several.length > 1
							? `"${query}" could be any of these maps: ${found.several.join(", ")}`
							: `no map "${query}" in maps/ (${have("map", usable)})${skipped}`,
				});
			}

			const { id, file } = found;
			const full = path.join(dir, file);
			const unreadable = readError(`can't read ${file}`);
			const info = yield* fs.stat(full).pipe(Effect.mapError(unreadable));
			const big = tooBig(file, Number(info.size));

			if (big !== undefined) {
				return yield* big;
			}

			const bytes = yield* fs.readFile(full).pipe(Effect.mapError(unreadable));
			const grid = yield* decodeMap(file, id, bytes);
			const loaded: LoadedMap = { id, grid };

			return loaded;
		});

		const load =
			<A>(
				kind: SheetKind,
				decode: (file: string, text: string) => Effect.Effect<A, SheetInvalid>
			) =>
			(query: string) =>
				Effect.gen(function* () {
					const entry = yield* find(kind, yield* entries(kind), query);

					const text = yield* fs
						.readFileString(path.join(dir, entry.file))
						.pipe(Effect.mapError(readError(`can't read ${entry.file}`)));

					return yield* decode(entry.file, text);
				}).pipe(Effect.withSpan(`CampaignContent.${kind}`));

		const bytesOf = (entry: Entry, maxBytes: number | undefined) =>
			Effect.gen(function* () {
				const full = path.join(dir, entry.file);

				if (maxBytes !== undefined) {
					const info = yield* fs.stat(full);

					if (Number(info.size) > maxBytes) {
						return Option.none<Uint8Array>();
					}
				}

				return Option.some(yield* fs.readFile(full));
			});

		const named = (
			all: ReadonlyArray<Entry>,
			nameIn: (
				entry: Entry,
				bytes: Uint8Array
			) => Effect.Effect<string, SheetInvalid | MapInvalid>,
			maxBytes?: number
		) =>
			Effect.forEach(
				all,
				(entry) =>
					bytesOf(entry, maxBytes).pipe(
						Effect.flatMap(
							Option.match({
								onNone: () => Effect.succeed(entry.id),
								onSome: (bytes) => nameIn(entry, bytes),
							})
						),
						Effect.match({
							onFailure: (): PrepEntry => ({ id: entry.id, name: entry.id }),
							onSuccess: (name): PrepEntry => ({ id: entry.id, name }),
						})
					),
				{ concurrency: 8 }
			);

		const pf = config.rules === "pf2e";

		const catalog = Effect.gen(function* () {
			const heroes = yield* entries("hero");
			const monsters = yield* entries("monster");
			const { usable: maps } = yield* mapEntries();

			const listed: PrepCatalog = {
				heroes: yield* named(heroes, (e, bytes) =>
					pf
						? pfName(e, bytes)
						: Effect.map(decodeHero(e.file, textOf(bytes)), (h) => h.name)
				),
				monsters: yield* named(monsters, (e, bytes) =>
					pf
						? pfName(e, bytes)
						: Effect.map(decodeMonster(e.file, textOf(bytes)), (m) => m.name)
				),
				maps: yield* named(
					maps.filter((e) => !MAP_WORDS.includes(e.id)),
					(e, bytes) =>
						Effect.map(decodeMap(e.file, e.id, bytes), (g) => g.name),
					MAP_BYTES
				),
			};

			return listed;
		}).pipe(Effect.withSpan("CampaignContent.catalog"));

		return CampaignContent.of({
			dir,
			ruleset: config.rules,
			heroes: Effect.map(entries("hero"), ids),
			monsters: Effect.map(entries("monster"), ids),
			hero: load("hero", decodeHero),
			monster: load("monster", decodeMonster),
			pfHero: load("hero", decodePfSheetFile),
			pfMonster: load("monster", decodePfSheetFile),
			maps: Effect.map(mapEntries(), ({ usable }) => ids(usable)),
			map,
			catalog,
		});
	});

	static readonly layer = (
		campaignDir: string
	): Layer.Layer<
		CampaignContent,
		CampaignConfigInvalid | ContentReadError,
		FileSystem.FileSystem | Path.Path
	> => Layer.effect(CampaignContent, CampaignContent.make(campaignDir));
}

export const SheetsLive = Sheets.toLayer(
	Effect.gen(function* () {
		const content = yield* CampaignContent;

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
				return yield* content.map(query);
			}),
		};
	})
);

export const CatalogLive = Catalog.toLayer(
	Effect.gen(function* () {
		const content = yield* CampaignContent;

		return {
			list: Effect.fn("Catalog.list")(function* () {
				return yield* content.catalog;
			}),
		};
	})
);
