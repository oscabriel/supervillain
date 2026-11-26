---
title: Hosting a table
summary: File over app. Install one binary, keep your campaign as typed Markdown and a JSONL log on your own disk, and invite players with one SSH address.
order: 2
---

Your machine is the table. Every campaign stays on your own disk as plain typed Markdown files, text maps and an append-only `events.jsonl` log. Players need only `ssh`; send them [Playing at a table](/docs/playing).

## Quick start (with a handle on supervillain.sh)

Try the table first with `ssh supervillain.sh` (open **Try a Table** for an instant solo sandbox, or **Create a Table** to reserve your GM handle with your SSH key and get a personalized setup command).

Or install directly from your terminal:

```sh
curl -fsSL https://supervillain.sh/install | sh
supervillain
```

The installer verifies `SHA256SUMS` (failing closed on any mismatch) and places `supervillain` in `~/.local/bin`. Running bare `supervillain` opens the local GM launcher: it scans `./` and `~/supervillain` for campaigns, walks you through creating a new table with a built-in wizard, and links your table to `supervillain.sh` under `<handle>/<table>` automatically (pass `--local` to stay off the relay).

You can also download any release binary and `SHA256SUMS` manually:

| File | For |
| --- | --- |
| `supervillain-linux-x64` | Linux on Intel or AMD (glibc) |
| `supervillain-linux-arm64` | Linux on ARM (glibc), such as a Raspberry Pi or ARM VPS |
| `supervillain-darwin-arm64` | macOS on Apple silicon |
| `supervillain-darwin-x64` | macOS on Intel |

On macOS, if you download through a browser rather than `curl`, clear quarantine with `xattr -d com.apple.quarantine supervillain-darwin-arm64`. To run from source instead, install [Bun](https://bun.sh), run `bun install`, and use `bun supervillain …`.

## Creating and opening tables from the CLI

```sh
supervillain new ~/supervillain/first-fight --example
supervillain host ~/supervillain/first-fight --handle ana --relay supervillain.sh
```

Or create and open in one step (linking under your saved handle in `~/.config/supervillain/gm.json`):

```sh
supervillain new first-fight --rules draw-steel --handle ana --open
```

When you claim a handle in the `ssh supervillain.sh` **Create a Table** tab, it prints a single-use `--claim sv-…` code that links your laptop's GM key (`~/.config/supervillain/gm_key`) to your handle using a key-bound HMAC proof, so the claim code never travels in cleartext.

| Option (`host`) | What it does |
| --- | --- |
| `--handle <you>` | Your GM handle on a relay (`ssh <handle>/<table>@…`) |
| `--table <name>` | The table's name (defaults to the folder's slug; `--room` is an alias) |
| `--door knock\|open` | Require newcomers to knock (default) or let anyone sit straight down |
| `--relay host[:7022]` | Dial out to a relay (`--relay-key` pins its fingerprint) |
| `--claim sv-…` | Pair this machine's GM key to a handle claimed over SSH |
| `--port 2222` | Local SSH port (`0` picks a free port) |
| `--bind 127.0.0.1` | Local interface (`0.0.0.0` for LAN or Tailscale) |
| `--no-lobby` | Keep this table out of the relay's lobby |
| `--headless` | Run without a local GM seat (logs to stdout; still serves `mcp.sock`) |

## Letting players in

Every new table starts with its door set to knock. When a new player connects to `ssh ana/first-fight@supervillain.sh`, they see the door, choose a display name, and knock. A banner appears at the top of your GM screen showing their name and short key fingerprint:

```text
⚑ Ana (ab12cd34) knocks · [Admit] [Deny]
```

Click a button, press `Alt+Y` or `Alt+N`, or type `/admit Ana` or `/deny Ana`. Admitting writes `core.member-admitted` to `events.jsonl` so their SSH key enters straight away next time. Denying turns them away and puts their key and address bucket on a 10-minute cooldown.

- `/kick Ana` closes their live seat immediately and requires them to knock again (even if they have an invite token).
- `/invite [uses] [minutes]` mints an in-memory invite token (`ssh ana/first-fight~token@supervillain.sh`) for groups you want to pre-admit.
- `/door open` or `/door knock` toggles knocking on the fly.

## The campaign folder (typed Markdown)

Campaign folders are private (`0700`) and designed to be edited in any text editor, Obsidian, git, or by an AI agent:

```text
first-fight/
  table.md           # campaign title, pitch, ruleset, start scene, sync mode
  party/*.md         # player characters (or legacy heroes/*.yaml)
  npcs/*.md          # NPC cards with optional monster: link
  monsters/*.md      # enemy stat blocks (or legacy monsters/*.yaml)
  scenes/*.md        # read-aloud text, linked NPCs, handouts, trackers, encounter setup
  handouts/*.md      # prose, clues, ASCII art, or non-battle maps
  items/*.md         # custom items and gear
  ancestries/*.md    # optional custom ruleset content
  classes/*.md       # optional custom ruleset content
  abilities/*.md     # reusable abilities referenced by party sheets
  maps/*.txt         # ASCII or MEKMODE tactical and region maps
  events.jsonl       # append-only live campaign log (machine-written)
```

