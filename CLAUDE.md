# supervillain — product definition phase

This repo is deliberately empty of code. It is the wayfinding ground for the final
supervillain product; the real project gets scaffolded (better-t-stack or otherwise)
only once the way is clear. Do not scaffold, add dependencies, or write product code
here — planning artifacts only.

## Destination (fixed)

A product definition for supervillain — surfaces, scope tiers (v0/v1/vN), architecture
seams, and monorepo shape — complete enough that the better-t-stack invocation (or the
decision that better-t-stack is wrong for this) is mechanical, and milestone 1 in the
new repo is specifiable with no product decisions left open.

## Wayfinder tracker (local-markdown)

No external issue tracker. The map and its tickets live in this repo:

- `wayfinder/map.md` — the map (label: `wayfinder:map`). Index only; never restates
  ticket detail.
- `wayfinder/tickets/NNN-<slug>.md` — one file per ticket. Frontmatter carries
  `status: open|closed`, `type: research|prototype|grilling|task`, `assignee`,
  `blocked-by: [NNN, ...]`. A ticket is claimed iff `assignee` is set; unblocked iff
  every `blocked-by` ticket is closed. Resolution comments are appended under a
  `## Resolution` heading before closing.
- Assets created while resolving a ticket go in `wayfinder/assets/`, linked from the
  ticket.

## Prior art — lessons only, never code

The previous prototype is scrapped; lift lessons, not files.

- Working prototype (M1–M3 of the old plan, verified over real SSH):
  `~/Developer/projects/supervillain` (`apps/ssh`). Read-only reference.
- The old plan (stack, state model, v0 room mockup, v1 iroh architecture):
  `~/Documents/sync-vault/projects/dev/supervillain/opentui-ssh-vtt-plan.md`
- Session handoff with hard-won verification/build lessons: `/tmp/supervillain-handoff.md`
  (ephemeral — copy anything load-bearing into wayfinder assets before trusting it to
  survive).
- OpenTUI source clone (API truth, never guess):
  `~/Developer/clones/github.com/anomalyco/opentui` @ `a0b9064`.

## Conventions

- Bun for anything runnable that sneaks in during prototyping tickets.
- Commit only when the user asks.
