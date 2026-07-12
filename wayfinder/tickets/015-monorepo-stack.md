---
status: open
type: grilling
assignee:
blocked-by: [004, 006, 014]
---

# Monorepo shape & stack decision

## Question

The mechanical output the destination promises: the monorepo layout (apps/packages
across gateway, CLI, web, shared state/game modules) and the **better-t-stack verdict**
— the exact invocation, or the reasoned decision that better-t-stack is wrong for this
and what replaces it.

Known tensions to resolve:
- The gateway is Bun + OpenTUI with its own lifecycle — a shape better-t-stack does
  not scaffold. Does better-t-stack scaffold the web app + backend and the gateway/CLI
  join the workspace by hand, or is the whole workspace hand-rolled?
- Web launch profile is unusual for the menu: DB + server-rendered pages + OG image
  generation, **no auth** at launch (but passkeys later — don't paint auth out).
- Shared packages: event-log/state core (game-neutral, per
  [Game module seam](006-game-module-seam.md)), game modules, identity primitives —
  consumed by gateway, CLI, room host, and (read-only) web.
- CLI distribution (compiled Bun binary?) and the room-host-under-Node fallback from
  [iroh transport viability](008-iroh-viability.md) if it lands that way.

Blocked on: [Browser terminal bridge](004-browser-terminal-bridge.md) (what the web
backend must accommodate later), [Game module seam](006-game-module-seam.md) (package
boundaries), [Scope tiers](014-scope-tiers.md) (what milestone 1 actually is).
