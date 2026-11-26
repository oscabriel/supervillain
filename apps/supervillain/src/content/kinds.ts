import type { CardKind, RulesetName } from "@supervillain/domain";
import type { Schema } from "effect";

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

export const MD_BYTES = 64 * 1024;

export const DOC_KINDS = [
	"scene",
	"npc",
	"handout",
	"item",
	"ancestry",
	"class",
	"ability",
	"party",
	"monster",
] as const satisfies ReadonlyArray<CardKind>;

export type DocKind = (typeof DOC_KINDS)[number];

export const FOLDERS = {
	scene: "scenes",
	npc: "npcs",
	handout: "handouts",
	item: "items",
	ancestry: "ancestries",
	class: "classes",
	ability: "abilities",
	party: "party",
	monster: "monsters",
} as const satisfies Record<DocKind, string>;

export const TABLE_FILE = "table.md";

export type SchemaKind = DocKind | "table";

export const schemaFor = (
	kind: SchemaKind,
	rules: RulesetName
): Schema.Codec<unknown, unknown> => {
	switch (kind) {
		case "table": {
			return TableFrontSchema;
		}

		case "scene": {
			return SceneFrontSchema;
		}

		case "npc": {
			return NpcFrontSchema;
		}

		case "handout": {
			return HandoutFrontSchema;
		}

		case "item": {
			return ItemFrontSchema;
		}

		case "ancestry": {
			return AncestryFrontSchema;
		}

		case "class": {
			return ClassFrontSchema;
		}

		case "ability": {
			return AbilityFrontSchema;
		}

		case "party": {
			return partySchemaFor(rules);
		}

		case "monster": {
			return monsterSchemaFor(rules);
		}

		default: {
			return TableFrontSchema;
		}
	}
};

export const globOf = (kind: SchemaKind): string =>
	kind === "table" ? TABLE_FILE : `${FOLDERS[kind]}/*.md`;
