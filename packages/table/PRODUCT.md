# Product

## Register

product

## Users

Two roles at one table. The **GM** hosts a room from their own machine (`supervillain create`) and runs the session: loading maps, moving tokens, adjudicating. **Players** reach the table through any SSH-capable terminal (`ssh <room>@supervillain.app`) — their terminal emulator, font, and palette are unknown and unowned. Sessions are live game nights: 2–4 hours of sustained attention where the table is the shared focal surface, plus brief pre-identity visits to the gateway lobby. A third audience is indirect: coding agents operating on the campaign folder's plain files between sessions.

## Product Purpose

supervillain is a terminal-first virtual tabletop: a system-agnostic core hosts live game rooms over SSH, with per-game modules (Draw Steel first) behind a fixed seam. The table — core chrome (feed, battle map, sidebar slots, focus routing) plus module panels — is the whole in-session product surface. Success is a table that a group willingly returns to weekly: legible at a glance mid-combat, fast over a laggy SSH pipe, and richer-feeling than "a chat log with a grid" without ever betraying its terminal nature.

## Brand Personality

Deadpan, honest, competent. The voice is dry understatement ("no accounts, no downloads, no browser. we're as surprised as you are." / "GMs sleep. allegedly.") — never camp: "mastermind"-style villain theming was explicitly rejected. Honesty is structural, not just tonal: status copy distinguishes "the command was not delivered" from "whether it landed is unknown"; a full room refuses new arrivals rather than degrading seated players. Delight lives in moments (splash wordmark, empty states, taglines), never in the play loop's way.

## Anti-references

- **Neon hacker-terminal aesthetic** — green-on-black matrix rain, glitch effects, CRT scanline cosplay. The saturated AI reflex for "terminal app."
- **Enterprise dashboard density** — nested frames, passive facts boxed as widgets, status bars crowded with indicators, and tab strips that mimic a web IDE. The Table's one light frame per focusable Pane is navigation, not permission to box every datum.
- **Roll20 / Foundry translated to text** — cramming a browser VTT's panel count into 80×24.
- **The current Nethack-bare state as an endpoint** — unstyled text dumps are the starting point, not the register.
- **Camp villain theming** — skulls, lairs, evil-laugh copy. The name is deadpan, not a costume.

## Design Principles

1. **Text is the source format.** Every ornamental tier (pixel-glyph wordmark, atlas-rendered map tiles) has a lossless plain-text fallback that is the same data — ADR-0007. Body text is always real text.
2. **Keyboard-complete, mouse-welcome.** No capability may depend on the mouse; pointer input reaches nothing keys cannot. But OpenTUI's mouse support is first-class, and so is ours: it is built in deliberately from the start — click to select seats/tokens/tabs, click to focus a region, scroll where scrolling exists (ADR-0006 pins the map's contract: keyboard-first, click as enhancement, no drag promise). "Enhancement" describes the dependency order, not the build order or polish level.
3. **Honest status.** The UI never pretends: uncertainty, refusal, and lag are stated plainly and specifically, in core chrome, at the moment they matter.
4. **The table disappears into the session.** Chrome serves play — hierarchy, focus, and density are tuned for glance-reads mid-combat. Delight is saved for thresholds (splash, join, empty states), not the play loop.
5. **Wit is removable; function isn't.** Every screen must still read correctly with its tagline deleted (ADR-0008).

## Accessibility & Inclusion

- **Exact ANSI-16 palette** resolved from semantic theme tokens — the player's own terminal palette (including high-contrast and colorblind-tuned schemes) is respected, never overridden with truecolor.
- **Meaning never rides on color alone**: seat markers, selection, and states pair color with glyph/position changes.
- **Text mode** is a per-session toggle rendering the map as one legend character per cell — the map file's own format — for screen readers, small terminals, and glyph-hostile fonts.
- **Keyboard-only operation** is the contract, not a mode.
- Must remain legible over high-latency SSH: on-demand rendering, no ambient animation loops (ADR-0012), no decoration that turns lag into garbage frames.
