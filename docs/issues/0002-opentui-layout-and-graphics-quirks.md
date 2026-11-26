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

## 5. SSH channels stand in for `NodeJS.ReadStream` and `NodeJS.WriteStream`

`createCliRenderer` types `stdin` as `NodeJS.ReadStream` and `stdout` as `NodeJS.WriteStream`, the TTY streams of a local process. A seat over SSH has neither: `packages/ssh/src/terminal.ts` gives the renderer a plain `Readable` fed from the channel and the `ssh2` `ServerChannel` itself with `columns` and `rows` set on it. At runtime OpenTUI 0.9.7 asks less than its types say: from `stdin` it calls `on`, `removeListener`, `pause`, `resume` and `read`, and treats `setRawMode` and `isTTY` as optional; from `stdout` it calls `write` and `emit` and reads `columns` and `rows`.

`isTerminalIn` and `isTerminalOut` in `terminal.ts` are type predicates that check exactly those members and then claim the full `NodeJS.ReadStream` and `NodeJS.WriteStream` types. That claim is wider than the check: the streams have no `setRawMode`, `isTTY`, `fd` or `getColorDepth`, so the two predicates are casts that OpenTUI's typings leave no way around. Re-read what the renderer touches on its streams whenever OpenTUI is upgraded, and keep the two member lists (`STDIN_READS`, `STDOUT_READS`) in step.

## 6. Every renderer listens on one process-wide emitter

Each `CliRenderer` builds a `TerminalConsole`, which subscribes to OpenTUI's `TerminalConsoleCache`, a singleton that lives for the whole process and is not exported, and the renderer itself adds `warning`, `uncaughtException`, `unhandledRejection` and `exit` listeners to `process`. With Node's default limit of 10 listeners, the eleventh seat makes Node print `MaxListenersExceededWarning` to stderr, which on a host is the GM's screen.

The cache cannot be reached to call `setMaxListeners` on it, so `serve()` in `packages/ssh/src/server.ts` raises `EventEmitter.defaultMaxListeners` to at least `limits.sessions + 16` instead. This is the only global the SSH server changes; it never lowers the limit, and a seat each is not a leak.

