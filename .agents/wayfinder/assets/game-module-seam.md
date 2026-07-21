# The game module seam

_Grilled and locked 2026-07-12/13 (ticket 006). Vocabulary: `/codebase-design` — module, interface, seam, adapter, depth. This is the seam between the system-agnostic core and a game module; Draw Steel is the first adapter, the fake game module is the second, Mothership/Mörk Borg arrive at v4+._

## Shape: a game module is code

A game module is a TypeScript package satisfying a small core-defined interface, **statically imported and compile-time registered**. No rules DSL, no dynamic loading, no sandbox, no versioned plugin API. "Not a plugin framework" is satisfied by how modules are wired (a static registry), not by prohibiting code. Game-as-data was rejected: Draw Steel's initiative is logic, and expressing logic as data means inventing a rules DSL — the plugin framework smuggled in as configuration.

## Four entry points, one package

The package keeps the game's identity whole; entry points keep dependency directions clean. No barrel.

| entry point | provides | imports |
| --- | --- | --- |
| `model` | `S`/`C`/`E` types, `init`, `apply` — pure, platform-free | — |
| `authority` | `decide` — all randomness, all authority | model, content |
| `view` | panels, `renderEvent` | model, content, OpenTUI |
| `content` | packaged static data, terminology, file validators | model |

True consumer edges (015 inherits these):

- **Host** = model + authority. Never imports OpenTUI.
- **Gateway** = model + view. Never imports `decide` — which is where all randomness and authority live. The gateway folds `apply` over the streamed events to produce the `S` snapshots panels consume; `apply` is pure, so the gateway is the right place to fold.
- **CLI** = model + content (validation, publish; later the builder).
- `view` imports `content` from v0: feed-line wording and panel labels ("Initiative," "Malice") are terminology, and panel headers can't arrive via event payloads. Harmless — content is platform-free.

## Authority end

```ts
interface GameAuthority<S, C, E> {
	init(): S; // constant empty state
	decide(state: S, cmd: C, ctx: TableView): E[] | Rejection; // single-writer host
	apply(state: S, event: E): S; // pure reducer, replay-safe
}
```

Namespaced command/event pass-through: the core defines the envelopes (actor, seq, timestamp, namespaced type, payload) and routes by namespace — `core.*` is the core's (rooms, seats, presence, chat, generic dice), `ds.*` is the module's. **One shared log**: game events interleave with core events in the same JSONL, because replay ordering across the seam is real. Game state is an **opaque subtree** of room state — the core persists and replays it but never inspects it.

Interface invariants (not implementation notes):

1. **`S` is plain serializable data.** The core persists and snapshots state it can't inspect — no class instances, Maps, or functions in game state.
2. **`init()` is deterministic — constant empty state.** Anything configuration-shaped enters as a logged `ds.*` setup event, so config becomes history and replay stays closed over the log. A zero-arg `init` that loaded files would make replay depend on the filesystem's current contents.
3. **Anything computed from content lands in the event payload — replay never consults stat blocks.** All randomness happens in `decide` on the host and lands in the event (power-roll dice results are payload, never re-rolled at replay). A GM can edit content files mid-campaign and old events still replay byte-identical. This is also what lets read-only reference data live outside `S` safely.
4. **Game state reacts to core changes only through explicit `ds.*` commands — GM-in-the-loop.** Every game this product serves has a GM by definition, so a player dropping mid-initiative is resolved by a GM command (or client UX issuing one on their behalf), not by the module observing core events. `apply` stays closed over `E`. If a future game genuinely needs reactive coupling, widening `apply` to accept core events is the **named escape hatch** — a deliberate future decision, not something backed into. Corollary: namespace discipline is one-way both ways — the module never emits `core.*`, the core never emits `ds.*`.

Riders:

