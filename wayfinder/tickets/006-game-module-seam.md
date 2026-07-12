---
status: open
type: grilling
assignee:
blocked-by: [005]
---

# Game module seam

## Question

What is the seam between the system-agnostic core and a game module? Concretely: what
does a game package *provide* (static content, character schema, creation-wizard flow,
dice idioms, terminology) and what does the core *own* (rooms, seats, presence, event
log, feed, generic dice)? Where do per-game artifacts (characters, maps) get their
schemas? The answer must be cheap enough that v0 ships Draw Steel without building a
plugin framework, yet real enough that adding Mothership or Mörk Borg later is adding
a module, not forking the core.

Use `/codebase-design` vocabulary; lean on the prototype's proven state seams (event
log carries picks, static game data in its own module) once
[Preserve prototype lessons](005-preserve-prototype-lessons.md) lands — hence the
blocking edge.
