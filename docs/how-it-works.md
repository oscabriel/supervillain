# How supervillain Works

This guide maps the architecture, invariants, and boundaries of the codebase so you know where each responsibility lives and what breaks if a seam moves. For individual design rationales, read `docs/adr/`; for known workarounds and limits, read `docs/issues/`.

## Package Topology

```
packages/
  domain/          Pure rules, commands, events, intake, projections (@alchemy.run/domain + effect only)
  platform-jsonl/  Domain.Platform over atomic append-only events.jsonl (generic, no domain imports)
  ssh/             Custom ssh2 server & client, post-quantum ML-KEM hybrid KEX, stranger rate/memory bounds
  site/            Foldkit + @foldkit/markdown public landing page, docs & blog (own Cloudflare stack)
apps/
  supervillain/    Single compiled Bun binary: host/, content/, relay/, table/, main.ts
scripts/           Cross-platform `bun build --compile` release builder and tmux TTY smoke harness
tools/             Oxlint plugins: vendored anti-slop + supervillain/no-comments + comments.ts scanner
```

Import boundaries are enforced at lint time in `oxlint.config.ts`:
- `packages/domain/src/**` may import **only** `effect`, `effect/rpc`, `@alchemy.run/domain`, and relative paths inside `packages/domain/src/`.
- `apps/supervillain/src/table/**` may import **only** OpenTUI, Solid, `node:zlib`, `@supervillain/domain` projections/types, and relative table files — never `effect`, `@alchemy.run/domain`, `@supervillain/platform-jsonl`, or `host/`.

## The Domain and the Log

`packages/domain` models the entire campaign as one `@alchemy.run/domain` aggregate (`Table`, instance `THE_TABLE = "table"`).
- **Total order & byte-identical JSONL:** Every accepted command emits one or more literal `Domain.Event` instances carrying `actor` alongside its payload. `packages/platform-jsonl` maps each event 1:1 to a single JSONL envelope line `{actor, seq, timestamp, type, payload}` in `events.jsonl`.
- **Deterministic replay:** `CurrentActor` and `Entropy` (a CSPRNG seed per command, never logged) enter `decide` via `Domain.RequestContext`. External facts (YAML sheets, map files, generated maps, `set.world` rolls, currently seated actors) are fetched *before* `Table.send` in `packages/domain/src/intake.ts` through `Domain.ExternalSystem` ports (`Sheets`, `Catalog`, `SetWorld`, `MapForge`, `Seating`) and stored inside event payloads. Replay never rolls dice, reads files, or hits the network.
- **Fast state round-trips:** `TableStateSchema` uses `Schema.declare` with an identity JSON codec so the aggregate state (including 20 structurally shared undo snapshots) passes through the kernel by reference (~23.8k cmd/s) instead of deep-cloning 3.5 MB per command.
- **Crash safety (`CampaignLog` & `JsonlPlatform`):** On open, `CampaignLog` takes an atomic `link(2)` PID lock (`events.lock`), renames stale locks aside, reads raw bytes with `ignoreBOM: true` to preserve exact byte offsets, cuts any torn trailing line, and replays batches through `kit.seed`. During live play, `send` runs under a single-writer semaphore: a throwing `evolve` writes nothing and returns a declared `Refused` rejection; a failed `append` truncates back to the pre-write size, marks the platform halted, and refuses all subsequent writes.
- **Strict writer, lenient reader:** `JsonlPlatform` halts startup with a typed `LogError` on any unknown event or invalid apply. `supervillain check` runs `parseLog` then `@supervillain/domain`'s lenient `readLog`, skipping unknown or undecodable lines loudly while recording skipped sequences as `loose` so later retractions still fold cleanly.

## Rulesets

Every ruleset's events are always composed into `Table` so any log replays regardless of `campaign.yaml`, while the campaign's `rules:` value selects commands, intake, and UI projections through the closure-erased `RULESETS` registry (`packages/domain/src/Ruleset.ts`):
- `draw-steel` — see `docs/rulesets/draw-steel.md`
- `set-world` — see `docs/rulesets/set-world.md`
- `pf2e` — see `docs/rulesets/pf2e.md` and `docs/ORC-NOTICE.md`

All three share one tactical grid, multi-square footprint (`1×1`–`4×4` + Tiny sharing), mark assignment, and stateful Dijkstra pathfinder (`packages/domain/src/rules/board/`).

## Host Edge and Terminal UI

- **`apps/supervillain/src/host/`** runs the Effect 4.1 runtime edge: `TableRoom` wraps `Table` + `JsonlPlatform` + `SecureRandom` + per-player rate limiting and keeps a `SubscriptionRef<TableState>` updated uninterruptibly with each send; `Seat` batches changes (~16 ms) and projects a pure `TableView` through `kept` (structural identity retention); `LocalSeat` renders the GM's terminal while sending logs to `host.log`; `TableServer` serves SSH shells and exec; `RelayLink` dials out to a relay with `Schedule` backoff and synchronous pre-admit key pinning; `AutoFoes` optionally drives `set-world` foe turns with ordinary GM commands.
- **`apps/supervillain/src/table/`** is a pure Solid + OpenTUI 0.9.7 app rendering `TableView`. Clicks on map tokens, band rows, or the GM prep panel never mutate state directly — they dispatch the exact slash-command line typing would send through `view.submit`.

## SSH and the Relay

- **`packages/ssh/`** wraps `ssh2@1.17.0` (patched via `patches/ssh2@1.17.0.patch` for post-quantum `mlkem768x25519-sha256` first, elliptic-curve only, no compression) with strict public-key signature checks (`Object.is(key.verify(...), true)`), per-address connection/session/connect-rate caps, login and idle timeouts, keepalive cutoffs, rekey caps, and a 4 MiB unread backpressure bound.
- **`apps/supervillain/src/relay/`** is a dumb byte-forwarding bridge listening on two ports (players' SSH and GMs' link). It pins room ownership in `rooms.json` (180-day lapse, per-subnet claim rates, 1,024 max rooms) and powers the lobby via `knows-1@supervillain.sh` (random 16-byte nonce + HMAC-SHA256 so linked hosts never learn unknown keys).

## Tooling and Checks

`bun run check` runs the full zero-warning gate across every tracked file:
1. `oxfmt --check` (tabs, width 80)
2. `oxlint --disable-nested-config` (`typeAware: true` via `tsrs`, `denyWarnings: true`, Ultracite core, `@effect/tsgo` recommended + 12 strict rules, vendored `anti-slop` core + Effect, `supervillain/no-comments`, and import boundaries)
3. `node tools/oxlint/supervillain/comments.ts check` (catches comments in CSS, HTML, YAML, TOML, shell, Dockerfiles, JSONC, and disable directives in TSX)
4. `tsc -b` (TypeScript 7.1 beta with `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noImplicitOverride`, `noFallthroughCasesInSwitch`)

All tracked source files carry **zero comments** and **zero non-`as const` type assertions** (ADR 0009, ADR 0010).

## Public Site (`packages/site`)

A Foldkit + `@foldkit/markdown` app prerendered to static pages by Vite and deployed independently to Cloudflare via `packages/site/alchemy.run.ts` (`SUPERVILLAIN_SITE_DOMAIN` in root `.env`). Its front page includes a self-contained client-side Draw Steel encounter demo built on the same event-log mental model as the real table.
