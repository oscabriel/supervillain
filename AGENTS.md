# supervillain

A terminal-first virtual tabletop. Players type `ssh <room>@<host>` and are sitting at a live table, with nothing to install and no account to make. The GM's machine is the authority, and the campaign is a plain append-only JSONL log on the GM's disk. Draw Steel is the game.

## Where things stand

We are rebuilding small, from a cleared tree. `ASSESSMENT.md` at the root is the plan: why, what survives, the eleven questions to settle, and the rebuild sketch. Its §9 is the one living record of decisions.

- The previous build is tagged `archive/2026-09-exploration`, with its ADRs, wayfinder and benchmarks under `.agents/`; nothing in it binds. Copy from it with care (ASSESSMENT §5 lists what's worth lifting), one file and its tests at a time, from a worktree: `git worktree add ../supervillain-archive archive/2026-09-exploration`.
- Spikes A and B import the archived packages, so they live at tag `archive/2026-09-spikes`. Spike C (paper) and Spike D (the runnable Effect table that settled the architecture) live in `spikes/`. Lift lessons from them, not code; root lint and format skip that folder.
- The rebuild went in slices toward a table friends can sit at: engine, SSH table with names and chat, chat-first input and layout, minimum Draw Steel, undo and the text map, then the relay and release binaries. All six are in: `supervillain host` runs a Draw Steel table players join over SSH, directly or through `supervillain relay`. Next is Session Zero (ASSESSMENT §8).
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
- `packages/ssh`: our SSH server and client on ssh2. A key is an identity and a keyless client can be a guest; each shell gets a renderer and each session its own Effect scope, or in raw mode (`onRaw`, the relay's players' side) plain byte streams. `attach()` serves SSH on a socket the host dialed out (the relay link, `persistent` and relay-only with `admitRelay`), and `connectClient()` is the relay's end of it. It is open to strangers, so it caps connections and sessions (per address and in all, with an opt-in connect rate), times out logins and idle sessions, cuts dead peers by keepalive and offers only elliptic-curve key exchange, with ML-KEM's post-quantum hybrid first. Stock ssh2 lacks that hybrid, so `patches/ssh2@1.16.0.patch` adds it (`bun patch`), with ML-KEM from @noble/post-quantum.
- `apps/supervillain`: the one binary (`src/main.ts`, effect/cli). Folders become packages only when a boundary hurts:
  - `game/`: the pure rules as modules composed in `table.ts` into one engine `Rules` and one command registry that drives parsing, completion and `/help`. `core.ts` is chat, names and dice; `drawSteel/` is the party, creatures, combat, Stamina, conditions, power rolls and resources, with the sheet types in `sheets.ts`. Projections (labels, the band, `/sheet`) are in `table.ts`.
  - `content/`: hero and monster YAML in a campaign's `heroes/` and `monsters/`, the `CampaignContent` loader, and the Steel Compendium import. The rules never read a file: the host loads a sheet and puts it in the command, so the event carries it.
  - `table/`: the chat-first App over `view.ts`, with the Draw Steel band (`band.ts` lays it out).
  - `host/`: the Effect edge. `TableRoom` (the room, with the log provided inside its layer), `Presence`, `tableServices` (those two and `CampaignContent` over one campaign), `line.ts` (one input line: host facts such as sheets, then the room), `Seat` (one `TableView` per seat), `TableServer` (SSH shells and exec), `RelayLink` (the host's dialed-out link to a relay: the hello, the relay-key pin in `relay_known`, redial with backoff) and `LocalSeat` (the GM's terminal).
  - `relay/`: `supervillain relay`, which renders nothing. `protocol.ts` is the link's one-line hello and answer, shared with `RelayLink`; `rooms.ts` the room claims in `rooms.json`; `server.ts` the players' SSH port and the GMs' link port.
- `scripts/`: `build.ts` compiles the release binaries (`bun build --compile`, the sample campaign embedded), `smoke.sh` checks one from an empty folder; `.github/workflows/release.yml` runs both on a `v*` tag. `docs/` holds the guides for players and hosts.
- `examples/campaign`: the sample campaign (four heroes, four bandits) that `supervillain new --example` copies and the end-to-end tests play.

Build with `bun run build`, test with `bun test`, lint and format-check with `bun run check`. Run the table from the root with `bun supervillain host`, and the app's tests from the root too (the root `bunfig.toml` preloads the Solid JSX transform). Compile a binary with `bun run release:build` and check it with `bun run release:smoke dist/supervillain-<os>-<arch>`.

## References

- Old prototype: `~/Developer/projects/supervillain-old`. Read-only, lessons only, never code.
- OpenTUI source (API truth, never guess): `~/Developer/clones/github.com/anomalyco/opentui`. Read v0.6.6 with `git -C <clone> show v0.6.6:<path>`.
- Effect source: `~/Developer/clones/github.com/Effect-TS/effect`.
- Issues: GitHub (oscabriel/supervillain) via `gh`. External PRs are not a request surface.
