# supervillain — product definition

_The destination artifact of the wayfinder map (ticket 016). Every claim traces to a closed ticket resolution or a linked asset; where the map leaves fog, this document names it rather than filling it. This is the spine — the detailed assets are the muscles, linked at each seam._

## What supervillain is

supervillain is a terminal-first virtual tabletop. Players `ssh` into a live game room and sit at a real table rendered in their terminal; the GM hosts that table from their own machine. It launches with Draw Steel on a system-agnostic base, and it is built so the game you run is a folder of plain files you own and the key you connect with is the only account you need. Free to self-host, forever.

## Surfaces

Three surfaces, terminal-first ([001](../tickets/001-product-surfaces.md)):

1. **SSH terminal tabletop** — players `ssh <room>@supervillain.app` into rooms; the proven core, rendered with OpenTUI.
2. **`supervillain` CLI** — the GM's tool: mint and host rooms, manage campaigns and characters, publish artifacts.
3. **Web surface (supervillain.app + a backend)** — marketing, docs, and read-only artifact pages at launch; a paid in-browser terminal into the _same_ sessions later.

Explicitly **not** a surface: a parallel web VTT client. The future browser terminal is a thin client into the existing session infrastructure, not a second renderer — see [browser-terminal-bridge](browser-terminal-bridge.md).

## Pillars

Named, load-bearing, and marketing-page material:

- **"Your key is your account."** Identity is an ed25519 public key everywhere — an SSH key fingerprint for players, an iroh NodeId for GM/CLI, a passkey for the future browser. No signup ([009](../tickets/009-identity-across-surfaces.md)).
- **"You own your campaign."** A campaign is a folder of plain, hand-editable files on the GM's disk — a JSONL event log plus sidecar character files. No opaque database; portability is moving the folder ([010](../tickets/010-cli-artifact-scope.md)).
- **GM-hosted is the center of gravity.** "A game necessarily has a GM." Room authority lives on the GM's machine by default; gateway-hosted rooms are a supported second mode, not the core ([007](../tickets/007-hosting-authority-model.md)).
- **Free core, forever.** Self-hosting costs us nothing, so GM-hosted play, the CLI, and joining rooms via the gateway are free forever ([011](../tickets/011-business-shape.md)).

## System-agnostic base + the game module seam

The core is game-neutral: rooms, seats, presence, chat, generic dice, the shared event log, feed, and layout. Each game's content, schemas, and flows live in a **per-game module**. Draw Steel is the first module; Mothership and Mörk Borg are the expected expansion ([002](../tickets/002-game-system-scope.md)).

A game module is **code** — a TypeScript package behind a small core-defined interface, statically imported and compile-time registered. No rules DSL, no plugin framework, no dynamic loading. Four entry points, one package ([006](../tickets/006-game-module-seam.md), full spec: [game-module-seam](game-module-seam.md)):

| entry point | provides | consumer edge |
| --- | --- | --- |
| `model` | `S`/`C`/`E` types, `init`, `apply` — pure, platform-free | everyone |
| `authority` | `decide` — all randomness, all authority | **host** (model+authority) |
| `view` | panels, `renderEvent` | **gateway/table** (model+view) |
| `content` | packaged data, terminology, file validators | **CLI** (model+content); also read by `authority` and `view` |

Key invariants (the rest are in the asset):

- **Host never imports OpenTUI; the render side never imports `decide`.** Those two prohibitions are the seam, and they are mechanically enforced (below).
- **One shared JSONL log.** `core.*` events (rooms, seats, presence, chat, generic dice) and `ds.*` events interleave; game state is an **opaque serializable subtree** the core persists but never inspects.
- **Replay never reads files.** `init()` is deterministic; all randomness happens in `decide` and lands in the event payload; content-derived facts (derived stat blocks) land in payloads too. A GM can edit content mid-campaign and old events replay byte-identical. **Room logs are portable and self-contained.**
- **`TableView`** is a read-only snapshot value passed to `decide` — the licensed churn point where v1 growth is honest. The **envelope is the core's forever-promise**; payload versioning is the module's problem.
- **The fake game module** is the second adapter, spanning all four entry points — the core's conformance fixture, present from v0, so core tests cross the same seam Draw Steel does.

