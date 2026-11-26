# supervillain

A terminal-first virtual tabletop over SSH. Players join with one command (`ssh <handle>/<table>@supervillain.sh`) with nothing to install and no account to make, knock at the door, and sit down at a live campaign stage and tactical board. The GM runs one local binary and keeps every campaign file on their own disk as plain typed Markdown, text maps, and an append-only JSONL log.

![A live Draw Steel fight in supervillain](docs/assets/table.png)

- **Zero install for players, instant taste over SSH:** Run `ssh supervillain.sh` to join live tables that know your SSH key, explore an ephemeral Draw Steel sandbox (**Try a Table**), or reserve a GM handle and get a one-line setup command (**Create a Table**).
- **File over app for GMs:** Your campaign is a plain local folder (`table.md`, `party/`, `npcs/`, `monsters/`, `scenes/`, `handouts/`, `items/`, `maps/`, and `events.jsonl`) validated by Effect Schema, with `## GM Notes` automatically stripped from every player view and live hot-reload while you play.
- **Campaign stage and battlemap:** Players always see the party strip and shared feed while the GM stages scenes, read-aloud prose, NPCs, handouts, drawings, clocks, and recaps, then flips everyone into the tactical map (text or kitty-graphics MEKMODE pixel tiles) when combat starts.
- **Four rulesets out of the box:** Draw Steel (default), `set.world`, PF2e Remaster under the ORC License (`rules: pf2e`), and `freeform`, all sharing one log, knock-to-join admission, click-to-act mouse menus, and `/undo`.
- **Live AI agents over MCP:** Connect Claude Code, Codex, Cursor, or T3 Code locally via `supervillain mcp` (GM) or zero-install over SSH via `mcp-1@supervillain.sh` (players and remote GMs) to dictate moves and scene updates live.

## Quick start

**Try it right now** (no install):

```sh
ssh supervillain.sh
```

**Install & launch as a GM** (Linux or macOS):

```sh
curl -fsSL https://supervillain.sh/install | sh
supervillain
```

Running bare `supervillain` opens the local GM launcher, scans `./` and `~/supervillain` for campaigns, walks you through creating a new table, and links it to `supervillain.sh` under your handle (pass `--local` to host on localhost only).

Or from the CLI directly:

```sh
supervillain new ~/supervillain/ford --example
supervillain host ~/supervillain/ford --handle <you> --relay supervillain.sh
```

**Join as a player** (needs only `ssh`):

```sh
ssh <handle>/ford@supervillain.sh
```

Plain text is chat, `/` runs commands, `Tab` completes, `/help` lists everything, and `Ctrl-C` leaves. Pass `--rules draw-steel | set-world | pf2e | freeform` to `supervillain new`.

## Install

- **Installer script:** `curl -fsSL https://supervillain.sh/install | sh` (verifies `SHA256SUMS` and fails closed on mismatch).
- **Manual release binary:** Download `supervillain-<os>-<arch>` and `SHA256SUMS` from GitHub Releases — see [docs/HOSTING.md](docs/HOSTING.md#install).
- **From source:** Install [Bun](https://bun.sh) 1.4.5+, run `bun install`, then `bun supervillain …` from the repo root.

## Guides

- [docs/PLAYING.md](docs/PLAYING.md) — player guide (door, lobby, campaign stage, keyboard, mouse, commands)
- [docs/HOSTING.md](docs/HOSTING.md) — GM launcher, typed Markdown campaigns, handles, knock-to-join, and relay hosting
- [docs/AGENTS-SETUP.md](docs/AGENTS-SETUP.md) — connecting Claude Code, Codex, Cursor, or T3 Code over MCP + copy-paste setup prompts
- [docs/rulesets/](docs/rulesets/) — [Draw Steel](docs/rulesets/draw-steel.md), [set.world](docs/rulesets/set-world.md), [PF2e Remaster (ORC)](docs/rulesets/pf2e.md), [Freeform](docs/rulesets/freeform.md)
- [docs/how-it-works.md](docs/how-it-works.md) — architecture, invariants, and [ADRs](docs/adr/)

## Develop

Requires [Bun](https://bun.sh) 1.4.5+ and Node 26+ (for `oxlint.config.ts` and `.ts` lint plugins).

```sh
bun install
bun run fmt            # format with oxfmt
bun run check          # oxfmt --check, strict oxlint, zero-comment check, and tsc -b
bun run build          # tsc -b across all workspaces
bun run test           # run the full test suite in parallel (or `bun test`)
bun run release:build  # compile dist/supervillain-<os>-<arch> (--all for every platform)
bun run release:smoke dist/supervillain-linux-x64
```

- **CI & site CD:** Pushing to `main` runs `.github/workflows/ci.yml` and automatically deploys `packages/site` (including `/install`) to Cloudflare via `.github/workflows/site-deploy.yml` when `packages/site/**` or `scripts/install.sh` changes.
- **Releases & relay CD:** Pushing a stable `v*` tag runs `.github/workflows/release.yml` (check, full tests, 4-platform binaries, 3-platform TTY smoke tests, `SHA256SUMS`, SLSA attestation, GitHub Release) and automatically upgrades the relay VPS via `.github/workflows/relay-deploy.yml` and `scripts/deploy-relay.sh`.

See [AGENTS.md](AGENTS.md) for workspace layout and engineering rules.

## License & Notices

[MIT](LICENSE). See [NOTICE](NOTICE) for third-party attributions and [docs/ORC-NOTICE.md](docs/ORC-NOTICE.md) for the Open RPG Creative (ORC) License notice covering the `pf2e` ruleset.

---

supervillain is an independent product published under the DRAW STEEL Creator License and is not affiliated with MCDM Productions, LLC. DRAW STEEL © 2024 MCDM Productions, LLC.
