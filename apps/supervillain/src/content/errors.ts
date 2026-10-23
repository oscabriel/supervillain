import { Schema } from "effect";

/** "hero" or "monster": which folder of the campaign a sheet lives in. */
export const SheetKind = Schema.Literals(["hero", "monster"]);
export type SheetKind = typeof SheetKind.Type;

/** A hero or monster file that doesn't decode. One line of `message` per problem, each naming the file. */
export class SheetInvalid extends Schema.TaggedError<SheetInvalid>()("SheetInvalid", {
  /** The file, relative to the campaign folder: "heroes/vex.yaml". */
  file: Schema.String,
  /** Each problem without the file name: "characteristics.might must be …". */
  problems: Schema.Array(Schema.String),
  message: Schema.String,
}) {}

/** No sheet's id is or starts with the query. */
export class SheetNotFound extends Schema.TaggedError<SheetNotFound>()("SheetNotFound", {
  kind: SheetKind,
  query: Schema.String,
  message: Schema.String,
}) {}

/** Several sheets' ids start with the query, and none is exactly it. */
export class SheetAmbiguous extends Schema.TaggedError<SheetAmbiguous>()("SheetAmbiguous", {
  kind: SheetKind,
  query: Schema.String,
  matches: Schema.Array(Schema.String),
  message: Schema.String,
}) {}

/** A file or folder the host couldn't read or write, for a reason other than its contents. */
export class ContentReadError extends Schema.TaggedError<ContentReadError>()("ContentReadError", {
  message: Schema.String,
}) {}

/** No map file's id is or starts with the query, or several start with it and none is it. */
export class MapNotFound extends Schema.TaggedError<MapNotFound>()("MapNotFound", {
  query: Schema.String,
  message: Schema.String,
}) {}

/** A map file the table can't draw: too big, not text, a stray character, or the wrong shape. */
export class MapInvalid extends Schema.TaggedError<MapInvalid>()("MapInvalid", {
  /** The file, relative to the campaign folder: "maps/ford.txt". */
  file: Schema.String,
  message: Schema.String,
}) {}

/** A `campaign.yaml` the host can't go by: not YAML, a setting it doesn't know, or an unknown ruleset. */
export class CampaignConfigInvalid extends Schema.TaggedError<CampaignConfigInvalid>()(
  "CampaignConfigInvalid",
  {
    /** The file's path. */
    file: Schema.String,
    message: Schema.String,
  },
) {}

/** Why a generated map couldn't be written into maps/ (`writeGeneratedMap`). */
export const MapWriteReason = Schema.Literals([
  "bad-id",
  "bad-seed",
  "exists",
  "no-campaign",
  "generate",
  "write",
]);
export type MapWriteReason = typeof MapWriteReason.Type;

/**
 * A generated map that didn't reach maps/: an id that can't be a map's, a seed out of range, a map
 * of that id already there, no campaign folder, a seed that made no map, or a write that failed.
 * The CLI and the table each say it their own way, by `reason`.
 */
export class MapWriteFailed extends Schema.TaggedError<MapWriteFailed>()("MapWriteFailed", {
  reason: MapWriteReason,
  /** The map's id, its file name in maps/. */
  id: Schema.String,
  message: Schema.String,
}) {}
