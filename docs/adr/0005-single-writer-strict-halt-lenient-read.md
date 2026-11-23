# One host locks a campaign; writers halt strictly and readers skip loudly

## Decision

`CampaignLog` acquires `<campaign>/events.lock` atomically via `link(2)`, renames stale locks (dead PIDs) aside safely, reads raw bytes with `TextDecoder("utf-8", { ignoreBOM: true })`, cuts any torn trailing line on open, checks on-disk file size before every append, loops on short writes, fsyncs, and truncates back to the pre-write size on failure. The writer halts immediately on any unknown event, invalid apply, or failed append; `supervillain check` runs `parseLog` then lenient `readLog`, skipping unknown or undecodable lines loudly while recording skipped sequences as `loose`.

## Why

Two hosts writing the same `events.jsonl` would interleave sequence numbers and corrupt the campaign. Halting the writer prevents silent state divergence, while a lenient reader lets players inspect logs written by newer versions.

## What breaks if you change this

- Switching `CampaignLog` to `fs.readFileString` strips a leading UTF-8 BOM and shifts `byteLength(parsed.intact)` by 3 bytes, corrupting torn-line truncation or halting the first append.
- Removing `rules.skip` for malformed payloads in `readLog` causes a subsequent `core.retracted` naming that sequence to halt `supervillain check`.
- Making `TableRoom.submit`'s send-plus-ref-update interruptible allows a disconnecting seat to commit to disk while leaving other seats on stale state.
