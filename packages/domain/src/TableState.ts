import { Predicate, Schema, SchemaTransformation } from "effect";

import type { TableState } from "./rules/compose.ts";

const isTableState = (input: unknown): input is TableState =>
	Predicate.isObject(input) &&
	Predicate.hasProperty(input, "seq") &&
	Predicate.hasProperty(input, "undo") &&
	Predicate.hasProperty(input, "core") &&
	Predicate.hasProperty(input, "ds") &&
	Predicate.hasProperty(input, "sw") &&
	Predicate.hasProperty(input, "pf");

export const TableStateSchema = Schema.declare<TableState>(isTableState, {
	identifier: "TableState",
	toCodecJson: () =>
		Schema.link<TableState>()(
			Schema.Unknown,
			SchemaTransformation.passthrough({ strict: false })
		),
});