## Hosting & authority model

Both modes, one codebase, GM-hosted as the center of gravity ([007](../tickets/007-hosting-authority-model.md)):

- **GM-hosted (the flagship, and v0):** room authority runs on the GM's machine via `supervillain create` (the create command _is_ the host); the campaign JSONL lives on the GM's disk; players reach it over iroh. The gateway is a doorway, not a landlord. The CLI verb set used throughout the resolutions is `create` / `join` / `publish`.
- **Gateway-hosted (supported, arrives v3):** rooms that persist while the GM sleeps, running on our servers. This is the paid tier — built last so it debuts as pure addition, never a paywalling of something free.
- **The RoomStore seam** — one interface, in-process store or iroh client behind it — is a standing architectural commitment that keeps both modes on one reducer and one codebase, and keeps a late pivot to gateway-first available as a fallback.

**What supervillain.app durably stores:** gateway-hosted room logs (once that mode exists) and the name→NodeId registry for GM-hosted rooms. Nothing durable for GM-hosted tables themselves — those live on the GM's disk.

## Identity across surfaces

Key-as-account, everywhere ([009](../tickets/009-identity-across-surfaces.md)):

- **Terminal:** SSH key fingerprint for players, iroh NodeId for GM/CLI. A keyless **guest path** exists with a can't-miss upgrade box; guest progress is **adopted** on upgrade by appending a linking event, so historical attribution stays immutable while progress becomes reachable (prototype-validated — [prototype-lessons](prototype-lessons.md)).
- **Cross-device key linking is launch-tier (v1):** one-time codes bind a second key to the same identity. The first GM with a desktop and a laptop hits this immediately. GM roaming (joining your own room from any machine) falls out of linking + key-as- account; the room host stays where it was minted.
- **Web read-only artifacts: capability URLs.** The unguessable share link _is_ the permission; revocable by the owner from terminal/CLI. **No web accounts** at launch.
- **Browser terminal (v3): passkey against the web backend.** A passkey is a keypair, so "your key is your account" survives the browser; the gateway mints the browser session onto the same identity primitive. Ed25519 public keys are the unifying primitive across SSH keys, NodeIds, and passkeys.

## CLI scope

The `supervillain` CLI is the GM's tool ([010](../tickets/010-cli-artifact-scope.md)):

- **Launch nouns: campaigns and characters.** Maps are deferred — they drag in the battle-map (FrameBuffer) story, its own scope tier.
- **A campaign is a folder of plain files** on the GM's disk: a JSONL event log plus human-readable sidecar character files a GM can hand-edit between sessions. No opaque database.
- **Portability is "move the folder."** `export`/sync verbs are vN polish.
- **`supervillain publish <artifact>`** mints the read-only capability URL — the bridge that makes the web surface real.
- **Offline:** characters are editable offline; rooms are mintable/resumable but only playable with a live host.

## Business shape

([011](../tickets/011-business-shape.md))

- **The core is free forever** — GM-hosted play, the CLI, joining rooms via the gateway. Self-hosting costs us nothing.
- **The paid story is one bundle: "host your game on our servers"** — persistence (rooms up while the GM sleeps) + browser access (the in-browser terminal is a paid perk, not a free surface) + **maybe AI features** (explicitly a MAYBE).
- **Licensed content: one-time charges, down the line**, contingent on actual agreements with game makers.
- **Nothing payment-shaped at launch.** The scaffold must only avoid painting the web backend into a corner payments can't be added to. Checkout venue (web vs terminal) is left open; default expectation is web.

## Brand voice

