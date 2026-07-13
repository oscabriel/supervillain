---
status: closed
type: grilling
assignee: oscar
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

## Resolution

Grilled 2026-07-12/13. Full spec with all amendments:
[game-module-seam](../assets/game-module-seam.md). The gist:

- **A game module is code** — a TypeScript package behind a small core-defined
  interface, statically imported, compile-time registered. No DSL, no plugin
  framework.
- **Four entry points, one package:** `model` (S/C/E, init, apply — pure),
  `authority` (decide — all randomness and authority), `view` (panels + renderEvent),
  `content` (packaged data + terminology + file validators). Host = model+authority,
  gateway = model+view (folds apply over the stream), CLI = model+content. Host never
  sees OpenTUI; gateway never sees decide.
- **Authority end:** namespaced core.*/ds.* pass-through, one shared JSONL log, game
  state an opaque serializable subtree. init deterministic (config = logged setup
  events); apply pure and closed over E (GM-in-the-loop, not core-event-reactive);
  content-derived facts land in payloads so replay never reads files → logs are
  portable and self-contained. TableView = snapshot value, the licensed churn point.
  Envelope is core's forever-promise; payload versioning is the module's problem.
- **Render end:** slot-based (v0: sidebar only), one-way data flow, dispatch is the
  only output. renderEvent deterministic (state = after this event). Semantic theme
  tokens, never ANSI. Core renders core.* + rejections; module renders ds.* only.
- **Content end:** packaged content ships in the module; GM files stay in the
  campaign folder, module ships validate(bytes) → ok|errors, never an introspectable
  schema. Characters enter play via logged ds.* events carrying derived stat blocks.
- **Binding:** logged opaque game id joins host/gateway registries; unregistered id
  fails replay loudly.
- **Fake game module** = second adapter, all four entry points, core's conformance
  fixture from v0.

Planned Q5 (dice) and Q6 (non-forking discipline) were absorbed, not skipped: dice by
"core owns generic /roll, power rolls are ds.* payloads"; discipline by the namespace
rules, the two import prohibitions, the opaque game id, and the fake module.

Handoff to 015: the dependency lattice is its acceptance test — scaffold must hold
host/gateway/CLI/web + game-modules-as-packages with entry-point boundaries
enforceable by dependency-cruiser, and the fake game module + core package (envelope,
log, registries, interfaces) exist before any feature does.
