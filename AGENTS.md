# supervillain

A terminal-first virtual tabletop. Players type `ssh <room>@<host>` and are sitting at a live table, with nothing to install and no account to make. The GM's machine is the authority, and the campaign is a plain append-only JSONL log on the GM's disk. Draw Steel is the game.

## Where things stand

We are rebuilding small, from a cleared tree. `ASSESSMENT.md` at the root is the plan: why, what survives, the eleven questions to settle, and the rebuild sketch. Its §9 is the one living record of decisions.

- The previous build is tagged `archive/2026-09-exploration`, with its ADRs, wayfinder and benchmarks under `.agents/`; nothing in it binds. Copy from it with care (ASSESSMENT §5 lists what's worth lifting), one file and its tests at a time, from a worktree: `git worktree add ../supervillain-archive archive/2026-09-exploration`.
- Spikes A and B import the archived packages, so they live at tag `archive/2026-09-spikes`. Spike C (paper) and Spike D (the runnable Effect table that settled the architecture) live in `spikes/`. Lift lessons from them, not code; root lint and format skip that folder.
- The rebuild goes in slices toward a table friends can sit at: engine, then SSH table with names and chat, chat-first input and layout, minimum Draw Steel, undo and the text map, then the relay. The first three are in: `bun supervillain host` runs a table you can join over SSH.
- The issue backlog from that phase is frozen. New issues come from play.

## Rules

- **Product decisions come from play.** Settle them with throwaway prototypes and real people at a table, then record them in ASSESSMENT §9 as the decision plus its evidence (date and what happened).
- **Docs describe the present.** Rewrite them freely; git holds the history. Don't append corrections.
- **No ADR without code in the same change.**
- **Commit subjects are at most 72 characters.** Detail goes in the body.
- **A red CI gets fixed, or the rule gets turned off, the same day.**
- **Commit only when the user asks.**

## Engine invariants (from the kernel)

- The log envelope is `{actor, seq, timestamp, type, payload}`, one JSON object per line.
- Randomness and derived facts go in the payload when a command is accepted. Replay never rolls and never reads files.
- The writer halts on an event it can't apply; readers skip unknown events loudly.
- Your SSH key is your identity: one key, one identity. Display names are separate (ASSESSMENT Q9).

## Stack

Bun workspaces, TypeScript 7 with `tsc -b`, oxlint and oxfmt on defaults, `bun test` with a small Effect helper. Dependencies are pinned exactly.

- **Rules are pure.** `decide(state, actor, command, dice)` returns events or a refusal, and `apply(state, envelope)` folds one event. No Effect runtime, I/O, clock or `Math.random` in rules.
- **Effect 4 runs the host edge:** the log file, the single writer, sessions and their lifetimes, as `Context.Service` classes with layers. Effect's own agent guide ships at `node_modules/effect/AGENTS.md`.
- **The table** is Solid on OpenTUI 0.6.6: one App for the GM's terminal and every SSH seat. It sees only the `TableView` in `table/view.ts`, never the room, the log or Effect.

- `packages/engine`: the envelope, the log reader, the fold, `CampaignLog` and the single-writer `Room`. Generic over a game's rules.
- `packages/ssh`: our SSH server on ssh2. A key is an identity and a keyless client can be a guest; each shell gets a renderer and each session its own Effect scope. It is open to strangers, so it caps connections and sessions (per address and in all), times out logins and idle sessions, cuts dead peers by keepalive and offers only elliptic-curve key exchange.
- `apps/supervillain`: the one binary (`src/main.ts`, effect/cli). Folders become packages only when a boundary hurts:
  - `game/`: the pure rules as modules (core: chat, names, dice), composed into one engine `Rules` and one command registry that drives parsing, completion and `/help`.
  - `table/`: the chat-first App over `view.ts`.
  - `host/`: the Effect edge. `TableRoom` (the room, with the log provided inside its layer), `Presence`, `Seat` (one `TableView` per seat), `TableServer` (SSH shells and exec) and `LocalSeat` (the GM's terminal).

Build with `bun run build`, test with `bun test`, lint and format-check with `bun run check`. Run the table from the root with `bun supervillain host` (the root `bunfig.toml` preloads the Solid JSX transform).

## References

- Old prototype: `~/Developer/projects/supervillain-old`. Read-only, lessons only, never code.
- OpenTUI source (API truth, never guess): `~/Developer/clones/github.com/anomalyco/opentui`. Read v0.6.6 with `git -C <clone> show v0.6.6:<path>`.
- Effect source: `~/Developer/clones/github.com/Effect-TS/effect`.
- Issues: GitHub (oscabriel/supervillain) via `gh`. External PRs are not a request surface.
