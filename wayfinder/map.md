# supervillain — product definition map

label: `wayfinder:map`

**MAP COMPLETE (2026-07-13).** All 16 tickets closed. The destination artifact:
[product-definition](assets/product-definition.md). Next effort: scaffold the real
repo per its Milestone 1 section.

## Destination

A product definition for supervillain — surfaces, scope tiers (v0/v1/vN), architecture
seams, and monorepo shape — complete enough that the better-t-stack invocation (or the
decision that better-t-stack is wrong for this) is mechanical, and milestone 1 in the
new repo is specifiable with no product decisions left open.

## Notes

- Domain: terminal-first virtual tabletop (SSH), launching with Draw Steel. Prior
  prototype proved the SSH table (see CLAUDE.md → Prior art); lessons only, never code.
- Skills: `/grilling` + `/domain-modeling` for decisions; `/research` for AFK reading;
  `/prototype` for fidelity-raising artifacts; `/replicant` for OpenTUI API truth
  (local clone pinned in CLAUDE.md).
- Standing preference: surface product-level trade-offs to the user instead of deciding
  silently — they enjoy co-imagining. One ticket per session. Commit only when asked.
- This is a planning map: tickets resolve decisions. No product code in this repo.

## Decisions so far

- [Product surfaces](tickets/001-product-surfaces.md) — three surfaces: SSH terminal
  tabletop; `supervillain` CLI (GM-hosted rooms + artifacts); web (marketing, docs,
  read-only artifacts, later an in-browser terminal into the *same* sessions).
- [Game-system scope](tickets/002-game-system-scope.md) — system-agnostic base;
  Draw Steel first, near-future expansion to Mothership, Mörk Borg, etc. Core stays
  game-neutral; per-game modules carry content/schemas/flows.
- [Hosting & authority model](tickets/007-hosting-authority-model.md) — both modes,
  GM-hosted as center of gravity; RoomStore seam keeps them one codebase; the gateway
  (supervillain.app) stores gateway room logs + name registry only.
- [Identity across surfaces](tickets/009-identity-across-surfaces.md) — key-as-account
  everywhere (SSH key / NodeId / passkey); guest path + adoption; capability URLs for
  web artifacts, no web accounts early; cross-device key linking is launch-tier.
