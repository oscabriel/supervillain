# Upstream

| Field | Value |
|---|---|
| Source | [K-Mistele/anti-slop](https://github.com/K-Mistele/anti-slop), Kyle Mistele's fork of [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) |
| Commit | `b7c1619b4d51b4815e89ba3700a975a6ec54b8c3` (2026-11-15) |
| Copied subtree | `skills/install-anti-slop/assets/anti-slop` (unchanged) |
| Licence | MIT, in `LICENSE` beside this file |

`vendor/eslint-stylistic/` retains its own MIT `LICENSE` and `UPSTREAM.md`.

## What is enabled in `oxlint.config.ts`

- **Enabled as errors:** all 21 core rules (`index.ts`) and all 14 Effect rules (`effect/index.ts`).
- **Disabled:**
  - `martinfowler/` (code-smell rules intended for `warn`, and warnings fail `pnpm check`).
  - `jev/` and `diff-rules/` (rules that invoke an LLM judge).

## Updating

Read `skills/install-anti-slop/references/update.md` in the upstream repository, merge changes rather than replacing files wholesale, and update the commit hash and date above.
