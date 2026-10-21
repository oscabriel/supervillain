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
