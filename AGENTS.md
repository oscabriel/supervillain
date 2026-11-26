# supervillain

A terminal-first virtual tabletop. Players type `ssh <handle>/<table>@<host>` and knock, the GM lets them in, and they are sitting at a live table, with nothing to install and no account to make. The GM's machine is the authority, and the campaign is a plain append-only JSONL log on the GM's disk. A campaign plays Draw Steel (default), `set.world`, PF2e Remaster under the ORC License (`rules: pf2e`), or a rules-light `freeform` table, and its prep is typed Markdown the table shows players through the campaign stage without ever showing them the GM's notes.

## Where things stand

We rebuilt small from a cleared tree, then re-architected the domain and hardened the entire workspace to strict Effect 4 + zero-comment + zero-assertion standards. `ASSESSMENT.md` holds the original plan and §9 is the living record of play decisions; canonical design records now live in `docs/adr/`, `docs/issues/`, `docs/how-it-works.md`, `docs/rulesets/`, `GLOSSARY.md`, `NOTICE`, and `docs/ORC-NOTICE.md`.

- The previous build is tagged `archive/2026-09-exploration`; Spikes A and B live at `archive/2026-09-spikes`; Spikes C and D live in `spikes/` (skipped by root lint and format).
- All four rulesets (`draw-steel`, `set-world`, `pf2e`, `freeform`), typed Markdown campaign content with `supervillain check` and `supervillain schema`, the campaign stage domain (cards, codex, trackers, recap; ADRs 0017–0019), the `@alchemy.run/domain` + `@supervillain/platform-jsonl` engine, the post-quantum SSH server, the OpenTUI table (text + kitty picture map + mouse + GM prep panel), the relay + lobby, the agent MCP control plane (local `mcp.sock` + `supervillain mcp`, the `mcp-1@supervillain.sh` SSH subsystem, remote GMs in `gm_keys`; ADR 0020), release binaries, and the public Foldkit site (`packages/site`) are built and green.
- The public site and the public relay are deployed (the relay runs on a Linux VPS with players on port 22, auto-upgraded on every stable `v*` release; the public site auto-deploys on pushes to `main` touching `packages/site/**`).
- Next is Session Zero at a live table (ASSESSMENT §8).

## Rules

- **Product decisions come from play.** Settle them with throwaway prototypes and real people at a table, then record them in `ASSESSMENT.md` §9 as the decision plus its evidence (date and what happened).
- **Docs describe the present.** Rewrite them freely; git holds the history. Don't append corrections.
- **No ADR without code in the same change.**
- **Zero comments and zero type assertions.** Every tracked source, test, config, YAML, CSS, HTML, and shell file passes `bun run check` with zero warnings, zero comments (enforced by `supervillain/no-comments` and `tools/oxlint/supervillain/comments.ts`), and zero non-`as const` type assertions. Durable "why" belongs in `docs/adr/`, workarounds in `docs/issues/`, terms in `GLOSSARY.md`, and attributions in `NOTICE` / `docs/ORC-NOTICE.md`.
- **Commit subjects are at most 72 characters.** Detail goes in the body.
- **A red CI gets fixed, or the rule gets turned off, the same day.**
- **Commit only when the user asks.**
- **Host neutrality.** Never commit personal domains, VPS IPs, usernames, or credentials into tracked files; keep local deployment variables in gitignored root `.env` and CI/CD coordinates in GitHub Actions secrets/variables (`relay` environment and repository secrets/variables).
- **ORC trademark neutrality.** The `pf2e` ruleset implements open mechanics under the ORC License (`docs/ORC-NOTICE.md`). Never use Paizo trademarks (including `"Pathfinder"`) or Reserved Material in code, UI, or public copy.

## Engine invariants

- The log envelope is `{actor, seq, timestamp, type, payload}`, one JSON object per line (`events.jsonl`).
- Randomness and derived external facts (sheets, maps, stage cards, set.world rolls, clock timestamps) go in the command/event payload when accepted. Replay never rolls and never reads files.
- The single writer (`events.lock`) halts on an event it can't apply or an unexpected file length; lenient readers (`supervillain check`, `readLog`) skip unknown events loudly.
- Agents go through the same `intake` as a typed line: an MCP tool's arguments never carry a command's host-fact keys (`HOST_FACT_KEYS`), and a player's MCP state holds only what their seat draws.
- Your SSH key is your identity: one key, one identity. Display names are separate (`ASSESSMENT.md` Q9).

## Stack & Workspace Layout

