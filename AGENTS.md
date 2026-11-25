# supervillain

A terminal-first virtual tabletop. Players type `ssh <room>@<host>` and are sitting at a live table, with nothing to install and no account to make. The GM's machine is the authority, and the campaign is a plain append-only JSONL log on the GM's disk. A campaign plays Draw Steel (default), `set.world`, or PF2e Remaster under the ORC License (`rules: pf2e`).

## Where things stand

We rebuilt small from a cleared tree, then re-architected the domain and hardened the entire workspace to strict Effect 4 + zero-comment + zero-assertion standards. `ASSESSMENT.md` holds the original plan and §9 is the living record of play decisions; canonical design records now live in `docs/adr/`, `docs/issues/`, `docs/how-it-works.md`, `docs/rulesets/`, `GLOSSARY.md`, `NOTICE`, and `docs/ORC-NOTICE.md`.

- The previous build is tagged `archive/2026-09-exploration`; Spikes A and B live at `archive/2026-09-spikes`; Spikes C and D live in `spikes/` (skipped by root lint and format).
- All three rulesets (`draw-steel`, `set-world`, `pf2e`), the `@alchemy.run/domain` + `@supervillain/platform-jsonl` engine, the post-quantum SSH server, the OpenTUI table (text + kitty picture map + mouse + GM prep panel), the relay + lobby, release binaries, and the public Foldkit site (`packages/site`) are built and green.
- The public site and the public relay are deployed; the relay runs v0.6.1 on a Linux VPS, with players on port 22.
- Next is Session Zero at a live table (ASSESSMENT §8).

## Rules

- **Product decisions come from play.** Settle them with throwaway prototypes and real people at a table, then record them in `ASSESSMENT.md` §9 as the decision plus its evidence (date and what happened).
- **Docs describe the present.** Rewrite them freely; git holds the history. Don't append corrections.
- **No ADR without code in the same change.**
- **Zero comments and zero type assertions.** Every tracked source, test, config, YAML, CSS, HTML, and shell file passes `bun run check` with zero warnings, zero comments (enforced by `supervillain/no-comments` and `tools/oxlint/supervillain/comments.ts`), and zero non-`as const` type assertions. Durable "why" belongs in `docs/adr/`, workarounds in `docs/issues/`, terms in `GLOSSARY.md`, and attributions in `NOTICE` / `docs/ORC-NOTICE.md`.
- **Commit subjects are at most 72 characters.** Detail goes in the body.
- **A red CI gets fixed, or the rule gets turned off, the same day.**
- **Commit only when the user asks.**
- **Host neutrality.** Never commit personal domains, VPS IPs, usernames, or credentials into tracked files; keep deployment variables in gitignored root `.env`.
- **ORC trademark neutrality.** The `pf2e` ruleset implements open mechanics under the ORC License (`docs/ORC-NOTICE.md`). Never use Paizo trademarks (including `"Pathfinder"`) or Reserved Material in code, UI, or public copy.

## Engine invariants

- The log envelope is `{actor, seq, timestamp, type, payload}`, one JSON object per line (`events.jsonl`).
- Randomness and derived external facts (sheets, maps, set.world rolls, clock timestamps) go in the command/event payload when accepted. Replay never rolls and never reads files.
- The single writer (`events.lock`) halts on an event it can't apply or an unexpected file length; lenient readers (`supervillain check`, `readLog`) skip unknown events loudly.
- Your SSH key is your identity: one key, one identity. Display names are separate (`ASSESSMENT.md` Q9).

## Stack & Workspace Layout

Bun 1.4.5 workspaces (pinned versions in root `package.json` `workspaces.catalog`), TypeScript 7 (`tsrs` + `tsc -b` with `exactOptionalPropertyTypes` and `verbatimModuleSyntax`), `oxlint` (`typeAware: true`, `denyWarnings: true`, Ultracite, `@effect/tsgo`, vendored `anti-slop`, `supervillain/no-comments`), `oxfmt`, and `bun test`.

- **Rules are pure.** `packages/domain` depends only on `effect` and `@alchemy.run/domain`: no Effect runtime, I/O, clock, or `Math.random` in rules.
- **Effect 4 runs the host edge:** the log file, single writer, HTTP client, sessions and their lifetimes, as `Context.Service` classes with layers. Effect's own agent guide ships at `node_modules/effect/AGENTS.md`.
- **The table** is Solid on OpenTUI 0.9.7: one App for the GM's terminal and every SSH seat. It sees only `TableView` in `apps/supervillain/src/table/view.ts`, never the room, the log, or Effect.

