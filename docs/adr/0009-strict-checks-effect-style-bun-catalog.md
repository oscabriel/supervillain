# Enforce zero-warning strict checks, Effect style, and pinned Bun catalog versions

## Decision

`bun run check` runs `oxfmt --check && bun run lint && bun run typecheck` (`oxlint --disable-nested-config`, `node tools/oxlint/supervillain/comments.ts check`, and `tsc -b`). Linting runs with `typeAware: true`, `denyWarnings: true`, and `reportUnusedDisableDirectives: "error"`, combining Ultracite core, `@effect/tsgo` recommended plus 12 strict Effect rules, vendored `tools/oxlint/anti-slop` (core and Effect), `supervillain/no-comments`, and package import boundaries. Root `package.json` pins coupled toolchain versions (`typescript`, `tsrs`, `oxlint`, `oxlint-tsgolint`, `@effect/tsgo`, `effect`, `alchemy`) in `workspaces.catalog` with `overrides: { effect: "4.1.5" }`, and `prepare` runs `effect-tsgo patch --oxlint --tsrs`.

## Why

Denying warnings eliminates drift, Effect's global-API rules keep runtime code deterministic and testable, and pinning coupled versions prevents broken `tsgo` patches or duplicate Effect instances (which break `RequestContext` and service identity).

## What breaks if you change this

- Upgrading `typescript`, `tsrs`, `oxlint`, or `oxlint-tsgolint` past versions supported by `@effect/tsgo` breaks `bun install`'s `prepare` script.
- Dropping `oxlint-tsgolint` from root `devDependencies` breaks type-aware linting under Bun, which skips optional peer dependencies.
- Removing Node 26 from CI breaks `oxlint.config.ts` and `.ts` plugins, which rely on Node's native type stripping.
