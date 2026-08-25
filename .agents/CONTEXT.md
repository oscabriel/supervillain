# supervillain

Terminal-first virtual tabletop: a system-agnostic core hosts live game rooms over SSH; per-game modules (Draw Steel first) plug in behind a fixed seam. This glossary is the ubiquitous language — definitions distilled from the wayfinder decisions.

## The table

**Room**: A live game session, bound at creation to exactly one game module by a logged game id. _Avoid_: session (reserved for the transport-neutral session contract), lobby, server

**Table**: The shared terminal client that renders a room — core chrome (feed, layout slots, focus routing) plus the module's panels. It is the only OpenTUI consumer outside game `view` entries. _Avoid_: client app, frontend, renderer (the table contains the renderer fold)

**Contextual text task**: A Pane action's temporary borrowing of the Message Pane for one line of free text (ADR-0030): the requesting Panel supplies a title (shown on the Message frame) and a converter from submitted text to its game command — core seam type `MessageTask` on `GamePanelInput.requestMessageTask`. Submit/cancel returns focus to the origin Pane; the borrowed-over ordinary draft is restored; contextual drafts discard on cancel. Submission is optimistic: the task closes on Enter, and an authority Rejection surfaces as ordinary status feedback — the typed text is not restored and the task does not reopen _(pinned 2026-08-04, [#118](https://github.com/oscabriel/supervillain/issues/118) review)_. _Avoid_: input mode, text prompt, modal (the pending task is visible chrome, not hidden state)

