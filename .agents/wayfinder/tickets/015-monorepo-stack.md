---
status: closed
type: grilling
assignee: oscar
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

## Resolution

Grilled 2026-07-13. Full spec with all amendments:
[monorepo-stack](../assets/monorepo-stack.md). The gist:

- **better-t-stack verdict: there is no invocation** — bts is wrong for this
  (research-verified vs clone e1bf536f: `bts add` is addon-only and bts.jsonc-gated,
  no library-package generator, no dependency-cruiser; its opentui addon is a local
  single-process TUI starter, dismissed explicitly). Replacement: a hand-rolled Bun
  workspace whose first commit is core + fake game module + dependency-cruiser
  lattice check. bts survives as convention reference and a possible v1 apps/web
  graft source.
- **Workspace:** apps/gateway, apps/cli; packages config, core, **table** (the shared
  client for both v0 doors and v3's browser — only OpenTUI consumer outside game view
  entries, never imports decide), room-host (package, three consumers: CLI v0,
  gateway v3, Node-fallback bin), transport-iroh, session (two real adapters day
  one), identity, games/draw-steel, games/fake. Registries compose in apps. No
  apps/web until v1.
- **Tooling:** Bun workspaces, no Turborepo. TS7 native tsc, composite refs, all
  packages emit js+d.ts; Node-compat set compiles nodenext (hedge enforcer #1).
  oxlint + oxfmt (pinned). dependency-cruiser in CI day one, ruleset enumerated —
  including bun:*/@opentui/* banned in the Node-compat set (#3) and gateway-only DB.
  Test discipline: the runner is the runtime claim — bun test vs vitest-under-Node
  (#2); transport-iroh + room-host run the same specs under both runners = the 008
  CI matrix = milestone 1's gate.
- **CLI artifact:** compiled Bun binary, four triples on native runners, curl
  installer + checksums + macOS codesign day one. Windows via WSL2 (named churn,
  revisit trigger: real Windows GM cohort). Invariant: one file → one archive →
  never "install a runtime"; the Node rung is a dev/CI hedge and gateway option,
  not a GM artifact.
- **Data edge:** event log is the canonical durable data; gateway SQLite via
  bun:sqlite, no ORM, PRAGMA user_version migrations. Web slot constraints recorded
  (SSR, OG, push-ingest snapshot DB, capability-URL routes, passkey-ready empty auth
  slot); web's lattice edge model+content-only with "neither" live if snapshots are
  self-describing.
- **Verify-at-scaffold list:** TS7 declarationMap; dependency-cruiser on typescript@6
  until TS 7.1 API; hello-iroh compile smoke per triple; oxfmt pinning.
