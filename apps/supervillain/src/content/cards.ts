import {
	ART_COLUMNS,
	ART_LINES,
	charsOf,
	ifDefined,
	isControl,
	listIfDefined,
} from "@supervillain/domain";
import type {
	CardKind,
	FfSheet,
	MapGrid,
	StageCard,
} from "@supervillain/domain";
import { Effect, Option, Predicate, Schema } from "effect";

import { readBounded, utf8Of } from "./bounded.ts";
import type {
	ContentIndex,
	Doc,
	Files,
	SheetDoc,
	YamlFields,
} from "./ContentIndex.ts";
import { docsOf } from "./ContentIndex.ts";
import { FreeformMonsterSchema, FreeformPartySchema } from "./frontmatter.ts";
import type { AbilityFrontSchema } from "./frontmatter.ts";
import { decodeMap, MAP_BYTES } from "./mapFiles.ts";
import {
	gmOnly,
	isReadAloud,
	normalized,
	playerSafe,
	readAloudOf,
} from "./markdown.ts";
import type { Sections } from "./markdown.ts";
import { proseOf } from "./prose.ts";
import { YamlValueSchema } from "./sheetFiles.ts";
import type { YamlValue } from "./sheetFiles.ts";

export const cardKey = (kind: CardKind, id: string): string => `${kind}:${id}`;

const TAB = /\t/gu;

const artLines = (text: string): ReadonlyArray<string> =>
	normalized(text)
		.replace(/\n+$/u, "")
		.split("\n")
		.map((line) =>
			charsOf(line.replaceAll(TAB, "    "))
				.filter((char) => !isControl(char.codePointAt(0) ?? 0))
				.join("")
				.trimEnd()
		);

export const artProblem = (lines: ReadonlyArray<string>): string | undefined =>
	lines.length > ART_LINES ||
	lines.some((line) => charsOf(line).length > ART_COLUMNS)
		? `art is at most ${ART_LINES} lines of ${ART_COLUMNS} columns`
		: undefined;

const ART_BYTES = 64 * 1024;

interface Part<A> {
	readonly value?: A;
	readonly problem?: string;
}

const NOTHING: Part<never> = {};

const readArt = Effect.fn("cards.readArt")(function* (
	{ fs, path }: Files,
	index: ContentIndex,
	id: string | undefined
) {
	if (id === undefined || !index.art.includes(id)) {
		return NOTHING;
	}

	const file = `art/${id}.txt`;
	const read = yield* readBounded(fs, path.join(index.dir, file), ART_BYTES);

	if (!read.ok) {
		return { problem: `${file} ${read.problem}` };
	}

	const text = utf8Of(read.bytes);

	const part: Part<ReadonlyArray<string>> =
		text === undefined
			? { problem: `${file} isn't UTF-8 text` }
			: { value: artLines(text) };

	return part;
});

const readGrid = Effect.fn("cards.readGrid")(function* (
	{ fs, path }: Files,
	index: ContentIndex,
	id: string | undefined
) {
	if (id === undefined || !index.maps.includes(id)) {
		return NOTHING;
	}

	const file = `maps/${id}.txt`;
	const read = yield* readBounded(fs, path.join(index.dir, file), MAP_BYTES);

	if (!read.ok) {
		return { problem: `${file} ${read.problem}` };
	}

	return yield* decodeMap(file, id, read.bytes).pipe(
		Effect.match({
			onFailure: (invalid): Part<MapGrid> => ({ problem: invalid.message }),
			onSuccess: (grid): Part<MapGrid> => ({ value: grid }),
		})
	);
});

export const bodyOf = (sections: Sections) =>
	proseOf(playerSafe(sections, isReadAloud));

const readAloud = (sections: Sections) => {
	const text = readAloudOf(sections);

	return text === undefined ? undefined : proseOf(text);
};

const gmNotesOf = (sections: Sections): string | undefined => {
	const text = gmOnly(sections);

	return text === "" ? undefined : text;
};

const stringOf = (value: YamlValue): string | undefined =>
	Predicate.isString(value) ? value : undefined;

const tagsOf = (value: YamlValue): ReadonlyArray<string> | undefined => {
	const tags = Array.isArray(value) ? value.filter(Predicate.isString) : [];

	return tags.length === 0 ? undefined : tags;
};

