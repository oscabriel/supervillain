---
title: Connect an agent
summary: Hook Claude Code, Codex, Cursor or T3 Code up to a live table over MCP so you can dictate scene updates, rolls and moves without memorizing commands.
order: 5
---

Every command at a supervillain table is a typed domain schema, and every state change redraws every connected terminal in milliseconds. You can run an AI agent right beside your terminal (or behind a voice-to-text tool) and let it drive the table live while you focus on the game.

Everything an agent sends goes through the exact same rules engine as typing or clicking:

- Every action is validated and written to `events.jsonl`, where `/undo` works normally.
- Player agents see only what that player's seat can see, and can only run legal actions for that player's SSH key.
- GM agents see the full table, GM notes, prep catalog and campaign files, and can update staged cards live.

## Player setup (nothing to install)

Players connect over the `mcp-1@supervillain.sh` SSH subsystem using their regular OpenSSH client and SSH key. Nothing needs to be installed on the player's machine.

First, make sure you have already connected interactively once (`ssh ana/first-fight@supervillain.sh`) so your SSH client has trusted the host key and your GM has admitted your key at the door. Guests without an SSH key can't connect agents.

### Claude Code

```sh
claude mcp add table -- ssh -T -o BatchMode=yes -o LogLevel=ERROR ana/first-fight@supervillain.sh -s mcp-1@supervillain.sh
```

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.table]
command = "ssh"
args = ["-T", "-o", "BatchMode=yes", "-o", "LogLevel=ERROR", "ana/first-fight@supervillain.sh", "-s", "mcp-1@supervillain.sh"]
```

### Cursor or T3 Code (`mcp.json`)

```json
{
  "mcpServers": {
    "table": {
      "command": "ssh",
      "args": [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "LogLevel=ERROR",
        "ana/first-fight@supervillain.sh",
        "-s",
        "mcp-1@supervillain.sh"
      ]
    }
  }
}
```

Once your key is admitted, you can also use your table's short name (`first-fight@supervillain.sh`) if it's the only live table of that name that knows your key. For direct non-relay tables, include `-p <port>` before the address.

## GM setup (local socket)

While your table is running on your laptop (`supervillain` or `supervillain host`), it creates a private `0600` Unix socket (`mcp.sock` inside the campaign folder, or under your private runtime directory for long paths). `supervillain mcp <campaign-dir>` bridges stdio straight to that running table as the GM.

### Claude Code

```sh
claude mcp add table -- supervillain mcp ~/supervillain/first-fight
```

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.table]
command = "supervillain"
args = ["mcp", "/Users/you/supervillain/first-fight"]
```

### Cursor or T3 Code (`mcp.json`)

```json
{
  "mcpServers": {
    "table": {
      "command": "supervillain",
      "args": ["mcp", "/Users/you/supervillain/first-fight"]
    }
  }
}
```

Because your campaign lives as typed Markdown files on your disk, your GM agent can also edit scenes, NPCs and handouts directly, call `validate_content` and `reload_content`, and immediately pin them onto the live table with `cmd_show`. Run `supervillain schema <campaign-dir>` (or let the agent read `supervillain://schema/*`) so it knows every valid frontmatter field.

### Optional: remote GM MCP via `gm_keys`

If you run a headless host on another machine and want to drive it as GM over SSH, place your SSH public key fingerprint (`SHA256:…`, one per line) in `<campaign-dir>/gm_keys` with mode `0600`. Connections from those keys on `mcp-1@supervillain.sh` act as GM; normal interactive SSH shells keep their regular key identity.

## Copy-paste setup prompts

Paste one of these prompts into your agent once the MCP server is added (replace `table` with the server name you chose).

### Co-GM prompt

```text
You are my co-GM for a live supervillain tabletop session through the `table` MCP server.

First, read `supervillain://help`, call `get_table_state`, and inspect the `supervillain://schema/*` resources if we are creating or editing campaign Markdown files.

During play, I will talk or dictate loosely ("put Old Mara on the table", "deal 6 damage to Brann and push him 2 east", "start the ford fight"). Translate my intent into the matching `cmd_*` tool calls (or `send_line` when a slash command is clearest).

