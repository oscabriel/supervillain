import {
	CardAmbiguous,
	CardNotFound,
	Catalog,
	ContentReadError,
	ffSheetProblem,
	ID,
	MAP_WORDS,
	MapInvalid,
	MapNotFound,
	SheetAmbiguous,
	SheetNotFound,
	Sheets,
} from "@supervillain/domain";
import type {
	FfSheet,
	HeroSheet,
	MapGrid,
	PfSheet,
	PrepCatalog,
	PrepEntry,
	RulesetName,
	SheetInvalid,
	SheetKind,
	StageCard,
	StatBlock,
} from "@supervillain/domain";
import { Context, Effect, FileSystem, Layer, Option, Path, Ref } from "effect";
import type { PlatformError } from "effect";

import { readBounded, utf8Of } from "./bounded.ts";
import { readCampaignConfig } from "./campaignFile.ts";
import {
	ffSheetOf,
	findDoc,
	gmNotesFor,
	keyedDocs,
	sheetFields,
	yamlText,
} from "./cards.ts";
import type { Found } from "./cards.ts";
import { indexWith } from "./ContentIndex.ts";
import type { ContentIndex, Files, SheetDoc } from "./ContentIndex.ts";
import type { CampaignConfigInvalid } from "./errors.ts";
import { MD_BYTES } from "./kinds.ts";
import { decodeMap, MAP_BYTES, tooBig } from "./mapFiles.ts";
import { decodePfSheetFile } from "./pfSheetFiles.ts";
import { decodeHero, decodeMonster, idOf, invalid } from "./sheetFiles.ts";
import { stageCatalog } from "./stageCatalog.ts";
import { checkWith, contentInvalid } from "./validate.ts";
import type { Checked, ContentInvalid } from "./validate.ts";

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

const MARKDOWN = /\.md$/iu;

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

const have = (kind: Kind, all: ReadonlyArray<Entry>) => {
	if (all.length === 0) {
		return `it has no ${kind === "map" ? ".txt" : ".yaml"} files`;
	}

	return `there are: ${all.map((e) => e.id).join(", ")}`;
};

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

const cardRefusal = (
	query: string,
	found: Found
): CardNotFound | CardAmbiguous =>
	"matches" in found && found.matches.length > 1
		? new CardAmbiguous({
				query,
				matches: [...found.matches],
				message: `"${query}" could be any of these cards: ${found.matches.join(", ")}`,
			})
		: new CardNotFound({
				query,
				message: `no card "${query}" in the campaign's scenes, npcs, handouts, items, ancestries, classes, abilities, party or monsters`,
			});

const markdownDocs = (
	fresh: ContentIndex,
	kind: SheetKind
): ReadonlyArray<SheetDoc> => (kind === "hero" ? fresh.party : fresh.monsters);

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
		readonly ffHero: (query: string) => Effect.Effect<FfSheet, LoadError>;
		readonly ffMonster: (query: string) => Effect.Effect<FfSheet, LoadError>;
		readonly index: Effect.Effect<ContentIndex>;
		readonly read: Effect.Effect<Checked>;
		readonly accept: (checked: Checked) => Effect.Effect<boolean>;
		readonly card: (
			query: string
		) => Effect.Effect<StageCard, CardNotFound | CardAmbiguous>;
		readonly cards: (
			keys: ReadonlyArray<string>
		) => Effect.Effect<ReadonlyArray<StageCard>>;
		readonly gmNotes: (key: string) => Effect.Effect<string | undefined>;
	}