interface CardParts {
	readonly title: string;
	readonly subtitle?: string | undefined;
	readonly tags?: ReadonlyArray<string> | undefined;
	readonly art?: string | undefined;
	readonly map?: string | undefined;
}

const decodeFields = Schema.decodeUnknownOption(
	Schema.Record(Schema.String, YamlValueSchema)
);

const joined = (
	...parts: ReadonlyArray<string | undefined>
): string | undefined => {
	const kept = parts.filter((p): p is string => p !== undefined && p !== "");

	return kept.length === 0 ? undefined : kept.join(" · ");
};

const partsOf = (
	kind: CardKind,
	fields: YamlFields,
	fallback: string
): CardParts => {
	const name = stringOf(fields.name) ?? stringOf(fields.title) ?? fallback;
	const tags = tagsOf(fields.tags);

	switch (kind) {
		case "scene": {
			return {
				title: name,
				subtitle: stringOf(fields.summary),
				map: stringOf(fields.map),
			};
		}

		case "npc": {
			return {
				title: name,
				subtitle: joined(stringOf(fields.role), stringOf(fields.pronouns)),
				tags,
				art: stringOf(fields.portrait),
			};
		}

		case "handout": {
			return {
				title: name,
				subtitle: stringOf(fields.kind),
				art: stringOf(fields.art),
				map: stringOf(fields.map),
			};
		}

		case "party":
		case "monster": {
			return {
				title: name,
				subtitle: joined(
					stringOf(fields.concept),
					stringOf(fields.class),
					stringOf(fields.pronouns)
				),
				tags,
				art: stringOf(fields.portrait),
			};
		}

		case "item":
		case "ancestry":
		case "class":
		case "ability": {
			return { title: name, subtitle: stringOf(fields.summary), tags };
		}

		default: {
			return { title: name };
		}
	}
};

export interface BuiltCard {
	readonly card: StageCard;
	readonly problems: ReadonlyArray<string>;
}

export const builtCard = Effect.fn("cards.builtCard")(function* (
	files: Files,
	index: ContentIndex,
	kind: CardKind,
	doc: Doc<YamlFields>
) {
	const parts = partsOf(kind, doc.front, doc.id);
	const art = yield* readArt(files, index, parts.art);
	const map = yield* readGrid(files, index, parts.map);
	const spoken = readAloud(doc.sections);

	const card: StageCard = {
		key: cardKey(kind, doc.id),
		kind,
		title: parts.title,
		...ifDefined(parts.subtitle, (subtitle) => ({ subtitle })),
		...ifDefined(spoken, (value) => ({ readAloud: value })),
		body: bodyOf(doc.sections),
		...ifDefined(art.value, (value) => ({ art: value })),
		...ifDefined(map.value, (value) => ({ map: value })),
		...ifDefined(parts.tags, (tags) => ({ tags: [...tags] })),
	};

	const built: BuiltCard = {
		card,
		problems: [
			...listIfDefined(art.problem, (p) => [p]),
			...listIfDefined(map.problem, (p) => [p]),
		],
	};

	return built;
});

export const buildCard = Effect.fn("cards.buildCard")(function* (
	files: Files,
	index: ContentIndex,
	kind: CardKind,
	doc: Doc<YamlFields>
) {
	return (yield* builtCard(files, index, kind, doc)).card;
});

export interface Keyed {
	readonly key: string;
	readonly kind: CardKind;
	readonly doc: Doc<YamlFields>;
}

export const keyedDocs = (index: ContentIndex): ReadonlyArray<Keyed> =>
	docsOf(index).flatMap((doc) =>
		Option.match(decodeFields(doc.front), {
			onNone: () => [],
			onSome: (front) => [
				{
					key: cardKey(doc.kind, doc.id),
					kind: doc.kind,
					doc: { ...doc, front },
				},
			],
		})
	);

export type Found =
	| { readonly found: Keyed }
	| { readonly matches: ReadonlyArray<string> };