Restraint. Structural copy — menus, help bars, errors — stays dry, legible, and serious, because this is an actual play tool; the deadpan-villainy register surfaces only at the emotional beats (a room minted → "your table is live. summon your players:", the guest-upgrade box, empty states, marketing headlines) and is never explained. Full-commitment theming (GM as "mastermind" everywhere) is rejected because it fights the seriousness of the tool. The name is locked as **supervillain**; the canonical domain is **supervillain.app**, and in-product copy reads `ssh <room>@supervillain.app` ([012](../tickets/012-naming-branding.md)).

## Web launch scope

Launch web = **marketing + docs + artifact pages** (character sheets, session logs) as capability URLs — minimal but present, because they are the product's shareable loop ([013](../tickets/013-web-launch-scope.md)):

- **Publish = snapshot push.** `supervillain publish` copies the artifact's data to the web backend at publish time, so URLs work while the GM's laptop sleeps. Re-publish to update, revoke to delete. Publishing is a visible act of copying data _out of_ your folder — reinforcing "you own your campaign."
- **Capability URLs ship custom OpenGraph images** — per-artifact OG cards, because the link unfurl in a group chat is the page's first impression. Implies server-side OG image generation at launch.
- **One backend service** owns the registry API, key-link codes, and capability-URL mint/revoke/render + OG generation. The SSH gateway stays its own process: two deployables, one monorepo.
- **No user auth at launch.** Capability URLs are the access model; passkeys arrive with the paid tier. The backend profile is: a DB, public HTTP, server-rendered pages, OG images — passkey-ready but with an empty auth slot.

## Scope tiers

Exactly as ticket [014](../tickets/014-scope-tiers.md) resolved them:

| tier | headline | what it adds |
| --- | --- | --- |
| **v0** | a real Draw Steel table plays over SSH | GM-first room over iroh; both player doors; neutral core + thin DS module; persistent campaign folder; iroh CI gate is the first build milestone |
| **v1** | flagship story complete — **this is launch** | DS at play-support depth; campaigns + characters as CLI nouns; `publish`; web launch (marketing/docs/artifact pages + OG); cross-device key linking + guest adoption; **still GM-hosted only** |
| **v2** | character builder | the retention move; its own licensing pass (a builder reproduces far more rulebook content than a renderer) |
| **v3** | the paid tier | gateway-hosted rooms + browser terminal + payments debut **together**; timed on demand signal |
| **v4+** | second game | Mothership / Mörk Borg, only once Draw Steel is deep |
| **vN** | unordered roadmap | battle maps, AI features, expansion-playbook detail |

**v0 detail** (the milestone-1 seed):

