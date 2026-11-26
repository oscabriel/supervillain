import { ID, ifDefined } from "@supervillain/domain";
import type { RulesetName } from "@supervillain/domain";
import {
	Effect,
	FileSystem,
	Option,
	Path,
	Predicate,
	Result,
	Schema,
} from "effect";
import type { SchemaIssue } from "effect";

import { readBounded, utf8Of } from "./bounded.ts";
import type { Files } from "./bounded.ts";
import {
	AbilityFrontSchema,
	AncestryFrontSchema,
	ClassFrontSchema,
	HandoutFrontSchema,
	ItemFrontSchema,
	monsterSchemaFor,
	NpcFrontSchema,
	partySchemaFor,
	SceneFrontSchema,
	TableFrontSchema,
} from "./frontmatter.ts";
import { FOLDERS, MD_BYTES, TABLE_FILE } from "./kinds.ts";
import type { DocKind, SchemaKind } from "./kinds.ts";
import { sectionsOf, splitFrontmatter } from "./markdown.ts";
import type { Sections } from "./markdown.ts";
import {
	fieldPath,
	formatIssues,
	idOf,
	YamlValueSchema,
} from "./sheetFiles.ts";
import type { YamlValue } from "./sheetFiles.ts";

export type { Files } from "./bounded.ts";

export const filesOf = Effect.gen(function* () {
	const files: Files = {
		fs: yield* FileSystem.FileSystem,
		path: yield* Path.Path,
	};

	return files;
});

export interface ContentProblem {
	readonly file: string;
	readonly field?: string;
	readonly line?: number;
	readonly message: string;
}

export interface Doc<F> {
	readonly kind: SchemaKind;
	readonly id: string;
	readonly file: string;
	readonly front: F;
	readonly sections: Sections;
	readonly bodyLine: number;
}

export type YamlFields = Readonly<Record<string, YamlValue>>;

export type TableDoc = Doc<typeof TableFrontSchema.Type>;

export type SceneDoc = Doc<typeof SceneFrontSchema.Type>;

export type NpcDoc = Doc<typeof NpcFrontSchema.Type>;

export type HandoutDoc = Doc<typeof HandoutFrontSchema.Type>;

export type ItemDoc = Doc<typeof ItemFrontSchema.Type>;

export type AncestryDoc = Doc<typeof AncestryFrontSchema.Type>;

export type ClassDoc = Doc<typeof ClassFrontSchema.Type>;

export type AbilityDoc = Doc<typeof AbilityFrontSchema.Type>;

export interface SheetRefs {
	readonly ancestry?: string;
	readonly class?: string;
	readonly items: ReadonlyArray<string>;
	readonly abilities: ReadonlyArray<string>;
	readonly portrait?: string;
}

export interface SheetDoc extends Doc<YamlFields> {
	readonly name: string;
	readonly refs: SheetRefs;
}

export interface ContentIndex {
	readonly dir: string;
	readonly rules: RulesetName;
	readonly table?: TableDoc;
	readonly scenes: ReadonlyArray<SceneDoc>;
	readonly npcs: ReadonlyArray<NpcDoc>;
	readonly handouts: ReadonlyArray<HandoutDoc>;
	readonly items: ReadonlyArray<ItemDoc>;
	readonly ancestries: ReadonlyArray<AncestryDoc>;
	readonly classes: ReadonlyArray<ClassDoc>;
	readonly abilities: ReadonlyArray<AbilityDoc>;
	readonly party: ReadonlyArray<SheetDoc>;
	readonly monsters: ReadonlyArray<SheetDoc>;
	readonly legacyHeroes: ReadonlyArray<string>;
	readonly legacyMonsters: ReadonlyArray<string>;
	readonly maps: ReadonlyArray<string>;
	readonly art: ReadonlyArray<string>;
	readonly problems: ReadonlyArray<ContentProblem>;
}

interface Read {
	readonly file: string;
	readonly id: string;
	readonly yaml: YamlFields;
	readonly sections: Sections;
	readonly bodyLine: number;
}

type ReadResult =
	| { readonly ok: true; readonly read: Read }
	| { readonly ok: false; readonly problems: ReadonlyArray<ContentProblem> };