export const findDoc = (index: ContentIndex, query: string): Found => {
	const all = keyedDocs(index);
	const wanted = query.trim().toLowerCase();
	const exact = all.find((k) => k.key === wanted);

	if (exact !== undefined) {
		return { found: exact };
	}

	const byId = all.filter((k) => k.doc.id === wanted);
	const [onlyId] = byId;

	if (byId.length === 1 && onlyId !== undefined) {
		return { found: onlyId };
	}

	if (byId.length > 1) {
		return { matches: byId.map((k) => k.key) };
	}

	const begun =
		wanted === ""
			? []
			: all.filter(
					(k) => k.key.startsWith(wanted) || k.doc.id.startsWith(wanted)
				);

	const [only] = begun;

	return begun.length === 1 && only !== undefined
		? { found: only }
		: { matches: begun.map((k) => k.key) };
};

const decodeFfParty = Schema.decodeUnknownOption(FreeformPartySchema);

const decodeFfMonster = Schema.decodeUnknownOption(FreeformMonsterSchema);

export const ffSheetOf = (doc: SheetDoc): FfSheet | undefined => {
	const front = Option.getOrUndefined(
		doc.kind === "party" ? decodeFfParty(doc.front) : decodeFfMonster(doc.front)
	);

	if (front === undefined) {
		return undefined;
	}

	const notes = bodyOf(doc.sections);

	return {
		id: doc.id,
		name: front.name,
		...ifDefined(front.pronouns, (pronouns) => ({ pronouns })),
		...ifDefined(front.concept, (concept) => ({ concept })),
		...ifDefined(front.dice, (dice) => ({ dice })),
		...ifDefined(front.stats, (stats) => ({ stats })),
		...ifDefined(front.resources, (resources) => ({ resources })),
		...ifDefined(front.tags, (tags) => ({ tags: [...tags] })),
		...ifDefined(front.portrait, (portrait) => ({ portrait })),
		...ifDefined(notes.length === 0 ? undefined : notes, (value) => ({
			notes: value,
		})),
	};
};

type AbilityFront = typeof AbilityFrontSchema.Type;

const DS_ABILITY_KEYS = [
	"name",
	"kind",
	"characteristics",
	"bonus",
	"cost",
	"keywords",
	"distance",
	"target",
	"tier1",
	"tier2",
	"tier3",
	"effect",
] as const;

const PF_ABILITY_KEYS = ["name", "actions", "traits", "text"] as const;

const picked = (
	front: AbilityFront,
	keys: ReadonlyArray<keyof AbilityFront>
): YamlFields =>
	Object.fromEntries(
		keys.flatMap((key): ReadonlyArray<readonly [string, YamlValue]> => {
			const value = front[key];

			return value === undefined ? [] : [[key, value]];
		})
	);

const abilityFields = (
	front: AbilityFront,
	rules: "draw-steel" | "pf2e"
): YamlFields => {
	if (rules === "draw-steel") {
		return picked(front, DS_ABILITY_KEYS);
	}

	const fields = picked(front, PF_ABILITY_KEYS);

	return front.text === undefined && front.summary !== undefined
		? { ...fields, text: front.summary }
		: fields;
};

const STRIPPED: Readonly<Record<"draw-steel" | "pf2e", ReadonlyArray<string>>> =
	{
		"draw-steel": ["ancestry", "items", "portrait"],
		pf2e: ["items", "portrait"],
	};

export const sheetFields = (
	index: ContentIndex,
	doc: SheetDoc,
	rules: "draw-steel" | "pf2e"
): YamlFields => {
	const kept: YamlFields = Object.fromEntries(
		Object.entries(doc.front).filter(([key]) => !STRIPPED[rules].includes(key))
	);

	const listed = kept.abilities;

	const abilities = isList(listed)
		? listed.flatMap((entry): ReadonlyArray<YamlValue> => {
				if (!Predicate.isString(entry)) {
					return [entry];
				}

				const found = index.abilities.find((a) => a.id === entry);

				return listIfDefined(found, (a) => [abilityFields(a.front, rules)]);
			})
		: undefined;

	return abilities === undefined ? kept : { ...kept, abilities };
};

const isList = (value: YamlValue): value is ReadonlyArray<YamlValue> =>
	Array.isArray(value);

const toJson = Schema.decodeUnknownOption(Schema.Json);

const jsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

export const yamlText = (fields: YamlFields): string =>
	Option.match(toJson(fields), {
		onNone: () => "{}",
		onSome: (json) => jsonText(json),
	});

export const gmNotesFor = (
	index: ContentIndex,
	key: string
): string | undefined => {
	const found = keyedDocs(index).find((k) => k.key === key);

	return found === undefined ? undefined : gmNotesOf(found.doc.sections);
};