- [CLI artifact scope](tickets/010-cli-artifact-scope.md) — launch nouns: campaigns +
  characters (maps deferred); campaign = a folder of plain files the GM owns ("you own
  your campaign" is a pillar); `publish` mints capability URLs; portability = move the
  folder.
- [Business shape](tickets/011-business-shape.md) — core free forever (self-hosting
  costs us nothing); paid = "host your game on our servers": persistence + browser
  access (+ MAYBE AI); licensed content one-time charges later, per game-maker
  agreements; nothing payment-shaped at launch.
- [Naming, domain & brand voice](tickets/012-naming-branding.md) — name locked:
  supervillain; canonical domain: supervillain.app (owned); voice: restraint —
  deadpan, villainy only at emotional beats.
- [Web surface launch scope](tickets/013-web-launch-scope.md) — launch web = marketing
  + docs + artifact pages; publish = snapshot push; capability URLs get custom OG
  images; one backend service beside the gateway; no user auth at launch.
- [Preserve prototype lessons](tickets/005-preserve-prototype-lessons.md) — lessons
  distilled to [prototype-lessons](assets/prototype-lessons.md): proven state seams,
  OpenTUI gotchas, SSH/PTY verification method, still-true iroh analysis vs superseded
  old-plan scope. No code carried.
- [Draw Steel license research](tickets/003-draw-steel-license.md) — Creator License
  permits free *or paid* works using text/names/mechanics/stats from its enumerated
  documents; exact independence notice required in-product + on marketing; no MCDM
  logos/art/unlisted content without written permission; SaaS/data-resale not expressly
  addressed → counsel before monetization. Detail:
  [draw-steel-license](assets/draw-steel-license.md).
- [Browser terminal bridge](tickets/004-browser-terminal-bridge.md) — xterm.js over a
  binary WebSocket to a gateway-side transport adapter feeding the same renderer/room
  factory as SSH; web backend mints short-lived single-use room-scoped grants from the
  passkey session; product owns a transport-neutral session seam (OpenTUI's SSH bridge
  is ssh2-coupled; no browser renderer exists). Detail:
  [browser-terminal-bridge](assets/browser-terminal-bridge.md).
- [iroh transport viability](tickets/008-iroh-viability.md) — keep iroh; JS bindings
  hit 1.0 (2026-06-15, in step with core) and passed a Bun smoke test (bind/close
  endpoint); ship Bun-in-process behind a narrow transport seam, gated on a two-peer
  cross-platform CI matrix; fallbacks: Node room host → Rust sidecar; production needs
  dedicated relays (n0's public relays are dev-only). Detail:
  [iroh-viability](assets/iroh-viability.md).
- [Game module seam](tickets/006-game-module-seam.md) — a game module is code: one
  package, four entry points (model/authority/view/content) behind a small core
  interface; namespaced core.*/ds.* events in one shared log, game state opaque,
  replay never reads files (logs portable); host never imports OpenTUI, gateway never
  imports decide; fake game module = second adapter from v0; the dependency lattice is
  015's acceptance test. Detail: [game-module-seam](assets/game-module-seam.md).
- [Scope tiers](tickets/014-scope-tiers.md) — v0 = GM-first real Draw Steel table over
  SSH (both doors: ssh-via-gateway mandatory + direct CLI join; neutral core + thin DS
  module; persistent campaign folder; iroh CI gate = first build milestone). v1 =
  launch: play-support DS depth, CLI nouns + publish, web launch, key linking — still
  GM-hosted only. v2 = character builder; v3 = paid tier (gateway-hosted rooms +
  browser terminal + payments debut together); v4+ = second game; maps/AI stay vN.
- [Monorepo shape & stack](tickets/015-monorepo-stack.md) — better-t-stack verdict:
  no invocation; hand-rolled Bun workspace, first commit = core + fake game module +
  dependency-cruiser lattice check. apps gateway/cli + packages incl. table (shared
  client for all doors) and room-host (package, three consumers); TS7, oxlint/oxfmt,
  runner-is-the-runtime-claim test split; compiled CLI binary (4 triples, never
  "install a runtime"); event log canonical, gateway bun:sqlite no-ORM. Detail:
  [monorepo-stack](assets/monorepo-stack.md).
- [Assemble product definition](tickets/016-assemble-product-definition.md) — the
  destination artifact assembled and head-reviewed:
  [product-definition](assets/product-definition.md). Scaffolding is now mechanical;
  milestone 1 is specified with no product decisions left open. Map done.

## Not yet specified

- **v1 web framework pick** — deferred by [015](tickets/015-monorepo-stack.md) with
  its constraints recorded (SSR, OG images, push-ingest snapshot DB, capability-URL
  routes, passkey-ready empty auth slot); decided when apps/web arrives.
- **Expansion playbook** — what adding a second game (Mothership, Mörk Borg) actually
  demands: content pipeline, per-game licensing terms. Placed v4+ by
  [Scope tiers](tickets/014-scope-tiers.md) — after Draw Steel is deep; full spec is a
  later effort.
- **Battle maps** — deferred out of the launch noun set; when maps enter the roadmap,
  the FrameBuffer story, map artifacts, and their sharing model come with them.
- **AI features** — an explicit MAYBE on the paid hosted tier (v3 at the earliest);
  what they'd even be (GM assistance? recap generation from event logs?) is
  undiscovered.
- **Paid-tier mechanics** — pricing, checkout venue, passkey onboarding flow; placed
  v3 by [Scope tiers](tickets/014-scope-tiers.md) (debuts with gateway-hosted rooms +
  browser terminal); specified when payments enter the roadmap.

## Out of scope

- Executing the scaffold (better-t-stack run, repo bootstrap) — first act of the next
  effort, not this map.
- Porting code from the scrapped prototype — lessons only.
