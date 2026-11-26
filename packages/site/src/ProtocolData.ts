import {
	commandInputFields,
	commandsFor,
	CORE_COMMANDS,
	hostFactKeysOf,
	STAGE_COMMANDS,
} from "@supervillain/domain";
import type { RulesetName, TableSpec } from "@supervillain/domain";
import { Option, Schema } from "effect";
import type { JsonSchema } from "effect";

import { ALL_RULESETS, RULESET_LABELS } from "./ProtocolTypes.ts";
import type {
	CampaignSchemaDoc,
	CatalogToolEntry,
	CommandDoc,
	CommandScope,
	McpCatalogDocument,
	MetaToolDoc,
	ParamEntry,
	ProtocolRole,
	ProtocolSnapshot,
	ResourceDoc,
} from "./ProtocolTypes.ts";

export { ALL_RULESETS, RULESET_LABELS };

export type {
	CampaignSchemaDoc,
	CatalogToolEntry,
	CommandDoc,
	CommandScope,
	McpCatalogDocument,
	MetaToolDoc,
	ParamEntry,
	ProtocolRole,
	ProtocolSnapshot,
	ResourceDoc,
};

const CORE_TAGS: ReadonlySet<string> = new Set(
	CORE_COMMANDS.map((cmd) => cmd.tag)
);

const STAGE_TAGS: ReadonlySet<string> = new Set(
	STAGE_COMMANDS.map((cmd) => cmd.tag)
);

const TOOL_NAME = /[^A-Za-z0-9_-]/gu;

const TOOL_NAME_MAX = 64;

const toToolName = (type: string): string =>
	`cmd_${type}`.replaceAll(TOOL_NAME, "_").slice(0, TOOL_NAME_MAX);

const JsonSchemaNode = Schema.Record(Schema.String, Schema.Json);

const decodeNode = Schema.decodeUnknownOption(JsonSchemaNode);

const decodeProps = Schema.decodeUnknownOption(
	Schema.Record(Schema.String, JsonSchemaNode)
);

const decodeNodes = Schema.decodeUnknownOption(Schema.Array(JsonSchemaNode));

const decodeStrings = Schema.decodeUnknownOption(Schema.Array(Schema.String));

const decodeString = Schema.decodeUnknownOption(Schema.String);

const decodeFinite = Schema.decodeUnknownOption(Schema.Finite);

const formatNodeType = (obj: Schema.JsonObject): string => {
	const enumValues = Option.getOrUndefined(decodeStrings(obj.enum));

	if (enumValues !== undefined && enumValues.length > 0) {
		return enumValues.map((v) => `"${v}"`).join(" | ");
	}

	const constVal = Option.getOrUndefined(decodeString(obj.const));

	if (constVal !== undefined) {
		return `"${constVal}"`;
	}

	const anyOf = Option.getOrUndefined(decodeNodes(obj.anyOf));

	if (anyOf !== undefined && anyOf.length > 0) {
		return anyOf.map(formatNodeType).join(" | ");
	}

	const oneOf = Option.getOrUndefined(decodeNodes(obj.oneOf));

	if (oneOf !== undefined && oneOf.length > 0) {
		return oneOf.map(formatNodeType).join(" | ");
	}

	const base = Option.getOrUndefined(decodeString(obj.type));

	if (base === "array") {
		const itemNode = Option.getOrUndefined(decodeNode(obj.items));

		return `${itemNode === undefined ? "unknown" : formatNodeType(itemNode)}[]`;
	}

	if (base === "integer" || base === "number") {
		const min = Option.getOrUndefined(decodeFinite(obj.minimum));
		const max = Option.getOrUndefined(decodeFinite(obj.maximum));

		if (min !== undefined && max !== undefined) {
			return `${base} (${min}..${max})`;
		}

		if (min !== undefined) {
			return `${base} (>= ${min})`;
		}

		if (max !== undefined) {
			return `${base} (<= ${max})`;
		}
	}

	if (base !== undefined) {
		return base;
	}

	const ref = Option.getOrUndefined(decodeString(obj.$ref));

	if (ref !== undefined) {
		return ref.split("/").at(-1) ?? "object";
	}

	return "object";
};

