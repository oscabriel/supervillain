---
title: A domain model whose database is one text file
summary: The table is an @alchemy.run/domain aggregate. Its storage is events.jsonl, appended one line at a time on the GM's disk. Here is how the two meet at 23,800 commands per second.
date: 2026-11-22
---

A supervillain campaign is a file called `events.jsonl`. Every change at the table is one JSON line appended to it, and the table you sit at is what you get by folding those lines in order. That file was our first invariant and the one we refuse to give up: a GM can read it with `cat`, search it with `grep`, back it up with `cp`, and keep it in git.

We rebuilt the core on [@alchemy.run/domain](https://github.com/alchemy-run/alchemy) and kept the exact same file format underneath. This post covers where an event-sourced domain framework meets a single flat text file, and the two surprises we measured along the way.

## The envelope stays fixed

One line of the log looks like this:

```json
{"actor":"gm","seq":9,"timestamp":"2026-10-22T16:23:16.573Z","type":"ds.moved","payload":{"id":"brann","path":[{"x":2,"y":4},{"x":3,"y":4},{"x":4,"y":4},{"x":5,"y":4}],"cost":4,"speed":5}}
```

`actor`, `seq`, `timestamp`, `type`, `payload`, one object per line, and nothing else. `seq` is the 1-based line number. Randomness and outside facts ride inside the payload: a power roll carries its rolled dice, a hero joining carries the full sheet, a map carries its grid, a set.world fighter carries its fetched API roll. Replay never rolls and never reads a file. The domain model had to fit that wire format byte-for-byte, not the other way around.

## What `@alchemy.run/domain` gives us

In `packages/domain`, every command and event is typed with Effect Schema, and the entire table is one aggregate wired over all three rulesets (`draw-steel`, `set-world`, `pf2e`):

```ts
export class DsMoved extends Domain.Event("ds.moved", {
	actor: ActorId,
	...Payloads["ds.moved"].fields,
}) {}
```

External facts (loading YAML sheets, generating seeded maps, calling set.world's HTTP API, reading seating) sit behind typed `ExternalSystem` ports. Pure rules stay pure: `packages/domain` has zero filesystem, HTTP, clock, or `Math.random` imports, and tests read as plain stories (given these events, when this command, then these events or this refusal).

The compiled binary cost of bringing in `@alchemy.run/domain` turned out to be tiny: about 254 KB out of a 120 MB Bun standalone binary, with zero bundler or build-time dependencies leaking into runtime.

## Two surprises we caught by measuring

**1. Structural state schemas break undo snapshot sharing.** Our first prototype gave the aggregate a deep `Schema.Struct` for `TableState`. Every command decoded and re-encoded the whole table state, which cost 1,294 ms per 1,000 commands and cloned every snapshot in the undo stack. Switching to an opaque identity `TableStateSchema` (`Schema.declare` with a passthrough transformation) brought throughput to **23,800 commands per second** while preserving structural sharing across all 20 undo snapshots. Event payloads stay strictly schema-validated at the boundary; internal folded state stays zero-copy.

**2. UTF-8 BOMs silently break byte-offset checks.** `CampaignLog` tracks the exact byte length of `events.jsonl` so it can detect external writes and truncate torn lines safely. Reading the file through `fs.readFileString` stripped a leading UTF-8 BOM, leaving `Buffer.byteLength` three bytes short of the real file size. Switching to raw bytes plus `TextDecoder("utf-8", { ignoreBOM: true })` fixed it, and a 240,000-line differential fuzzer confirmed zero divergence between the old fold and the new aggregate.

## The platform is a single writer over one file

`@supervillain/platform-jsonl` implements `Domain.Platform` directly over the campaign folder:

- **One writer.** Opening a campaign takes `events.lock` via `link(2)` with the host PID. Before every append, the writer verifies that the file length on disk still matches what it last wrote; if another process touched the file, the writer halts instead of interleaving.
- **Command batches.** All events from one command share their `actor` and `timestamp` and hit disk in one write. On reopen, consecutive lines with the same actor and timestamp reconstruct the batch whole.
- **Fast tail reads and crash recovery.** A 64-line in-memory ring serves `recent(n)` in O(1), and a 1,024-entry LRU receipt cache handles idempotency. A half-written final line with no newline is truncated on open; a failed write rolls back to the previous byte offset and halts further writes until restart.
- **Halt on write, skip on read.** The live host halts if it hits an event it cannot apply. `supervillain check` uses the lenient reader, skipping unknown event types loudly while keeping retractions consistent.

## What a file keeps

A database would give us secondary indexes and concurrent writers. A tabletop campaign needs neither: one table has one GM and a few thousand events over a whole campaign. Folding the log on startup takes milliseconds and uses the exact same code path as live play.

What you keep is a campaign you actually own. It sits on your disk in plain text, opens in any editor twenty years from now, and never depends on a server staying online. The [architecture page](/docs/architecture) shows how the rest of the binary fits around it, and the [front page](/) runs the real domain rules right in your browser.
