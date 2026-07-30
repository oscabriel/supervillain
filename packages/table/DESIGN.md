# Design — the supervillain table & lobby

Answers "how it looks"; companion to [PRODUCT.md](./PRODUCT.md) ("who and why"). Distilled 2026-07-29 from the TUI vision research pass (Caves of Qud layouts/vibes, kitlangton/ghui, tuiparts, kommander/tts-lab, an OpenTUI capability audit against the pinned clone @ `a0b9064`, and a Cogmind/Brogue/lazygit/BBS precedent sweep), plus the [MEK.txt](https://www.mek.gallery/) touchstones added 2026-07-29 (MonoMEK, MEKmode, WOR(L)D, CHAPTER00.txt — see Render tiers). This is a design system for a terminal surface: "typography" here means text attributes and glyph vocabulary, "palette" means semantic tokens over the player's own ANSI-16. Where this file says "law," a violation is a bug; where it says "target," it names direction the current code hasn't reached.

## Theme

The player's terminal is the theme. We draw structure and hierarchy; the terminal supplies the colors, the font, and the background. One visual world across lobby and table: a quiet instrument panel with a literary streak — dense, typeset, still. Personality is spent at thresholds (splash, join, empty states, become-a-GM); the play surface is deliberately boring in the way a good instrument is boring.

## Color

- **Law — indexed intent only.** Every color is a semantic token resolved to an exact ANSI-16 index (`RGBA.fromIndex`). Body UI never uses truecolor, never blends, never repaints the background (`defaultBackground`/`defaultForeground` are real values, use them). OpenTUI widget adoption must pass an explicit token for _every_ color option — the widgets default to hex.
- **Law — glyph first, color second.** Color may reinforce a distinction, never carry it alone. Every state has a printing glyph; no state renders as whitespace.
- **Law — structure is never colored.** Rules, borders, corner ticks, and dividers render in `muted` or default fg. At most one accent color per surface.
- **Token vocabulary (target).** Grow the current five tokens (`primary` 7, `muted` 8, `accent` 6, `danger` 1, `success` 2) toward intent _pairs_ in the tuiparts shape (intent + on-intent, so contrast is never inferred), adding `warning` (3) and game vocabulary (seat states, conditions, terrain) as tokens — not inline indices. The channel split is law: **background answers "where am I / what is chosen"; foreground answers "can I act on this."**
- **Attributes are the second axis.** `dim` (timestamps, chrome, hints), `bold` (speaker names, critical results), `italic` (asides), `reverse` (map cursor, selected token), `underline` (links). This costs zero palette and is the cheapest hierarchy win available. `blink` is banned.

## Glyph vocabulary — the one pen

A small, rigid mark set reused on every screen, so competence transfers between screens:

- **Light box-drawing only.** `─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼`. Heavy, double, and rounded are banned — the system has a single pen. Every rule that meets another rule gets a real junction character, computed, never a broken cross.
- **Rule-filled headers, not boxes.** Section titles are label-in-rule: `─┤ seats ├──────`. Regions are marked by detached corner ticks or a single-side rule, not closed rectangles. Ink reaches both margins; gaps are filled with dim rules, never left ragged.
- **The mark cell.** Lists reserve a 1-cell glyph gutter unconditionally; state changes swap the glyph, never shift the label. Marks: `>` selection caret, `●`/`○` presence, `[-]`/`[+]` collapse, `·` unknown, `−` none.
- **Key legend grammar.** `[key] verb` pairs, lowercase, dim, space-separated, bottom-anchored, scoped to the focused region — derived from the live keymap, never hand-typed. Disabled affordances render dim, not hidden.
- **Meters are text-in-bar.** A background-color run behind real text (`HP 188 / 188`), never a separate gauge widget. A meter that cannot vary is not rendered.
- **Cell discipline.** Every glyph occupies exactly one cell; no emoji, no combining marks; width measurement is wcwidth/grapheme-aware (player names are not ASCII). An ASCII fallback glyph set exists as a token overlay, not a code path.

## Layout

- **Band frame.** The table is horizontal bands, not boxes: header band (room · game · round state, rule-filled to full width) / main (map region above feed, sidebar right) / state band (conditions | target/turn | contextual keys) / input line. The lobby is the quiet variant: vast field, small centered column, chevron back/next at the margins.
- **Named layouts, not resizable panes.** Three presets — map-focused, feed-focused, no-map — cycled by one key, auto-selected by terminal size at connect. Same regions, same relative positions in all three; only sizes change. Panels never move on their own.
- **The demotion ladder is written down.** Non-negotiables: the feed and the seat list. Everything else demotes in a stated order as space shrinks (map tiers full → minimal → hidden; sidebar rows two-line → one-line → count-only; hint count 5 → 3). The map viewport is sized so a typical module ability's reach is visible without scrolling — the number comes from the module, not taste.
- **Depth is a stack, not more panes.** `Enter` escalates a region to full view; `Esc` walks back one level. Modals are inset with the live table visible at the edges, never a blackout. A topmost layer that cancels an interaction still consumes it.

## Components

- **List rows:** up to two lines on a computed column skeleton — line 1 mark + name + right-aligned figures, line 2 dim detail, dropped first under `compact`. Per-group width fitting; hanging indent on wraps.
- **Sidebar:** a visible tab strip over the 28-column slot (seats first), the focused panel taking full height. Entries are selectable; selection cross-highlights the matching token on the map (the keyboard's hover). Sort by certainty: directly known above hearsay.
- **Examine card:** one fixed slot order everywhere — identity / state line / prose / relations / mechanics / one-word verdict in the bottom rule — anchored beside its subject, never over it.
- **Dialogs:** draft-and-apply. Edits land on a draft; nothing broadcasts until `Enter`; `Esc` discards; errors recolor the frame and stay in place. "Changes apply only when Enter is pressed" is the reassurance a shared table needs.
- **Focus:** roving focus with repair — one tab stop per collection, arrows within, membership follows visible order, and the tab stop repairs itself when a seat drops mid-session. `disabled` (shown, skipped) and `unavailable` (gone) are distinct concepts.
- **Command surfaces:** the input line's leading character is the mode indicator (plain text = chat, `/` = command). A command menu opens on a ~150 ms delay so experts never see it paint. `?` opens a keybinding sheet scoped to the focused region.

## Motion

- **Stillness is the identity.** On-demand rendering (ADR-0012) is an aesthetic position, not just a constraint. No spinners, no marching bars, no ambient effects, no interval-driven repaints — a renderable holding a timer is a bug.
- **Finite motion only.** Deliberate bursts ride `requestLive()` → Timeline → guaranteed `dropLive()` on every exit path, with the idle-CPU benchmark proving the counter returns to zero. Licensed uses: the splash wordmark settling once, a moved token sliding one cell, a two-render flash notice in the status line.
- **Attention without animation.** New-activity gutter marks on feed lines, live counters in the state band, terminal title updates ("your turn"), capability-gated OSC notifications. Never blink, never motion.

## Voice in the chrome

Structural copy — menus, hints, errors, status — is dry, specific, and lowercase-calm. Wit fires only at licensed thresholds (ADR-0008: splash tagline, offline beat) and every screen reads correctly with its tagline deleted. The feed is the teaching surface: first-encounter mechanics get one dim bracketed explainer line, once per player, persisted gateway-side — no tutorial mode, no popups.

## Render tiers

Text mode is the design target; pixel-glyph (ADR-0007) is the treat. The two tiers are the same composer with different glyph tables — the fallback is structural, not bolted on. The pixel tier's 4×3-cells-per-tile budget (ADR-0021) means the demotion ladder is written per tier. Octant packing is done in TypeScript against theme tokens (`setCell` + `fromIndex`); OpenTUI's native supersample path emits truecolor and is off-limits.

**The battlemap's look is MEK.txt's.** The named aesthetic touchstones for the map surface are [MonoMEK](https://www.mek.gallery/font-monomek-otf) (CC0; ADR-0007's original atlas source, superseded by MEKmode per ADR-0021), [MEKmode](https://www.mek.gallery/mekmode-otf) (pixel-perfect 8×12 textmode font with a Ding Mode organized by keyboard rows — landscape/nature, structures, geometry), and the maps built from them: [WOR(L)D](<https://www.mek.gallery/wor(l)d-mek.txt-x-figma-collaboration>) and CHAPTER00.txt — DOS-tile scenes whose density, patterned terrain fills, framed regions, and inline caption boxes are the target register for the table's map region. MonoMEK and MEKmode are siblings, not the same font: MonoMEK (2024) is a vector monotype drawn in a pixel idiom but not grid-exact; MEKmode (2025) is a strict pixel-perfect 8×12 rebuild for textmode with the same text/dings split (**the pinned atlas source since ADR-0021** — files obtained directly from MEK.txt 2026-07-30 under an informal free-use okay; its 100+ dings are the tile-art vocabulary). A live proof of the register: **Emberwood** ([zombot.net/emberwood](https://zombot.net/emberwood/index.html)), a colony sim rendered entirely in MEK-Dings pictograms — patterned terrain fills, a legend keyed char→meaning, and the token idiom worth stealing: _people share one figure and use role colors_ (glyph carries the kind, color carries the role — our glyph-first/color-second law, applied to tokens). Emberwood's density is a ceiling reference for terrain that wants texture, not a floor for every tile: **empty and sparse glyph tiles are acceptable and expected** — negative space is part of the look, and an intentionally faint floor tile carries its state in the legend. The intent, stated plainly: the pixel-glyph tier renders octant-block pixels that **are the MEKmode dings, bit for bit** (we cannot ship a font over ssh — the atlas is the font, ADR-0007/0021); the text tier prints the real legend characters those dings are keyed to, which is what keeps the fallback lossless. Local fonts for reference: `~/.local/share/fonts/MonoMEK/` (MEK-Mono.otf, MEK-Dings.otf, v1.2).

## Open questions (tracked, not decided)

Required-glyph baseline and the degraded-ASCII tier (now including pre-Unicode-16 terminals, where octants render as tofu — ADR-0021 keeps the no-detection stance); whether the text tier wants an optional sized-up variant to match the pixel tier's scale (touches ADR-0006's 1-cell-per-tile pin — tracked as a GitHub issue); a scrim/pressed idiom without color blending; the missing "separator" grey tier under ANSI-16 (dim vs glyph-weight); split-footer scrollback for the feed (spike against the Door before commitment); the feed's per-line renderable restructure (measure against the ADR-0018 ceiling); non-animated attention signals need playtesting.
