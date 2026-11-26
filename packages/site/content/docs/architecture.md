---
title: How it fits together
summary: One binary on the GM's machine holds the rules, SSH server, typed Markdown content, MCP control plane and JSONL log. The relay forwards bytes and pins GM handles.
order: 4
---

supervillain is one self-contained program. On the GM's machine it is the table: the rules, campaign content index, SSH server, local MCP control socket, every player's screen and the campaign log. On a VPS it runs as the relay. Players install nothing at all.

```text
  players' ssh / agents (-s mcp-1)
        │
        v
  ┌──────────────── relay (optional VPS) ────────────────┐
  │  handles.json · 3-tab lobby · ephemeral sandbox      │
  └────────────────────────┬─────────────────────────────┘
                           │ outbound GM link (gm_key)
                           v
  ┌─────────────────── GM's machine ─────────────────────┐
  │  SSH server + mcp.sock ─> intake + TableRoom         │
  │                              │                       │
  │                              v                       │
  │  pure rules: decide ─> events ─> events.jsonl        │
  │              apply  <────────────┘                   │
  │                              │                       │
  │  CampaignContent (typed .md) + TableView projection  │
  │  every seat redraws · player views strip GM notes    │
  └──────────────────────────────────────────────────────┘
```

## File over app, GM machine as authority

Every input, whether typed at a seat, clicked with the mouse, sent via SSH exec, or called by an AI agent over MCP, flows through the same `intake` and `Table` aggregate on the GM's machine. Accepted events append to `events.jsonl`, and every connected seat redraws from the resulting `TableState`.

`events.lock` guarantees a single writer per campaign. A failed append truncates back to its prior byte offset and halts further writes so the log is never half-written.

## Pure rules and deterministic replay

`packages/domain` depends only on `effect` and `@alchemy.run/domain`: no Effect runtime, no filesystem, no network, no clock, and no `Math.random`.

- `decide(state, actor, command, dice, now)` returns typed `Domain.Event` instances or a clean `Refused` rejection.
- `apply(state, envelope)` folds one event deterministically.

External facts (validated sheets, maps, stage cards, set.world rolls, pending knocks, seated players) are loaded in `intake` through `ExternalSystem` ports before `decide` runs and embedded into event payloads. Replay never rolls dice or reads external files, so `events.jsonl` alone rebuilds the entire campaign.

## Typed Markdown content and visibility

Campaign prep lives as typed Markdown files (`table.md`, `party/`, `npcs/`, `monsters/`, `scenes/`, `handouts/`, `items/`, plus custom ruleset folders) alongside `maps/*.txt`. Frontmatter is validated with Effect Schema and cross-checked across folders by `CampaignContent` and `supervillain check`.

Visibility is enforced strictly on the host when projecting `TableView` and MCP views:

- `## GM Notes` (and equivalent GM/Director/DM/Secret headings plus HTML comments) are stripped during Markdown parsing and never enter `TableState` or `events.jsonl`.
- Cards have three tiers: `gm-only` (absent from state), `revealed` (browsable in `/codex`), and `on-table` (pinned to the Campaign Stage).
- `ContentWatch` watches content folders while a table runs, keeping the last valid snapshot on broken edits and holding back auto-sync if GM notes shrink while player-visible text grows.

## Effect runs the edge

[Effect 4](https://effect.website) manages every side effect as a `Context.Service` with composable layers: `CampaignLog` and `JsonlPlatform`, `TableRoom`, `Presence`, `Knocks`, `CampaignContent`, `ContentWatch`, `TableServer`, `RelayLink`, `GmKey`, `McpSocket`, and `Relay`. When a player disconnects, their session scope closes and releases every resource cleanly.

## Defensive SSH and post-quantum key exchange

`packages/ssh` wraps [ssh2](https://github.com/mscdex/ssh2) with a small patch adding post-quantum hybrid key exchange (`mlkem768x25519-sha256`, backed by `@noble/post-quantum`) first, plus environment forwarding on SSH subsystems for `mcp-1@supervillain.sh`.

- Strict public-key verification (`Object.is(key.verify(...), true)`), elliptic-curve only, no compression.
- Per-address and global connection/session caps, session rate limits, login and idle timeouts, keepalive cutoffs, rekey caps, and a 4 MiB backpressure ceiling.
- Knock-to-join membership (`core.member-admitted`) gates both interactive seats and agent sessions, with per-address knock caps and 10-minute deny cooldowns enforced even through a relay via opaque `SV_BUCKET` hashes.

## One UI app for every seat

The table UI is a single Solid app on OpenTUI rendering a pure, read-only `TableView`. It switches cleanly between the Campaign Stage (party strip, active scene, pinned cards, trackers, recap, Codex) and the tactical Battlemap (combat band plus text or kitty-graphics MEKMODE pixel tiles). Clicks never mutate state directly: they submit the exact slash command typing would send.

## The relay and lobby

`supervillain relay` stores zero campaign data. Its disk state is two SSH keys and `handles.json` mapping short GM handles (`ana`) to GM key fingerprints (`~/.config/supervillain/gm_key`).

- GMs dial out and present their GM key as the link host key; claim codes from the lobby's **Create a Table** tab are proven via `HMAC-SHA256(code, gmKeyFingerprint)` so codes never travel in cleartext.
- Returning players get privacy-preserving lobby discovery and short-name routing (`ssh first-fight@supervillain.sh`) via `knows-1@supervillain.sh` nonce+HMAC probes against live linked hosts.
- The **Try a Table** lobby tab runs a strictly capped, in-memory sandbox (`CampaignLog` memory layer, zero disk writes, zero outbound HTTP) so first-time visitors can explore a live table with nothing installed.

## Agent MCP control plane

`apps/supervillain/src/mcp/` builds on Effect's `effect/ai/McpServer` (supporting MCP protocols `2024-11-05` through `2025-11-25`) to expose every command for the campaign's ruleset as a typed JSON Schema tool, with host-fact keys stripped and rejected if forged. Local GM agents connect through an owner-only (`0600`) Unix socket via `supervillain mcp`; players and remote GMs connect over the `mcp-1@supervillain.sh` SSH subsystem. See [Connect an agent](/docs/agents).