>()("supervillain/content/CampaignContent") {
	static readonly make = Effect.fn("CampaignContent.make")(function* (
		dir: string
	) {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const config = yield* readCampaignConfig(dir);
		const files: Files = { fs, path };

		const fromDisk = indexWith(files, dir, config.rules).pipe(
			Effect.flatMap((fresh) => checkWith(files, fresh)),
			Effect.withSpan("CampaignContent.read")
		);

		const first = yield* fromDisk;

		if (first.problems.length > 0) {
			return yield* contentInvalid(dir, first.problems);
		}

		const snapshot = yield* Ref.make(first);
		const current = Ref.get(snapshot);
		const index = Effect.map(current, (checked) => checked.index);

		const accept = Effect.fn("CampaignContent.accept")(function* (
			checked: Checked
		) {
			if (checked.problems.length > 0) {
				return false;
			}

			yield* Ref.set(snapshot, checked);

			return true;
		});

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
			const fresh = yield* index;
			const seen = new Map<string, Entry>();

			const inOrder = EXTENSIONS[kind].flatMap((x) =>
				listed.filter((name) => x.test(name))
			);

			const markdown =
				kind === "map" ? [] : markdownDocs(fresh, kind).map((d) => d.file);

			for (const file of [
				...inOrder.map((name) => `${FOLDER[kind]}/${name}`),
				...markdown,
			]) {
				const id = idOf(file);

				if (!seen.has(id)) {
					seen.set(id, { id, file });
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

			if (info.type !== "File") {
				return yield* new MapInvalid({
					file,
					message: `${file} isn't a plain file.`,
				});
			}

			const big = tooBig(file, Number(info.size));

			if (big !== undefined) {
				return yield* big;
			}

			const bytes = yield* fs.readFile(full).pipe(Effect.mapError(unreadable));
			const grid = yield* decodeMap(file, id, bytes);
			const loaded: LoadedMap = { id, grid };

			return loaded;
		});

		const markdownDoc = Effect.fn("CampaignContent.markdownDoc")(function* (
			kind: SheetKind,
			entry: Entry
		) {
			const fresh = yield* index;
			const doc = markdownDocs(fresh, kind).find((d) => d.file === entry.file);

			if (doc === undefined) {
				return yield* invalid(entry.file, [
					"isn't in the campaign's last good files",
				]);
			}

			return { fresh, doc };
		});

		const yamlFile = Effect.fn("CampaignContent.yamlFile")(function* (
			entry: Entry
		) {
			const read = yield* readBounded(fs, path.join(dir, entry.file), MD_BYTES);
			const text = read.ok ? utf8Of(read.bytes) : undefined;

			if (text === undefined) {
				return yield* new ContentReadError({
					message: `can't read ${entry.file}: ${read.ok ? "it isn't UTF-8 text" : read.problem}`,
				});
			}

			return text;
		});

		const load =
			<A>(
				kind: SheetKind,
				decode: (file: string, text: string) => Effect.Effect<A, SheetInvalid>,
				rules: "draw-steel" | "pf2e" = "draw-steel"
			) =>
			(query: string) =>
				Effect.gen(function* () {
					const entry = yield* find(kind, yield* entries(kind), query);

					if (!MARKDOWN.test(entry.file)) {
						return yield* decode(entry.file, yield* yamlFile(entry));
					}

					const { fresh, doc } = yield* markdownDoc(kind, entry);

					return yield* decode(
						entry.file,
						yamlText(sheetFields(fresh, doc, rules))
					);
				}).pipe(Effect.withSpan(`CampaignContent.${kind}`));

		const loadFf = (kind: SheetKind) =>
			Effect.fn(`CampaignContent.ff.${kind}`)(function* (query: string) {
				const entry = yield* find(
					kind,
					(yield* entries(kind)).filter((e) => MARKDOWN.test(e.file)),
					query
				);

				const { doc } = yield* markdownDoc(kind, entry);
				const sheet = ffSheetOf(doc);

				if (sheet === undefined) {
					return yield* invalid(entry.file, [
						"isn't a freeform sheet: name it and give it stats like `stats: { might: 2 }`",
					]);
				}

				const problem = ffSheetProblem(sheet);

				return problem === undefined
					? sheet
					: yield* invalid(entry.file, [problem]);
			});

		const card = Effect.fn("CampaignContent.card")(function* (query: string) {
			const checked = yield* current;
			const found = findDoc(checked.index, query);

			if ("matches" in found) {
				return yield* cardRefusal(query, found);
			}

			const built = checked.cards.get(found.found.key);

			if (built === undefined) {
				return yield* cardRefusal(query, { matches: [] });
			}

			return built;
		});

		const cards = Effect.fn("CampaignContent.cards")(function* (
			keys: ReadonlyArray<string>
		) {
			const checked = yield* current;

			return keyedDocs(checked.index).flatMap((k) => {
				const built = keys.includes(k.key)
					? checked.cards.get(k.key)
					: undefined;

				return built === undefined ? [] : [built];
			});
		});

		const gmNotes = Effect.fn("CampaignContent.gmNotes")(function* (
			key: string
		) {
			return gmNotesFor(yield* index, key);
		});

		const bytesOf = (entry: Entry, maxBytes: number) =>
			Effect.map(
				readBounded(fs, path.join(dir, entry.file), maxBytes),
				(read) =>
					read.ok ? Option.some(read.bytes) : Option.none<Uint8Array>()
			);

		const named = (
			all: ReadonlyArray<Entry>,
			nameIn: (
				entry: Entry,
				bytes: Uint8Array
			) => Effect.Effect<string, SheetInvalid | MapInvalid>,
			maxBytes = MD_BYTES
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

		const sheetEntries = (
			fresh: ContentIndex,
			kind: SheetKind,
			all: ReadonlyArray<Entry>,
			yamlName: (
				e: Entry,
				bytes: Uint8Array
			) => Effect.Effect<string, SheetInvalid>
		) =>
			Effect.gen(function* () {
				const docs = markdownDocs(fresh, kind);

				const yaml = yield* named(
					all.filter((e) => !MARKDOWN.test(e.file)),
					yamlName
				);

				const markdown = all.flatMap((e): ReadonlyArray<PrepEntry> => {
					const doc = docs.find((d) => d.file === e.file);

					return doc === undefined ? [] : [{ id: e.id, name: doc.name }];
				});

				return [...yaml, ...markdown].toSorted((a, b) =>
					byId({ id: a.id, file: "" }, { id: b.id, file: "" })
				);
			});

		const catalog = Effect.gen(function* () {
			const fresh = yield* index;
			const heroes = yield* entries("hero");
			const monsters = yield* entries("monster");
			const { usable: maps } = yield* mapEntries();

			const listed: PrepCatalog = {
				heroes: yield* sheetEntries(fresh, "hero", heroes, (e, bytes) =>
					pf
						? pfName(e, bytes)
						: Effect.map(decodeHero(e.file, textOf(bytes)), (h) => h.name)
				),
				monsters: yield* sheetEntries(fresh, "monster", monsters, (e, bytes) =>
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
				...stageCatalog(fresh),
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
			pfHero: load("hero", decodePfSheetFile, "pf2e"),
			pfMonster: load("monster", decodePfSheetFile, "pf2e"),
			ffHero: loadFf("hero"),
			ffMonster: loadFf("monster"),
			index,
			read: fromDisk,
			accept,
			card,
			cards,
			gmNotes,
			maps: Effect.map(mapEntries(), ({ usable }) => ids(usable)),
			map,
			catalog,
		});
	});

	static readonly layer = (
		campaignDir: string
	): Layer.Layer<
		CampaignContent,
		CampaignConfigInvalid | ContentReadError | ContentInvalid,
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
