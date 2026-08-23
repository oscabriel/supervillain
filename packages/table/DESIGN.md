# Design — the supervillain table & lobby

Answers "how it looks"; companion to [PRODUCT.md](./PRODUCT.md) ("who and why"). Distilled 2026-07-29 from the TUI vision research pass (Caves of Qud layouts/vibes, kitlangton/ghui, tuiparts, kommander/tts-lab, an OpenTUI capability audit against the pinned clone @ `a0b9064`, and a Cogmind/Brogue/lazygit/BBS precedent sweep), plus the [MEK.txt](https://www.mek.gallery/) touchstones added 2026-07-29 (MonoMEK, MEKmode, WOR(L)D, CHAPTER00.txt — see Render tiers). This is a design system for a terminal surface: "typography" here means text attributes and glyph vocabulary, "palette" means semantic tokens over the player's own ANSI-16. Where this file says "law," a violation is a bug; where it says "target," it names direction the current code hasn't reached.

## Theme

The player's terminal is the theme. We draw structure and hierarchy; the terminal supplies the colors, the font, and the background. One token-and-type world, two compositions: the Table is a quiet framed instrument panel; the Lobby is a distinct open threshold in a large field. Both are dense, typeset, and still. Personality is spent at thresholds (splash, join, empty states, become-a-GM); the play surface is deliberately boring in the way a good instrument is boring.

## Color

- **Law — indexed intent only.** Every color is a semantic token resolved to an exact ANSI-16 index (`RGBA.fromIndex`). Body UI never uses truecolor, never blends, never repaints the background (`defaultBackground`/`defaultForeground` are real values, use them). OpenTUI widget adoption must pass an explicit token for _every_ color option — the widgets default to hex.
- **Law — glyph first, color second, with one recorded exception.** Color may reinforce a distinction, never carry it alone. Every state has a printing glyph; no state renders as whitespace. ADR-0030's default Pane-focus frame is the sole exception: whole-frame `muted`→`accent` color alone, repairable by the opt-in `>` focus-marker preference.
- **Law — structure is quiet except for the focused Pane.** Inactive rules, borders, corner ticks, and dividers render in `muted` or default fg. The focused Pane's whole frame and title use `accent`; no fill or content recoloring joins it. At most one accent color per surface.
- **Token vocabulary (target).** Grow the current five tokens (`primary` 7, `muted` 8, `accent` 6, `danger` 1, `success` 2) toward intent _pairs_ in the tuiparts shape (intent + on-intent, so contrast is never inferred), adding `warning` (3) and game vocabulary (seat states, conditions, terrain) as tokens — not inline indices. The channel split is law: **background answers "what is chosen"; foreground answers "can I act on this."** Pane location is ADR-0030's recorded frame-color exception, with the optional printing marker as repair.
- **Attributes are the second axis.** `dim` (timestamps, chrome, hints), `bold` (speaker names, critical results), `italic` (asides), `reverse` (map cursor, selected token), `underline` (links). This costs zero palette and is the cheapest hierarchy win available. `blink` is banned.

## Glyph vocabulary — the one pen

A small, rigid mark set reused on every screen, so competence transfers between screens:

- **Light box-drawing only.** `─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼`. Heavy, double, and rounded are banned — the system has a single pen. Every rule that meets another rule gets a real junction character, computed, never a broken cross.
- **Closed Pane frames, open passive bands.** Every focusable Table Pane has one independent closed light box and a stable top title; adjacent Pane boxes have a one-cell gutter. There is no outer Table frame. Header, state/status, and keybind bands stay unboxed, so a box means “focus lives here.” The Lobby does not inherit the Pane grid: its content stays open and only typed fields receive a closed box.
- **The mark cell.** Lists reserve a 1-cell glyph gutter unconditionally; state changes swap the glyph, never shift the label. Marks: `>` selection/focus caret, `●`/`○` presence, `[−]`/`[+]` open/Rail, `!` Lobby callout, `·` unknown, `−` none.
- **Key legend grammar.** `[key] verb` pairs, lowercase, dim, and space-separated. The Table bar is bottommost and starts with the focused Pane name; `[tab] pane`, `[v] layout`, and `[?] keys` remain visible, followed by up to two contextual entries. Disabled affordances render dim, not hidden. The Lobby uses the same grammar in its own screen-contextual terminal-bottom bar. All entries derive from the live keymap, never hand-typed.
- **Meters are text-in-bar.** A background-color run behind real text (`HP 188 / 188`), never a separate gauge widget. A meter that cannot vary is not rendered.
- **Cell discipline.** Every glyph occupies exactly one cell; no emoji, no combining marks; width measurement is wcwidth/grapheme-aware (player names are not ASCII). An ASCII fallback glyph set exists as a token overlay, not a code path.

## Layout

- **Framed Table, open bands.** Header (room · game · round) / main (`Feed — Map — Sidebar`) / unboxed state/status row / full-width Message Pane / bottom keybind bar. Map is the large central focal surface. Feed and Sidebar are side Panes that independently toggle to informative Rails. The Lobby is not a quiet copy of this grid: it is a 48-column-wordmark-led, left-aligned composition centered horizontally in the upper third of a vast field and allowed to fall toward the top as height shrinks.
- **Named layouts, not resizable panes.** Three presets — `map-focused`, `feed-focused`, `no-map` — cycled by `v`, auto-selected by terminal size at connect, and persisted under ADR-0026's explicit-choice rule. `map-focused` protects Map width; `feed-focused` widens Feed while retaining Map; `no-map` removes Map and gives its width to Feed. Regions never move, and independent Rail choices survive layout changes.
- **Rails are not hidden Panes.** Feed and Sidebar each toggle with `c` or their clickable `[−]`/`[+]`. A Rail is five columns: one-cell frame around three content cells. Feed Rail carries a printing `●` activity mark and the `1…99+` count of FeedLines received while closed (zero omits the count), clearing on expansion. Sidebar Rail carries per-Seat `●`/`○` presence in Seat order, anonymous `+N` Spectators, and `+N` overflow. The two Rails never disappear while the Table is renderable. A focused Rail is indicated by its accent frame only: at five columns it has no title for the focus-marker `> ` prepend, so ADR-0030's color-only-focus revisit trigger must be evaluated with Rails in mind.
- **Depth is a stack, not more panes.** Modals are inset with the live Table visible at the edges, never a blackout. The `?` key sheet redraws the underlying Table through muted/dim indexed tokens—no alpha scrim—and consumes all input until `?`/Esc. A topmost layer that cancels an interaction still consumes it.

### Demotion ladder

Explicit open/Rail choices are applied first. Keyed choices persist by resolved identity; Guest choices last for one Door session. Automatic Rails are fit constraints, never saved, and reopen automatically when the explicit preference fits again. Named-layout snap-down stays one-way.

| order | shared demotion |
| --- | --- |
| 1 | keybind bar drops its two contextual entries: `5 → 3`, preserving Pane name plus `[tab] pane [v] layout [?] keys` |
| 2 | expanded Sidebar rows drop dim second lines: `two-line → one-line` |
| 3 | expanded Feed/Sidebar shrink to their readable minima; body copy wraps and optional figures demote before names |
| 4 | preset-specific temporary Rails apply in the table below |
| 5 | a visible Map that cannot meet the module-declared viewport floor in the active tier forces one-way snap toward a fitting preset, ultimately `no-map` |
| 6 | if `no-map` cannot retain Feed, Sidebar Rail, Message, and the three-entry keybar, replace the Table with an honest `terminal too small` surface—never silently erase a required region |

| preset | first forced Rail | second forced Rail / terminal failure |
| --- | --- | --- |
| `map-focused` | Feed | Sidebar; if Map still misses its floor, snap to `no-map` |
| `feed-focused` | Sidebar | Feed remains open; if Map misses its floor, snap to `no-map` |
| `no-map` | Sidebar | Feed remains open; if its readable minimum cannot fit, use the too-small surface |

The ladder is encoded as one ordered table-side engine. Its Sidebar compact stage is named, not yet live: no shipped Panel emits two-line rows; the first such rows must add their real (likely height-based) trigger at this stage rather than invent another fit policy. The keybar stage derives five entries from the live keymap and drops its two contextual entries when the resulting line does not fit; the Map-floor/snap stage remains a named no-op owned by #117.

Map minima are game knowledge declared by the game `view` entry as width×height in Map cells. Table converts them without taste: the bitmap and pixel tiers cost 4×3 terminal cells per Map cell; text tier costs 1×1. Draw Steel's literal dimensions require an ability-corpus justification. Failure never auto-switches tiers: `?` always offers `[t] map tier`, including from `no-map`, and `v` retries a Map layout. `80×24` is a required acceptance shape; other thresholds derive from declared minima and measured content rather than magic breakpoints.

## Components

- **List rows:** up to two lines on a computed column skeleton — line 1 mark + name + right-aligned figures, line 2 dim detail, dropped first under `compact`. Per-group width fitting; hanging indent on wraps. The Sidebar Rail's `●` means a claimed Seat, deliberately diverging from the expanded Seat list's viewer-relative `●`; the expanded list is the side expected eventually to yield to the mark-table reading (`●`/`○` = presence), outside this ticket.
- **Sidebar:** one stable core Pane, never one Pane per module Panel. The Seat list remains at its top while a visible horizontal tab strip switches module Panels below; exactly one Panel is visible. Tabs follow module declaration order, Left/Right wraps between them, and Up/Down belongs to the active Panel. Clicking a tab activates it; clicking an actionable Panel row performs that row's keyboard-equivalent behavior, and either click focuses the Sidebar. Entries are selectable; selection cross-highlights the matching Token on Map (the keyboard's hover). Sort by certainty: directly known above hearsay.
- **Examine card:** one fixed slot order everywhere — identity / state line / prose / relations / mechanics / one-word verdict in the bottom rule — anchored beside its subject, never over it.
- **Dialogs:** draft-and-apply. Edits land on a draft; nothing broadcasts until `Enter`; `Esc` discards; errors recolor the frame and stay in place. "Changes apply only when Enter is pressed" is the reassurance a shared table needs.
- **Focus:** click directly or traverse `Feed → Map → Sidebar → Message` with Tab; Shift+Tab reverses and absent Panes drop out. Initial focus follows the layout's focal viewing Pane, never Message. Inactive whole frame/title is `muted`; focused whole frame/title is `accent`. The optional focus-marker preference prepends a reserved `>` title cell. Collections inside a Pane still use roving focus with repair; `disabled` (shown, skipped) and `unavailable` (gone) remain distinct.
- **Command surfaces:** Message is the sole free-text Pane. Its leading character is the mode indicator (plain text = chat, `/` = command); no viewing Pane may enter an internal all-printable mode. A Pane action needing text borrows Message under a contextual title and returns to its origin on submit/cancel. Ordinary drafts survive focus changes; contextual drafts discard on cancel; Tab-away leaves a task pending under its visible contextual title (cancel is the only discard point). Contextual submission is optimistic: Enter closes the task before authority answers, and a Rejection surfaces as ordinary status feedback without restoring the typed text or reopening the task. A command menu opens on a ~150 ms delay so experts never see it paint.

