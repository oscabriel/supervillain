# The campaign log is an append-only JSONL sequence of envelopes

## Decision

Every campaign is persisted in one append-only file, `<campaign>/events.jsonl`, with one JSON object per line shaped `{ actor, seq, timestamp, type, payload }`. `seq` is 1-based and strictly equal to the line number. Every event carries its submitting `actor` alongside its payload.

## Why

A plain JSONL file on the GM's disk needs no database server, is inspectable with `jq` or `grep`, backs up with `cp` or `git`, and keeps the GM's machine the sole authority over a campaign.

## What breaks if you change this

- Dropping `actor` or reordering envelope keys breaks `packages/platform-jsonl/src/codec.ts` and `parseLog`.
- Allowing any event payload to declare a top-level `_tag` or `actor` field collides with `@alchemy.run/domain`'s tagged event encoding (`packages/domain/test/verify.test.ts` guards against this).
- Splitting a campaign across multiple streams breaks `seq === lineNumber` and atomic cross-slice `/undo`.
