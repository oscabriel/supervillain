# supervillain

A terminal-first virtual tabletop. Players type `ssh <room>@<host>` and are sitting at a live table, with nothing to install and no account to make. The GM's machine is the authority, and the campaign is a plain append-only JSONL log on the GM's disk. Draw Steel is the game; a campaign may choose set.world's rules instead.

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
- `packages/ssh`: our SSH server and client on ssh2. A key is an identity and a keyless client can be a guest; each shell gets a renderer and each session its own Effect scope, or in raw mode (`onRaw`, the relay's players' side) plain byte streams; a trusted relay may also ask for the subsystems a server names (`relaySubsystems`). `attach()` serves SSH on a socket the host dialed out (the relay link, `persistent` and relay-only with `admitRelay`), and `connectClient()` is the relay's end of it. It is open to strangers, so it caps connections and sessions (per address and in all, with an opt-in connect rate), times out logins and idle sessions, cuts dead peers by keepalive, names itself `supervillain` without compression, and offers only elliptic-curve key exchange, with ML-KEM's post-quantum hybrid first. Stock ssh2 lacks that hybrid, so `patches/ssh2@1.16.0.patch` adds it (`bun patch`), with ML-KEM from @noble/post-quantum.
- `apps/supervillain`: the one binary (`src/main.ts`, effect/cli). Folders become packages only when a boundary hurts:
  - `game/`: the pure rules as modules composed in `table.ts` into one engine `Rules` and one command registry that drives parsing, completion and `/help`. `core.ts` is chat, names and dice; `drawSteel/` is the party, creatures, combat, Stamina, conditions, power rolls and resources, with the sheet types in `sheets.ts` and the map letters (MEKMODE's Ding Mode: what each depicts and what the rules see) in `mekmode.ts`; `setWorld/` is set.world's ruleset: fighters rolled at set.world, turns by initiative on a logical clock, Set's stamina, dodge, critical and damage (`rules.ts` states the rules, `weapons.ts` every weapon's delivery and reach), on Draw Steel's grid and movement. Every module is always composed, so one fold replays any log; a module's `ruleset` (`draw-steel`, `set-world`; core has none) says which tables offer its commands, and two rulesets may type a command the same way (`/map`, `/play`, `/unplay`, `/place`, `/start`, `/move`, `/done`, `/end`) because their command types differ (`map`, `set-map`). Projections (labels, the band, the map, `/sheet`, the mouse's choices in `actionsOf`, typed in `actions.ts`) are in `table.ts`, chosen by the campaign's ruleset, and so is the GM's prep panel (`prepOf`: each ruleset's `view.ts` projects the steps to a fight, who waits for a square, and its sections from the campaign's files and the state, each item with the command line it sends; `prep.ts` holds the shapes and the shared maps and steps). `/map new <kind> [seed]` parses in `drawSteel/map.ts` for both rulesets; `mapGeneration` and `withMapId` in `table.ts` hand it to the host.
  - `content/`: a campaign's `campaign.yaml` (`rules: draw-steel` or `set-world`; none means draw-steel) in `campaignFile.ts`, hero and monster YAML in its `heroes/` and `monsters/`, maps in its `maps/`, the `CampaignContent` loader (which carries the ruleset, read once when the table opens), the Steel Compendium import, `mapgen.ts`, the seeded map generator, and `newMap.ts`, which writes a generated map into `maps/` for both `supervillain map` and the table's `/map new`. `CampaignContent.catalog` lists every hero, monster and map with its name, for the prep panel. The rules never read a file: the host loads a sheet and puts it in the command, so the event carries it.
  - `table/`: the chat-first App over `view.ts`, with the panels each seat shows or hides btop style (`panels.ts`: Alt+1-4, and Alt+5 for the GM's prep panel, from `input.ts`'s `keyAction`, `/view` presets, `togglePanel`), the band (Draw Steel's or set.world's; `band.ts` lays it out), the text map (`map.ts`, `MapPane.tsx`) and the picture map (`picture.ts` paints it from the MEKMODE glyphs in `atlas/`, used with MEK's permission; `PictureMap.tsx` shows it on seats with kitty graphics), and the mouse (`mouse.ts`: a click on a token or band row opens a menu of the choices the rules project, `actionsOf` in `game/table.ts`, and ends as the very command line typing sends, through `view.submit`; squares are found by `squareAt` and `pictureSquareAt`, band rows by `whoAt`; `/mouse [on|off]` per seat; seats' renderers track buttons only, never any motion, and focus nothing on a click, so the input line keeps the keyboard), and the GM's prep panel, a column right of the map and the feed (`prep.ts` says what the next free square clicked on the map does, a token's `/place` or a monster count's `/add … xN`, then `/place` for what it added, nearest the square; `Prep.tsx` draws it, each token as the picture map would; a click sends its line through `view.submit` or puts a free-text one on the input line, so it never changes state itself).
  - `host/`: the Effect edge. `TableRoom` (the room, with the log provided inside its layer), `Presence`, `SetWorld` (set.world's roll API, fetched with a timeout; `SetWorld.answering` serves recorded answers in tests), `tableServices` (those three and `CampaignContent` over one campaign), `line.ts` (one input line, parsed for the campaign's ruleset: host facts such as sheets, maps and set.world rolls, and for `/map new` the map written into `maps/` from its seed, then the room), `Seat` (one `TableView` per seat; the GM's alone gets `prep`, its lists read through `CampaignContent.catalog` each time the panel opens), `TableServer` (SSH shells and exec), `lobby.ts` (the table's answer to the relay's lobby: does it know this key), `RelayLink` (the host's dialed-out link to a relay: the hello, the relay-key pin in `relay_known`, redial with backoff) and `LocalSeat` (the GM's terminal).
  - `relay/`: `supervillain relay`, which renders nothing. `protocol.ts` is the link's one-line hello and answer, shared with `RelayLink`, and the lobby's question (the `knows-1@supervillain.sh` subsystem on the link: a nonce and a MAC of the player's key, answered yes with a seat count or no); `rooms.ts` the room claims in `rooms.json`; `lobby.ts` the lobby's screen, one frame of text with ANSI colours from what the relay knows (the tables, their seated counts, the player's key); `server.ts` the players' SSH port, the lobby (a player with a key and no room picks from the open tables that know it, on that screen redrawn per key and resize) and the GMs' link port.
- `scripts/`: `build.ts` compiles the release binaries (`bun build --compile`, the sample campaign embedded), `smoke.sh` checks one from an empty folder; `.github/workflows/release.yml` runs both on a `v*` tag. `docs/` holds the guides for players and hosts.
- `examples/campaign`: the sample campaign (four heroes, four bandits) that `supervillain new --example` copies and the end-to-end tests play.

Build with `bun run build`, test with `bun test`, lint and format-check with `bun run check`. Run the table from the root with `bun supervillain host`, and the app's tests from the root too (the root `bunfig.toml` preloads the Solid JSX transform). Compile a binary with `bun run release:build` and check it with `bun run release:smoke dist/supervillain-<os>-<arch>`.

## References

- Old prototype: `~/Developer/projects/supervillain-old`. Read-only, lessons only, never code.
- OpenTUI source (API truth, never guess): `~/Developer/clones/github.com/anomalyco/opentui`. Read v0.6.6 with `git -C <clone> show v0.6.6:<path>`.
- Effect source: `~/Developer/clones/github.com/Effect-TS/effect`.
- Issues: GitHub (oscabriel/supervillain) via `gh`. External PRs are not a request surface.