Packages:

- `packages/domain`: the `@alchemy.run/domain` `Table` aggregate and `Supervillain` model, opaque identity `TableStateSchema`, `CurrentActor` and `Entropy` (`diceOf` 64-bit mixer), `ExternalSystem` ports (`Sheets`, `Catalog`, `SetWorld`, `MapForge`, `Seating`), `intake`, lenient `readLog`, shared multi-square `rules/board/`, and the always-composed closure-erased `RULESETS` registry (`core`, `drawSteel`, `setWorld`, `pf2e`).
- `packages/platform-jsonl`: generic `Domain.Platform` implementation over `CampaignLog` (`events.jsonl`, `events.lock`, UTF-8 `ignoreBOM`, 64-line tail ring, torn-line truncation, defect-safe single-writer `send`, 1,024-entry LRU receipt cache, scoped `PubSub` shutdown).
- `packages/ssh`: our SSH server and client on `ssh2@1.17.0` with `patches/ssh2@1.17.0.patch` adding `mlkem768x25519-sha256` via `@noble/post-quantum`. Key auth (strict `Object.is(key.verify(...), true)`) and keyless guests, per-session Effect scopes, raw mode for the relay, `relaySubsystems`, outbound `attach()` + `connectClient()`, and stranger bounds (per-address and global connection/session caps, session/connect rate limits, login and idle timeouts, keepalives, rekey caps, 4 MiB socket/channel backpressure caps).
- `apps/supervillain`: the one binary (`src/main.ts`, `effect/cli`):
  - `content/`: `campaign.yaml` (`rules: draw-steel | set-world | pf2e`), hero/PC/monster/map YAML loaders on Effect `FileSystem`/`Path`, `CampaignContent` catalog, Steel Compendium bestiary import, Pathbuilder JSON import, and seeded map generator (`mapgen.ts`, `newMap.ts`).
  - `table/`: Solid + OpenTUI 0.9.7 UI (`view.ts`, `keep.ts`, `panels.ts`, `band.ts`, text `MapPane.tsx`, kitty-graphics `PictureMap.tsx` with MEKMODE `atlas/`, `mouse.ts`, and GM `Prep.tsx`).
  - `host/`: Effect edge (`TableRoom`, `Presence`, `SetWorld` on `HttpClient`, `AutoFoes` for set.world `/auto foes`, `tableServices`, `line.ts`, `Seat`, `TableServer`, `lobby.ts`, `RelayLink` with synchronous `relay_known` pinning, `LocalSeat`, and `check`).
  - `relay/`: `supervillain relay` (`protocol.ts` with `knows-1@supervillain.sh` lobby MAC, `rooms.ts`, `lobby.ts`, `server.ts`).
- `packages/site`: the Foldkit + `@foldkit/markdown` + `@alchemy.run/cloudflare` static site, docs, blog, and playable Draw Steel front-page terminal demo.
- `tools/oxlint/`: vendored `anti-slop` plugin and local `supervillain/` plugin (`no-comments` + `comments.ts` checker).
- `scripts/`: `build.ts` (`bun build --compile` with embedded sample campaign) and `smoke.sh`; `.github/workflows/{ci,release}.yml`.
- `examples/campaign`: the sample Draw Steel campaign copied by `supervillain new --example` and exercised by end-to-end tests.

## Commands

- `bun run build` — `tsc -b` across the workspace
- `bun test` — run all tests from the repo root (preloads Solid JSX transform via `bunfig.toml`)
- `bun run check` — `oxfmt --check`, strict `oxlint` (`--disable-nested-config`), and `comments.ts check`
- `bun run fmt` — format with `oxfmt`
- `bun supervillain host` — run the CLI from source
- `bun --filter @supervillain/site build` — build and prerender the static site
- `bun run release:build` / `bun run release:smoke dist/supervillain-<os>-<arch>` — compile and smoke-test the standalone binary

## References

- Old prototype: `~/Developer/projects/supervillain-old`. Read-only, lessons only, never code.
- OpenTUI source (API truth, never guess): `~/Developer/clones/github.com/anomalyco/opentui`. Read v0.9.7 with `git -C <clone> show v0.9.7:<path>`.
- Effect source: `~/Developer/clones/github.com/Effect-TS/effect`.
- Issues: GitHub (oscabriel/supervillain) via `gh`. External PRs are not a request surface.