const failed = (...problems: ReadonlyArray<ContentProblem>): ReadResult => ({
	ok: false,
	problems,
});

const decodeYaml = Schema.decodeUnknownOption(YamlValueSchema);

const decodeFields = Schema.decodeUnknownOption(
	Schema.Record(Schema.String, YamlValueSchema)
);

const parseYaml = (source: string): Option.Option<YamlValue> => {
	try {
		return decodeYaml(Bun.YAML.parse(source));
	} catch {
		return Option.none();
	}
};

const yamlProblem = (source: string): string => {
	try {
		Bun.YAML.parse(source);

		return "its fields aren't YAML";
	} catch (error) {
		return `its fields aren't YAML (${(Predicate.isError(error) ? error.message : String(error)).replace(/^YAML Parse error: /u, "")})`;
	}
};

const issueProblems = (
	file: string,
	issue: SchemaIssue.Issue
): ReadonlyArray<ContentProblem> =>
	formatIssues(issue).issues.map(({ path = [], message }) => ({
		file,
		...ifDefined(path.length === 0 ? undefined : fieldPath(path), (field) => ({
			field,
		})),
		message,
	}));

export const fieldsOf = (file: string, text: string): ReadResult => {
	const split = splitFrontmatter(text);

	if ("problem" in split) {
		return failed({
			file,
			...ifDefined(split.line, (line) => ({ line })),
			message: split.problem,
		});
	}

	const parsed = parseYaml(split.yaml);

	if (Option.isNone(parsed)) {
		return failed({ file, line: 2, message: yamlProblem(split.yaml) });
	}

	const { value } = parsed;

	const mapping = Array.isArray(value) ? undefined : value;

	const fields = Predicate.isNullish(value)
		? Option.some({})
		: decodeFields(mapping);

	if (Option.isNone(fields)) {
		return failed({
			file,
			line: 2,
			message:
				"its fields must be a list like `title: The Market`, one per line",
		});
	}

	return {
		ok: true,
		read: {
			file,
			id: idOf(file),
			yaml: fields.value,
			sections: sectionsOf(split.body, split.bodyLine),
			bodyLine: split.bodyLine,
		},
	};
};

const readMd = Effect.fn("ContentIndex.readMd")(function* (
	{ fs, path }: Files,
	dir: string,
	file: string
) {
	const read = yield* readBounded(fs, path.join(dir, file), MD_BYTES);

	if (!read.ok) {
		return failed({ file, message: read.problem });
	}

	const text = utf8Of(read.bytes);

	return text === undefined
		? failed({ file, message: "can't be read as UTF-8 text" })
		: fieldsOf(file, text);
});

const bodyProblems = (read: Read): ReadonlyArray<ContentProblem> =>
	read.sections.problems.map((p) => ({
		file: read.file,
		line: p.line,
		message: p.message,
	}));

const listFiles = Effect.fn("ContentIndex.listFiles")(function* (
	{ fs, path }: Files,
	dir: string,
	folder: string,
	extension: RegExp
) {
	const found = yield* fs
		.readDirectoryEntries(path.join(dir, folder))
		.pipe(Effect.orElseSucceed(() => []));

	return found
		.filter(
			(entry) =>
				entry.type !== "Directory" &&
				!entry.name.startsWith(".") &&
				extension.test(entry.name)
		)
		.map((entry) => entry.name)
		.toSorted();
});

const MD = /\.md$/iu;

const YAML = /\.ya?ml$/iu;

const TXT = /\.txt$/iu;

const decoded = <A>(
	schema: Schema.Decoder<A>,
	read: Read
): { readonly front?: A; readonly problems: ReadonlyArray<ContentProblem> } => {
	const result = Schema.decodeResult(schema)(read.yaml, {
		errors: "all",
		onExcessProperty: "error",
	});

	return Result.isFailure(result)
		? { problems: issueProblems(read.file, result.failure.issue) }
		: { front: result.success, problems: [] };
};

const idProblems = (read: Read): ReadonlyArray<ContentProblem> =>
	ID.test(read.id)
		? []
		: [
				{
					file: read.file,
					message:
						"its name is its id, so it must be lower-case letters, digits and hyphens, at most 40, then .md",
				},
			];

