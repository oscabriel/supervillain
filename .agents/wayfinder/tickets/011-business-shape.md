---
status: closed
type: grilling
assignee: oscar
blocked-by: []
---

# Business shape

## Question

Is supervillain a business, and if so what does it charge for? The pillars already
decided constrain this hard: "your key is your account" (no signup friction), "you own
your campaign" (no data hostage-taking), GM-hosted rooms as center of gravity (core
play can't require our servers). Candidate revenue lines:

- **Gateway persistence** — gateway-hosted rooms that stay up while the GM sleeps;
  free tier small, paid tiers for more/bigger/longer-lived rooms.
- **Vanity registry** — reserved/custom room and handle names on supervillain.now.
- **Published-artifact hosting** — capability-URL pages are free-cheap; richer
  published campaign sites could be paid.
- **Licensed content** — paid game-content modules, subject to per-game licenses.
- **Nothing** — a free project / portfolio piece; decide that consciously too.

Also in scope: does payment ride the terminal (terminal.shop-style checkout, on-brand
but heavy) or plain web checkout? Posture only — pricing numbers are out of scope.

## Resolution

- **The core of the product is free forever.** Hosting on your own server/computer
  costs us nothing, forever — GM-hosted play, the CLI, joining rooms via the gateway.
- **The paid story: "host your game on our servers."** One bundle: persistence
  (rooms up while the GM sleeps) + **access from a browser** (the in-browser terminal
  is a paid-tier perk, not a free surface) + **maybe some AI features** (explicitly a
  MAYBE — now its own fog entry).
- **Licensed content: one-time charges, down the line**, contingent on actual
  agreements with game makers — only if/when we gain the ability to have those
  conversations. (Interacts with per-game license research.)
- **Nothing payment-shaped at initial launch.** The scaffold just mustn't paint the
  web backend into a corner payments can't be added to.
- Checkout venue (web vs terminal) left open — moot until payments exist; default
  expectation is web.
