# Model the campaign as one pure @alchemy.run/domain aggregate

## Decision

All game rules live in `packages/domain`, which imports only `effect`, `effect/rpc`, and `@alchemy.run/domain` (enforced by `no-restricted-imports` in `oxlint.config.ts`). The entire campaign is modeled as one `Table` aggregate (`THE_TABLE = "table"`) with literal `Domain.Command` and `Domain.Event` classes and an opaque identity `TableStateSchema` (`Schema.declare` with passthrough JSON codec).

## Why

- One aggregate preserves total ordering across chat, combat, and `/undo`, keeps `seq` 1:1 with lines in `events.jsonl`, and allows `Story` BDD specs to test every ruleset in memory with zero I/O.
- Literal command and event classes give per-command declared event guarantees without type assertions.
- An identity JSON codec keeps `TableState` (including 20 structurally shared undo snapshots) round-tripping by reference (~23.8k cmd/s) instead of deep-cloning megabytes per command.

## What breaks if you change this

- Importing filesystem, HTTP, socket, or terminal modules in `packages/domain/src/**` fails `bun run check`.
- Replacing `TableStateSchema`'s identity codec with a structural JSON codec breaks snapshot sharing and slows replay of large logs by ~30×.
- Splitting rulesets into separate aggregates breaks cross-slice `/undo` and line-sequential `events.jsonl`.
