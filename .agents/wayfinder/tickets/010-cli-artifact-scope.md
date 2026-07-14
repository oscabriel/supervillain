---
status: closed
type: grilling
assignee: oscar
blocked-by: []
---

# CLI artifact scope

## Question

What does the `supervillain` CLI actually manage, and where do artifacts live? Surfaces decision says "minting and managing GM-hosted rooms, and probably characters, maps, etc." — pin down:

- The noun set: rooms/campaigns certainly; characters? maps? handouts? dice macros?
- The artifact home: a campaign directory of plain files on the GM's disk (JSONL log + sidecar artifact files)? A `~/.supervillain` workspace? Both?
- Campaign portability between GM machines (from the identity grilling's addendum): is "it's a file, move it yourself" enough for launch, or does the CLI owe export/import (or sync) commands?
- Which artifacts can be minted/edited _offline_ (no room live), vs only at the table?
- The web tie-in: publishing an artifact as a read-only capability URL — a CLI verb?

Recommendation pending discussion.

## Resolution

Accepted as recommended:

- **Noun set at launch: campaigns and characters.** Maps deferred — they drag in the battle-map (FrameBuffer) story, which is its own scope tier.
- **Home: a campaign directory of plain files on the GM's disk** — JSONL event log + human-readable sidecar character files a GM can hand-edit between sessions. No opaque database. **"You own your campaign"** is a product pillar (Oscar: "a strong signal") — marketing-page material alongside "your key is your account."
- **Portability: "it's a folder, move it" suffices for launch**; `export`/sync verbs are vN polish.
- **Publishing is a CLI verb** — `supervillain publish <artifact>` mints the read-only capability URL; the bridge that makes the web surface real.
- **Offline: characters editable offline**; rooms mintable/resumable but only playable with a live host.
