# supervillain — product repo

supervillain is a terminal-first virtual tabletop: players `ssh` into a live game room; the GM hosts the table from their own machine. Draw Steel is the first game module on a system-agnostic core. This repo is the product monorepo.

## `.agents/` — the agent docs

All planning and reference docs live under `.agents/`:

- **`.agents/CONTEXT.md`** — the glossary (ubiquitous language). Use its terms exactly — several are load-bearing distinctions (entry point vs door, host vs gateway, envelope vs payload). Resolve new terms here, not in scattered docs.
- **`.agents/wayfinder/`** — the read-only record of the product-definition phase:
  - **`assets/product-definition.md`** — the binding spec for the scaffold, milestone 1, and the v0 slice. Read it first; the detailed assets (seam spec, monorepo shape, licensing, iroh viability, prototype lessons) are linked from it.
  - `map.md` and `tickets/` — the decision history. Historical; don't edit. Assets may gain corrections.
- **`.agents/adr/`** — architectural decision records for decisions made _after_ the definition phase (create lazily; the wayfinder tickets are the ADRs of the definition phase).
- **`.agents/benchmarks/`** — the measurements that gate numbers. A cap, a size ceiling, or a public capacity claim that has no dated results doc here is a placeholder, not a decision (ADR-0012, NQ-10). Each doc records the run, the box it ran on, the numbers chosen from it, and the reopening triggers stated against those baselines.

Do not re-derive or reopen the definition's decisions. If work surfaces a product decision the definition doesn't cover, that is a definition bug: surface it and patch the definition — never decide silently.

## Stack & conventions (from the definition — pointers, not the spec)

- Hand-rolled **Bun workspaces** — no better-t-stack, no Turborepo. Root scripts + `tsc -b`.
- **TypeScript 7**, every package `composite: true` off the `packages/config` strict base; all packages emit js + d.ts. The Node-compat set compiles under `nodenext`.
- **oxlint + oxfmt**, pinned (oxfmt is 0.x).
- **dependency-cruiser lattice in CI from day one** — the seam boundaries are mechanically enforced (host never imports OpenTUI; render side never imports `decide`; `content` imports `model` only; `room-wire` imports no transport package; the transport's server half is the gateway's; full ruleset in `.agents/wayfinder/assets/monorepo-stack.md`).
- **The runner is the runtime claim:** Bun-bound code → `bun test`; the Node-compat set → vitest under Node. `room-host`, `room-wire` and `transport-ws` run the same specs under both lanes — that dual lane is milestone 1's CI gate.
- CLI verb set is pinned: `create` / `join` / `publish`. Don't reopen. It is the **table** surface, not the CLI's whole surface — management nouns (`key`, `character`, `map`, `campaign`) and the gateway **role selector** (`supervillain gateway serve`, ADR-0015) sit deliberately outside it.
- Commit only when the user asks.

## Code standards

- This project uses [Ultracite](https://ultracite.ai), a zero-config preset that enforces strict code quality standards through automated formatting and linting. When you're done making changes to this codebase, refer to `.agents/code-standards.md` to ensure your changes align with code quality expectations.

## External references

- Old prototype: `~/Developer/projects/supervillain-old` — read-only, lessons only, never code.
- OpenTUI source clone (API truth, never guess): `~/Developer/clones/github.com/anomalyco/opentui` @ `a0b9064`.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (oscabriel/supervillain) via the `gh` CLI; external PRs are not a request surface. See `.agents/issue-tracker.md`.

### Triage labels

The five canonical triage labels, default strings, exist on the repo. See `.agents/triage-labels.md`.

### Domain docs

Single-context, at non-default paths: glossary at `.agents/CONTEXT.md`, ADRs in `.agents/adr/`. See `.agents/domain.md`.
