# Issue 0002: OpenTUI 0.9.7 Layout, Focus, and Graphics Quirks

## Status

Open workarounds tracked in `apps/supervillain/src/table/`.

## 1. Solid JSX `Node` type without DOM `lib`

`apps/supervillain/tsconfig.json` does not include the browser `DOM` lib. Without a local `Node` alias, Solid's JSX namespace falls back to `any` on OpenTUI intrinsic elements, weakening type-aware lint rules (`@typescript-eslint/no-unsafe-*`).

`apps/supervillain/src/table/jsx.d.ts` declares `type Node = BaseRenderable` (matching `@opentui/solid`), keeping Solid JSX strictly typed without pulling browser DOM globals into the terminal app.

## 2. Mouse tracking without pointer motion and without click-focus

Terminal mouse reporting over SSH can flood the wire if motion events are enabled. `packages/ssh` and `apps/supervillain/src/table/` enable button/wheel tracking only (never any-motion tracking), and clicks never steal focus from the bottom input line so typing always lands in the command prompt.

## 3. Kitty graphics gated outside multiplexers

Picture maps (default in supported terminals, with `/view text` to opt out) emit Kitty Graphics Protocol PNGs painted at the terminal's reported pixel cell dimensions (defaulting to 36 px/square when unavailable). Half-block Unicode fallbacks make single-character token marks unreadable, and tmux/screen intercept or corrupt kitty APC sequences, so seats outside supported kitty-graphics terminals stay in text mode.

## 4. View slice memoization (`table/keep.ts`)

Rebuilding the entire `TableView` on every chat line or combat event caused OpenTUI to re-layout unchanged panes on every connected seat. `apps/supervillain/src/table/keep.ts` preserves referential equality for unchanged band, map, feed, and prep projections across updates so only modified panes repaint.