## Keyboard

`v` is the only globally reserved bare letter outside Message. Message owns every printable character, including `v` and `?`; the corresponding permanent bar entries stay visible but dim/disabled until Message releases focus.

| scope | bindings |
| --- | --- |
| core outside Message | `Tab`/`Shift+Tab` next/previous Pane; `v` layout; `?` key sheet |
| Message | printable text; Enter send/submit; Esc return/cancel; Tab traverse while preserving an ordinary draft |
| Feed | Up/Down or `j`/`k` line; PageUp/PageDown viewport; Home/End oldest/latest; `c` Rail |
| Map | arrows or `h`/`j`/`k`/`l` move; Enter/Space hold/drop; `x`/Delete remove; `t` tier |
| Sidebar chrome | Left/Right module tab; `c` Rail; Up/Down delegated to active Panel |
| Draw Steel initiative | `s` start; `e` end; `t` take turn; `a` add hero; `m` add enemy; `r` roll setup |
| Draw Steel roll setup | `a`/`i`/`m`/`p`/`r` characteristic; `e` edges; `b` banes; Enter roll; Esc cancel |
| Draw Steel sheet | `[`/`]` bound character |
| key sheet | `f` focus marker; `t` Map tier; `?`/Esc close |
| Lobby non-input | arrows or `j`/`k`; Enter choose; contextual `q` leave; Esc back |

