import { Result, Schema, SchemaIssue } from "effect";
import type { Envelope } from "./envelope.ts";

const EnvelopeLine = Schema.fromJsonString(
  Schema.Struct({
    actor: Schema.String,
    seq: Schema.Int,
    timestamp: Schema.String,
    type: Schema.String,
    payload: Schema.Unknown,
  }),
);
const decodeLine = Schema.decodeUnknownResult(EnvelopeLine);

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) =>
    issue._tag === "MissingKey" ? "missing" : SchemaIssue.defaultLeafHook(issue),
});

/** What's wrong with a line, in words a GM can act on: "timestamp: missing", "seq: expected number". */
const problem = (issue: SchemaIssue.Issue) => {
  const [first] = formatIssue(issue).issues;
  const message = (first?.message ?? "not an envelope").replace(/^\w/, (c) => c.toLowerCase());
  const field = first?.path?.[0];
  return field === undefined ? message : `${String(field)}: ${message}`;
};

export interface ParsedLog {
  /** Every envelope before the first bad line. */
  readonly envelopes: ReadonlyArray<Envelope>;
  /** The text up to and including the last newline. */
  readonly intact: string;
  /** A last line with no newline: a write that never finished. */
  readonly torn?: string;
  /** The first complete line that isn't a valid envelope. Lines after it are not read. */
  readonly error?: { readonly line: number; readonly message: string };
}

/** Reads a campaign log's text. Pure: the host's replay and every reader share it. */
export function parseLog(text: string): ParsedLog {
  const end = text.lastIndexOf("\n") + 1;
  const intact = text.slice(0, end);
  const tail = text.slice(end);
  const parsed: ParsedLog =
    tail === "" ? { envelopes: [], intact } : { envelopes: [], intact, torn: tail };
  const envelopes: Envelope[] = [];
  const lines = intact.split("\n").slice(0, -1);
  for (const [i, raw] of lines.entries()) {
    const result = decodeLine(raw);
    if (Result.isFailure(result)) {
      return {
        ...parsed,
        envelopes,
        error: { line: i + 1, message: problem(result.failure.issue) },
      };
    }
    if (result.success.seq !== i + 1) {
      return {
        ...parsed,
        envelopes,
        error: { line: i + 1, message: `seq ${result.success.seq} on line ${i + 1}` },
      };
    }
    envelopes.push(result.success);
  }
  return { ...parsed, envelopes };
}
