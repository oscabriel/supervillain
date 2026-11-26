import {
	cardProblem,
	ffSheetProblem,
	listIfDefined,
	orEmpty,
} from "@supervillain/domain";
import type {
	CardKind,
	RulesetName,
	SheetInvalid,
	StageCard,
} from "@supervillain/domain";
import { Effect, Predicate, Schema } from "effect";

import { readCampaignConfig } from "./campaignFile.ts";
import {
	artProblem,
	builtCard,
	ffSheetOf,
	keyedDocs,
	sheetFields,
	yamlText,
} from "./cards.ts";
import { filesOf, loadIndex } from "./ContentIndex.ts";
import type {
	ContentIndex,
	ContentProblem,
	Files,
	SheetDoc,
} from "./ContentIndex.ts";
import { FOLDERS } from "./kinds.ts";
import { decodePfSheetFile } from "./pfSheetFiles.ts";
import { decodeHero, decodeMonster } from "./sheetFiles.ts";

export class ContentInvalid extends Schema.TaggedError<ContentInvalid>()(
	"ContentInvalid",
	{
		dir: Schema.String,
		problems: Schema.Array(
			Schema.Struct({
				file: Schema.String,
				field: Schema.optionalKey(Schema.String),
				line: Schema.optionalKey(Schema.Int),
				message: Schema.String,
			})
		),
		message: Schema.String,
	}
) {}

export const problemLine = (p: ContentProblem): string => {
	const at = p.line === undefined ? p.file : `${p.file}:${p.line}`;

	return p.field === undefined
		? `${at}: ${p.message}`
		: `${at}: ${p.field} ${p.message}`;
};

export const contentInvalid = (
	dir: string,
	problems: ReadonlyArray<ContentProblem>
): ContentInvalid =>
	new ContentInvalid({
		dir,
		problems: [...problems],
		message: `${dir} has ${problems.length === 1 ? "a problem" : `${problems.length} problems`} in its campaign files:\n${problems.map((p) => `  ${problemLine(p)}`).join("\n")}`,
	});

type RefKind = CardKind | "map" | "art";

const FOLDER_OF: Readonly<Record<RefKind, string>> = {
	...FOLDERS,
	map: "maps",
	art: "art",
};

const EXT: Readonly<Record<RefKind, string>> = {
	scene: "md",
	npc: "md",
	handout: "md",
	item: "md",
	ancestry: "md",
	class: "md",
	ability: "md",
	party: "md",
	monster: "md",
	map: "txt",
	art: "txt",
};

const idsOf = (index: ContentIndex, kind: RefKind): ReadonlySet<string> => {
	switch (kind) {
		case "scene": {
			return new Set(index.scenes.map((d) => d.id));
		}

		case "npc": {
			return new Set(index.npcs.map((d) => d.id));
		}

		case "handout": {
			return new Set(index.handouts.map((d) => d.id));
		}

		case "item": {
			return new Set(index.items.map((d) => d.id));
		}

		case "ancestry": {
			return new Set(index.ancestries.map((d) => d.id));
		}

		case "class": {
			return new Set(index.classes.map((d) => d.id));
		}

		case "ability": {
			return new Set(index.abilities.map((d) => d.id));
		}

		case "party": {
			return new Set([...index.party.map((d) => d.id), ...index.legacyHeroes]);
		}

		case "monster": {
			return new Set([
				...index.monsters.map((d) => d.id),
				...index.legacyMonsters,
			]);
		}

		case "map": {
			return new Set(index.maps);
		}

		case "art": {
			return new Set(index.art);
		}

		default: {
			return new Set();
		}
	}
};

interface Ref {
	readonly file: string;
	readonly field: string;
	readonly kind: RefKind;
	readonly ids: ReadonlyArray<string>;
}

const one = (id: string | undefined): ReadonlyArray<string> =>
	id === undefined ? [] : [id];

const many = (
	ids: string | ReadonlyArray<string> | undefined
): ReadonlyArray<string> => {
	if (ids === undefined) {
		return [];
	}

	return Predicate.isString(ids) ? [ids] : ids;
};

const tableRefs = (index: ContentIndex): ReadonlyArray<Ref> =>
	listIfDefined(index.table, (table) => [
		{
			file: table.file,
			field: "start",
			kind: "scene" as const,
			ids: one(table.front.start),
		},
	]);

const refsOf = (index: ContentIndex): ReadonlyArray<Ref> => [
	...tableRefs(index),
	...index.scenes.flatMap((d): ReadonlyArray<Ref> => [
		{ file: d.file, field: "npcs", kind: "npc", ids: orEmpty(d.front.npcs) },
		{
			file: d.file,
			field: "handouts",
			kind: "handout",
			ids: orEmpty(d.front.handouts),
		},
		{
			file: d.file,
			field: "items",
			kind: "item",
			ids: orEmpty(d.front.items),
		},
		{ file: d.file, field: "map", kind: "map", ids: one(d.front.map) },
		{
			file: d.file,
			field: "encounter.map",
			kind: "map",
			ids: one(d.front.encounter?.map),
		},
		{
			file: d.file,
			field: "encounter.monsters",
			kind: "monster",
			ids: orEmpty(d.front.encounter?.monsters).map((m) => m.id),
		},
		{ file: d.file, field: "next", kind: "scene", ids: many(d.front.next) },
	]),
	...index.npcs.flatMap((d): ReadonlyArray<Ref> => [
		{
			file: d.file,
			field: "monster",
			kind: "monster",
			ids: one(d.front.monster),
		},
		{
			file: d.file,
			field: "portrait",
			kind: "art",
			ids: one(d.front.portrait),
		},
	]),
	...index.handouts.flatMap((d): ReadonlyArray<Ref> => [
		{ file: d.file, field: "map", kind: "map", ids: one(d.front.map) },
		{ file: d.file, field: "art", kind: "art", ids: one(d.front.art) },
	]),
	...[...index.party, ...index.monsters].flatMap((d): ReadonlyArray<Ref> => [
		{
			file: d.file,
			field: "ancestry",
			kind: "ancestry",
			ids: one(d.refs.ancestry),
		},
		{ file: d.file, field: "class", kind: "class", ids: one(d.refs.class) },
		{ file: d.file, field: "items", kind: "item", ids: d.refs.items },
		{
			file: d.file,
			field: "abilities",
			kind: "ability",
			ids: d.refs.abilities,
		},
		{
			file: d.file,
			field: "portrait",
			kind: "art",
			ids: one(d.refs.portrait),
		},
	]),
];

