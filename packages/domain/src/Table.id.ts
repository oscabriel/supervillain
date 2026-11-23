import { Schema } from "effect";

export const TableId = Schema.String.pipe(Schema.brand("TableId"));

export type TableId = typeof TableId.Type;

export const THE_TABLE: TableId = TableId.make("table");