const stringOf = (value: YamlValue): string | undefined =>
	Predicate.isString(value) ? value : undefined;

const stringsOf = (value: YamlValue): ReadonlyArray<string> =>
	Array.isArray(value) ? value.filter(Predicate.isString) : [];

const refsOf = (yaml: YamlFields, rules: RulesetName): SheetRefs => {
	const soft = rules === "draw-steel" || rules === "pf2e";
	const ancestry = rules === "pf2e" ? undefined : stringOf(yaml.ancestry);
	const klass = soft ? undefined : stringOf(yaml.class);
	const portrait = stringOf(yaml.portrait);

	return {
		...ifDefined(ancestry, (value) => ({ ancestry: value })),
		...ifDefined(klass, (value) => ({ class: value })),
		items: stringsOf(yaml.items),
		abilities: stringsOf(yaml.abilities),
		...ifDefined(portrait, (value) => ({ portrait: value })),
	};
};

interface Loaded<A> {
	readonly docs: ReadonlyArray<A>;
	readonly problems: ReadonlyArray<ContentProblem>;
}

const loadKind = <F, A>(
	files: Files,
	dir: string,
	kind: DocKind,
	schema: Schema.Decoder<F>,
	build: (read: Read, front: F) => A
): Effect.Effect<Loaded<A>> =>
	Effect.gen(function* () {
		const folder = FOLDERS[kind];
		const names = yield* listFiles(files, dir, folder, MD);

		const results = yield* Effect.forEach(
			names,
			(name) => readMd(files, dir, `${folder}/${name}`),
			{ concurrency: 8 }
		);

		const docs: Array<A> = [];
		const problems: Array<ContentProblem> = [];

		for (const result of results) {
			if (!result.ok) {
				problems.push(...result.problems);
				continue;
			}

			const { read } = result;
			const { front, problems: found } = decoded(schema, read);
			problems.push(...idProblems(read), ...found, ...bodyProblems(read));

			if (front !== undefined && found.length === 0 && ID.test(read.id)) {
				docs.push(build(read, front));
			}
		}

		const loaded: Loaded<A> = { docs, problems };

		return loaded;
	}).pipe(Effect.withSpan("ContentIndex.loadKind"));

const docOf =
	(kind: SchemaKind) =>
	<F>(read: Read, front: F): Doc<F> => ({
		kind,
		id: read.id,
		file: read.file,
		front,
		sections: read.sections,
		bodyLine: read.bodyLine,
	});

const sheetDocOf =
	(kind: "party" | "monster", rules: RulesetName) =>
	(read: Read): SheetDoc => ({
		kind,
		id: read.id,
		file: read.file,
		front: read.yaml,
		sections: read.sections,
		bodyLine: read.bodyLine,
		name: stringOf(read.yaml.name) ?? read.id,
		refs: refsOf(read.yaml, rules),
	});

interface TableLoad {
	readonly table?: TableDoc;
	readonly problems: ReadonlyArray<ContentProblem>;
}

const tableLoad = (
	table: TableDoc | undefined,
	problems: ReadonlyArray<ContentProblem>
): TableLoad => (table === undefined ? { problems } : { table, problems });

const NO_TABLE: TableLoad = { problems: [] };

const loadTable = Effect.fn("ContentIndex.loadTable")(function* (
	files: Files,
	dir: string
) {
	const { fs, path } = files;

	const there = yield* fs
		.exists(path.join(dir, TABLE_FILE))
		.pipe(Effect.orElseSucceed(() => false));

	if (!there) {
		return NO_TABLE;
	}

	const result = yield* readMd(files, dir, TABLE_FILE);

	if (!result.ok) {
		return tableLoad(undefined, result.problems);
	}

	const { front, problems } = decoded(TableFrontSchema, result.read);

	return tableLoad(
		front === undefined ? undefined : docOf("table")(result.read, front),
		[...problems, ...bodyProblems(result.read)]
	);
});

const ids = (names: ReadonlyArray<string>): ReadonlyArray<string> =>
	[...new Set(names.map(idOf))].toSorted();

