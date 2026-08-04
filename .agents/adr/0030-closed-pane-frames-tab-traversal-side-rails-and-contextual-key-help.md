---
status: accepted
date: 2026-08-04
---

# Closed pane frames, Tab traversal, side rails, and contextual key help

Resolved in the grilling of [#84](https://github.com/oscabriel/supervillain/issues/84), with [ADR-0026](./0026-named-layouts-one-way-snap-down-and-the-pane-focus-model.md) as inherited input and [#109](https://github.com/oscabriel/supervillain/issues/109) as the standing collision example. The definition had never decided whether supervillain wanted titled/bordered regions at all. The answer is yes: the Table is a set of independently framed panes, while the Lobby remains a visually distinct open threshold. The herdr panes used during the decision session supplied the concrete focus and rail precedent: a quiet neutral frame becomes one coherent accent frame on focus, and a collapsed side region remains a thin informative rail rather than disappearing.

## Table frame and pane topology

**Decision: every focusable Table pane gets one closed light box; passive chrome does not.** The stable pane set is Feed, Map (when present), Sidebar, and Message. Each pane has its own one-cell light frame and top title, with a one-cell gutter between adjacent panes. There is no outer Table frame. The room header, state/status row, and keybind bar remain unboxed full-width bands, so a box means “this region can hold focus.” Heavy, double, rounded, and pixel-glyph frames remain rejected.

The Sidebar is one core Pane, not one Pane per game Panel: the Seat list stays at its top, a horizontal tab strip switches the module Panels inside it, and game modules cannot grow the Table-level focus ring. Titles name stable core nouns (`feed`, `sidebar`, `message`, `map · <name>`); the active Sidebar tab stays inside its frame. A contextual text task temporarily replaces `message` with the task title.

**Decision: the main geometry is Feed — Map — Sidebar, with Message below all three.** Feed and Sidebar are collapsible side regions around the large central Map; Message spans the width beneath the unboxed state/status row, and the compact keybind bar is bottommost. This replaces `DESIGN.md`’s former “map above feed, sidebar right” band frame. Named layouts still allocate width rather than moving regions: `map-focused` protects Map, `feed-focused` widens Feed while retaining Map, and `no-map` removes Map and gives its width to Feed.

## Focus and text entry

**Decision: focus is a whole-frame ANSI-16 highlight.** Inactive frame and title use `muted`; the focused frame and title change together to `accent`, matching the herdr precedent. This is deliberately color-only by default—an explicit exception to the design system’s glyph-first/color-second rule. An opt-in **focus marker** preference prepends a reserved `>` cell to the focused title. It defaults off, is configurable in both Lobby settings and the expanded Table key sheet, persists by resolved identity for keyed users, and is session-local for Guests.

OpenTUI @ `a0b9064` supports this shape directly: a focusable `BoxRenderable` has `focusedBorderColor`, and an unset fixed `titleColor` follows the current border color. It has no generic box `focusedStyle`; the optional `>` is a title-string change. Mouse auto-focus finds the nearest focusable renderable on left click, while map hit-testing may set the same focus explicitly when consuming the click.

**Decision: Tab traversal replaces direct pane letters.** [ADR-0026](./0026-named-layouts-one-way-snap-down-and-the-pane-focus-model.md)’s dim letter hints and global bare-letter focus keys are struck. `Tab` traverses `feed → map → sidebar → message → …`; `Shift+Tab` reverses it, and absent panes are omitted. Initial focus follows the named layout (`map-focused` → Map; `feed-focused`/`no-map` → Feed), never Message. Clicking focuses directly. This is the less-technical general-audience posture: ordinary traversal over a leader or a globally reserved mnemonic alphabet.

**Decision: Message is the Table’s sole free-text surface.** No viewing Pane enters an internal all-printable text mode. A Pane action that needs text (for example, Draw Steel “add enemy”) borrows Message with a contextual title, then submit/cancel returns to the originating Pane. Ordinary Message drafts survive Esc and Tab; contextual drafts are discarded on cancel. Send and Esc return to the Pane that originated the text task, repairing to the layout’s focal Pane only if that origin disappeared. While Message is focused, every printable character—including `v` and `?`—is text.

## Rails, persistence, and demotion

**Decision: Feed and Sidebar independently toggle between open Pane and five-column framed Rail.** `c` toggles the focused Feed/Sidebar; `[−]`/`[+]` is the clickable equivalent. The three interior columns are enough for the expansion mark and `99+`/`+N` summaries. This replaces ADR-0026’s former “Feed and Seat list are never hidden” non-negotiables with a sharper one: **the Feed Rail and Sidebar Rail never disappear**, but their full content and identities may.

- The Feed Rail shows `[+]`, a printing activity mark, and the session-local number of FeedLines that arrived while it was closed. Expansion clears the count; it caps visibly at `99+`. This is “new while closed,” never durable read state.
- The Sidebar Rail shows `[+]`, one `●`/`○` presence mark per Seat in Seat order, the anonymous `+N` Spectator count, and `+N` overflow when height cannot show every Seat. It hides Seat identities and Panel content.

Explicit Feed/Sidebar rail choices persist globally by resolved identity; Guests retain them for one Door session. Named layouts determine expanded widths, not rail state. Under width pressure, automatic rails temporarily override an explicit open preference without saving it, then reopen automatically when space returns. The forced order protects the focal region: `map-focused` rails Feed then Sidebar; `feed-focused` and `no-map` rail Sidebar first and keep Feed open.

The living demotion rows belong to `packages/table/DESIGN.md`. The contract is: compact key hints `5 → 3`; Sidebar rows `two-line → one-line → Rail`; expanded regions shrink to readable minima before forced Rails; and a map layout that still cannot meet its game-declared viewport floor snaps one-way toward a fitting preset, ultimately `no-map`. If `no-map` cannot honestly retain Feed, Sidebar Rail, Message, and keybind bar, the Table shows an honest “terminal too small” surface instead of hiding them. Named layouts never auto-upgrade; forced Rails restoring an unchanged explicit preference is not a layout upgrade.

**Decision: the game `view` entry declares the minimum useful Map viewport in map cells.** Core must not hardcode a Draw Steel reach. The Table converts the same width/height declaration through the active tier (pixel: 4×3 terminal cells per Map cell; text: 1×1). Draw Steel’s values must be justified from its ability corpus during implementation. If the current tier cannot meet that floor after demotion, the Table does not guess another tier: it snaps to `no-map`. The expanded key sheet always exposes `[t] map tier`, even with Map hidden, so the player can choose text and retry a map layout with `v`.

## Keybind bar, key sheet, and complete key surface

**Decision: a compact contextual keybind bar is always bottommost.** It begins with the focused Pane name and keeps `[tab] pane`, `[v] layout`, and `[?] keys` permanently visible, followed by up to two focused-Pane hints when they fit. At narrow widths it demotes from five entries to those three. While Message owns printable input, `[v] layout` and `[?] keys` remain visible but render disabled/dim; they resume after Message releases focus.

`?` outside Message opens the complete focused-Pane key sheet. The sheet is an inset accent-framed top layer; the live Table remains visible behind it but is redrawn through muted/dim indexed tokens—no opacity, truecolor scrim, animation, or blackout. The top layer consumes input. `f` toggles the focus-marker preference, `t` toggles Map tier even when Map is hidden, and `?`/Esc closes.

The complete Table key surface is:

| scope | keys |
| --- | --- |
| core outside Message | `Tab`/`Shift+Tab` next/previous Pane; `v` cycles `map-focused → feed-focused → no-map`; `?` opens key sheet |
| Message | all printable characters; Enter sends/submits; Esc returns/cancels; Tab traverses while preserving an ordinary draft |
| Feed | Up/Down or `j`/`k` one line; PageUp/PageDown one viewport; Home/End oldest/latest; `c` Rail |
| Map | arrows or `h`/`j`/`k`/`l` move; Enter/Space hold/drop; `x`/Delete remove; `t` pixel/text |
| Sidebar chrome | Left/Right previous/next module tab; `c` Rail; Up/Down belongs to the active Panel |
| Draw Steel initiative | `s` start; `e` end; `t` take turn; `a` add hero via Message; `m` add enemy via Message; `r` roll setup |
| Draw Steel roll setup | `a`/`i`/`m`/`p`/`r` characteristic; `e` edges; `b` banes; Enter rolls; Esc cancels |
| Draw Steel sheets | `[`/`]` previous/next bound character |
| key sheet | `f` focus marker; `t` Map tier; `?`/Esc close |

`v` is the sole globally reserved bare letter outside Message; a game Panel may not claim it at top level. `c` and Left/Right are Sidebar-chrome keys before the active Panel. The fake game’s current `v` fixture action must move to a non-reserved fixture key; that fixture literal is not a product key contract.

## Lobby hierarchy

**Decision: the Lobby stays visually distinct from the boxed Table.** Its baseline is a horizontally centered composition in the upper third of a large quiet field, falling toward the top as height shrinks. The existing 48-column pixel wordmark leads; real text remains the narrow fallback. Content beneath it is open and left-aligned. Only actual typed fields receive a closed light box. A later Lobby-specific art pass may deepen this identity without blocking the Table chrome.

Unknown/offline/full/dropped arrival copy becomes an open `!`-marked callout between wordmark and screen title, with semantic token color reinforcing—but never carrying—severity. Lobby hints use the same `[key] verb` grammar in a screen-contextual terminal-bottom bar, not the Table’s Pane/layout entries. Splash uses arrows or `j`/`k`, Enter chooses, and `q` leaves; `q` also leaves informational screens. Join/link fields own every printable character, Enter submits, and Esc returns.

## Render-tier and ANSI scope fence

Pane frames are tier-neutral one-cell box drawing. ADR-0007/0021’s pixel ornament allowance remains limited here to Map and isolated threshold art such as the Lobby wordmark; no 4×3 atlas ding enters a Pane frame or changes frame geometry. The two ANSI promises remain distinct: Map keeps byte-level exact ANSI-16; all controllable chrome colors use indexed semantic tokens, while [#81](https://github.com/oscabriel/supervillain/issues/81)’s narrowly documented OpenTUI RGB-white remainder remains allowed outside Map.

## Shipping and consequences

The boxed Table, visible focus, Tab model, Rails, and persistent key help are v1 Table foundations and do not slip behind pixel ornament. They land independently of the pixel tier. The open/centered Lobby baseline lands with shared token and hint work; a deeper Lobby art pass is follow-up polish.

This decision amends ADR-0026’s focus letters, geometry, and Feed/Seat visibility guarantees; adds three presentation-pref instances under ADR-0008 (focus marker, Feed Rail, Sidebar Rail); fences ADR-0007/0021 ornament away from Pane frames; and preserves ADR-0027’s anonymous Spectator count in both expanded state chrome and the collapsed Sidebar Rail.

## Revisit triggers

- Tab traversal proves materially slower or less comprehensible than direct focus in playtest—the rejected leader-assisted focus mode is the next candidate, not globally colliding bare letters.
- Color-only focus fails real palettes despite the reachable focus-marker preference—the marker default reopens.
- Five-column Rails cannot carry honest activity/presence at real Seat counts or terminal heights—the Rail summary, not disappearance, reopens.
- A module cannot nominate one honest minimum useful viewport—the `view` declaration shape reopens against measured play, never a core hardcode.
- The distinct open Lobby fails its later art pass—the Lobby may gain its own framing language, but does not inherit the Table dashboard by default.
