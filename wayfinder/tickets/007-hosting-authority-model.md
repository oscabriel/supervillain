---
status: closed
type: grilling
assignee: oscar
blocked-by: []
---

# Hosting & authority model

## Question

Where does room authority live, and what does supervillain.now durably store? The old
plan's answer was **both**: gateway-hosted rooms (created from the lobby TUI, persist
while the GM sleeps, logs on the server) *and* GM-hosted rooms (created via
`supervillain create`, campaign JSONL on the GM's disk, reached over iroh, gateway as
doorway-not-landlord). Options now:

1. Both, as the old plan had it — gateway-hosted is the v0 path, GM-hosted the flagship.
2. GM-hosted only — supervillain.now holds nothing but the name registry; purest pitch,
   but no room exists unless a GM's machine is up, and v0 gets harder.
3. Gateway-hosted only — simplest ops, but kills the "GM brings the table" identity
   and the CLI surface's reason to exist.

Recommendation on the table: option 1 (both), with the RoomStore seam (in-process
store vs iroh client, one interface) as the architectural commitment that keeps them
one codebase.

## Resolution

**Both — with GM-hosted rooms as the center of gravity.** Oscar's framing: "a game
necessarily has a GM," so GM-hosted is the mode he's most interested in; gateway-hosted
is supported and worth exploring alongside it.

Consequences:

- The RoomStore seam (one interface; in-process store or iroh client behind it) is a
  standing architectural commitment — both modes share one codebase and one reducer.
- GM-hosted-as-priority makes iroh viability a launch-path question, not a vN one —
  spawned [iroh transport viability](008-iroh-viability.md).
- Which mode leads v0 (gateway-first for speed vs GM-first for identity) is now a
  sharp sub-question of scope tiers — it stays in that fog until tiers are grilled.
- supervillain.now durably stores: gateway-hosted room logs + the name→NodeId registry
  for GM-hosted rooms. Nothing durable for GM-hosted tables themselves.