## Motion

- **Stillness is the identity.** On-demand rendering (ADR-0012) is an aesthetic position, not just a constraint. No spinners, no marching bars, no ambient effects, no interval-driven repaints — a renderable holding a timer is a bug.
- **Finite motion only.** Deliberate bursts ride `requestLive()` → Timeline → guaranteed `dropLive()` on every exit path, with the idle-CPU benchmark proving the counter returns to zero. Licensed uses: the splash wordmark settling once, a moved token sliding one cell, a two-render flash notice in the status line.
- **Attention without animation.** New-activity gutter marks on feed lines, live counters in the state band, terminal title updates ("your turn"), capability-gated OSC notifications. Never blink, never motion.

## Voice in the chrome

Structural copy — menus, hints, errors, status — is dry, specific, and lowercase-calm. Wit fires only at licensed thresholds (ADR-0008: splash tagline, offline beat) and every screen reads correctly with its tagline deleted. The feed is the teaching surface: first-encounter mechanics get one dim bracketed explainer line, once per player, persisted gateway-side — no tutorial mode, no popups.

## Render tiers

Text mode is the design target; pixel-glyph (ADR-0007) is the treat; bitmap mode (ADR-0032) sits above both where the connect-time probe confirms kitty graphics support — the same MEKmode raster as true pixels, placed via Unicode placeholders inside the cell grid, sharing the pixel tier's 4×3-cells-per-tile budget so viewport and demotion math never fork on tier. The tiers are one composer with different encoders — the fallback is structural, not bolted on. The 4×3 budget (ADR-0021) changes the Map viewport calculation, never Pane-frame geometry. Pane frames remain tier-neutral one-cell light boxes; pixel ornament is Map plus isolated threshold art such as the Lobby wordmark, not borders/titles; bitmap never leaves the Map. Octant packing is done in TypeScript against theme tokens (`setCell` + `fromIndex`); OpenTUI's native supersample path emits truecolor and is off-limits. Map retains the byte-level exact-ANSI-16 guarantee outside ADR-0032's one carve-out — truecolor lives inside the transmitted bitmap payload, never in cells; controllable chrome uses indexed tokens while #81's documented OpenTUI RGB-white remainder remains permitted outside Map.