Rules to follow:
1. Never invent dice results: always let the table roll.
2. Never edit `events.jsonl` directly. Use `cmd_undo` to reverse mistakes.
3. Before high-impact actions (ending combat, kicking a player, damaging multiple targets, or running `batch_commands`), briefly confirm what you plan to send if my intent was ambiguous.
4. Keep GM notes, hidden trackers, monster stat blocks and unrevealed files private; never paste them into public chat or narration.
5. When editing campaign `.md` files on disk, run `validate_content` and `reload_content` before staging them.
6. Use `wait_for_change` when I ask you to watch the table and summarize what players just did.
```

### Player prompt

```text
You are helping me play my character at a live supervillain table through the `table` MCP server, acting under my SSH key.

First, read `supervillain://help` and call `get_table_state` so you know my character, current scene or map, and whose turn it is.

During play, I will dictate my moves and lines naturally ("move behind the cart and hit the bruiser with Driving Blow", "say I don't trust the baron"). Translate what I say into the matching `cmd_*` tools (or `send_line` for chat and emotes).

Rules to follow:
1. If a target, square or ability is ambiguous, ask me a short clarifying question before sending.
2. Only take combat turns when it is my turn unless I explicitly ask.
3. Never assume or claim anything that isn't in `get_table_state`, `supervillain://codex/*`, or `supervillain://sheet/*`.
4. If the table refuses a move or rate-limits a request, tell me why plainly and wait.
5. Use `wait_for_change` when I ask you to watch for my turn or new scene updates.
```

## What agents can and can't see

| Surface | Player agent | GM agent |
| --- | --- | --- |
| Tools | Player-legal `cmd_*`, `send_line`, `get_table_state`, `wait_for_change`, `help` | All `cmd_*` (including stage, combat, admission, undo), `reload_content`, `validate_content`, `batch_commands`, `deny_knock`, `create_invite`, `set_auto_foes` |
| State (`get_table_state`) | Strictly player-safe: `seq`, `ruleset`, `myName`, `present`, `party`, `stage` (only `on-table` and `revealed`), `band`, `map`, `feed` | Full GM state plus `prep`, `gmNotes`, `contentProblems`, `knocks`, `catalog`, and recent log envelopes |
| Resources | `supervillain://help`, `supervillain://table/state`, `supervillain://sheet/{party-member}`, `supervillain://codex/{revealed-key}` | Everything players see, plus `supervillain://campaign/files`, `supervillain://campaign/{kind}/{id}`, `supervillain://schema/{kind}`, and any creature sheet |

## Safety

- **Host-fact rejection:** command fields that the host fills from disk or presence (`sheet`, `grid`, `card`, `cards`, `member`, `seated`, `character`, and similar) are stripped from every MCP tool schema and rejected if an agent tries to forge them.
- **Same permission boundary:** `Table.decide` enforces `gmOnly` and knock-to-join membership on every command regardless of whether it came from a terminal or MCP. Kicking a player closes their active MCP session immediately.
- **Bounds on player agents:** non-GM MCP sessions share the player's rate limit, cap concurrent in-flight requests, allow only one parked `wait_for_change` at a time, and reject oversized inputs before parsing.
- **Private local socket:** `mcp.sock` is staged inside a `0700` directory, locked to mode `0600`, and removed when the host closes. Anyone running as your OS user can connect to it while your table is open, just like they can read your campaign folder.

## Troubleshooting

- **SSH hangs or fails immediately with `Host key verification failed`:** connect once interactively (`ssh ana/first-fight@supervillain.sh`) to accept the host key, or add `-o StrictHostKeyChecking=accept-new` to your SSH args.
- **`Agents need an SSH key`:** generate one with `ssh-keygen -t ed25519`, knock at the table interactively once so your GM admits it, then reconnect your agent.
- **`Knock first: the GM hasn't let you in.`:** join interactively first so your GM can admit your key.
- **`no table open in <dir>`:** start your table locally (`supervillain` or `supervillain host <dir>`) before connecting `supervillain mcp`.
- **`This table's host is too old to take agents.`:** ask your GM to upgrade with `curl -fsSL https://supervillain.sh/install | sh`.
