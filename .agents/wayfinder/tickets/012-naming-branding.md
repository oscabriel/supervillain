---
status: closed
type: grilling
assignee: oscar
blocked-by: []
---

# Naming, domain & brand voice

## Question

Is the product actually named **supervillain**, on what domain, with what voice? Sub-questions:

- Lock the name? It's been the working title through two efforts; the pillars ("your key is your account", "you own your campaign") and the anti-immersion terminal aesthetic all fit a deadpan-villainy register. Any trademark/App-collision worry worth a quick check?
- Domain: the old plan assumed `supervillain.now`. Verify ownership/availability — likely spawns a HITL task (check + register), since only Oscar can buy it. `.now` pricing/registrar quirks included. Fallbacks worth listing.
- Brand voice: name the register once so marketing pages, docs, and in-terminal copy speak the same way (e.g. deadpan, dry, henchman-flavored UI copy — "table live", "your lair", or restraint instead?). One paragraph, not a brand book.

## Resolution

- **Name locked: supervillain.**
- **Domain locked: `supervillain.app` — already owned by Oscar. Canonical URL and canonical name.** All prior references to `supervillain.now` (old plan, earlier tickets) read as `supervillain.app` from here on; the in-product copy becomes `ssh <room>@supervillain.app`. (`.app` is an HSTS-preloaded TLD — HTTPS-only web, which we'd do anyway; no effect on SSH.)
- **Voice locked: restraint — deadpan, with villainy at the emotional beats.** Structural copy (menus, help bars, errors) stays dry and legible; the henchman register surfaces only at moments (room minted → "your table is live. summon your players:", the guest-upgrade box, empty states, marketing headlines) and is never explained. Full-commitment theming (GM = "mastermind" everywhere) explicitly rejected — it fights the seriousness of an actual play tool.
