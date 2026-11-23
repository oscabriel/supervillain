# Undo and redo refold from snapshots via corrective events

## Decision

`/undo` and `/redo` append `core.retracted` and `core.redone` events rather than rewriting `events.jsonl`. `compose` maintains a 20-batch undo stack of `before` snapshots; a batch is consecutive retractable events sharing one actor and one monotonic timestamp. Players may undo only their own latest non-rolled batch within 30 seconds (`ctx.now`). Retracting refuses if any later batch would fold differently without it; hero/fighter assignments are never retractable.

## Why

Rewriting history breaks append-only durability and live sync. Inverse events per module are lossy for temporary health, conditions, and turn budgets. Snapshot-plus-refold is exact across all three rulesets and guarantees redo only applies onto the state its undo left.

## What breaks if you change this

- Dropping monotonic timestamping in `JsonlPlatform` merges distinct submissions into one undo batch or splits one submission across batches.
- Changing which event types are retractable breaks replay of historical `core.retracted` events (the retractable set is log contract).
- Letting `/auto foes` trigger on a state whose `redo` depth just increased immediately overwrites the GM's `/undo` with a fresh foe roll.