- **GM-first**, not gateway-first. Rationale: matches the center of gravity, and gateway persistence _is_ the paid tier — building it first would build the paid feature before the free core. The iroh CI-matrix gate is the first milestone; the fallback ladder (Node room host → Rust sidecar) bounds the risk to schedule, not existence.
- **Two player doors, one client:** `ssh supervillain.app` is mandatory (zero-install is the pitch; the gateway is a stateless doorway — name registry + iroh proxy), and direct `supervillain join` over iroh also ships. Both are the same RoomStore-client seam.
- **Gameplay floor:** neutral core (chat, dice, shared log, presence) + a thin Draw Steel module — power rolls with edges/banes, a DS-shaped initiative tracker, read-only stat blocks loaded from files. Proves the 006 seam with one real module. Draw Steel independence notice in-product from day one.
- **Persistent:** rooms append JSONL to the campaign folder and resume after GM restart. No artifacts, publish, web, or key linking in v0; identity is key-as-account automatically.
- **Seats are log-derived** _(correction 2026-07-14, surfaced by issue #8 — the definition said the core owns seats but never specified claiming)_: room creation claims the GM seat (`gm`) for the creating key; a joining key claims a seat on arrival (`core.seat-claimed`, seats named `player-N` in claim order); a key holds at most one seat per room, so reconnecting with the same key returns to the same seat, and claiming is idempotent. Seat events replay like everything else — a joiner's fold derives the same seating the host holds. Guest identity is the SSH door's concern (#9); the direct door always has a key. Before the gateway registry exists, the direct door's room-ref is the iroh ticket `create` prints — names arrive with #9. _(Correction 2026-07-14, issue #9, [ADR-0004](../../adr/0004-gateway-registration-trusted-stamping-and-guest-actors.md): names arrive via `create --name <room> [--gateway <addr>]`, which registers name→host-address at the gateway over iroh; ownership is the registering key, re-registration by the same key updates the address. The receipt's gateway identity becomes the host's sole trusted stamper, letting the gateway submit for the players it proxies without weakening ADR-0002. Keyless SSH lands as a per-session `guest:<12 hex>` actor via keyboard-interactive, behind the upgrade box.)_

**v1 depth:** DS at **play-support depth only** — full sheet rendering, condition tracking, resource tracking (heroic resources, recoveries, surges), victory tallies. Character files are still authored outside the app. **No builder** (biggest scope trap, and the licensing-heaviest surface — held to v2).

**Accepted launch gap:** v1 has no answer for "my GM's machine is off." That is what v3 gateway-hosting resolves, deliberately.

## Monorepo shape & stack

**The better-t-stack verdict: there is no invocation.** bts is wrong for this product; the workspace is hand-rolled ([015](../tickets/015-monorepo-stack.md), full spec: [monorepo-stack](monorepo-stack.md)). Verified against a fresh clone (e1bf536f): `bts add` is addon-only and `bts.jsonc`-gated with no path into a foreign workspace; bts has no library-package generator and no dependency-cruiser; its opentui addon is a local single-process TUI starter, dismissed explicitly. bts survives only as a convention reference and a possible v1 `apps/web` graft source.

**Workspace tree:**

```
apps/
  gateway/           # SSH session adapter, name registry, iroh proxy
  cli/               # supervillain: host embedding, campaign nouns, local attach
packages/
  config/            # strict tsconfig base, dependency-cruiser rules, shared tool config
  core/              # envelope, log, registries (interfaces), seam interfaces,
                     # TableView, theme-token types
  table/             # the shared client: renderer fold, core chrome (feed, layout
                     # slots, focus routing, rejection feedback), token→ANSI resolution
  room-host/         # single-writer host: decide loop, JSONL persistence,
                     # in-process RoomStore adapter
  room-wire/         # RoomStore wire protocol over the transport seam: codec,
                     # serve half, iroh client adapter (correction — ADR-0002)
  transport-iroh/    # iroh endpoint behind the narrow transport seam
  session/           # transport-neutral session contract
  identity/          # ed25519 key-as-account primitives (SSH key ↔ NodeId)
  games/draw-steel/  # model / authority / view / content
  games/fake/        # conformance fixture, all four entry points
```

Structural calls: **`packages/table` is the shared client** — the only OpenTUI consumer outside game `view` entries; it serves both v0 doors and v3's browser terminal, and never imports `decide`. **`room-host` is a package, not an app** — three consumers (CLI in-process at v0, gateway in-process at v3, Node-fallback bin if it lands that way). **Registries compose in the apps** (apps do the static game imports; room-host takes an injected authority registry and stays game-agnostic). **`session` is real on day one** — the gateway's SSH adapter and the CLI's local-TTY attach are two genuine adapters of one contract, never typed to ssh2. **No `apps/web` until v1.**

**Tooling:**

- **Plain Bun workspaces, no Turborepo** (root scripts + `tsc -b` cover this size).
- **TypeScript 7** (native tsc, GA 2026-07-08); every package `composite: true` off the `packages/config` strict base; **all packages emit js + d.ts** (no bundler; apps consume built output). The Node-compat set compiles under `nodenext` so emitted output is Node-loadable by construction — the hedge's first enforcer.
- **oxlint + oxfmt** (pinned; oxfmt is 0.x — absorb format churn deliberately).
- **dependency-cruiser rules in `packages/config`, CI from day one** — the lattice enforcement: `games/*` imported only by apps; `@opentui/*` only in `packages/table` and `games/*/view`; nothing on the table side imports `decide`; `content` imports `model` only; `bun:*`/`@opentui/*` banned across the Node-compat set; only `apps/gateway` imports `bun:sqlite`.
- **Test discipline — the runner is the runtime claim.** Bun-bound code → `bun test`; the Node-compat set → vitest under Node. **`transport-iroh` + `room-host` run the same specs under both runners — that dual lane IS the 008 CI matrix.**

**The CLI artifact:** a **compiled Bun binary** (`bun build --compile`) — "host your table from one file you downloaded." It statically imports the game packages, so DS's packaged content rides inside the binary and a GM's binary version pins their content version. Platforms: **linux-x64, linux-arm64, macos-arm64 (three triples)** — macos-x64 was dropped from the original four-triple set when the hello-iroh smoke surfaced that upstream publishes no darwin-x64 iroh artifact ([ADR-0001](../../adr/0001-drop-macos-x64-from-v0-gm-platforms.md)); Windows GMs via WSL2 (named churn, revisit trigger: a real Windows GM cohort). Built per-triple on native CI runners; curl installer + checksums + macOS codesign from day one; GitHub releases at v0 (brew/npm deferred). **Distribution invariant:** one file → one archive (binary + sidecar `.node`) → **never "install a runtime."** The Node fallback rung is a dev/CI hedge and the gateway's option, not a GM-shippable artifact.

**The data edge:** the **event log is the canonical durable data — plain files** (campaign folder now; gateway room logs via the RoomStore seam at v3). Server-side databases are only ever lookup/index state, so ORM pressure never develops. The gateway store is **SQLite via `bun:sqlite`, directly — no ORM**; v0 schema is the name→NodeId registry (~one table), with a ten-line `PRAGMA user_version` migration helper from day one.

## Milestone 1, specified

Derived strictly from the decisions above; **no product decisions left open.**

**First commit (the 006 → 015 genesis):** the **core package** (envelope, log, registries, seam interfaces, `TableView`, theme-token types) + the **fake game module** (all four entry points) + the **dependency-cruiser lattice check** — before any feature exists. The fake module is the conformance surface: core tests cross the same seam Draw Steel will. The lattice check is 015's acceptance test — it must hold host / gateway / CLI (/ web at v1) plus game-modules-as-packages with entry-point boundaries enforced.

**The gate (milestone 1's exit criterion):** the **iroh CI matrix** — `transport-iroh` and `room-host` running the same spec files under **both Bun and Node** lanes, proving **two-peer direct connection, forced-relay, reconnect, and clean shutdown**, **cross-platform** (linux-x64, linux-arm64, macos-arm64 — ADR-0001). This dual-runner lane _is_ the 008 matrix and _is_ milestone 1's gate per ticket 014. If Bun fails, the ladder is: Node room-host → Rust iroh sidecar — schedule risk, not existence risk.

**Then the v0 slice:** a GM-first Draw Steel room over iroh; both player doors (`ssh supervillain.app` mandatory + direct `supervillain join`); the neutral core + thin DS module (power rolls, DS initiative tracker, read-only file-loaded stat blocks); a persistent campaign folder that resumes after GM restart; the Draw Steel independence notice in-product.

**Verify-at-scaffold caveats** (burn down in the first days, not blockers — [monorepo-stack](monorepo-stack.md)):

1. TS7 `declarationMap` emit (absent at RC) — built-output consumption needs it for cross-package go-to-definition.
2. dependency-cruiser pins its own `typescript@6` for parsing while tsc 7 builds — no stable TS7 programmatic API until 7.1.
3. The **hello-iroh compile smoke per triple**: a direct platform-specific `.node` import inside `bun build --compile` output. (OpenTUI's native artifact is already solved upstream via `$bunfs`; iroh is the open question.)
4. oxfmt 0.x pinning; absorb the format churn deliberately when the Prettier port lands.

## Licensing constraints that bind the product

From the Draw Steel Creator License ([003](../tickets/003-draw-steel-license.md), full findings: [draw-steel-license](draw-steel-license.md)):

- **What we may ship free at launch:** rules text, ancestry/class/kit names, mechanics, and stat values sourced **solely from the license's enumerated documents**. The license states no quantity limit and no digital-tool exclusion, and permits free _or paid_ works.
- **The exact independence notice is mandatory** both in a conspicuous in-product legal/about surface _and_ on the marketing page: _"supervillain is an independent product published under the DRAW STEEL Creator License and is not affiliated with MCDM Productions, LLC. DRAW STEEL © 2026 MCDM Productions, LLC."_ It ships from v0 (baked into the v0 gameplay floor).
- **No MCDM / main DRAW STEEL logos, book art, screenshots/scans, copied trade dress, or unlisted-source content.** The plain-text "for Draw Steel" compatibility wording is fine; the supplied compatibility logo is optional. Do not imply endorsement.
- **Counsel before monetization.** SaaS and raw-data resale are _not_ expressly addressed by the license, so the paid model (v3) and the exact notice placement need legal review before any charge. Per-game expansion licenses (Mothership, Mörk Borg) are fog until expansion is scheduled.

## Named-churn ledger + open fog

Deferred by decision, not oversight — recorded so nothing looks forgotten.

**Interface / stack churn** (from the assets):

| churn | where | when |
| --- | --- | --- |
| character↔seat bindings | `TableView` | v1 |
| per-game chat idioms | `GameView` | v1, if real play demands |
| field-level schema introspection | content entry | v2 (builder) |
| creation-wizard flow | new entry point or CLI-side | v2 |
| `apply` widened to core events | authority end | escape hatch, only if a game needs reactive coupling |
| Turborepo / task caching | tooling | when the graph actually hurts |
| `export`/sync verbs | CLI | vN polish |
| Windows-native CLI (drop WSL2) | CLI triples | trigger: real Windows GM cohort |
| macos-x64 (Intel Mac) CLI | CLI triples | trigger: real Intel-Mac GM cohort + a darwin-x64 iroh artifact ([ADR-0001](../../adr/0001-drop-macos-x64-from-v0-gm-platforms.md)) |
| brew tap / npm shim | CLI distribution | post-v0 |
| Drizzle-or-similar ORM | web backend | attached to v1 web |

**Open fog** (deliberately unspecified — [map.md](../map.md)):

- **v1 web framework pick** — deferred; constraints recorded (SSR, OG images, push-ingest snapshot DB, capability-URL routes, passkey-ready empty auth slot). Decided when `apps/web` arrives. Its lattice edge is **model + content only, never authority/view** — and possibly _no_ game import at all if published snapshots are self-describing.
- **Expansion playbook** — what adding a second game demands (content pipeline, per-game licensing). Placed v4+; full spec is a later effort.
- **Battle maps** — deferred from the launch noun set; the FrameBuffer story, map artifacts, and their sharing model arrive together when maps enter the roadmap.
- **AI features** — an explicit MAYBE on the paid tier (v3 earliest); what they'd even be (GM assistance? recap from event logs?) is undiscovered.
- **Paid-tier mechanics** — pricing, checkout venue, passkey onboarding flow. Placed v3; specified when payments enter the roadmap.
- **Production relays** — iroh needs dedicated managed or self-hosted relays (≥2 regions); n0's public relays are dev-only. Managed pricing vs self-hosted egress is unpriced ([iroh-viability](iroh-viability.md)).

---

_Sources: map.md and tickets 001–015 (resolutions) with assets prototype-lessons.md, draw-steel-license.md, browser-terminal-bridge.md, iroh-viability.md, game-module-seam.md, monorepo-stack.md. This document closes ticket 016 and marks the map done._