const extractParams = (
	schema: JsonSchema.JsonSchema
): ReadonlyArray<ParamEntry> => {
	const props = Option.getOrElse(decodeProps(schema.properties), () => ({}));

	const required = new Set(
		Option.getOrElse(decodeStrings(schema.required), () => [])
	);

	return Object.entries(props).map(([name, obj]) => ({
		name,
		type: formatNodeType(obj),
		required: required.has(name),
		description: Option.getOrElse(decodeString(obj.description), () => ""),
	}));
};

const withDefs = (
	base: JsonSchema.JsonSchema,
	definitions: JsonSchema.Definitions
): JsonSchema.JsonSchema =>
	Object.keys(definitions).length === 0
		? base
		: { ...base, $defs: definitions };

const EMPTY_INPUT: JsonSchema.JsonSchema = {
	type: "object",
	properties: {},
	additionalProperties: false,
};

const schemaFromFields = (
	fields: Schema.Struct.Fields
): JsonSchema.JsonSchema => {
	if (Object.keys(fields).length === 0) {
		return EMPTY_INPUT;
	}

	const { schema, definitions } = Schema.toJsonSchemaDocument(
		Schema.Struct(fields),
		{ onExcessProperty: "error", generateDescriptions: true }
	);

	const base: JsonSchema.JsonSchema = {
		...schema,
		type: "object",
		properties: Option.getOrElse(decodeProps(schema.properties), () => ({})),
		required: Option.getOrElse(decodeStrings(schema.required), () => []),
		additionalProperties: false,
	};

	return withDefs(base, definitions);
};

const scopeOf = (type: string): CommandScope => {
	if (CORE_TAGS.has(type)) {
		return "core";
	}

	return STAGE_TAGS.has(type) ? "stage" : "ruleset";
};

const commandDocOf = (spec: TableSpec): CommandDoc | undefined => {
	const fields = commandInputFields(spec.type);

	if (fields === undefined) {
		return undefined;
	}

	const inputSchema = schemaFromFields(fields);

	return {
		type: spec.type,
		toolName: toToolName(spec.type),
		usage: spec.usage,
		summary: spec.summary,
		gmOnly: spec.gmOnly,
		scope: scopeOf(spec.type),
		hostFacts: hostFactKeysOf(spec.type),
		params: extractParams(inputSchema),
		inputSchema,
		jsonSchema: JSON.stringify(inputSchema, null, 2),
	};
};

const COMMAND_CACHE = new Map<RulesetName, ReadonlyArray<CommandDoc>>();

export const commandCatalog = (
	ruleset: RulesetName
): ReadonlyArray<CommandDoc> => {
	const cached = COMMAND_CACHE.get(ruleset);

	if (cached !== undefined) {
		return cached;
	}

	const built = commandsFor(ruleset).flatMap((spec) => {
		const doc = commandDocOf(spec);

		return doc === undefined ? [] : [doc];
	});

	COMMAND_CACHE.set(ruleset, built);

	return built;
};

const metaTool = (
	name: string,
	description: string,
	fields: Schema.Struct.Fields,
	flags: {
		readonly gmOnly: boolean;
		readonly readOnly: boolean;
		readonly destructive: boolean;
		readonly rulesets?: ReadonlyArray<RulesetName>;
	}
): MetaToolDoc => {
	const inputSchema = schemaFromFields(fields);

	return {
		name,
		description,
		gmOnly: flags.gmOnly,
		readOnly: flags.readOnly,
		destructive: flags.destructive,
		rulesets: flags.rulesets ?? ALL_RULESETS,
		params: extractParams(inputSchema),
		inputSchema,
		jsonSchema: JSON.stringify(inputSchema, null, 2),
	};
};

const BATCH_STEP = Schema.Struct({
	type: Schema.String.annotate({
		description: "Command type name (without leading slash or cmd_ prefix).",
	}),
	args: Schema.optionalKey(Schema.JsonObject),
});

