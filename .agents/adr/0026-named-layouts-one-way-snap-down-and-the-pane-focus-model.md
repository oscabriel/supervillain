---
status: accepted
date: 2026-07-30
---

# Named layouts: three presets, one-way snap-down, identity-keyed persistence, and the pane focus model

Resolved 2026-07-30, grilling of [#97](https://github.com/oscabriel/supervillain/issues/97). `packages/table/DESIGN.md` § Layout proposed the table's screen-real-estate answer — named layouts, not resizable panes — and the definition said nothing about layout presets as a player-facing surface. This ADR pins the preset set, the auto-select/resize rule, persistence, the key mechanism (which forced the table's focus model onto the record), and where the demotion ladder lives.

**Decision: three presets — `map-focused`, `feed-focused`, `no-map` — ratified as proposed.** All three use the same regions in the same relative positions; only sizes change, and nothing moves when cycling. Three is deliberate: the set covers the actual modes of a session (combat / conversation / no encounter — and `no-map` is the common case pre-map-load and in non-combat play), and a one-key cycle stays usable at three. The names describe what they do and need no teaching.

**Decision: auto-select at connect; on live resize, automatic downgrades only — and only to avoid a broken screen.** Terminal size picks the starting layout at connect. Thereafter the layout never changes on its own, with one exception: if a resize makes the current preset unrenderable, it snaps **down** to the nearest preset that fits. It never snaps back up when the terminal grows — recovery is the player's cycle key. Within a preset, regions stretch and shrink elastically per the demotion ladder before any snap fires. Implementation note (verified against the pinned OpenTUI clone): within-preset elasticity is OpenTUI's Yoga flexbox doing its job; preset thresholds and the snap-down rule are our logic hooked on the renderer's `resize` event — OpenTUI has no breakpoint system, so the thresholds are ours to own. Per [ADR-0012](./0012-outbound-only-hybrid-drop-iroh-host-dials-out.md)'s on-demand rendering stance, resize handling is event-driven, never a polling loop.

**Decision: explicit choices persist per identity; automatic ones don't.** A layout picked with the cycle key is saved to the [ADR-0008](./0008-bare-ssh-lobby-lazy-guest-minting-and-keyed-preference-persistence.md) gateway prefs table, keyed by resolved identity — the second concrete instance of that carve-out, beside [ADR-0025](./0025-teach-once-explainers-prefs-instance-strings-only-seam-render-side-only.md)'s seen-explainers set. Auto-picks and forced snap-downs are not saved — they weren't choices. On connect: the saved preference wins if it fits the current terminal, otherwise size-based auto-pick. Guests get nothing saved, per ADR-0008's deliberate amnesia.

**Decision: the table's focus model — every region is a pane, including the input line.** Grilling the cycle key surfaced that the key mechanism depends on the input model, so the input model is pinned here:

- **Click to focus.** Any pane takes focus on mouse click (OpenTUI's mouse pipeline is first-class and works over SSH; verified in the clone's `parse.mouse.ts`/renderer).
- **Letter hints.** Each pane wears a dim hint letter; pressing it snaps focus there from the keyboard.
- **The input line is opt-in — a pane like any other.** It is focused deliberately (click, or its hint letter) and released deliberately (Esc / send). Bare letters act as hotkeys whenever the input pane is unfocused; they type only while it is focused. Default focus at connect is a viewing region, not the chat — the table is a viewer first; chat is a mode you enter. btop-style bare-letter ergonomics are thereby licensed without the invisible-modal-state trap, because focus is visible chrome.
- **The layout cycle key is a bare letter** in that same vocabulary, cycling `map-focused → feed-focused → no-map → …`, and its legend entry is **permanent** — a feature you can't discover doesn't exist.
- **No literal key is assigned here.** Which letter focuses which pane and which cycles layouts is decided in one pass by [#84](https://github.com/oscabriel/supervillain/issues/84)'s chrome grilling, which owns the keyboard surface — assigning keys piecemeal is how collisions like [#109](https://github.com/oscabriel/supervillain/issues/109) happen. This ADR pins the contract; #84 pins the letters.

Consequence for the record: this model rewrites [#109](https://github.com/oscabriel/supervillain/issues/109)'s diagnosis — "map focus swallows `/quit`" stops being an accident and becomes the designed rule (`/quit` is typed in the input pane, which you focus first). What #109 still owes is the bench control fix and honest affordances for reaching the input pane.

**Decision: the demotion ladder lives in `packages/table/DESIGN.md`; this ADR pins only the non-negotiables.** The ladder — the stated order in which regions shrink, collapse, or hide as space runs out, written per preset per render tier (the pixel tier's 4×3-cells-per-tile budget makes "what fits" tier-specific per [ADR-0021](./0021-mekmode-atlas-octant-packing-and-4x3-tiles.md)) — is dense, living, tuning-prone detail; DESIGN.md owns the rows and may change them freely. The non-negotiables are contract: **the feed and the seat list are never hidden by any demotion at any tier.** Changing a non-negotiable — not a row — reopens this ADR. Filling in the rows is implementation-time work.

## Consequences

The gateway prefs table gains a layout row (identity-keyed, guests amnesiac — the ADR-0008 pattern now has two instances and is convention). #84 inherits the ratified input model (pane focus, click-to-focus, letter hints, opt-in input line) as input, plus the letter-assignment work. #109's triage proceeds against the designed rule, not against "focus is broken." DESIGN.md § Layout gains ownership of the demotion-ladder table with two pinned non-negotiables.

## Revisit triggers

- A fourth preset earning existence (the one-key cycle degrades past three — would force reconsidering direct selection).
- Players demonstrably fighting the no-auto-upgrade rule after a snap-down (telemetry-free product, so this arrives as playtest feedback, not numbers).
- The opt-in input line failing playtest — if players' first instinct is to type and their words vanish into hotkeys, the default-focus decision reopens (#84's affordances are the first line of defense).
- Anything wanting to hide the feed or seat list — reopens here, by design.
