# The game module seam

_Grilled and locked 2026-07-12/13 (ticket 006). Vocabulary: `/codebase-design` — module, interface, seam, adapter, depth. This is the seam between the system-agnostic core and a game module; Draw Steel is the first adapter, the fake game module is the second, Mothership/Mörk Borg arrive at v4+._

## Shape: a game module is code

A game module is a TypeScript package satisfying a small core-defined interface, **statically imported and compile-time registered**. No rules DSL, no dynamic loading, no sandbox, no versioned plugin API. "Not a plugin framework" is satisfied by how modules are wired (a static registry), not by prohibiting code. Game-as-data was rejected: Draw Steel's initiative is logic, and expressing logic as data means inventing a rules DSL — the plugin framework smuggled in as configuration.

## Four entry points, one package

The package keeps the game's identity whole; entry points keep dependency directions clean. No barrel.

| entry point | provides | imports |
| --- | --- | --- |
| `model` | `S`/`C`/`E` types, `init`, `apply`, `offers` — pure, platform-free | core seam types, type-only |
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
	offers?(state: S, ctx: TableView): readonly Offer<C>[]; // pure eligibility, shared with the render side
}
```

Namespaced command/event pass-through: the core defines the envelopes (actor, seq, timestamp, namespaced type, payload) and routes by namespace — `core.*` is the core's (rooms, seats, presence, chat, generic dice), `ds.*` is the module's. **One shared log**: game events interleave with core events in the same JSONL, because replay ordering across the seam is real. Game state is an **opaque subtree** of room state — the core persists and replays it but never inspects it.

Interface invariants (not implementation notes):

1. **`S` is plain serializable data.** The core persists and snapshots state it can't inspect — no class instances, Maps, or functions in game state.
2. **`init()` is deterministic — constant empty state.** Anything configuration-shaped enters as a logged `ds.*` setup event, so config becomes history and replay stays closed over the log. A zero-arg `init` that loaded files would make replay depend on the filesystem's current contents.
3. **Anything computed from content lands in the event payload — replay never consults stat blocks.** All randomness happens in `decide` on the host and lands in the event (power-roll dice results are payload, never re-rolled at replay). A GM can edit content files mid-campaign and old events still replay byte-identical. This is also what lets read-only reference data live outside `S` safely.
4. **Game state reacts to core changes only through explicit `ds.*` commands — GM-in-the-loop.** Every game this product serves has a GM by definition, so a player dropping mid-initiative is resolved by a GM command (or client UX issuing one on their behalf), not by the module observing core events. `apply` stays closed over `E`. If a future game genuinely needs reactive coupling, widening `apply` to accept core events is the **named escape hatch** — a deliberate future decision, not something backed into. Corollary: namespace discipline is one-way both ways — the module never emits `core.*`, the core never emits `ds.*`.

Riders:

- **`TableView` is a read-only snapshot value captured at command time** (not a live handle), exposing the narrow core facts `decide` may read (seats, who holds the GM seat). It is the **licensed churn point**: v1 growth there (e.g. character↔seat bindings) is honest interface evolution. _(Correction 2026-07-14, surfaced by issue #10, [ADR-0002](../../adr/0002-tableview-carries-the-authenticated-actor.md): `TableView` also carries `actor` — the authenticated key of the perspective the snapshot serves: the command's connection-authenticated issuer in `decide`, the viewing player in panels. GM-only authority rules read it instead of trusting command payloads.)_ _(Correction 2026-07-20, issues #21/#24: `SeatView` carries `characterId: string | null`; bindings are established by the core-owned `core.bind-character` command → `core.character-bound` event, bind the issuer's own seat (actor-resolved, ADR-0002), are opaque to the core, last-write-wins in log order, and derive purely from replay.)_
- **The envelope is the core's forever-promise; payload schema versioning is the module's problem.** The v1 Draw Steel module must replay v0 events.

### Standing decisions (ADR-0035)

_(Added 2026-09-10, [#138](https://github.com/oscabriel/supervillain/issues/138), [ADR-0035](../adr/0035-standing-decisions-a-pending-choice-is-state-continued-by-its-own-command.md), surfaced by reading tobi/neohack.) A `ds.*` command that needs a follow-up choice before it finishes does not grow a parameter per possible follow-up — the Panel would have to know every follow-up ahead of time. The command is accepted, `apply` leaves a **standing decision** in `S` with an id, a kind, and the offered answers, and a separate command (`ds.decision.answer {decisionId, answer}` / `ds.decision.cancel {decisionId}`) continues exactly that decision. The open decision is state, not a Panel's local buffer: it replays across reconnects and fold checkpoints (ADR-0018) and renders identically in every Panel. Ids give `decide` the answer-drift check for free: an answer whose id is not the currently standing one is rejected with one equality check — a late-arriving answer from a slow Table can never land on a different question, because an adapter may never substitute a newer standing question for a caller's older answer._

- **At most one standing decision per seat; ids unique in the room's log.** Draw Steel has simultaneous triggered actions across seats, so per-room is too narrow. The id is minted in `decide` (all randomness lives there) and lands in the event payload, so replay never re-mints it.
- **The GM may answer or cancel any seat's decision; a seat answers its own.** Seam invariant 4 (GM-in-the-loop) applied to stuck decisions: every game this product serves has a GM, so a vanished player's decision is unstickable by definition.
- **Cancel cannot undo time already spent.** What a cancelled decision leaves behind ("the attack happened, you declined the bonus") is the module's per-decision-kind call. `decide` accepts the cancel (and rejects a stale id), `apply` clears the decision, and the initiating command's effects stand.
- **No decision auto-resolves.** Timeout is not a thing. If a player disappears, the GM cancels or answers.
- **Core stays blind.** The standing decision lives in the module's `S`, typed only by the module; no core machinery, no `GameView` hint (a read-only `standingDecision?()` hint is named churn until a real Panel needs to show "waiting on <seat>" without importing `S`). Exercised by the fake game module: a two-step command, a standing decision, a stale-id rejection, and GM-vs-seat resolution rights.

### Offers (ADR-0036)

_(Added 2026-09-10, [#139](https://github.com/oscabriel/supervillain/issues/139), [ADR-0036](../adr/0036-offers-eligibility-projection-on-the-model-entry.md), surfaced by reading tobi/neohack.) The `model` entry gains `offers(state, view): readonly Offer<C>[]` — the one place eligibility rules live, so a Panel never re-derives a rule `decide` also knows and never offers what the authority would refuse. `decide` and the render side both call it; no new lattice edge (`model` was already importable from both `authority` and `view`)._

- **An offer is eligibility, never a guarantee.** Offers are computed from state at render time; state moves between the offer and the command landing, so `decide` may still reject an offered command. The rule worth stealing verbatim from neohack: "Eligibility does not imply safety."
- **Availability is a closed three-way union, and `Offer<C>` is a discriminated union on it** — `attemptable` carries `command: C`; `needsSelection` carries `template: Partial<C>` (a fill-in the Panel completes into a whole `C`; the ADR-0030 contextual text task shape); `blocked` carries `reason: string` and no command. The template is typed partial on purpose: typing it as `C` would force every templatable command in the module's union to grow optional fields, and `decide` to reject half-filled commands at runtime. Deliberately smaller than neohack's five-way union: there is no perception uncertainty here — state is authoritative and shared. A `blocked` offer exists so a Panel can show a disabled action with a reason instead of hiding it (ADR-0030's contextual key help wants that text).
- **The conformance rule is one-way:** every `attemptable` offer's command is accepted by `decide` on the same state. "The UI offered it and authority refused it" is a bug by definition. The reverse — `decide` pre-checking `offers` and rejecting anything unoffered — is a recommended pattern, not a requirement: a GM-only force command may be decidable without ever being offered to anyone. A `blocked` offer's reason must be a rule `decide` actually enforces, worded once and read by both (the fake module exports the string and both sides use it); a reason `decide` does not know is the drift this section exists to prevent, in the other direction.
- **The gate:** a seat with a standing decision (above) collapses its offer list to answering or declining that decision — the same input-gate instinct neohack's driver has. Both conventions land together in the fake game module.
- **Labels and reasons are module-owned strings**, never ANSI, per the render-end posture. Core defines the `Offer` shape; the module owns the words.

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
3. **Panel input contract, minimal and one-directional:** core owns focus routing; a focused panel receives input; its only output is `dispatch(command)`. _(Correction 2026-07-14, issue #10 — the contract's concrete v0 shape: `GamePanel.onKey?: (key, input) => boolean` receives semantic key values while focused and returns whether it handled the key; `render` returns `readonly FeedLine[]` so panels can be multi-row; ephemeral view-local state (row selection, an in-panel text buffer) may live in the panel, never game facts. `GameView` also gains optional `notices: readonly FeedLine[]`, rendered by core chrome at table start — how a module's license-mandated text reaches the table without the gateway importing `content`.)_ _(Correction 2026-07-18, issue #17 — `GamePanelInput` also carries required `readonly focused: boolean` on every `render` and `onKey` snapshot; core rerenders panels on both focus gain and focus loss, so focus-dependent presentation updates immediately without lifecycle callbacks.)_ _(Correction 2026-07-21, [#26 deep review](https://github.com/oscabriel/supervillain/issues/26) — panels are minted per table session via `GameView.createPanels()` because module-singleton panel-local state leaks across sessions; core calls the factory once and shares those instances between key handling and rendering.)_
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

The second adapter that makes the seam real in v0 (two-adapters rule): a trivial game module used by core's tests, spanning **all four entry points**. Its `decide` exercises rejection, multi-event emission, and a `TableView` read through the same log as core events; its view end is a trivial panel + feed line proving the render seam; its content end is a trivial validator. _(Extended 2026-09-10, [#138](https://github.com/oscabriel/supervillain/issues/138)/[#139](https://github.com/oscabriel/supervillain/issues/139): it also exercises the standing-decision convention — a two-step command, a standing decision in `S`, a stale-id rejection, GM-vs-seat resolution rights — and the offers projection, including the standing-decision gate, a `blocked` offer with a reason, and the one-way conformance rule that every `attemptable` offer is accepted by `decide` on the same state.)_ It is the conformance surface for the interface — core tests cross the same seam Draw Steel does.

## Named-churn ledger (deferred by decision, not oversight)

| churn | where | when |
| --- | --- | --- |
| character↔seat bindings | `TableView` | landed v1, 2026-07-20 #21/#24 |
| per-game chat idioms | `GameView` | v1, if real play demands |
| field-level schema introspection | content entry | v2 (builder) |
| creation-wizard flow | new entry point or CLI-side | v2 — zero present consumers, so no entry point now |
| `apply` widened to core events | authority end | escape hatch, only if a game needs reactive coupling |
| `offers` on the Draw Steel model entry | `model` entry (ADR-0036) | when Draw Steel v0 Panels need eligibility they would otherwise re-derive |
| `GameView.standingDecision?()` read-only hint | `GameView` (ADR-0035) | when core chrome must show "waiting on <seat>" without importing `S` |
| standing decisions in Draw Steel commands | module convention (ADR-0035) | when Draw Steel's first follow-up choice arrives |

## Handoff to 015 — the lattice as acceptance test

The scaffold must hold **host / gateway / CLI / web plus game-modules-as-packages**, with the entry-point boundaries **enforceable by dependency-cruiser** (host never imports OpenTUI; gateway never imports `decide`; content imports model only; view is the only OpenTUI consumer in a game package). **The fake game module plus the core package (envelope, log, registries, interfaces) exist before any feature does.**