export const META_TOOLS: ReadonlyArray<MetaToolDoc> = [
	metaTool(
		"get_table_state",
		"Returns what your seat sees right now as JSON: seq, your name, present seats, party, stage, combat band, map, and recent feed lines.",
		{
			feed_limit: Schema.optionalKey(
				Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 200 }))
			),
		},
		{ gmOnly: false, readOnly: true, destructive: false }
	),
	metaTool(
		"wait_for_change",
		"Blocks until the table moves past after_seq, then returns the new feed lines. Times out after timeout_ms (at most 30000 ms).",
		{
			after_seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
			timeout_ms: Schema.optionalKey(
				Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30_000 }))
			),
		},
		{ gmOnly: false, readOnly: true, destructive: false }
	),
	metaTool(
		"send_line",
		"Sends one line at the table exactly as typed at a seat: chat, an emote, or a /command. Prefer typed cmd_* tools for structured commands.",
		{
			line: Schema.String.check(Schema.isMaxLength(2000)),
		},
		{ gmOnly: false, readOnly: false, destructive: false }
	),
	metaTool(
		"help",
		"Lists every command this campaign's rules accept, or detailed help for one topic.",
		{
			topic: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
		},
		{ gmOnly: false, readOnly: true, destructive: false }
	),
	metaTool(
		"batch_commands",
		"Runs up to 32 table commands in sequence. Each accepted step logs its own entry so /undo reverses one step at a time.",
		{
			commands: Schema.Array(BATCH_STEP).check(Schema.isMaxLength(32)),
			stop_on_refusal: Schema.optionalKey(Schema.Boolean),
		},
		{ gmOnly: true, readOnly: false, destructive: true }
	),
	metaTool(
		"reload_content",
		"Re-reads campaign Markdown files, sheets, and maps from disk and reports any validation problems.",
		{},
		{ gmOnly: true, readOnly: false, destructive: false }
	),
	metaTool(
		"validate_content",
		"Validates campaign Markdown frontmatter, sheets, and cross-references the way supervillain check does without changing the table.",
		{},
		{ gmOnly: true, readOnly: true, destructive: false }
	),
	metaTool(
		"deny_knock",
		"Turns away a visitor knocking at the door by name or key fingerprint prefix.",
		{
			who: Schema.String.check(Schema.isMaxLength(64)),
		},
		{ gmOnly: true, readOnly: false, destructive: true }
	),
	metaTool(
		"create_invite",
		"Generates a single-use or bounded-use invite token (~token) that bypasses knocking. Never written to events.jsonl.",
		{
			uses: Schema.optionalKey(
				Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
			),
			minutes: Schema.optionalKey(
				Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
			),
		},
		{ gmOnly: true, readOnly: false, destructive: false }
	),
	metaTool(
		"set_auto_foes",
		"Toggles automatic foe turns in set.world campaigns (on: true lets the table play foes; false returns control to the GM).",
		{
			on: Schema.Boolean,
		},
		{
			gmOnly: true,
			readOnly: false,
			destructive: false,
			rulesets: ["set-world"],
		}
	),
];

export const MCP_RESOURCES: ReadonlyArray<ResourceDoc> = [
	{
		uri: "supervillain://help",
		name: "help",
		mimeType: "text/plain",
		gmOnly: false,
		description: "Every command this campaign's rules accept.",
	},
	{
		uri: "supervillain://table/state",
		name: "table state",
		mimeType: "application/json",
		gmOnly: false,
		description:
			"Seat-scoped JSON view of the live table: seq, party, stage, combat band, map, and recent feed.",
	},
	{
		uri: "supervillain://sheet/{who}",
		name: "sheet",
		mimeType: "text/plain",
		gmOnly: false,
		description:
			"Formatted character sheet. Players can read party members; GMs can read any hero or creature.",
	},
	{
		uri: "supervillain://codex/{key}",
		name: "codex card",
		mimeType: "text/plain",
		gmOnly: false,
		description:
			"A scene, NPC, handout, or item card revealed to the table (for example npc:old-mara). GMs also see private GM notes.",
	},
	{
		uri: "supervillain://campaign/files",
		name: "campaign files",
		mimeType: "application/json",
		gmOnly: true,
		description:
			"Index of every Markdown file and text map in the GM's campaign folder with its resource URI.",
	},
	{
		uri: "supervillain://campaign/{kind}/{id}",
		name: "campaign file",
		mimeType: "text/markdown",
		gmOnly: true,
		description:
			"Raw campaign source file from disk, including frontmatter and private ## GM Notes.",
	},
	{
		uri: "supervillain://schema/{kind}",
		name: "content schema",
		mimeType: "application/json",
		gmOnly: true,
		description:
			"JSON Schema (Draft 2020-12) for one campaign Markdown kind's frontmatter.",
	},
];