Every `.md` file starts with YAML frontmatter validated by Effect Schema. Inside the Markdown body:

- `## Read Aloud` is framed distinctly on the Campaign Stage when shown to players.
- `## GM Notes` (as well as `## Director's Notes`, `## DM Notes`, `## Secrets`, and HTML comments) is stripped automatically before anything reaches a player seat or the log. Only your GM seat sees it.

### Fail-fast checks, JSON Schemas, and live hot-reload

- **`supervillain check <dir>`** validates every Markdown file's frontmatter, checks cross-references (a scene referencing a missing NPC, handout or map fails fast with the exact file and field), flags suspicious GM-note formatting, and replays `events.jsonl`.
- **`supervillain schema <dir>`** emits JSON Schema files (draft 2020-12 or `--draft 07`) and an `index.json` glob map into `<dir>/schemas/` for editors and agents.
- **Hot-reload:** while a table is running, editing a valid Markdown file refreshes your prep catalog and auto-syncs updated cards on the stage (`sync: auto` in `table.md`). If a file edit breaks validation, the table never crashes: it keeps the last valid snapshot and raises an alert in your header and Prep panel. If an edit shrinks GM notes while growing player text, auto-sync holds that card back until you explicitly confirm with `/sync`.

Host runtime files in the campaign folder: `events.jsonl` (the log), `events.lock` (single-writer PID lock), `host_key` (direct SSH host identity), `host.log`, `mcp.sock` (owner-only local agent socket while running), optional `relay_known`, and optional `gm_keys` (fingerprints granted remote GM MCP access).

## Staging scenes and running fights

Press `Alt+5` or `/prep` on your GM seat to open the Prep column. From there (or with slash commands) you control what players see on the table:

- `/show <ref>` pins a scene, NPC, handout or item onto the Campaign Stage (`on-table`).
- `/reveal <ref>` unlocks a card into the party's `/codex` without pinning it to the stage.
- `/unpin <ref>` moves a pinned card to the Codex; `/hide <ref>` removes it from players' view completely.
- `/tracker` and `/tick` manage clocks, counters and quests (new trackers start hidden until `/tracker <id> show`).
- `/recap <text>` adds a beat to the visible session recap.
- Clicking **Start fight** on a prepared scene loads its map, places its monsters, and flips every player's screen from the Campaign Stage into the tactical Battlemap automatically. Ending combat returns everyone to the Campaign Stage with updated health, resources and conditions intact.

## Connecting an AI co-GM

While your table is running, it opens an owner-only Unix socket (`mcp.sock`) so Claude Code, Codex, Cursor or T3 Code can connect with `supervillain mcp <campaign-dir>`, read your campaign schemas and GM notes, edit Markdown files, and drive the live table as you talk. See [Connect an agent](/docs/agents).

## Reaching your players

By default, bare `supervillain` and `new --open` dial the public relay (`supervillain.sh:7022`, players on port 22). You also have three self-managed options:

1. **Same network or Tailscale:** `supervillain host <dir> --bind 0.0.0.0` (players connect to your LAN IP or tailnet name on port 2222).
2. **A TCP tunnel:** `bore local 2222 --to bore.pub`, or `ssh -N -R 0.0.0.0:2222:127.0.0.1:2222 you@your.vps`.
3. **Your own relay on a small Linux VPS:** 1 vCPU and 512 MB RAM is plenty:

```sh
supervillain relay \
  --dir /var/lib/supervillain-relay \
  --bind 0.0.0.0 \
  --player-port 22 \
  --gm-port 7022 \
  --public-relay table.example.com:7022
```

The relay keeps no campaign data and stores only `host_key`, `relay_key`, and `handles.json` (binding handles to GM key fingerprints). Because players' SSH terminates at the relay, the relay sees live frames in transit and vouches for relayed player identities. Use a relay you trust, or run your own.

## Rulesets and imports

Pass `--rules draw-steel` (default), `--rules set-world`, `--rules pf2e`, or `--rules freeform` to `supervillain new`, or set `rules:` in `table.md` or `campaign.yaml`.

- Import Steel Compendium bestiary JSON into Draw Steel monsters: `supervillain import <bestiary-path> --into <dir>`
- Import a Pathbuilder 2e JSON export into a `pf2e` PC sheet: `supervillain import pathbuilder <export.json> <dir>`
- Generate a seeded MEKMODE battlemap: `supervillain map crossing <dir> --seed 7` (or `keep`)

See [Rulesets](/docs/rulesets) for full mechanics.
