# How supervillain Works

This guide maps the architecture, invariants, and boundaries of the codebase so you know where each responsibility lives and what breaks if a seam moves. For individual design rationales, read `docs/adr/`; for known workarounds and limits, read `docs/issues/`.

## Package Topology

```
packages/
  domain/          Pure rules, commands, events, intake, projections (@alchemy.run/domain + effect only)
  platform-jsonl/  Domain.Platform over atomic append-only events.jsonl (generic, no domain imports)
  ssh/             Custom ssh2 server & client, post-quantum ML-KEM hybrid KEX, stranger rate/memory bounds
  site/            Foldkit + @foldkit/markdown public landing page, docs & acknowledgments (own Cloudflare stack)
apps/
  supervillain/    Single compiled Bun binary: host/, content/, relay/, table/, main.ts
scripts/           Cross-platform `bun build --compile` release builder, tmux TTY smoke harness, and forced-command VPS relay deployer
tools/             Oxlint plugins: vendored anti-slop + supervillain/no-comments + comments.ts scanner
```

Import boundaries are enforced at lint time in `oxlint.config.ts`:
- `packages/domain/src/**` may import **only** `effect`, `effect/rpc`, `@alchemy.run/domain`, and relative paths inside `packages/domain/src/`.
- `apps/supervillain/src/table/**` may import **only** OpenTUI, Solid, `node:zlib`, `@supervillain/domain` projections/types, and relative table files — never `effect`, `@alchemy.run/domain`, `@supervillain/platform-jsonl`, or `host/`.

## The Domain and the Log

`packages/domain` models the entire campaign as one `@alchemy.run/domain` aggregate (`Table`, instance `THE_TABLE = "table"`).
- **Total order & byte-identical JSONL:** Every accepted command emits one or more literal `Domain.Event` instances carrying `actor` alongside its payload. `packages/platform-jsonl` maps each event 1:1 to a single JSONL envelope line `{actor, seq, timestamp, type, payload}` in `events.jsonl`.
- **Agent input:** `COMMAND_CLASSES` maps each command type to its `Domain.Command` class and `HOST_FACT_KEYS` lists the fields only `intake` fills (`packages/domain/src/commandInput.ts`); `commandFromInput` turns a tool's JSON arguments into a `Command`, refusing any key outside the class's other fields, so an agent can never supply a host fact.
- **Deterministic replay:** `CurrentActor` and `Entropy` (a CSPRNG seed per command, never logged) enter `decide` via `Domain.RequestContext`. External facts (YAML sheets, map files, generated maps, `set.world` rolls, currently seated actors) are fetched *before* `Table.send` in `packages/domain/src/intake.ts` through `Domain.ExternalSystem` ports (`Sheets`, `Catalog`, `SetWorld`, `MapForge`, `Seating`) and stored inside event payloads. Replay never rolls dice, reads files, or hits the network.
- **Fast state round-trips:** `TableStateSchema` uses `Schema.declare` with an identity JSON codec so the aggregate state (including 20 structurally shared undo snapshots) passes through the kernel by reference (~23.8k cmd/s) instead of deep-cloning 3.5 MB per command.
- **Crash safety (`CampaignLog` & `JsonlPlatform`):** On open, `CampaignLog` takes an atomic `link(2)` PID lock (`events.lock`), renames stale locks aside, reads raw bytes with `ignoreBOM: true` to preserve exact byte offsets, cuts any torn trailing line, and replays batches through `kit.seed`. During live play, `send` runs under a single-writer semaphore: a throwing `evolve` writes nothing and returns a declared `Refused` rejection; a failed `append` truncates back to the pre-write size, marks the platform halted, and refuses all subsequent writes.
- **Strict writer, lenient reader:** `JsonlPlatform` halts startup with a typed `LogError` on any unknown event or invalid apply. `supervillain check` runs `parseLog` then `@supervillain/domain`'s lenient `readLog`, skipping unknown or undecodable lines loudly while recording skipped sequences as `loose` so later retractions still fold cleanly.

## Rulesets

Every ruleset's events are always composed into `Table` so any log replays regardless of `campaign.yaml`, while the campaign's `rules:` value selects commands, intake, and UI projections through the closure-erased `RULESETS` registry (`packages/domain/src/Ruleset.ts`):
- `draw-steel` — see `docs/rulesets/draw-steel.md`
- `set-world` — see `docs/rulesets/set-world.md`
- `pf2e` — see `docs/rulesets/pf2e.md` and `docs/ORC-NOTICE.md`
- `freeform` — see `docs/rulesets/freeform.md` and ADR 0019

All four share one tactical grid, multi-square footprint (`1×1`–`4×4` + Tiny sharing), mark assignment, and stateful Dijkstra pathfinder (`packages/domain/src/rules/board/`).

