import { Schema } from "effect";

import { MAP_KINDS } from "../rules/board/grid.ts";

export const SheetKind = Schema.Literals(["hero", "monster"]);

export type SheetKind = typeof SheetKind.Type;

export class SheetInvalid extends Schema.TaggedError<SheetInvalid>()(
	"SheetInvalid",
	{
		file: Schema.String,
		problems: Schema.Array(Schema.String),
		message: Schema.String,
	}
) {}

export class SheetNotFound extends Schema.TaggedError<SheetNotFound>()(
	"SheetNotFound",
	{
		kind: SheetKind,
		query: Schema.String,
		message: Schema.String,
	}
) {}

export class SheetAmbiguous extends Schema.TaggedError<SheetAmbiguous>()(
	"SheetAmbiguous",
	{
		kind: SheetKind,
		query: Schema.String,
		matches: Schema.Array(Schema.String),
		message: Schema.String,
	}
) {}

export class ContentReadError extends Schema.TaggedError<ContentReadError>()(
	"ContentReadError",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) }
) {}

export class MapNotFound extends Schema.TaggedError<MapNotFound>()(
	"MapNotFound",
	{
		query: Schema.String,
		message: Schema.String,
	}
) {}

export class MapInvalid extends Schema.TaggedError<MapInvalid>()("MapInvalid", {
	file: Schema.String,
	message: Schema.String,
}) {}

export const MapWriteReason = Schema.Literals([
	"bad-id",
	"bad-seed",
	"exists",
	"no-campaign",
	"generate",
	"write",
]);

export type MapWriteReason = typeof MapWriteReason.Type;

export class MapWriteFailed extends Schema.TaggedError<MapWriteFailed>()(
	"MapWriteFailed",
	{
		reason: MapWriteReason,
		id: Schema.String,
		message: Schema.String,
	}
) {}

export const SquareSchema = Schema.Struct({ x: Schema.Int, y: Schema.Int });

export const MapGridSchema = Schema.Struct({
	name: Schema.String,
	terrain: Schema.Array(Schema.String),
	dressing: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const MapKindSchema = Schema.Literals(MAP_KINDS);

export const MapGenerationSchema = Schema.Struct({
	kind: MapKindSchema,
	seed: Schema.optionalKey(Schema.Int),
});

export const PrepEntrySchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
});

export const PrepCatalogSchema = Schema.Struct({
	heroes: Schema.Array(PrepEntrySchema),
	monsters: Schema.Array(PrepEntrySchema),
	maps: Schema.Array(PrepEntrySchema),
});
