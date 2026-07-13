---
status: closed
type: task
assignee: claude
blocked-by: [014, 015]
---

# Assemble the product definition

## Question

(AFK task — the destination itself.) Assemble the final product definition document
from the map's closed tickets: surfaces, pillars ("your key is your account", "you
own your campaign"), system-agnostic base + game module seam, hosting/authority
model, identity, CLI scope, business shape, brand voice (one paragraph), web launch
scope, scope tiers (v0/v1/vN), monorepo shape, and the better-t-stack invocation (or
its replacement). Output: `wayfinder/assets/product-definition.md` — complete enough
that scaffolding the real repo is mechanical and milestone 1 is specifiable with no
product decisions left open. This closing marks the map done.

## Resolution

Assembled 2026-07-13. Output: [product-definition](../assets/product-definition.md)
(~400 lines) — drafted by a delegated agent from tickets 001–015 and all six assets,
then head-reviewed against the map. Covers: pitch, surfaces, four named pillars, the
game module seam (gisted, asset-linked), hosting/authority, identity, CLI scope,
business shape, brand voice (one paragraph), web launch scope, the full tier table
(v0–vN), monorepo shape & stack with the no-invocation bts verdict, milestone 1 fully
specified (first commit → iroh CI gate → v0 slice, plus the verify-at-scaffold
caveats), binding license constraints with the exact independence notice, and the
named-churn ledger + open fog.

Review fixes applied: CLI verb pinned to `create` (the resolutions' consistent verb;
set = create/join/publish), and the entry-point table corrected to show `content` is
also read by `authority` and `view`.

Two items surfaced for the user, not blockers: the independence notice substitutes
the lowercase locked name "supervillain" into the license template (legal form/
capitalization unverified), and it carries "© 2026" verbatim from the license asset.
Both live in the Licensing section; confirm at counsel review, which is already a
pre-monetization gate.

This closing marks the map done.