export const CAMPAIGN_SCHEMAS: ReadonlyArray<CampaignSchemaDoc> = [
	{
		kind: "table",
		glob: "table.md",
		uri: "supervillain://schema/table",
		purpose: "Campaign title, ruleset, and opening table notes.",
	},
	{
		kind: "scene",
		glob: "scenes/*.md",
		uri: "supervillain://schema/scene",
		purpose: "Staged scenes, read-aloud boxes, linked encounters, and maps.",
	},
	{
		kind: "npc",
		glob: "npcs/*.md",
		uri: "supervillain://schema/npc",
		purpose: "Non-player characters with public traits and private GM notes.",
	},
	{
		kind: "handout",
		glob: "handouts/*.md",
		uri: "supervillain://schema/handout",
		purpose: "Letters, clues, and player-facing handouts.",
	},
	{
		kind: "item",
		glob: "items/*.md",
		uri: "supervillain://schema/item",
		purpose: "Treasure, relics, and notable gear cards.",
	},
	{
		kind: "ancestry",
		glob: "ancestries/*.md",
		uri: "supervillain://schema/ancestry",
		purpose: "Campaign ancestry reference cards.",
	},
	{
		kind: "class",
		glob: "classes/*.md",
		uri: "supervillain://schema/class",
		purpose: "Campaign class reference cards.",
	},
	{
		kind: "ability",
		glob: "abilities/*.md",
		uri: "supervillain://schema/ability",
		purpose: "Reusable ability reference cards.",
	},
	{
		kind: "party",
		glob: "party/*.md",
		uri: "supervillain://schema/party",
		purpose: "Ruleset-typed player character sheets and portraits.",
	},
	{
		kind: "monster",
		glob: "monsters/*.md",
		uri: "supervillain://schema/monster",
		purpose: "Ruleset-typed monster and foe stat blocks.",
	},
];

const EnvelopeSchema = Schema.Struct({
	actor: Schema.String.annotate({
		description: 'Seat identity ("gm", "key:SHA256:...", or "guest:...").',
	}),
	seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
		description: "1-based monotonic sequence number matching the line index.",
	}),
	timestamp: Schema.String.annotate({
		description: "ISO-8601 UTC timestamp captured when the event was accepted.",
	}),
	type: Schema.String.annotate({
		description:
			'Namespaced domain event type (for example "core.dice-rolled" or "ds.moved").',
	}),
	payload: Schema.JsonObject.annotate({
		description:
			"Deterministic event payload including any dice rolls or host facts resolved on acceptance.",
	}),
});

export const ENVELOPE_SCHEMA_OBJECT: JsonSchema.JsonSchema = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	$id: "https://supervillain.sh/schemas/envelope.schema.json",
	title: "Supervillain Log Envelope",
	...Schema.toJsonSchemaDocument(EnvelopeSchema, {
		onExcessProperty: "error",
		generateDescriptions: true,
	}).schema,
};

export const ENVELOPE_SCHEMA_JSON: string = JSON.stringify(
	ENVELOPE_SCHEMA_OBJECT,
	null,
	2
);

export const mcpCatalogDocument = (
	ruleset: RulesetName
): McpCatalogDocument => {
	const meta: Array<CatalogToolEntry> = META_TOOLS.flatMap((tool) =>
		tool.rulesets.includes(ruleset)
			? [
					{
						name: tool.name,
						description: tool.description,
						gmOnly: tool.gmOnly,
						readOnly: tool.readOnly,
						destructive: tool.destructive,
						inputSchema: tool.inputSchema,
					},
				]
			: []
	);

	const commanded: Array<CatalogToolEntry> = commandCatalog(ruleset).map(
		(cmd) => ({
			name: cmd.toolName,
			description: `${cmd.summary} At the table: ${cmd.usage}.${cmd.gmOnly ? " GM only." : ""}`,
			gmOnly: cmd.gmOnly,
			readOnly: false,
			destructive: cmd.gmOnly,
			inputSchema: cmd.inputSchema,
		})
	);

	return {
		ruleset,
		subsystem: "mcp-1@supervillain.sh",
		tools: [...meta, ...commanded],
		resources: MCP_RESOURCES,
	};
};

export const buildProtocolSnapshot = (): ProtocolSnapshot => ({
	commands: {
		"draw-steel": commandCatalog("draw-steel"),
		"set-world": commandCatalog("set-world"),
		pf2e: commandCatalog("pf2e"),
		freeform: commandCatalog("freeform"),
	},
	metaTools: META_TOOLS,
	resources: MCP_RESOURCES,
	campaignSchemas: CAMPAIGN_SCHEMAS,
	envelopeSchemaJson: ENVELOPE_SCHEMA_JSON,
});