Every ruleset also answers the party it shows on the stage, whether it is in combat, the lines that set up a scene's fight, and the lines that reload changed sheets.

## Campaign Content and the Stage

Beside the YAML sheets and `maps/`, a campaign holds typed Markdown (ADR 0017): `table.md`, `scenes/`, `npcs/`, `handouts/`, `items/`, `ancestries/`, `classes/`, `abilities/`, `party/` and `monsters/*.md`. Each file's frontmatter is decoded by a strict Effect `Schema` (`apps/supervillain/src/content/frontmatter.ts`); its body splits into player-safe prose and GM notes (any heading starting `GM`, `Game Master`, `DM`, `Director notes` or `Secret`, however emphasised, with every deeper section under it until a `#` heading of its level; comments go first and an unclosed fence is a problem). `supervillain check` validates every file and every link between them, the host will not open a campaign with problems, and `supervillain schema` writes the same schemas as JSON Schema for editors.

The campaign stage (ADR 0018) is the `stage` slice of `TableState`, outside undo: cards the GM has revealed (the players' codex) or put on the table, the current scene, trackers and the recap. A card is built from a file's player-safe part by the host and carried into the event by `intake`, so neither GM notes nor files reach the log or replay. `stageOf` projects it for a seat; its mode follows the fight unless the GM's `/stage` holds it until the next fight starts or ends.

At a seat the stage takes the map's place out of a fight, and the party strip (`partyOf`) takes the band's: the scene with its read-aloud box, the cards on the table side by side when there is room (a card's map drawn read-only), trackers and the last three recap lines. When a fight starts the seat shows the band and the map; when it ends it goes back to the stage. `/view stage` and `/view board` look at the other one at that seat only, and `/codex` opens the codex there. Only the GM's seat gets `gmNotes`, which draws each card's GM notes under it; a player's `TableView` holds none.

While a hosted table is open, `ContentWatch` watches the campaign folder (`FileSystem.watch`, debounced 250 ms), reading again only the content folders, `table.md` and `campaign.yaml`, never `events.jsonl`, `events.lock`, `host.log`, keys, `schemas/`, dotfiles or editor temp files. A good edit replaces `CampaignContent`'s validated snapshot, which cards, GM notes, the prep panel and Markdown sheets all read, and syncs changed cards on the stage with one `core.content-synced` as the GM (unless `table.md` says `sync: manual`; the synced cards then match the files, so it never loops). A card whose GM notes shrank as its player text grew, the mark of a GM half-way through retyping `## GM Notes`, is held back instead and offered in the prep panel's sync row as `/sync <card>`, so it reaches the players only when the GM says; and compares the party's sheets in play with the files, offering the changed ones as one click in the prep panel. A bad edit never stops the table: the last good index stays and the problems show in the GM's header and prep panel. Sandbox tables never watch.

## Host Edge and Terminal UI

- **`apps/supervillain/src/host/`** runs the Effect 4.1 runtime edge: `TableRoom` wraps `Table` + `JsonlPlatform` + `SecureRandom` + per-player rate limiting and keeps a `SubscriptionRef<TableState>` updated uninterruptibly with each send; `Seat` batches changes (~16 ms) and projects a pure `TableView` through `kept` (structural identity retention); `LocalSeat` renders the GM's terminal while sending logs to `host.log`; `TableServer` serves SSH shells and exec, seating members and sending everyone else to the door (`Knocks` holds knocks and invites in memory, ADR 0016); `RelayLink` dials out to a relay as `<handle>/<table>`, presenting the GM's `gm_key` (`GmKey`), with `Schedule` backoff and synchronous pre-admit key pinning; `AutoFoes` optionally drives `set-world` foe turns with ordinary GM commands.
- **`apps/supervillain/src/mcp/`** seats AI agents (ADR 0020) on Effect's `effect/ai/McpServer`, one fresh `McpServer.layerStdio` per session over its byte stream (`duplexStdio`). `session.ts` refuses guests and non-members, enters `Presence`, and closes the session when its actor stops being a member; `tools.ts` registers `cmd_<type>` for every command in `commandsFor(ruleset)` (GM-only ones for the GM only) with JSON Schemas from the command classes minus their host-fact keys, plus `send_line`, `get_table_state`, `wait_for_change`, `help` and the GM's batch, content, knock and invite tools; `resources.ts` serves `supervillain://` help, state, sheets and codex cards to everyone and campaign files and schemas to the GM; `view.ts` builds the player-safe state and the GM's fuller one. `McpSocket` (`socket.ts`) listens on the campaign's `mcp.sock` for the GM's local agents (`supervillain mcp`, `bridge.ts`); `TableServer` serves the `mcp-1@supervillain.sh` subsystem, as the GM for a key in `gm_keys` (`gmKeys.ts`) and as the key's own actor otherwise. Every command an agent sends goes through `sendCommand` in `host/line.ts`: `commandFromInput`, `intake`, the room's rate limit and `Table.send`, exactly as a typed line.
- **`apps/supervillain/src/table/`** is a pure Solid + OpenTUI 0.9.7 app rendering `TableView`. Clicks on map tokens, band rows, or the GM prep panel never mutate state directly — they dispatch the exact slash-command line typing would send through `view.submit`.

## SSH and the Relay

- **`packages/ssh/`** wraps `ssh2@1.17.0` (patched via `patches/ssh2@1.17.0.patch` for post-quantum `mlkem768x25519-sha256` first, elliptic-curve only, no compression, and an `env` option on `Client.subsys`) with strict public-key signature checks (`Object.is(key.verify(...), true)`), per-address connection/session/connect-rate caps, login and idle timeouts, keepalive cutoffs, rekey caps, and a 4 MiB unread backpressure bound.
- **`apps/supervillain/src/relay/`** is a dumb byte-forwarding bridge listening on two ports (players' SSH and GMs' link). It routes `<handle>/<table>` and the returning player's bare `<table>` shorthand, pins handles to GM keys in `handles.json` (up to 4 keys a handle, claim codes for another machine, 180-day lapse or 30 if never linked, per-subnet claim rates, 4,096 max handles, ADR 0015), and powers the lobby via `knows-1@supervillain.sh` (random 16-byte nonce + HMAC-SHA256 so linked hosts never learn unknown keys; hosts answer only for members). A server's `relaySubsystems` open only for a pinned relay, its `subsystems` only for a direct connection or a relayed one naming its player in `SV_ACTOR`; the relay's player-facing server routes `mcp-1@supervillain.sh` (an agent) to the named table, or the one a shorthand resolves to, without the lobby, and never accepts `knows-1` from players.

## Tooling, Checks, and CI/CD

Development requires Bun 1.4.5+ and Node 26+ (for native TypeScript stripping in `oxlint.config.ts` and `.ts` lint plugins).

`bun run check` runs the full zero-warning gate across every tracked file:
1. `oxfmt --check` (tabs, width 80; format with `bun run fmt`)
2. `oxlint --disable-nested-config` (`typeAware: true` via `tsrs`, `denyWarnings: true`, Ultracite core, `@effect/tsgo` recommended + 12 strict rules, vendored `anti-slop` core + Effect, `supervillain/no-comments`, and import boundaries)
3. `node tools/oxlint/supervillain/comments.ts check` (catches comments in CSS, HTML, YAML, TOML, shell, Dockerfiles, JSONC, and disable directives in TSX)
4. `tsc -b` (TypeScript 7.1 beta with `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noImplicitOverride`, `noFallthroughCasesInSwitch`)

All tracked source files carry **zero comments** and **zero non-`as const` type assertions** (ADR 0009, ADR 0010). Run the full test suite with `bun run test` (`bun test --parallel`).

Workflows in `.github/workflows/`:
- **`ci.yml`** (push to `main` and PRs): `bun run check`, `bun test --parallel`, site build, binary build, and tmux TTY smoke test.
- **`site-deploy.yml`** (push to `main` touching `packages/site/**`, plus `workflow_dispatch`): runs `bun run check`, `bun test packages/site`, and deploys the public site to Cloudflare via Alchemy (`bun run deploy:ci`, skipping cleanly when Cloudflare secrets are unset).
- **`release.yml`** (push of a `v*` tag): runs `bun run check` and `bun test --parallel`, builds all 4 platform binaries, runs tmux TTY smoke tests on Linux x64, Linux ARM64, and macOS ARM64, generates `SHA256SUMS`, signs SLSA build provenance (`actions/attest-build-provenance`), publishes the GitHub Release, and calls `relay-deploy.yml` for stable (non-prerelease) tags.
- **`relay-deploy.yml`** (`workflow_call` from `release.yml` and `workflow_dispatch` for manual deploys/rollbacks): scoped to the `relay` GitHub Environment; downloads the release binary, verifies `SHA256SUMS` and `gh attestation verify`, and streams the archive over pinned, restricted forced-command SSH to `scripts/deploy-relay.sh` on the VPS (atomic swap + health check + automatic rollback).

## Public Site (`packages/site`)

A Foldkit + `@foldkit/markdown` app prerendered to static pages by Vite and deployed independently to Cloudflare via `packages/site/alchemy.run.ts` (`Cloudflare.Website.Foldkit` + `Cloudflare.state()`, reading `SUPERVILLAIN_SITE_DOMAIN` from root `.env` locally or GitHub Actions variables in `site-deploy.yml`). Its front page includes a self-contained client-side Draw Steel encounter demo built on the same event-log mental model as the real table.
