---
status: closed
type: grilling
assignee: oscar
blocked-by: []
---

# Web surface launch scope

## Question

What does the web surface (supervillain.app over HTTPS) ship at launch, and what does that demand of a backend? The full surface list (from [Product surfaces](001-product-surfaces.md) + [Business shape](011-business-shape.md)) is: marketing pages, docs, read-only artifact pages (capability URLs), and later the paid tier's browser terminal, payments, and maybe-AI. The launch question:

- Marketing + docs: static, obviously. But do artifact pages ship at launch, or does the web start as marketing/docs _only_ with capability URLs following fast behind?
- If artifact pages ship at launch: what renders them? They read from published campaign data — where does a published artifact's data live (pushed to the web backend at `publish` time vs fetched from the gateway)?
- What else needs a backend at launch: the name→NodeId registry API (needed by the CLI regardless of web), cross-device key-link codes, capability-URL mint/revoke. Do these live in one backend service or does the gateway own some?
- Implicitly: how much of better-t-stack's menu (auth, DB, API layer) launch actually exercises — feeds the monorepo/stack decision.

## Resolution

Accepted as recommended, with one addition from Oscar:

- **Launch web = marketing + docs + artifact pages** (character sheets, session logs) as capability URLs — minimal but present, because they're the product's shareable loop.
- **Publish = snapshot push.** `supervillain publish` copies the artifact's data to the web backend at publish time; URLs work while the GM's laptop sleeps. Re-publish to update, revoke to delete. Snapshot semantics reinforce "you own your campaign" — publishing is a visible act of copying data out of your folder.
- **Capability URLs ship custom OpenGraph images** (Oscar's addition) — per-artifact OG cards (character sheet card, session-log card) for maximal sharing potential; the link unfurl in a group chat is the page's first impression. Implies server-side OG image generation in the web backend at launch.
- **One backend service** owns registry API, key-link codes, capability-URL mint/revoke/render + OG generation. The SSH gateway stays its own process; two deployables, one monorepo.
- Stack-relevant profile: launch needs a DB, public HTTP, server-rendered pages, OG image generation — and **no user auth at all** (capability URLs are the access model; passkeys arrive with the paid tier).
