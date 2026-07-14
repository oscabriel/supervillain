---
status: closed
type: grilling
assignee: oscar
blocked-by: []
---

# Product surfaces

## Question

What surfaces does the _final_ supervillain product comprise? Candidates from prior art: the SSH table via gateway (proven prototype), GM-hosted rooms + CLI over iroh (old v1 pitch), a web surface (ranging from marketing page to full parallel VTT client), payments/hosting tiers.

## Resolution

Three surfaces, terminal-first:

1. **SSH terminal tabletop** — players `ssh` into rooms; the proven core.
2. **`supervillain` CLI** — minting and managing GM-hosted rooms, and probably artifacts: characters, maps, etc. (exact scope → fog: "CLI artifact scope").
3. **Web surface with a backend** — marketing pages, docs, read-only artifacts, and (down the line) an **in-browser terminal** for users who don't want a desktop terminal, connecting to the _same_ sessions a real terminal reaches.

Explicitly not a surface: a parallel web VTT client. The browser terminal is a thin client into the existing session infrastructure, not a second implementation — spawned research ticket [Browser terminal bridge](004-browser-terminal-bridge.md). Payments remain fog until scope tiers firm up.
