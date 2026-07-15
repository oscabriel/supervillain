# supervillain

Terminal-first virtual tabletop: a system-agnostic core hosts live game rooms over SSH and iroh; per-game modules (Draw Steel first) plug in behind a fixed seam. This glossary is the ubiquitous language — definitions distilled from the wayfinder decisions.

## The table

**Room**: A live game session, bound at creation to exactly one game module by a logged game id. _Avoid_: session (reserved for the transport-neutral session contract), lobby, server

**Table**: The shared terminal client that renders a room — core chrome (feed, layout slots, focus routing) plus the module's panels. It is the only OpenTUI consumer outside game `view` entries. _Avoid_: client app, frontend, renderer (the table contains the renderer fold)

**Seat**: A position at the table held by an identity; the core owns seats, presence, and who holds the GM seat. _Avoid_: slot (reserved for layout), player object

**GM**: The person with authority over a room; every supported game has one. The GM's machine hosts the room by default. _Avoid_: mastermind (rejected theming), dungeon master, admin

**Door**: A way for a player to reach a room. v0 ships two: `ssh <room>@supervillain.app` through the gateway, and direct `supervillain join` over iroh. Both are the same RoomStore-client seam. _Avoid_: entry point (reserved for game-module facets), login method

**Campaign folder**: A folder of plain, hand-editable files on the GM's disk — the JSONL event log plus sidecar character files. The canonical durable data; portability is moving the folder. _Avoid_: save file, database, workspace

**Guest**: A keyless player identity. Guest progress is adopted on upgrade by appending a linking event — historical attribution stays immutable while progress becomes reachable. _Avoid_: anonymous user, temp account

## Identity

**Key-as-account**: The identity model: an ed25519 public key is the account everywhere — SSH key fingerprint for players, iroh NodeId for GM/CLI, passkey for the future browser. No signup. _Avoid_: user account, profile, registration

**Key linking**: Binding a second key to the same identity via a one-time code (v1). GM roaming falls out of it. _Avoid_: device sync, multi-login

**Capability URL**: An unguessable share link that _is_ the permission for a published web artifact; revocable by the owner. The web access model at launch — no web accounts. _Avoid_: share token, public link, permalink

**Trusted stamper**: A connection identity a room host allows to submit commands on behalf of other actors — in v0, exactly the gateway the GM registered with. Everyone else remains bound to connection-equals-actor (ADR-0002/0004). _Avoid_: proxy auth, impersonation, service account

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

## Game modules

**Game module**: A TypeScript package satisfying the core's seam interface — statically imported, compile-time registered. Code, not a plugin: no rules DSL, no dynamic loading. _Avoid_: plugin, extension, game pack

**Entry point**: One of a module's four facets — `model`, `authority`, `view`, `content` — each a package subpath with its own import rules. Consumers take only the entry points on their edge. _Avoid_: door (reserved for player access), export, submodule

**Fake game module**: The trivial second adapter spanning all four entry points — the core's conformance fixture, present from the first commit, so core tests cross the same seam Draw Steel does. _Avoid_: mock module, test stub

**Content**: The module facet with two natures: packaged static data (license-enumerated material, terminology) shipping inside the module, and schemas — validator functions, never schema documents — for GM-owned files. Ships schemas, never instances. _Avoid_: assets, resources, data pack

## Rendering

**Panel**: A one-way-data-flow view component placed by a core layout slot: receives a read-only `S` snapshot plus `TableView`, emits only `dispatch(command)`. _Avoid_: widget, window, component (unqualified)

**Slot**: The core layout's placement vocabulary for panels; v0 needs only a sidebar slot. _Avoid_: seat (reserved), region, pane

**FeedLine**: The semantic value `renderEvent` returns for the shared feed: text runs tagged with theme tokens, never ANSI. _Avoid_: log line, message, output

**Theme token**: A semantic style tag composed by modules and core alike; resolution to ANSI happens once, in core chrome, against exact-ANSI-16. _Avoid_: color, style, ANSI code

## Infrastructure

**Gateway**: The stateless doorway on our servers: SSH session adapter, name→NodeId registry, iroh proxy. It folds `apply` over streamed events to feed views; it never imports `decide` and never holds the campaign folder. _Avoid_: server, host (reserved), relay (an iroh concept)

**RoomStore**: The seam with one interface and two adapters — in-process store (GM-hosted) or iroh client — keeping both hosting modes on one reducer and one codebase. _Avoid_: room database, state store

**Session**: The transport-neutral contract between a connected terminal and the table, with two genuine adapters from day one: the gateway's SSH adapter and the CLI's local-TTY attach. Never typed to ssh2. _Avoid_: connection, socket, room (a session attaches to a room)

**Lattice**: The dependency-cruiser ruleset that mechanically enforces the seam and workspace boundaries; in CI from the first commit, and the scaffold's acceptance test. _Avoid_: import rules, lint config

**Publish**: Snapshot push: `supervillain publish` copies an artifact's data out of the campaign folder to the web backend, minting a capability URL. Re-publish updates; revoke deletes. _Avoid_: share, upload, sync

**Artifact**: A publishable snapshot of campaign data — character sheets and session logs at launch. _Avoid_: document, export, page

## Process

**Named churn**: Interface evolution deferred by decision and recorded in a ledger (e.g. `TableView` character↔seat bindings at v1) — expected growth at a licensed point, not scope creep. _Avoid_: tech debt, TODO, backlog

**Fog**: An area deliberately left unspecified until its decision point arrives (v1 web framework, paid-tier mechanics). Named in the definition so nothing looks forgotten. _Avoid_: unknowns, open questions (fog is _deliberately_ open)

**Independence notice**: The mandatory Draw Steel Creator License notice, verbatim, in-product and on the marketing page from v0. Exact legal form/capitalization confirmed at counsel review. _Avoid_: disclaimer, attribution, credits