const duplicates = (
	legacy: ReadonlyArray<string>,
	folder: string,
	docs: ReadonlyArray<SheetDoc>
): ReadonlyArray<ContentProblem> =>
	docs.flatMap((d) =>
		legacy.includes(d.id)
			? [
					{
						file: d.file,
						message: `has the id ${d.id}, and so does ${folder}/${d.id}.yaml; an id names one sheet`,
					},
				]
			: []
	);

const sheetSchema = (
	schema: Schema.Decoder<unknown>
): Schema.Decoder<unknown> => schema;

export const indexWith = Effect.fn("ContentIndex.indexWith")(function* (
	files: Files,
	dir: string,
	rules: RulesetName
) {
	const table = yield* loadTable(files, dir);

	const [
		scenes,
		npcs,
		handouts,
		items,
		ancestries,
		classes,
		abilities,
		party,
		monsters,
	] = yield* Effect.all(
		[
			loadKind(files, dir, "scene", SceneFrontSchema, docOf("scene")),
			loadKind(files, dir, "npc", NpcFrontSchema, docOf("npc")),
			loadKind(files, dir, "handout", HandoutFrontSchema, docOf("handout")),
			loadKind(files, dir, "item", ItemFrontSchema, docOf("item")),
			loadKind(files, dir, "ancestry", AncestryFrontSchema, docOf("ancestry")),
			loadKind(files, dir, "class", ClassFrontSchema, docOf("class")),
			loadKind(files, dir, "ability", AbilityFrontSchema, docOf("ability")),
			loadKind(
				files,
				dir,
				"party",
				sheetSchema(partySchemaFor(rules)),
				sheetDocOf("party", rules)
			),
			loadKind(
				files,
				dir,
				"monster",
				sheetSchema(monsterSchemaFor(rules)),
				sheetDocOf("monster", rules)
			),
		],
		{ concurrency: 8 }
	);

	const legacyHeroes = ids(yield* listFiles(files, dir, "heroes", YAML));
	const legacyMonsters = ids(yield* listFiles(files, dir, "monsters", YAML));
	const maps = ids(yield* listFiles(files, dir, "maps", TXT));
	const art = ids(yield* listFiles(files, dir, "art", TXT));

	const all = [scenes, npcs, handouts, items, ancestries, classes, abilities];

	const index: ContentIndex = {
		dir,
		rules,
		...ifDefined(table.table, (value) => ({ table: value })),
		scenes: scenes.docs,
		npcs: npcs.docs,
		handouts: handouts.docs,
		items: items.docs,
		ancestries: ancestries.docs,
		classes: classes.docs,
		abilities: abilities.docs,
		party: party.docs,
		monsters: monsters.docs,
		legacyHeroes,
		legacyMonsters,
		maps,
		art,
		problems: [
			...table.problems,
			...all.flatMap((loaded) => loaded.problems),
			...party.problems,
			...monsters.problems,
			...duplicates(legacyHeroes, "heroes", party.docs),
			...duplicates(legacyMonsters, "monsters", monsters.docs),
		],
	};

	return index;
});

export const loadIndex = Effect.fn("ContentIndex.loadIndex")(function* (
	dir: string,
	rules: RulesetName
) {
	return yield* indexWith(yield* filesOf, dir, rules);
});

export const docsOf = (
	index: ContentIndex
): ReadonlyArray<Doc<unknown> & { readonly kind: DocKind }> => [
	...index.scenes.map((d) => ({ ...d, kind: "scene" as const })),
	...index.npcs.map((d) => ({ ...d, kind: "npc" as const })),
	...index.handouts.map((d) => ({ ...d, kind: "handout" as const })),
	...index.items.map((d) => ({ ...d, kind: "item" as const })),
	...index.ancestries.map((d) => ({ ...d, kind: "ancestry" as const })),
	...index.classes.map((d) => ({ ...d, kind: "class" as const })),
	...index.abilities.map((d) => ({ ...d, kind: "ability" as const })),
	...index.party.map((d) => ({ ...d, kind: "party" as const })),
	...index.monsters.map((d) => ({ ...d, kind: "monster" as const })),
];