- **`TableView` is a read-only snapshot value captured at command time** (not a live handle), exposing the narrow core facts `decide` may read (seats, who holds the GM seat). It is the **licensed churn point**: v1 growth there (e.g. character↔seat bindings) is honest interface evolution. _(Correction 2026-07-14, surfaced by issue #10, [ADR-0003](../../adr/0003-tableview-carries-the-authenticated-actor.md): `TableView` also carries `actor` — the authenticated key of the perspective the snapshot serves: the command's connection-authenticated issuer in `decide`, the viewing player in panels. GM-only authority rules read it instead of trusting command payloads.)_ _(Correction 2026-07-20, issues #21/#24: `SeatView` carries `characterId: string | null`; bindings are established by the core-owned `core.bind-character` command → `core.character-bound` event, bind the issuer's own seat (actor-resolved, ADR-0003), are opaque to the core, last-write-wins in log order, and derive purely from replay.)_
- **The envelope is the core's forever-promise; payload schema versioning is the module's problem.** The v1 Draw Steel module must replay v0 events.

## Render end

```ts
interface GameView<S, C, E> {
	renderEvent(event: E, state: S): FeedLine | null; // ds.* events in the shared feed
	panels: GamePanel<S, C>[]; // placed by core layout slots
}
```

Slot-based: the core layout owns placement via a tiny slot vocabulary — **v0 needs only a sidebar slot**. Panels are one-way-data-flow components: they receive a read-only snapshot of `S` (plus the same `TableView`) and `dispatch(command)` — the only way a view causes anything is by dispatching a `ds.*` command into the same decide/apply pipeline. No side channel between view and game state.

1. **`renderEvent` is deterministic** — it runs in the same fold as `apply`, on live events and on replay. Its `state` parameter means **state after applying this event**. In practice the results-in-payload rule makes events self-describing, so it should rarely need state at all.
2. **`FeedLine` is semantic** — text runs tagged with core theme tokens, never ANSI. Color and width resolution happen once in core chrome against exact-ANSI-16 (prototype lesson: remote capability detection is conservative). Same rule for panels: compose tokens, never pick colors.
3. **Panel input contract, minimal and one-directional:** core owns focus routing; a focused panel receives input; its only output is `dispatch(command)`. _(Correction 2026-07-14, issue #10 — the contract's concrete v0 shape: `GamePanel.onKey?: (key, input) => boolean` receives semantic key values while focused and returns whether it handled the key; `render` returns `readonly FeedLine[]` so panels can be multi-row; ephemeral view-local state (row selection, an in-panel text buffer) may live in the panel, never game facts. `GameView` also gains optional `notices: readonly FeedLine[]`, rendered by core chrome at table start — how a module's license-mandated text reaches the table without the gateway importing `content`.)_ _(Correction 2026-07-18, issue #17 — `GamePanelInput` also carries required `readonly focused: boolean` on every `render` and `onKey` snapshot; core rerenders panels on both focus gain and focus loss, so focus-dependent presentation updates immediately without lifecycle callbacks.)_
4. **Render symmetry with the namespace discipline:** the module renders only `ds.*` feed lines, the core renders only `core.*`. Rejections close their loop in core chrome — the module supplies the message, the core renders it as ephemeral feedback to the issuing client.
5. **The namespace id is the join key** between the host registry (→ authority) and the gateway registry (→ view); the package keeps the game whole.

Chat idioms: **no registration in v0**, and the pressure is lower than it looks — generic dice is core-owned, so `/roll 2d6` ships as core chrome with zero module machinery. Only per-game idioms are deferred, which is the two-adapters rule applied honestly; if real play demands them, that is **named v1 churn** on `GameView`.

## Content end

Content has **two natures, split deliberately**:

- **Packaged static data** — license-enumerated Draw Steel material, terminology — ships inside the module, versioned with it.
- **GM-owned files** — characters, later homebrew — live in the campaign folder; the content entry ships their **schemas, never their instances**.

Render-side code may consult packaged content freely (deterministic per module version) but **never files** — enforced physically: the gateway doesn't have the campaign folder, only the event stream. File-derived facts reach rendering only through payloads.

**How a character enters play (the mechanism behind log self-containment):** a character enters play via a logged `ds.*` event carrying the derived stat block, computed by `decide` from the character file at command time; sheet edits re-enter the same way — a new `ds.*` event with the newly derived values. Replay therefore never needs the campaign folder: **room logs are portable and complete.**

- **The schema interface is a validator function, not a schema document**: `validate(bytes) → ok | errors`. The core learns validity and error text, nothing about fields. A schema format the core interprets would be the rules-DSL objection back at miniature scale. Field-level introspection (v2 builder, richer CLI) is **named churn** on the content entry, decided when a real consumer exists.
- Characters are **module-schema'd, core-opaque plain files** — the same opacity discipline as `S`, applied to the campaign folder ("you own your campaign" stays true: plain files, hand-authorable).

## Binding

A room binds to its module via a logged game id (`core.*` room-creation event). The id is an **opaque registry key** — storing it isn't "core naming Draw Steel" any more than a filename is. It joins the host and gateway registries. **Replay hitting an unregistered id fails loudly**; a log the registry can't interpret is an error, never a degraded generic table. _(Correction 2026-07-14, issue #10: the game id is NOT the event-namespace prefix — `draw-steel` binds a room whose module emits `ds.*`. Routing is by ownership, not prefix-matching: `core.*` events belong to the core, every other event in a room's log belongs to that room's single bound module, and the host refuses a module emission typed `core.*`. The module prefix is a module convention the core never reads.)_

## The fake game module

The second adapter that makes the seam real in v0 (two-adapters rule): a trivial game module used by core's tests, spanning **all four entry points**. Its `decide` exercises rejection, multi-event emission, and a `TableView` read through the same log as core events; its view end is a trivial panel + feed line proving the render seam; its content end is a trivial validator. It is the conformance surface for the interface — core tests cross the same seam Draw Steel does.

## Named-churn ledger (deferred by decision, not oversight)

| churn | where | when |
| --- | --- | --- |
| character↔seat bindings | `TableView` | landed v1, 2026-07-20 #21/#24 |
| per-game chat idioms | `GameView` | v1, if real play demands |
| field-level schema introspection | content entry | v2 (builder) |
| creation-wizard flow | new entry point or CLI-side | v2 — zero present consumers, so no entry point now |
| `apply` widened to core events | authority end | escape hatch, only if a game needs reactive coupling |

## Handoff to 015 — the lattice as acceptance test

The scaffold must hold **host / gateway / CLI / web plus game-modules-as-packages**, with the entry-point boundaries **enforceable by dependency-cruiser** (host never imports OpenTUI; gateway never imports `decide`; content imports model only; view is the only OpenTUI consumer in a game package). **The fake game module plus the core package (envelope, log, registries, interfaces) exist before any feature does.**
