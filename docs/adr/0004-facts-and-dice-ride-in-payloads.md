# Randomness and host facts ride in event payloads; replay never rolls or reads

## Decision

Every command receives `CurrentActor` and `Entropy` (a CSPRNG integer seed from `SecureRandom`, converted via a 64-bit arithmetic mixer in `diceOf`) through `Domain.RequestContext`. External facts—YAML sheets, map files, generated maps, `set.world` API rolls, and currently seated actors—are resolved before `Table.send` in `packages/domain/src/intake.ts` via `Domain.ExternalSystem` ports (`Sheets`, `Catalog`, `SetWorld`, `MapForge`, `Seating`). Rolled faces and fetched facts are stored inside the emitted event payloads; seeds are never logged.

## Why

Storing derived outcomes and fetched facts in the log guarantees deterministic replay across machines, offline restarts, and edited YAML files. Putting `intake` before `decide` keeps commands synchronous and prevents failed file reads or network errors from polluting the log.

## What breaks if you change this

- Calling `Math.random()`, `Date.now()`, filesystem APIs, or `fetch` inside `decide` or `apply` breaks replay determinism and is blocked by `oxlint`.
- Replacing `diceOf`'s non-linear seed mixer with a raw linear congruential initializer correlates adjacent test seeds.
- Moving external fetches into async policies puts failed fetches into `events.jsonl` and makes `/hero` or `/recruit` eventually consistent.