**The battlemap's look is MEK.txt's.** The named aesthetic touchstones for the map surface are [MonoMEK](https://www.mek.gallery/font-monomek-otf) (CC0; ADR-0007's original atlas source, superseded by MEKmode per ADR-0021), [MEKmode](https://www.mek.gallery/mekmode-otf) (pixel-perfect 8×12 textmode font with a Ding Mode organized by keyboard rows — landscape/nature, structures, geometry), and the maps built from them: [WOR(L)D](<https://www.mek.gallery/wor(l)d-mek.txt-x-figma-collaboration>) and CHAPTER00.txt — DOS-tile scenes whose density, patterned terrain fills, framed regions, and inline caption boxes are the target register for the table's map region. MonoMEK and MEKmode are siblings, not the same font: MonoMEK (2024) is a vector monotype drawn in a pixel idiom but not grid-exact; MEKmode (2025) is a strict pixel-perfect 8×12 rebuild for textmode with the same text/dings split (**the pinned atlas source since ADR-0021** — files obtained directly from MEK.txt 2026-07-30 under an informal free-use okay; its 100+ dings are the tile-art vocabulary). A live proof of the register: **Emberwood** ([zombot.net/emberwood](https://zombot.net/emberwood/index.html)), a colony sim rendered entirely in MEK-Dings pictograms — patterned terrain fills, a legend keyed char→meaning, and the token idiom worth stealing: _people share one figure and use role colors_ (glyph carries the kind, color carries the role — our glyph-first/color-second law, applied to tokens). Emberwood's density is a ceiling reference for terrain that wants texture, not a floor for every tile: **empty and sparse glyph tiles are acceptable and expected** — negative space is part of the look, and an intentionally faint floor tile carries its state in the legend. The intent, stated plainly: the pixel-glyph tier renders octant-block pixels that **are the MEKmode dings, bit for bit** (we cannot ship a font over ssh — the atlas is the font, ADR-0007/0021); the text tier prints the real legend characters those dings are keyed to, which is what keeps the fallback lossless. Local fonts for reference: `~/.local/share/fonts/MonoMEK/` (MEK-Mono.otf, MEK-Dings.otf, v1.2).

## Open questions (tracked, not decided)

**Definition bug — the default-legend art pass has no approved visual assignments.** #50 asks “which ding is a wall? a door?”, but ADR-0006 pins the default legend characters (`. # + ^ ~`) while ADR-0007/0021 only pin that pixel mode draws the atlas entry keyed by the authored character. That mechanically yields the MEKMODE dings keyed by `. # + ^ ~`; it does not say those five pictures are the approved floor/wall/door/hazard/difficult curation, nor license substituting other keys. Do not invent a second character→picture mapping in render code. The definition must name the five approved keyed dings (or explicitly approve identity-keying as the art pass) before that checklist item can close.

Required-glyph baseline and the degraded-ASCII tier (now including pre-Unicode-16 terminals, where octants render as tofu — ADR-0021 keeps the no-detection stance); whether the text tier wants an optional sized-up variant to match the pixel tier's scale (touches ADR-0006's 1-cell-per-tile pin — tracked as a GitHub issue); a pressed idiom without color blending (the key-sheet recession is resolved as token dimming, not a general scrim); the missing "separator" grey tier under ANSI-16 (dim vs glyph-weight); split-footer scrollback for the feed (spike against the Door before commitment); the feed's per-line renderable restructure (measure against the ADR-0018 ceiling); non-animated attention signals need playtesting.