**Seat**: A position at the table held by an identity; the core owns seats, presence, and who holds the GM seat. The seat belongs to the actor, not the connection: an actor joining a room where it already holds a seat — a GM `join`ing their own table included — gets a second **view** of that one seat, never a second seat _(pinned 2026-07-25, grilling session, after [#63](https://github.com/oscabriel/supervillain/issues/63))_. _Avoid_: slot (reserved for layout), player object

**Spectator**: A seatless, read-only view of a live room, admitted only while the GM's `/spectate` toggle is on (default off, dies with the session, `off` ejects everyone). Spectators claim no seat, never touch the log, and surface only as a gateway-side presence count in the table chrome _(pinned 2026-07-30, [ADR-0027](./adr/0027-general-spectating-seatless-views-behind-a-gm-admission-mode-toggle.md); support access is its first use case)_. _Avoid_: observer, viewer (reserved connotations: a seat's view), audience seat

**GM**: The person with authority over a room; every supported game has one. The GM's machine hosts the room by default. _Avoid_: mastermind (rejected theming), dungeon master, admin

**Door**: A way for a player to reach a room. v0 ships one: `ssh <room>@supervillain.app` through the gateway; `supervillain join` is its thin CLI front (an ordinary SSH session with the CLI-managed key) _(correction 2026-07-24, [#54](https://github.com/oscabriel/supervillain/issues/54), ADR-0012: the direct-iroh second door is deleted; a native local-render join is trigger-gated future work)_. _Avoid_: entry point (reserved for game-module facets), login method

**Campaign folder**: A folder of plain, hand-editable files on the GM's disk — the JSONL event log plus sidecar character files. The canonical durable data; portability is moving the folder. _Avoid_: save file, database, workspace

**Agent surface**: The property that the campaign folder's plain files are directly operable by any coding agent the user points at them — by construction, not by feature. Agents edit under the GM's hand-edit contract (between sessions, validated by `content`/core validators); the log is read-only to everything but the host; replay never reads files, so agent edits can't corrupt history. Agent authorization belongs to the user's harness — supervillain has no propose-versus-run list or human-versus-agent permission boundary. Never paywalled — paid AI means features we operate. _Avoid_: AI integration, agent API (there is no separate API — the file is the API)

**Guest**: A keyless player identity. Guest progress is adopted on upgrade by appending a linking event — historical attribution stays immutable while progress becomes reachable. _Avoid_: anonymous user, temp account

**Battle map**: The core-owned tactical surface (v1): a terrain grid loaded from a map file plus live tokens, rendered by core chrome as one cell grid. It adjudicates nothing — shared positional truth the GM manipulates. _Avoid_: board, scene, arena

**Map file**: A plain-text file in the campaign folder's `maps/`: a metadata header (name, legend) then an ASCII grid, one character per cell, legend-mapped to the core tile vocabulary. Terrain only — authored in a text editor; entering play copies its content into the log (`core.map-loaded`), so replay never reads it. _Avoid_: map asset, level file

**Token**: A movable marker on the battle map: id, glyph, label, position, optional seat binding — never game fields. The GM controls all tokens; a player moves only tokens bound to their own seat. _Avoid_: piece, miniature; unqualified "token" for theme tokens (that's **Theme token**)

**Glyph atlas**: The committed, build-time-baked set of 1-bit glyph bitmaps (from MEKMODE, by MEK.txt — ADR-0021) that pixel-glyph and bitmap modes render from. Pure data in a render-side package; every entry is keyed by the character it depicts, which is what makes text mode a lossless fallback. _Avoid_: sprite sheet, font (it ships no font)

**Bitmap mode / Pixel-glyph mode / Text mode**: The three render tiers of the battle map. Bitmap (default where the connect-time probe confirms kitty graphics with Unicode-placeholder support — ADR-0032's placeholder-support condition; Konsole and iTerm2 sit outside it): the same atlas tiles and tokens as true pixels. Pixel-glyph (default otherwise): atlas glyphs rasterized as octant blocks. Both cost one tile = 4×3 cells. Text (per-session opt-in): one legend character per cell — the map file's own format. Same data, same events, same interactions in all three; body text is always real text; ornamental chrome is pixel-glyph only — bitmap never leaves the Map. _Avoid_: graphics mode, image mode, kitty mode, ASCII mode

## Identity

**Key-as-account**: The identity model: an ed25519 public key is the account everywhere — SSH key fingerprint for players, a linked per-machine host key for the GM's hosting machine, passkey for the future browser. No signup; identity is the equivalence class of linked keys, and the backend's internal per-class id is never user-facing _(correction 2026-07-24, [#54](https://github.com/oscabriel/supervillain/issues/54), ADR-0012: NodeId died with iroh; the pillar survives verbatim — key-as-**address** is the lost half and copy must never imply it)_. _Avoid_: user account, profile, registration

**Key linking**: Binding a second key to the same identity via a one-time code (v1). GM roaming falls out of it. _Avoid_: device sync, multi-login

**Key revocation**: Retiring a key — a **state on the key, not a deletion**. The key leaves its equivalence class for authentication only: it can no longer host, join, link, or revoke, while the identity keeps its other keys, its rooms, and every line the retired key wrote. The state is a column in the gateway store, so refusal is a local read that works with our servers unreachable (ADR-0012 NQ-3, located by ADR-0013). Rotation is "link new, retire old"; `supervillain key revoke` is the retire, run from a machine you still control. It takes effect **immediately** — live pipes and terminals on that key are dropped, not merely refused at their next login ([#59](https://github.com/oscabriel/supervillain/issues/59)). _Avoid_: delete key, unlink, deactivate, ban

**Pairing code**: The one pasteable string that onboards a Host to a gateway — the gateway's `wss://` URL carrying its certificate fingerprint in a `#fp=sha256:…` fragment (ADR-0014). Only a gateway with no CA behind it publishes one; a hosted gateway's address is a bare URL. The first connection pins the fingerprint in per-machine config; a gateway that later serves a different certificate is refused, never prompted. Distinct from **key linking**'s one-time code, which binds a key to an identity. _Avoid_: invite code, join token, gateway secret

**Capability URL**: An unguessable share link that _is_ the permission for a published web artifact; revocable by the owner. The web access model at launch — no web accounts. _Avoid_: share token, public link, permalink

**Trusted stamper**: A connection identity a room host allows to submit commands on behalf of other actors — in v0, exactly the gateway the GM registered with. Everyone else remains bound to connection-equals-actor (ADR-0001/0004). _Avoid_: proxy auth, impersonation, service account

## Events & authority

**Envelope**: The core-defined wrapper on every event: actor, seq, timestamp, namespaced type, payload. The core's forever-promise; payload schema versioning is the module's problem. _Avoid_: event header, wrapper, message format

**Log**: The single shared JSONL event log per room, where `core.*` and game (`ds.*`) events interleave. Canonical, portable, and self-contained — replay never needs files. _Avoid_: history, database, journal

**Namespace discipline**: `core.*` events belong to the core (rooms, seats, presence, chat, generic dice); `ds.*` to the module. One-way both ways: the module never emits `core.*`, the core never emits `ds.*`. _Avoid_: event routing, type prefixes

**Host**: The single-writer authority process for a room — the decide loop plus JSONL persistence, running on the GM's machine at v0 (`packages/room-host`, embedded by the CLI). Never imports OpenTUI. _Avoid_: server, backend, authority service

**decide**: The module's authority function: `(state, command, TableView) → events | Rejection`. All randomness and all authority live here, and nowhere else. _Avoid_: handler, command processor, resolver

**apply**: The module's pure reducer: `(state, event) → state`. Replay-safe, closed over the module's own events. _Avoid_: reducer (as a distinct concept), event handler

**TableView**: A read-only snapshot value captured at command time, exposing the narrow core facts `decide` may read (seats, GM seat). The licensed churn point for v1 growth. _Avoid_: core state handle, context object

**Rejection**: `decide`'s refusal result. The module supplies the message; core chrome renders it as ephemeral feedback to the issuing client — the loop closes in core. _Avoid_: error, exception, validation failure

**Replay**: Refolding the log to reproduce state, byte-identical. Replay never reads files or content — everything computed (dice, derived stat blocks) already lives in payloads. _Avoid_: rehydration, state recovery

**Fold posture**: The pinned contract for events a fold can't cleanly apply (ADR-0010). Two tiers, keyed on type recognition: **unknown** (unrecognized type — silent skip, forward compat) vs **known-invalid** (recognized type, violated payload shape or fold invariant). Writers halt, readers tolerate: the host refuses to open on either tier; render folds never halt — unknown skips silently, known-invalid skips loudly (a warning FeedLine with seq/type/reason). Shapes a released host ever wrote stay valid forever via upgrade-on-read. _Avoid_: error handling, validation policy, fault tolerance

**Fold checkpoint**: A disposable, memory-only capture of a live Room's render fold through one Envelope sequence, paired with a bounded contiguous Envelope tail for late join replay (ADR-0018). The Host's Log remains authoritative; the gateway rebuilds the checkpoint from Host replay on every attachment and discards it on detach. _Avoid_: save state, durable snapshot, authority snapshot

**Event grammar**: A game module's declared list of every event type its fold recognizes, legacy shapes included — the mechanism the writer fold asks to tell _unknown_ from _known-invalid_ on module events (ADR-0010, implemented in [#53](https://github.com/oscabriel/supervillain/issues/53)). It rides on the module's authority entry beside `model` and `authority`; a declaration, not a derivation, so the module's own conformance test is what holds it to `apply`. _Avoid_: event schema, event registry, type whitelist

## Game modules

**Game module**: A TypeScript package satisfying the core's seam interface — statically imported, compile-time registered. Code, not a plugin: no rules DSL, no dynamic loading. _Avoid_: plugin, extension, game pack

**Entry point**: One of a module's four facets — `model`, `authority`, `view`, `content` — each a package subpath with its own import rules. Consumers take only the entry points on their edge. _Avoid_: door (reserved for player access), export, submodule

**Fake game module**: The trivial second adapter spanning all four entry points — the core's conformance fixture, present from the first commit, so core tests cross the same seam Draw Steel does. _Avoid_: mock module, test stub

**Content**: The module facet with two natures: packaged static data (license-enumerated material, terminology) shipping inside the module, and schemas — validator functions, never schema documents — for GM-owned files. Ships schemas, never instances. _Avoid_: assets, resources, data pack

## Rendering

**Pane**: A focusable region of Table chrome. The stable set is Feed, Map (when present), Sidebar, and Message (the opt-in input line); a game Panel lives inside Sidebar and never becomes a Pane. _Avoid_: panel, slot, window

**Rail**: The collapsed-but-still-present state of the Feed or Sidebar Pane, retaining compact activity or presence and a way back to the open Pane. A Rail is not hidden. _Avoid_: hidden pane, minimized window

**Panel**: A one-way-data-flow view component placed by a core layout slot: receives a read-only `S` snapshot plus `TableView`, emits only `dispatch(command)`. _Avoid_: pane, widget, window, component (unqualified)

**Slot**: The core layout's placement vocabulary for panels; v0 needs only a sidebar slot. _Avoid_: seat (reserved), pane

**FeedLine**: The semantic value `renderEvent` returns for the shared feed: text runs tagged with theme tokens, never ANSI. _Avoid_: log line, message, output

**Theme token**: A semantic style tag composed by modules and core alike; resolution to ANSI happens once, in core chrome, against exact-ANSI-16. _Avoid_: color, style, ANSI code

## Infrastructure

**Gateway**: The stateless doorway on our servers: SSH session adapter, the name registry (name→owner identity, durable; name→live pipe, memory), and the broker the Host dials out to (one shared per-Room fold, per-session views). What the per-Room fold shares is each live Room's memory-only **fold checkpoint and bounded Envelope tail**; each joining Table restores that checkpoint then runs the module's `apply` over the tail and live stream _(correction 2026-07-26, [ADR-0018](./adr/0018-memory-only-render-fold-checkpoints-and-bounded-replay-tails.md): issue #77 deliberately authorizes the `packages/table` contract change the 2026-07-25 correction reserved; the gateway now genuinely shares game-derived render state without making it durable or authoritative)_. It never imports `decide` and never holds the campaign folder. "Stateless" means **no durable game state** — the registry, host key, and presentation prefs are durable; game-derived state is memory-only and game content never enters logs or telemetry _(correction 2026-07-22, [#44](https://github.com/oscabriel/supervillain/issues/44), ADR-0008)_ _(correction 2026-07-24, [#54](https://github.com/oscabriel/supervillain/issues/54), ADR-0012: iroh proxy → outbound broker; also runs self-hosted — the same MIT binary)_. _Avoid_: server, host (reserved), relay

**Role**: Which of the two things the one compiled `supervillain` binary is doing. The **table roles** are `create`/`join` and the management nouns; the **gateway role** is `supervillain gateway serve` — the SSH door, the broker, and the gateway's own store, and the whole of the self-hosted posture (ADR-0015). A role selector is not a verb: the pinned `create`/`join`/`publish` set is the table surface and stays closed. _Avoid_: mode, subcommand (the selector is one), daemon

**Lobby**: The gateway's first-contact TUI, served on bare `ssh supervillain.app` and as the chrome for unknown/offline-room arrivals: splash (pixel-glyph wordmark), interactive join, become-a-GM screen, settings. Pre-identity for guests — a `guest:` actor mints only at room entry. Never creates rooms; no game imports (ADR-0008). _Avoid_: storefront, landing page, menu (unqualified); "lobby" for a room (a room is a live session)

**RoomStore**: The seam with one interface and two adapters — in-process store (GM-hosted) or broker client over `transport-ws` — keeping both hosting modes on one reducer and one codebase _(correction 2026-07-24, [#54](https://github.com/oscabriel/supervillain/issues/54), ADR-0012: the remote adapter was the iroh client; `room-wire` is transport-neutral, so a returning transport is another adapter)_. _Avoid_: room database, state store

**Session**: The transport-neutral contract between a connected terminal and the table, with two genuine adapters from day one: the gateway's SSH adapter and the CLI's local-TTY attach. Never typed to ssh2. _Avoid_: connection, socket, room (a session attaches to a room)

**Lattice**: The dependency-cruiser ruleset that mechanically enforces the seam and workspace boundaries; in CI from the first commit, and the scaffold's acceptance test. _Avoid_: import rules, lint config

**Sovereignty invariant**: The pinned guarantee that supervillain.app is never load-bearing — any table runs indefinitely with our servers unreachable. A review gate every feature must answer ("does this work sovereign?"); exceptions need their own ADR naming why (the v1 hosted-only publishing exception, ADR-0015, is the template) _(pinned 2026-08-22, [ADR-0033](./adr/0033-ownership-lives-in-format-not-topology-sovereignty-invariant-and-log-egress.md))_. _Avoid_: self-hosting requirement (self-hosting is a posture, the invariant is the guarantee), offline mode (a feature; this is a structural property)

**Sovereignty ladder**: The three hosting postures read as one ordered surface — hosted (zero friction, our servers), self-hosted gateway (the GM's own box and address, same MIT binary per ADR-0015), local/offline (no network). Each rung trades convenience for control; no rung is a trap because Log egress exits every rung _(named 2026-08-22, [ADR-0033](./adr/0033-ownership-lives-in-format-not-topology-sovereignty-invariant-and-log-egress.md))_. _Avoid_: tier (reserved for scope tiers — postures are not a pricing ladder), upgrade path (movement between rungs is free in both directions)

**Log egress**: The one-way materialization of a room's Log into a Campaign folder (`supervillain campaign pull`, [#135](https://github.com/oscabriel/supervillain/issues/135)): byte-identical Envelope stream, never merged or synced back, free at every tier forever. Pull authorization is **any seated identity** — the owner trivially included; past seat-holding counts, verifiable from the log being pulled; Spectators stay excluded, seatless views never touch the log. Owner-gating would add no privacy (every connected Table already holds the full Envelope stream) while foreclosing Authority handoff (#136). Pillar infrastructure, not a feature — it is what makes every ladder rung exit-safe and keeps "you own your campaign" true regardless of hosting topology _(pinned 2026-08-22, [ADR-0033](./adr/0033-ownership-lives-in-format-not-topology-sovereignty-invariant-and-log-egress.md); authorization pinned 2026-08-22, #135 triage)_. Distinct from **Publish**, which copies snapshot artifacts to the web backend. _Avoid_: sync (deliberately bidirectional connotation — egress is one-way only), export (reserved for vN CLI polish verbs), backup

**Authority handoff**: Named direction ([#136](https://github.com/oscabriel/supervillain/issues/136)), not built: resuming a dead Host from the shared Log on a seated player's machine — possible because replay is byte-identical and the Log needs nothing but itself. Dissolves the accepted launch gap with zero new infrastructure. Design pinned at triage (#136, 2026-08-22, [ADR-0034](./adr/0034-authority-handoff-design-in-log-seat-transfer-epoch-fencing-and-claim-follows-the-log.md)): the GM seat **migrates via an in-log transfer event** — never delegated stamping, never a second GM seat — so the handoff is itself part of byte-identical replay; **any current seat holder** may resume (symmetric with Log egress authorization); the resumed room **runs log-only**, serving future map loads from whatever files its folder holds and degrading cleanly otherwise; fencing is the in-log epoch, the registry claim follows the log, fenced hosts stand down terminally, orphaned events are never auto-merged. Build unscheduled — graduates when ADR-0033's offline-host tripwire fires. Single-host surfaces must record their interaction with handoff rather than foreclose it _(surfaced 2026-08-22, [ADR-0033](./adr/0033-ownership-lives-in-format-not-topology-sovereignty-invariant-and-log-egress.md))_. _Avoid_: failover (server vocabulary), host migration (implies automatic; this is a deliberate act), takeover (connotes hostility), GM proxy/delegate (rejected stamping shapes)

**Publish**: Snapshot push: `supervillain publish` copies an artifact's data out of the campaign folder to the web backend, minting a capability URL. Re-publish updates; revoke deletes. _Avoid_: share, upload, sync

**Artifact**: A publishable snapshot of campaign data — character sheets, session logs, and battle maps (terrain-only) at launch. Keyed by (owner identity, type, name); its capability URL is stable across re-publishes and dies permanently on revoke. _Avoid_: document, export, page

**Publisher warranty**: The GM's affirmation, made by publishing, that they own the content or hold every permission and consent needed to publish it, including content concerning or contributed by other people. It is responsibility assigned to the publisher, not a player-consent mechanism. _Avoid_: consent flag, platform approval

**Operator takedown**: The service operator's discretionary, permanent removal of a published Artifact without changing who owns its content. It kills that Capability URL like an owner revoke but does not prevent a fresh Publish. _Avoid_: suspension, moderation hold, operator revoke

**Snapshot document**: The self-describing, core-owned, integer-versioned payload `supervillain publish` pushes — semantic sections/fields (sheets), FeedLine-style entries (logs), legend + grid (maps) — built by the CLI from its own game packages so web artifact pages import zero game code. The backend renders every version it ever accepted. _Avoid_: export format, render output, JSON blob

**Card section**: The core-owned part of a snapshot document (title, description, a few label/value pairs, optional glyph + accent hint, grid for maps) that OG card generation renders — keeping unfurl images as game-blind as the pages. OG image URLs derive from the capability token and are revoked with it. _Avoid_: metadata, preview data

## Process

**Named churn**: Interface evolution deferred by decision and recorded in a ledger (e.g. `TableView` character↔seat bindings at v1) — expected growth at a licensed point, not scope creep. _Avoid_: tech debt, TODO, backlog

**Fog**: An area deliberately left unspecified until its decision point arrives (v1 web framework, paid-tier mechanics). Named in the definition so nothing looks forgotten. _Avoid_: unknowns, open questions (fog is _deliberately_ open)

**Independence notice**: The mandatory Draw Steel Creator License notice, verbatim, in-product and on the marketing page from v0. Exact legal form/capitalization confirmed at counsel review. _Avoid_: disclaimer, attribution, credits