Bun 1.4.5 workspaces (pinned versions in root `package.json` `workspaces.catalog`) and Node 26+ (required for `oxlint.config.ts` and `.ts` lint plugins), TypeScript 7 (`tsrs` + `tsc -b` with `exactOptionalPropertyTypes` and `verbatimModuleSyntax`), `oxlint` (`typeAware: true`, `denyWarnings: true`, Ultracite, `@effect/tsgo`, vendored `anti-slop`, `supervillain/no-comments`), `oxfmt`, and `bun test`.

- **Rules are pure.** `packages/domain` depends only on `effect` and `@alchemy.run/domain`: no Effect runtime, I/O, clock, or `Math.random` in rules.
- **Effect 4 runs the host edge:** the log file, single writer, HTTP client, sessions and their lifetimes, as `Context.Service` classes with layers. Effect's own agent guide ships at `node_modules/effect/AGENTS.md`.
- **The table** is Solid on OpenTUI 0.9.7: one App for the GM's terminal and every SSH seat. It sees only `TableView` in `apps/supervillain/src/table/view.ts`, never the room, the log, or Effect.

Packages:

- `packages/domain`: the `@alchemy.run/domain` `Table` aggregate and `Supervillain` model, opaque identity `TableStateSchema`, `CurrentActor` and `Entropy` (`diceOf` 64-bit mixer), `ExternalSystem` ports (`Sheets`, `Catalog`, `SetWorld`, `MapForge`, `Seating`, `Knocks`), `intake`, lenient `readLog`, shared multi-square `rules/board/`, `prose.ts` (`ProseSchema`), the campaign stage (`rules/core/stage.ts` for its commands and events, `stage.ts` for `stageOf`, `prep.ts` for `prepStage`), `party.ts`, `commandInput.ts` (`COMMAND_CLASSES`, `HOST_FACT_KEYS`, `commandFromInput` for agents), and the always-composed closure-erased `RULESETS` registry (`core`, `drawSteel`, `setWorld`, `pf2e`, `freeform`).
- `packages/platform-jsonl`: generic `Domain.Platform` implementation over `CampaignLog` (`events.jsonl`, `events.lock`, or a capped in-memory log via `layerMemory`, UTF-8 `ignoreBOM`, 64-line tail ring, torn-line truncation, defect-safe single-writer `send`, 1,024-entry LRU receipt cache, scoped `PubSub` shutdown).
- `packages/ssh`: our SSH server and client on `ssh2@1.17.0` with `patches/ssh2@1.17.0.patch` adding `mlkem768x25519-sha256` via `@noble/post-quantum` and an `env` option on `Client.subsys`. Key auth (strict `Object.is(key.verify(...), true)`) and keyless guests, per-session Effect scopes, raw mode for the relay, `relaySubsystems` (pinned relays only) and actor-bearing `subsystems` (a relayed one needs `SV_ACTOR`), outbound `attach()` + `connectClient()`, and stranger bounds (per-address and global connection/session caps, session/connect rate limits, login and idle timeouts, keepalives, rekey caps, 4 MiB socket/channel backpressure caps).
- `apps/supervillain`: the one binary (`src/main.ts`, `effect/cli`):
  - `content/`: `campaign.yaml` (`rules: draw-steel | set-world | pf2e | freeform`, or `rules` in `table.md`), typed Markdown (`markdown.ts` frontmatter and GM-note splitting, `prose.ts`, `frontmatter.ts` Schemas, `kinds.ts`, `ContentIndex.ts` `loadIndex`, `validate.ts` `crossCheck` and `validateCampaign`, `cards.ts` player-safe cards and freeform sheets, `jsonSchema.ts` for `supervillain schema`), hero/PC/monster/map YAML loaders on Effect `FileSystem`/`Path`, `CampaignContent` catalog, Steel Compendium bestiary import, Pathbuilder JSON import, seeded map generator (`mapgen.ts`, `newMap.ts`), and `newCampaign.ts` (`makeCampaign` and the embedded `examplePath`, shared by `new` and the launcher).
  - `table/`: Solid + OpenTUI 0.9.7 UI (`view.ts`, `keep.ts`, `panels.ts`, `band.ts`, text `MapPane.tsx`, kitty-graphics `PictureMap.tsx` with MEKMODE `atlas/`, `mouse.ts`, and GM `Prep.tsx`).
  - `host/`: Effect edge (`TableRoom`, `Presence`, `Knocks` for knocks and invites, `GmKey`, `SetWorld` on `HttpClient`, `AutoFoes` for set.world `/auto foes`, `tableServices` and the in-memory `sandboxServices` (`memoryPorts.ts`), `line.ts`, `Seat` with the knock seat, `TableServer` (also serving `mcp-1@supervillain.sh`), `lobby.ts`, `RelayLink` with synchronous `relay_known` pinning, `LocalSeat`, and `check`).
  - `mcp/`: agents on Effect's `effect/ai/McpServer` (ADR 0020): `session.ts` (`mcpSession`, a fresh `McpServer.layerStdio` per session), `stdio.ts` (`duplexStdio`), `schema.ts` (tool JSON Schemas from command classes), `tools.ts`, `resources.ts`, `view.ts` (player-safe and GM state), `socket.ts` (`McpSocket`, `mcp.sock`), `bridge.ts` (`supervillain mcp`), and `gmKeys.ts`.
  - `relay/`: `supervillain relay` (`protocol.ts` v2 with `parseAddress` and the `knows-1@supervillain.sh` lobby MAC, `handles.ts`, `pairings.ts`, the three-tab `lobby/` (`frame.ts`, `keys.ts`, `create.ts`, `osc52.ts`), `sandbox.ts` for Try a Table, and `server.ts`, which also routes players' `mcp-1@supervillain.sh` agents).
  - `launcher/`: bare `supervillain` in a terminal (`GmConfig.ts` for `gm.json`, `scan.ts`, the pure `wizard.ts`, and the Solid `Launcher.tsx`).
- `packages/site`: the Foldkit + `@foldkit/markdown` + `@alchemy.run/cloudflare` static site, docs, acknowledgments, and playable Draw Steel front-page terminal demo.
- `tools/oxlint/`: vendored `anti-slop` plugin and local `supervillain/` plugin (`no-comments` + `comments.ts` checker).
- `scripts/`: `build.ts` (`bun build --compile` with embedded sample campaign), `smoke.sh` (tmux TTY smoke harness), `deploy-relay.sh` (forced-command VPS deployer with checksum, version, atomic swap, and rollback), and `install.sh` (the POSIX installer the site serves at `/install`); `.github/workflows/{ci,release,relay-deploy,site-deploy}.yml`.
- `examples/campaign`: the sample Draw Steel campaign copied by `supervillain new --example` and exercised by end-to-end tests.

## Commands & CI/CD

- `bun install` — install workspace dependencies and patch `oxlint`/`tsrs` (`prepare`)
- `bun run fmt` — format with `oxfmt`
- `bun run check` — `oxfmt --check`, `oxlint --disable-nested-config`, `comments.ts check`, and `tsc -b`
- `bun run build` — `tsc -b` across the workspace
- `bun test` / `bun run test` — run all tests from the repo root (`bun run test` runs `bun test --parallel`; preloads Solid JSX transform via `bunfig.toml`)
- `bun supervillain host` — run the CLI from source
- `bun supervillain mcp <campaign-dir>` — connect an MCP agent's stdio to a table open on this machine, as its GM
- `bun --filter @supervillain/site build` — build and prerender the static site
- `bun run release:build` / `bun run release:smoke dist/supervillain-<os>-<arch>` — compile and smoke-test the standalone binary

CI/CD triggers:

- **`git push origin main`**: runs `ci.yml` (`bun run check`, `bun test --parallel`, site build, binary build + TTY smoke test) and, when `packages/site/**` changes, runs `site-deploy.yml` (`bun run check`, `bun test packages/site`, and Alchemy deploy to Cloudflare).
- **`git push origin vX.Y.Z`**: runs `release.yml` (`bun run check`, `bun test --parallel`, all 4 platform binaries, 3-platform TTY smoke tests, `SHA256SUMS`, SLSA build provenance attestation, GitHub Release) and, for stable (non-prerelease) tags, calls `relay-deploy.yml` to verify `SHA256SUMS` + `gh attestation verify` and roll out atomically to the relay VPS via `scripts/deploy-relay.sh` (`relay` GitHub Environment; also runnable manually via `workflow_dispatch` for rollbacks).
- **`git push origin main vX.Y.Z`**: runs all of the above in one push.

## References

- Old prototype: `~/Developer/projects/supervillain-old`. Read-only, lessons only, never code.
- OpenTUI source (API truth, never guess): `~/Developer/clones/github.com/anomalyco/opentui`. Read v0.9.7 with `git -C <clone> show v0.9.7:<path>`.
- Effect source: `~/Developer/clones/github.com/Effect-TS/effect`.
- Issues: GitHub (oscabriel/supervillain) via `gh`. External PRs are not a request surface.
