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

export class CardNotFound extends Schema.TaggedError<CardNotFound>()(
	"CardNotFound",
	{ query: Schema.String, message: Schema.String }
) {}

export class CardAmbiguous extends Schema.TaggedError<CardAmbiguous>()(
	"CardAmbiguous",
	{
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

export const PrepEncounterSchema = Schema.Struct({
	map: Schema.optionalKey(Schema.String),
	monsters: Schema.Array(
		Schema.Struct({ id: Schema.String, count: Schema.optionalKey(Schema.Int) })
	),
});

export const PrepSceneSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	encounter: Schema.optionalKey(PrepEncounterSchema),
});

export const PrepTrackerSchema = Schema.Struct({
	id: Schema.String,
	label: Schema.String,
	kind: Schema.Literals(["clock", "counter", "quest"]),
	max: Schema.optionalKey(Schema.Int),
	value: Schema.optionalKey(Schema.Int),
	scene: Schema.optionalKey(Schema.String),
});

export const PrepCatalogSchema = Schema.Struct({
	heroes: Schema.Array(PrepEntrySchema),
	monsters: Schema.Array(PrepEntrySchema),
	maps: Schema.Array(PrepEntrySchema),
	scenes: Schema.optionalKey(Schema.Array(PrepSceneSchema)),
	npcs: Schema.optionalKey(Schema.Array(PrepEntrySchema)),
	handouts: Schema.optionalKey(Schema.Array(PrepEntrySchema)),
	items: Schema.optionalKey(Schema.Array(PrepEntrySchema)),
	trackers: Schema.optionalKey(Schema.Array(PrepTrackerSchema)),
});
