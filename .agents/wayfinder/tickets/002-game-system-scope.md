---
status: closed
type: grilling
assignee: oscar
blocked-by: []
---

# Game-system scope

## Question

Is supervillain a **Draw Steel product**, or a **system-agnostic terminal VTT that
launches with Draw Steel**?

Radiates into: data model (hardcoded TS constants vs content/plugin layer), CLI
artifact formats (Draw Steel character files vs generic schemas), scope tiers, and
the marketing-page promise. Legal edge regardless of answer: Draw Steel content is
governed by MCDM's creator license — see
[Draw Steel license research](003-draw-steel-license.md).

Recommendation on the table (pending Oscar's call): Draw Steel product through v0/v1,
with one cheap concession to agnosticism — rules data stays out of the core state
model (events carry picks; static game data lives in its own module, as the prototype
already did). No plugin system, no generic schemas, no multi-system promise.
Multi-system, if ever, is a vN redraw.

## Resolution

**System-agnostic base, Draw Steel first.** Recommendation overridden: the base is
system-agnostic by design, with initial focus on Draw Steel and a stated intention to
expand to other games in the near future — e.g. **Mothership** and **Mörk Borg**.

Consequences:

- The core (state model, rooms, presence, dice, artifacts) must be game-neutral; each
  game's content, character schema, and creation flows live in a per-game module. The
  shape of that boundary is now its own design question — spawned
  [Game module seam](006-game-module-seam.md).
- Multi-system is roadmap truth, so the marketing promise can say so — but launch
  focus stays Draw Steel.
- Licensing is now per-game: [Draw Steel license research](003-draw-steel-license.md)
  covers launch; expansion-system licenses (Mothership, Mörk Borg third-party terms)
  are fog until expansion is scheduled.