const trackerProblems = (
	index: ContentIndex
): ReadonlyArray<ContentProblem> => {
	const seen = new Map<string, string>();
	const problems: Array<ContentProblem> = [];

	for (const scene of index.scenes) {
		for (const t of orEmpty(scene.front.trackers)) {
			const other = seen.get(t.id);

			if (other !== undefined) {
				problems.push({
					file: scene.file,
					field: "trackers",
					message: `sets up ${t.id}, and so does ${other}; a tracker's id is the campaign's`,
				});
			}

			if (t.max !== undefined && t.value !== undefined && t.value > t.max) {
				problems.push({
					file: scene.file,
					field: "trackers",
					message: `starts ${t.id} at ${t.value}, past its most, ${t.max}`,
				});
			}

			seen.set(t.id, scene.file);
		}
	}

	return problems;
};

export const crossCheck = (
	index: ContentIndex
): ReadonlyArray<ContentProblem> => [
	...refsOf(index).flatMap((ref) => {
		const known = idsOf(index, ref.kind);

		return ref.ids
			.filter((id) => !known.has(id))
			.map((id) => ({
				file: ref.file,
				field: ref.field,
				message: `names ${id}, but there's no ${FOLDER_OF[ref.kind]}/${id}.${EXT[ref.kind]}`,
			}));
	}),
	...trackerProblems(index),
];

const sheetCheck = (
	rules: "draw-steel" | "pf2e",
	doc: SheetDoc,
	text: string
): Effect.Effect<void, SheetInvalid> => {
	if (rules === "pf2e") {
		return Effect.asVoid(decodePfSheetFile(doc.file, text));
	}

	return doc.kind === "party"
		? Effect.asVoid(decodeHero(doc.file, text))
		: Effect.asVoid(decodeMonster(doc.file, text));
};

const sheetProblems = Effect.fn("validate.sheetProblems")(function* (
	index: ContentIndex,
	doc: SheetDoc,
	rules: RulesetName
) {
	if (rules === "freeform") {
		const sheet = ffSheetOf(doc);

		const problem =
			sheet === undefined ? "isn't a freeform sheet" : ffSheetProblem(sheet);

		return problem === undefined ? [] : [{ file: doc.file, message: problem }];
	}

	if (rules !== "draw-steel" && rules !== "pf2e") {
		return [];
	}

	const text = yamlText(sheetFields(index, doc, rules));

	const decode = sheetCheck(rules, doc, text);

	return yield* decode.pipe(
		Effect.as<ReadonlyArray<ContentProblem>>([]),
		Effect.catchTag("SheetInvalid", (invalid) =>
			Effect.succeed<ReadonlyArray<ContentProblem>>(
				invalid.problems.map((message) => ({ file: doc.file, message }))
			)
		)
	);
});

export interface Checked {
	readonly index: ContentIndex;
	readonly cards: ReadonlyMap<string, StageCard>;
	readonly problems: ReadonlyArray<ContentProblem>;
}

export const checkWith = Effect.fn("validate.checkWith")(function* (
	files: Files,
	index: ContentIndex
) {
	const built = yield* Effect.forEach(
		keyedDocs(index),
		(keyed) =>
			builtCard(files, index, keyed.kind, keyed.doc).pipe(
				Effect.map(({ card, problems }) => {
					const problem =
						cardProblem(card) ??
						(card.art === undefined ? undefined : artProblem(card.art));

					const found: ReadonlyArray<ContentProblem> = [
						...problems.map((message) => ({ file: keyed.doc.file, message })),
						...listIfDefined(problem, (why) => [
							{
								file: keyed.doc.file,
								message: `can't be shown at the table: ${why}`,
							},
						]),
					];

					return { card, problems: found };
				})
			),
		{ concurrency: 8 }
	);

	const sheets = yield* Effect.forEach(
		[...index.party, ...index.monsters],
		(doc) => sheetProblems(index, doc, index.rules),
		{ concurrency: 8 }
	);

	const checked: Checked = {
		index,
		cards: new Map(built.map(({ card }) => [card.key, card] as const)),
		problems: [
			...index.problems,
			...crossCheck(index),
			...built.flatMap((b) => b.problems),
			...sheets.flat(),
		],
	};

	return checked;
});

const checkIndex = Effect.fn("validate.checkIndex")(function* (
	index: ContentIndex
) {
	return yield* checkWith(yield* filesOf, index);
});

export interface Validation {
	readonly rules: RulesetName;
	readonly index: ContentIndex;
	readonly problems: ReadonlyArray<ContentProblem>;
}

export const validateIndex = Effect.fn("validate.validateIndex")(function* (
	index: ContentIndex
) {
	return (yield* checkIndex(index)).problems;
});

export const validateCampaign = Effect.fn("validateCampaign")(function* (
	dir: string
) {
	const { rules } = yield* readCampaignConfig(dir);
	const index = yield* loadIndex(dir, rules);
	const problems = yield* validateIndex(index);
	const validation: Validation = { rules, index, problems };

	return validation;
});
