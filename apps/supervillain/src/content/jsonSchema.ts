import type { RulesetName } from "@supervillain/domain";
import { JsonSchema, Schema } from "effect";

import { DOC_KINDS, globOf, schemaFor } from "./kinds.ts";
import type { SchemaKind } from "./kinds.ts";

export type Draft = "2020-12" | "07";

export const SCHEMA_KINDS: ReadonlyArray<SchemaKind> = ["table", ...DOC_KINDS];

export interface SchemaFile {
	readonly file: string;
	readonly text: string;
}

const fileOf = (kind: SchemaKind) => `${kind}.schema.json`;

const withDefinitions = (
	base: JsonSchema.JsonSchema,
	key: string,
	definitions: JsonSchema.Definitions
): JsonSchema.JsonSchema =>
	Object.keys(definitions).length === 0
		? base
		: { ...base, [key]: definitions };

const documentOf = (
	kind: SchemaKind,
	rules: RulesetName,
	draft: Draft
): JsonSchema.JsonSchema => {
	const document = Schema.toJsonSchemaDocument(schemaFor(kind, rules), {
		onExcessProperty: "error",
	});

	if (draft === "07") {
		const older = JsonSchema.toDocumentDraft07(document);

		return withDefinitions(
			{
				$schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
				$id: fileOf(kind),
				...older.schema,
			},
			"definitions",
			older.definitions
		);
	}

	return withDefinitions(
		{
			$schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
			$id: fileOf(kind),
			...document.schema,
		},
		"$defs",
		document.definitions
	);
};

const pretty = (value: JsonSchema.JsonSchema): string =>
	`${JSON.stringify(value, null, 2)}\n`;

export const schemaFiles = (
	rules: RulesetName,
	draft: Draft
): ReadonlyArray<SchemaFile> => [
	...SCHEMA_KINDS.map((kind) => ({
		file: fileOf(kind),
		text: pretty(documentOf(kind, rules, draft)),
	})),
	{
		file: "index.json",
		text: pretty({
			rules,
			draft,
			schemas: Object.fromEntries(
				SCHEMA_KINDS.map((kind) => [globOf(kind), fileOf(kind)])
			),
		}),
	},
];
