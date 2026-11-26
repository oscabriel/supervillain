# Connecting an AI Agent to supervillain (MCP)

Every action at a supervillain table is a typed domain command, and every accepted change redraws every connected terminal in real time. You can run an AI agent (Claude Code, Codex, Cursor, or T3 Code) right beside your terminal — or behind voice dictation — and let it stage scenes, roll dice, move tokens, and update campaign files live while you play.

Everything an agent sends goes through the same `intake` and `Table` rules engine as typing or clicking:

- Accepted actions append to `events.jsonl` and can be reversed with `/undo`.
- Player agents see only what that player's seat can see and can only submit legal player commands for their SSH key.
- GM agents get full GM tools, GM notes, prep catalog, and direct access to campaign Markdown files and schemas.

## Player setup (zero install over SSH)

Players connect through the `mcp-1@supervillain.sh` SSH subsystem using their regular OpenSSH client and SSH key — nothing to install.

Connect interactively once first (`ssh <handle>/<table>@supervillain.sh`) so your SSH client trusts the host key and your GM admits your key at the door. Keyless guests cannot attach agents.

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

Once admitted, you can also use the table's short name (`first-fight@supervillain.sh`) if it's the only live table of that name that knows your key. For direct non-relay hosts, pass `-p <port>` before the destination.

## GM setup (local Unix socket)

While your table is open locally (`supervillain` or `supervillain host`, including `--headless`), the host creates a private `0600` Unix socket (`<campaign>/mcp.sock`, or under your private runtime directory when the campaign path exceeds 84 bytes). `supervillain mcp <campaign-dir>` bridges MCP stdio directly to that running table as the GM.

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

Because campaign content lives as typed Markdown files on your disk, your GM agent can edit `scenes/`, `npcs/`, `handouts/`, `items/`, and `party/` directly, validate them with `validate_content`, refresh the live snapshot with `reload_content`, and immediately pin cards onto the table with `cmd_show`. You can also emit editor/agent JSON Schemas with `supervillain schema <campaign-dir>` or let the agent read `supervillain://schema/*`.

### Optional: remote GM MCP via `gm_keys`

If you run a headless host on a server and want to control it as GM over SSH, create `<campaign-dir>/gm_keys` (mode `0600`, owned by the host user) with one `SHA256:…` SSH public key fingerprint per line. Connections from those keys on `mcp-1@supervillain.sh` act as GM; interactive SSH shells keep their regular `key:SHA256:…` player identity.

## Copy-paste setup prompts

Paste one of these prompts into your agent after adding the MCP server (replace `table` with the server name you chose).

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

## Role boundaries and safety

| Surface | Player agent | GM agent |
| --- | --- | --- |
| Tools | Player-legal `cmd_*`, `send_line`, `get_table_state`, `wait_for_change`, `help` | All `cmd_*` (stage, combat, admission, undo), `reload_content`, `validate_content`, `batch_commands` (up to 32 steps, each undoable), `deny_knock`, `create_invite`, `set_auto_foes` |
| State (`get_table_state`) | Strictly player-safe: `seq`, `ruleset`, `myName`, `present`, `party`, `stage` (`on-table` and `revealed` only), `band`, `map`, `feed` | Full GM state plus `prep`, `gmNotes`, `contentProblems`, `knocks`, `catalog`, and recent log envelopes |
| Resources | `supervillain://help`, `supervillain://table/state`, `supervillain://sheet/{party-member}`, `supervillain://codex/{revealed-key}` | Everything players see, plus `supervillain://campaign/files`, `supervillain://campaign/{kind}/{id}`, `supervillain://schema/{kind}`, and any creature sheet |

- **Host-fact rejection:** Command fields normally filled by the host (`sheet`, `grid`, `card`, `cards`, `member`, `seated`, `character`, etc.) are omitted from every MCP tool schema and rejected if supplied.
- **Foreign-ruleset protection:** `batch_commands` rejects commands that do not belong to the campaign's active ruleset.
- **Membership & kick enforcement:** `Table.decide` enforces `gmOnly` and knock-to-join membership identically on MCP and terminal seats; `/kick` or `/door knock` severs active non-member MCP sessions immediately (even while parked in `wait_for_change`).
- **Player bounds:** Non-GM MCP sessions share the player's rate limit, cap concurrent in-flight requests at 4, allow at most 1 parked `wait_for_change`, and reject oversized inputs before parsing.
- **Socket safety:** `mcp.sock` is staged inside a fresh `0700` directory, locked to `0600`, checked with `lstat` (no symlink traversal, owner-only), and removed on shutdown. If the socket cannot bind, `supervillain host` logs a warning and keeps hosting normally.

## Troubleshooting

- **`Host key verification failed`:** Run `ssh ana/first-fight@supervillain.sh` interactively once to accept the host key, or add `-o StrictHostKeyChecking=accept-new`.
- **`Agents need an SSH key`:** Generate one with `ssh-keygen -t ed25519`, knock at the table interactively so your GM admits it, then reconnect.
- **`Knock first: the GM hasn't let you in.`:** Connect interactively first and wait for your GM to admit your key.
- **`no table open in <dir>`:** Start your table (`supervillain` or `supervillain host <dir>`) before running `supervillain mcp`.
- **`This table's host is too old to take agents.`:** Ask your GM to upgrade (`curl -fsSL https://supervillain.sh/install | sh`).
