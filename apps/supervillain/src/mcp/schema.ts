import { commandInputFields, commandsFor } from "@supervillain/domain";
import type { RulesetName, TableSpec } from "@supervillain/domain";
import { Option, Schema } from "effect";
import type { McpSchema } from "effect/ai";

import { schemaFiles } from "../content/index.ts";

export interface CommandTool {
	readonly spec: TableSpec;
	readonly name: string;
	readonly inputSchema: McpSchema.ToolJson;
}

const TOOL_NAME = /[^A-Za-z0-9_-]/gu;

const TOOL_NAME_MAX = 64;

const NO_INPUT: McpSchema.ToolJson = {
	type: "object",
	properties: {},
	additionalProperties: false,
};

const decodeProperties = Schema.decodeUnknownOption(
	Schema.Record(
		Schema.String,
		Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Boolean])
	)
);

const decodeRequired = Schema.decodeUnknownOption(Schema.Array(Schema.String));

export const toolName = (prefix: string, type: string): string =>
	`${prefix}${type}`.replaceAll(TOOL_NAME, "_").slice(0, TOOL_NAME_MAX);

export const inputSchemaOf = (
	fields: Schema.Struct.Fields
): McpSchema.ToolJson => {
	if (Object.keys(fields).length === 0) {
		return NO_INPUT;
	}

	const { schema, definitions } = Schema.toJsonSchemaDocument(
		Schema.Struct(fields),
		{ onExcessProperty: "error", generateDescriptions: true }
	);

	const defs =
		Object.keys(definitions).length === 0 ? {} : { $defs: definitions };

	return {
		...schema,
		...defs,
		type: "object",
		properties: Option.getOrElse(
			decodeProperties(schema.properties),
			() => ({})
		),
		required: Option.getOrElse(decodeRequired(schema.required), () => []),
		additionalProperties: false,
	};
};

export const commandTools = (
	ruleset: RulesetName,
	gm: boolean
): ReadonlyArray<CommandTool> =>
	commandsFor(ruleset)
		.filter((spec) => gm || !spec.gmOnly)
		.flatMap((spec) => {
			const fields = commandInputFields(spec.type);

			return fields === undefined
				? []
				: [
						{
							spec,
							name: toolName("cmd_", spec.type),
							inputSchema: inputSchemaOf(fields),
						},
					];
		});

export const contentSchemaText = (
	ruleset: RulesetName,
	kind: string
): string | undefined =>
	schemaFiles(ruleset, "2020-12").find((f) => f.file === `${kind}.schema.json`)
		?.text;
