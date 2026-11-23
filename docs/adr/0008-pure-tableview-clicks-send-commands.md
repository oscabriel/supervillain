# The table UI is pure Solid over TableView, and every click sends a command line

## Decision

`apps/supervillain/src/table/` imports only OpenTUI, Solid, `node:zlib`, and `@supervillain/domain` projections/types (enforced by `oxlint.config.ts`). Each seat receives a `TableView` batched on a ~16 ms frame interval with structural retention (`kept`); projection throws are logged once and keep the last valid frame. Clicking a map token, band row, or GM prep item never mutates state—it submits the exact slash-command line typing would send through `view.submit`, and seats render with `autoFocus: false` so the input line keeps keyboard focus. `apps/supervillain/src/table/jsx.d.ts` declares global `type Node = BaseRenderable` because the workspace omits DOM libs.

## Why

Keeping the UI stateless over `TableView` means local GM seats and remote SSH seats run one identical renderer, every UI action is auditable in `events.jsonl`, and Up-arrow history recalls clicked commands naturally. Declaring `Node = BaseRenderable` stops Solid's `JSX.Element` from silently decaying to `any`.

## What breaks if you change this

- Importing `effect`, `@alchemy.run/domain`, `@supervillain/platform-jsonl`, or `host/` in `table/` fails `bun run check`.
- Removing `src/table/jsx.d.ts` breaks JSX typing in `Seat.ts` and `table/*.tsx` under `typeAware` linting.
- Enabling mouse motion tracking (`all-motion`) floods SSH links on every pointer move; seats track button clicks, drags, and wheel only.
