# Host @alchemy.run/domain directly over events.jsonl via platform-jsonl

## Decision

`packages/platform-jsonl` implements `Domain.Platform` directly over `CampaignLog` without depending on `@supervillain/domain` or any external database. `JsonlPlatform` omits optional `start`/`history` (avoiding `Backfill`), replays batches eagerly via `kit.seed`, stamps monotonic timestamps (`max(clock, last + 1)`), serializes sends under a 1-permit semaphore, and keeps a 1,024-entry LRU receipt cache and a 64-line in-memory tail ring for O(1) `recent(n)`.

## Why

`supervillain` ships as a single compiled binary with zero infrastructure. Implementing `Domain.Platform` directly over `events.jsonl` gives us `@alchemy.run/domain`'s typed commands, events, and `Story` tests locally while leaving the domain portable to `Domain.Cloudflare` or `Domain.EffectCluster` later.

## What breaks if you change this

- Letting `evolve` swallow throws into a state flag would persist bad events to disk; instead `evolve` throws and `JsonlPlatform.send` turns defects into a declared `Refused` rejection without writing.
- Dropping `Refused { message }` from any command's `rejects` list causes the `@alchemy.run/domain` client to die when the platform rejects a rule defect or append halt.
- Wrapping `Domain.InMemory` instead of writing a dedicated platform would leak memory forever and introduce asynchronous view lag.
