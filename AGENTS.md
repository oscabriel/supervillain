# supervillain — product repo

supervillain is a terminal-first virtual tabletop: players `ssh` into a live game room;
the GM hosts the table from their own machine. Draw Steel is the first game module on a
system-agnostic core. This repo is the product monorepo.

## The spec

`wayfinder/assets/product-definition.md` is the product definition — the binding spec
for the scaffold, milestone 1, and the v0 slice. Detailed assets (seam spec, monorepo
shape, licensing, iroh viability) are linked from it. Do not re-derive or reopen its
decisions. If work surfaces a product decision the definition doesn't cover, that is a
definition bug: surface it and patch the definition — never decide silently.

`wayfinder/` (map, tickets, assets) is the read-only record of the definition phase.
Assets may gain corrections; tickets and the map are historical.

## Vocabulary

`CONTEXT.md` at the repo root is the glossary. Use its terms exactly — several are
load-bearing distinctions (entry point vs door, host vs gateway, envelope vs payload).

## Stack & conventions (from the definition — pointers, not the spec)

- Hand-rolled **Bun workspaces** — no better-t-stack, no Turborepo. Root scripts +
  `tsc -b`.
- **TypeScript 7**, every package `composite: true` off the `packages/config` strict
  base; all packages emit js + d.ts. The Node-compat set compiles under `nodenext`.
- **oxlint + oxfmt**, pinned (oxfmt is 0.x).
- **dependency-cruiser lattice in CI from day one** — the seam boundaries are
  mechanically enforced (host never imports OpenTUI; render side never imports
  `decide`; `content` imports `model` only; full ruleset in
  `wayfinder/assets/monorepo-stack.md`).
- **The runner is the runtime claim:** Bun-bound code → `bun test`; the Node-compat
  set → vitest under Node. `transport-iroh` + `room-host` run the same specs under
  both lanes — that dual lane is milestone 1's CI gate.
- CLI verb set is pinned: `create` / `join` / `publish`. Don't reopen.
- Commit only when the user asks.

## External references

- Old prototype: `~/Developer/projects/supervillain-old` — read-only, lessons only,
  never code.
- OpenTUI source clone (API truth, never guess):
  `~/Developer/clones/github.com/anomalyco/opentui` @ `a0b9064`.
