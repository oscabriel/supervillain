---
status: closed
type: grilling
assignee: oscar
blocked-by: [003, 008]
---

# Scope tiers (v0 / v1 / vN)

## Question

The synthesis ticket: lay every decided surface and pillar across time. What exactly
is **v0** (first thing real players touch), **v1** (the flagship story complete), and
**vN** (gisted roadmap)? The sharpest sub-question, deliberately parked from
[Hosting & authority model](007-hosting-authority-model.md): **which hosting mode
leads v0** — gateway-first (fastest to a live table; the prototype already proved it)
or GM-first (the center of gravity, but stakes v0 on iroh)?

Blocked on research because the answer genuinely depends on:
- [iroh transport viability](008-iroh-viability.md) — if bindings are solid under
  Bun, GM-first v0 is plausible; if not, gateway-first is forced.
- [Draw Steel license research](003-draw-steel-license.md) — what game content may
  ship in v0 at all.

Inputs already fixed: three surfaces; system-agnostic base with Draw Steel first;
both hosting modes with GM-hosted priority; launch nouns campaigns + characters;
web launch = marketing/docs/artifact pages with OG cards; free core, paid hosted
tier later, nothing payment-shaped at launch; browser terminal is paid-tier, post-
launch. Also place: cross-device key linking (launch-tier per identity decision),
battle maps (vN), expansion games (vN), AI features (maybe, vN).

## Resolution

Grilled 2026-07-11/12. Seven decisions, walked in dependency order; the tier
vocabulary grew from v0/v1/vN to v0/v1/v2/v3/v4+/vN during the grilling.

**v0 — a real Draw Steel table plays over SSH.**

- **GM-first** (the parked 007 sub-question, resolved): room authority on the GM's
  machine via `supervillain create`, reached over iroh. Rationale: matches the center
  of gravity ("a game necessarily has a GM") and the business shape (gateway
  persistence *is* the paid tier — building it first would build the paid feature
  before the free core). The iroh CI-matrix gate (two-peer, direct + forced-relay,
  cross-platform) is the first milestone of the build; the 008 fallback ladder
  (Node room host → Rust sidecar) bounds the risk to schedule, not existence; the
  RoomStore seam keeps a late pivot to gateway-first available as a fallback.
- **Two player doors, one client:** `ssh supervillain.app` is mandatory (zero-install
  is the pitch; gateway = stateless doorway: name registry + iroh proxy), and direct
  `supervillain join` over iroh also ships — both are the same RoomStore-client seam.
- **Gameplay floor:** neutral core (chat, dice, shared log, presence) + thin Draw
  Steel module — power rolls with edges/banes, DS-shaped initiative tracker,
  read-only stat blocks loaded from files. Proves the 006 seam with one real module.
  Draw Steel independence notice in-product from day one.
- **Persistent:** rooms append JSONL to the campaign folder and resume after GM
  restart — the recovery story for the GM-first bet; "you own your campaign" is true
  from the first commit. No artifacts, publish, web, or key linking in v0; identity
  is key-as-account automatically.

**v1 — flagship story complete; this is launch.**

- DS module at **play-support depth only**: full sheet rendering, condition tracking,
  resource tracking (heroic resources, recoveries, surges), victory tallies.
  Character files still authored outside the app. No builder (biggest scope trap;
  also the licensing-heaviest surface).
- Campaigns + characters as first-class CLI nouns; `publish` mints capability URLs.
- The 013 web launch: marketing, docs, artifact pages with OG images.
- The 009 launch-tier identity: cross-device key linking, guest adoption.
- **Still GM-hosted only** — gateway-hosted rooms deliberately excluded so the paid
  tier later debuts as pure addition, never a paywalling of something free.

**v2 — character builder.** Close behind launch; the retention move. Requires its
own licensing pass (a builder reproduces far more rulebook content than a renderer).

**v3 — the paid tier.** Gateway-hosted rooms + browser terminal + payments debut
*together* ("your table, now persistent and in the browser"). Timed on demand signal
from a live audience. Accepted launch gap: v1 has no answer for "my GM's machine is
off."

**v4+ — second game** (Mothership / Mörk Borg), only once Draw Steel is deep — one
deep game then a second beats two thin ones. **Unordered vN:** battle maps, AI
features, expansion-playbook detail.
