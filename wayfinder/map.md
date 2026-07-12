# supervillain — product definition map

label: `wayfinder:map`

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

## Not yet specified

- **Expansion playbook** — what adding a second game (Mothership, Mörk Borg) actually
  demands: content pipeline, per-game licensing terms, when it enters the roadmap.
  vN-tier: [Scope tiers](tickets/014-scope-tiers.md) gists it; full spec is a later
  effort.
- **Battle maps** — deferred out of the launch noun set; when maps enter the roadmap,
  the FrameBuffer story, map artifacts, and their sharing model come with them.
- **AI features** — an explicit MAYBE on the paid hosted tier; what they'd even be
  (GM assistance? recap generation from event logs?) is undiscovered.
- **Paid-tier mechanics** — pricing, checkout venue, passkey onboarding flow;
  post-launch by decision, specified when payments enter the roadmap.

## Out of scope

- Executing the scaffold (better-t-stack run, repo bootstrap) — first act of the next
  effort, not this map.
- Porting code from the scrapped prototype — lessons only.
