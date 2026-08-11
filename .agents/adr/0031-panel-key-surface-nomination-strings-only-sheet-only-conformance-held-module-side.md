---
status: accepted
date: 2026-08-11
---

# Panel key-surface nomination: strings-only, sheet-only, conformance held module-side

Resolved 2026-08-11, grilling of [#128](https://github.com/oscabriel/supervillain/issues/128). [ADR-0030](./0030-closed-pane-frames-tab-traversal-side-rails-and-contextual-key-help.md) centralized the Table's key help — the compact keybind bar and the expanded key sheet both select from one binding source, and neither owns hand-written help — but the `GamePanel` seam declared no key surface, so a game module's keys could not be derived from live surfaces. The #119 implementation hand-baked Draw Steel scopes into `packages/table`; the review rejected that (dead help under other games, the live game's own keys shown nowhere, one game's vocabulary named inside core chrome). The interim posture shipped with #119 restricted the sheet to core/chrome scopes. This ADR pins the nomination seam that ends the interim.

**Decision: each `GamePanel` nominates its key surface as static, strings-only data — a sibling of `onKey`.** The nomination is a list of module-titled groups, each holding bindings of machine-readable key names plus display strings and labels:

- A binding carries `keys: readonly string[]` of real `PanelKey.name` values, an optional `display` string for the sheet, and a `label`. Machine names are what make the conformance obligation mechanical; the display string is what the sheet prints. This is still ADR-0025's strings-only posture — data, no behavior.
- Groups carry module-authored titles ("initiative", "roll setup", "bound sheets"), printed verbatim in lowercase, no game-name prefix — exactly one game is live at a table. A group title is where a modal sub-grammar states its "when"; the declaration itself is static and does not vary with game state. The sheet is reference, like a manual page — showing roll-setup keys outside roll mode is not the dead help the #119 review rejected (that was the *wrong game's* keys).
- The nomination hangs on the Panel, not on `GameView` or `ViewEntry`, co-located with the `onKey` that must claim those keys — the same way `MessageTask` rides the panel seam.

**Decision: nominated keys appear only in the expanded key sheet, never in the keybind bar.** The bar stays core/chrome-only: its two contextual slots cannot rank a module's six initiative keys honestly, and the chrome keys (`←/→` panel, `c` rail) are what a disoriented player needs first. `[?] keys` is permanently visible precisely so the deep surface has one entrance. The focused-Sidebar sheet renders the **active Panel's** groups only, after the chrome scopes — keys route to the active tab (`chrome.ts`'s `activePanel()`), so a closed tab's keys are not dispatchable and showing them would be nominated-but-dead help by construction.

**Decision: the nomination-to-dispatch contract is bidirectional, and the module's own conformance test is what holds it.** Every nominated key name must be claimed by the panel's `onKey` (no dead help), and every key `onKey` claims must be nominated (no secret keys) — one-way enforcement tolerates the same lie in the other direction. Core ships no harness; per the event-grammar precedent, each module's conformance spec proves both directions: for each group, a state fixture in which the group is live, asserting every nominated key returns `true` from `onKey`; then a probe of the canonical key alphabet in each fixture, asserting every claimed key appears in some nomination.

**Decision: reserved keys split refusal by house posture — the render-side merge tolerates loudly, the hard failure lives module-side.** Core exports the reserved set (`v` globally; `tab`/`?` core; the Sidebar chrome's `c` and `←`/`→`) as one constant, so the merge and the tests share one truth. The sheet merge is a render fold and render never halts (ADR-0010 posture): a nominated reserved key is skipped with a dim warning line, never a throw. The module's conformance spec asserts no nominated key name is in the reserved set — that is where the build goes red. Dispatch already shields `v` from panels mechanically; this does not change.

## Consequences

`GamePanel` in `packages/core` grows one optional strings-only field; `packages/table`'s sheet derivation merges the focused pane's chrome scopes with the active Panel's nominated groups, with zero game references in `packages/table/src` (the mechanical check from #128's acceptance). Draw Steel nominates initiative, roll setup, and sheet-paging groups; the fake game nominates its `q` fixture key — both gain a conformance spec binding nomination to dispatch. The `SHEET_SCOPES` interim restriction and its #128 comment are retired. ADR-0030's key-surface table remains the pinned product content of those nominations; this ADR pins where that content lives and how it reaches the sheet.

## Revisit triggers

- The #124 usability playtests show players never finding game keys through `[?]` — reopens the bar exclusion (a module nominating a small number of bar-eligible hints, competing for ADR-0030's two contextual slots).
- A module's key grammar becomes state-dependent enough that a static nomination reads dishonestly as reference (whole groups that can never fire in a given room configuration) — reopens static-versus-derived nomination.
- A second simultaneous game surface (never currently planned) — reopens verbatim group titles with no game-name prefix.
