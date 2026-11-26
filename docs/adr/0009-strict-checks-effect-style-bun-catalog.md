# Enforce zero-warning strict checks, Effect style, and pinned Bun catalog versions

## Decision

`bun run check` runs `oxfmt --check && bun run lint && bun run typecheck` (`oxlint --disable-nested-config`, `node tools/oxlint/supervillain/comments.ts check`, and `tsc -b`). Linting runs with `typeAware: true`, `denyWarnings: true`, and `reportUnusedDisableDirectives: "error"`, combining Ultracite core, `@effect/tsgo` recommended plus 12 strict Effect rules, vendored `tools/oxlint/anti-slop` (core and Effect), `supervillain/no-comments`, and package import boundaries. Root `package.json` pins coupled toolchain versions (`typescript`, `tsrs`, `oxlint`, `oxlint-tsgolint`, `@effect/tsgo`, `effect`, `alchemy`) in `workspaces.catalog` with `overrides: { effect: "4.1.5", "@types/node": "26.6.5" }`, and `prepare` runs `effect-tsgo patch --oxlint --tsrs`.

Ternaries never nest (`anti-slop/max-ternary-depth` is 1). Optional fields and optional list items are built with the helpers in `packages/domain/src/present.ts` (`when`, `ifDefined`, `listIf`, `listIfDefined`, `orEmpty`), spread at the call site: under `exactOptionalPropertyTypes` a key must be absent, not `undefined`, and these helpers are the one sanctioned way to say so. `anti-slop/no-conditional-spread` still bans the inline `...(condition ? {} : {})` form, so every conditional key goes through a named helper.

## Why

Denying warnings eliminates drift, Effect's global-API rules keep runtime code deterministic and testable, and pinning coupled versions prevents broken `tsgo` patches or duplicate Effect instances (which break `RequestContext` and service identity).

## What breaks if you change this

- Dropping the `@types/node` override lets `@types/ssh2` bring `@types/node@18` back beside Bun's version 26. The two copies merge, `net.Server` loses its `EventEmitter` members in the type checker, and `ssh2`'s `injectSocket()` stops accepting the workspace's `net.Socket`.
- Replacing a `present.ts` helper with `key: value | undefined` puts an explicit `undefined` on command and event payloads, which `exactOptionalPropertyTypes` rejects at compile time.
- Upgrading `typescript`, `tsrs`, `oxlint`, or `oxlint-tsgolint` past versions supported by `@effect/tsgo` breaks `bun install`'s `prepare` script.
- Dropping `oxlint-tsgolint` from root `devDependencies` breaks type-aware linting under Bun, which skips optional peer dependencies.
- Removing Node 26 from CI breaks `oxlint.config.ts` and `.ts` plugins, which rely on Node's native type stripping.
