---
status: closed
type: task
assignee: pi:lessons
blocked-by: []
---

# Preserve prototype lessons

## Question

(AFK task — unblocks decisions by making prior-art lessons durable and citable.)

`/tmp/supervillain-handoff.md` is ephemeral and holds hard-won lessons: OpenTUI
gotchas, SSH/PTY verification technique, the state-model seams that worked
(event-log reducer, transient presence out of the log, `onDispatch` persistence seam,
guest→key adoption), and delegation patterns. Distill the *lessons* (never code, never
old-plan scope) into `wayfinder/assets/prototype-lessons.md` and link it here. Also
sweep the old plan doc (`~/Documents/sync-vault/projects/dev/supervillain/
opentui-ssh-vtt-plan.md`) for still-true architectural facts worth carrying (e.g. the
v1 iroh "connections only, single-writer host" analysis) vs decisions this map will
remake.

## Resolution

Preserved the prototype's proven state seams, OpenTUI API gotchas, real-SSH/PTY
verification method, still-sound iroh analysis, explicit old-plan supersessions, and
delegation lessons in [prototype lessons](../assets/prototype-lessons.md). No prototype
code or inherited milestone decisions were carried forward.
