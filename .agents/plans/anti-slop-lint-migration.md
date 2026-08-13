# Anti-slop lint migration plan

Status: active. Workstream 0 decided: option 1, a lightweight schema library (valibot or arktype, not zod). ADR still to be written before workstream 2 starts. Baseline: 467 findings from `bun run check` after installing the anti-slop oxlint plugin (`tools/oxlint/anti-slop/`, oxlint 1.78.0). `tsc -b` is clean.

Regenerate the finding list at any point with:

```bash
bun run check 2>&1 | grep 'error anti-slop' > /tmp/antislop-findings.txt
```

## The three buckets

| bucket | rules | count | nature |
| --- | --- | --- | --- |
| A. parsing style | no-runtime-typeof (191), no-unknown-parameters (135), no-unsafe-dictionary-type (49) | 375 | flags the hand-rolled boundary parsers themselves; needs one architectural decision |
| B. mechanical | no-known-value-widening (42), no-shape-in-symbol-names (11), no-conditional-empty-object-spread (7), no-widen-then-assert (1) | 61 | local rewrites, no decision needed |
| C. test forgeries | no-chained-type-assertions (31) | 31 | tests forging hostile values via `as unknown as X`; per-site judgment |

## Workstream 0: decide the parsing foundation (gate for bucket A)

The repo parses wire and JSON data with hand-rolled `typeof` predicates: `isRecord` in `packages/core/src/validation.ts`, the `is*` predicate family in `core/src/snapshot.ts` and `core/src/map.ts`, `parseRoomCommand` and friends in `room-wire/src/messages.ts`. These functions sit exactly where the rule message says parsing belongs. The rules flag them anyway because they can't distinguish a designated parser from scattered validation. So bucket A is only resolvable by choosing one of:

**Option 1: adopt a schema library** (zod mini, valibot, or arktype). Parsers become schema definitions; `typeof`, `unknown` parameters, and `Record<string, unknown>` disappear from the codebase entirely. No lint overrides needed. Cost: a new runtime dependency inside `core` and the wire packages. That is a definition-level decision (AGENTS.md: never decide silently). It needs an ADR and a check against the dual-lane constraint (`room-wire`, `room-host`, `transport-ws` run under both Bun and Node; the major schema libraries are fine there, but the ADR should say so explicitly).

**Option 2: in-repo parser combinators, zero new dependencies.** Add one module to `@supervillain/core` (say `src/parse.ts`) with small combinators: `string`, `record`, `optional`, `literalOf`, `arrayOf`, etc. All `typeof` and `unknown` handling concentrates there; every current predicate rewrites against the combinators. The combinator module itself still trips the rules, so it needs a file-scoped override in `oxlint.config.ts` for that single path. That is the one honest exception: it is the designated boundary, and the override is scoped to it, not a severity downgrade anywhere else.

Decision: option 1, with a lightweight library (valibot or arktype; zod ruled out for weight). The ADR in `.agents/adr/` must pick between the two and record: bundle/runtime cost, dual-lane (Bun + Node under vitest) behavior, and which packages take the dependency (`core` plus the wire packages, or `core` only with schemas re-exported). No lint overrides needed under this option.

## Workstream 1: bucket B mechanical fixes (start immediately, no gate)

Independent of workstream 0. Roughly 61 findings, all local:

- `no-known-value-widening` (42): explicit anonymous object annotations discarding inference, e.g. `#origin: { originX: number; originY: number } = {...}` in `table/src/map-region.ts` and annotated fixture returns in tests. Fix: drop the annotation, use `satisfies`, or name the contract (several sites want a named `MapRegionSize` / `Origin` type that already half-exists).
- `no-shape-in-symbol-names` (11): renames. `SHAPES` in `table/test/chrome-snapshots.test.ts` describes terminal geometries; rename to `TERMINAL_SIZES` or similar. Pure rename, verify with grep.
- `no-conditional-empty-object-spread` (7): `...(cond ? {} : { x })` patterns (e.g. `apps/cli/src/index.ts:1735`). Rewrite as separate statements or a direct optional property.
- `no-widen-then-assert` (1): single site in `packages/games`.

Fix per package, run that package's test script after each.

## Workstream 2: bucket A migration, inside-out along the lattice

Blocked on workstream 0. Migrate in dependency order so each layer builds on already-converted parsers:

1. `packages/core` (~76 findings): rewrite `validation.ts`, the `snapshot.ts` and `map.ts` predicate families, and `index.ts` payload checks against the chosen foundation. This is the bulk of the predicate code; everything downstream imports from here. Gate: `test:conformance` (dual lane).
2. `packages/room-wire` (~70): `messages.ts`, `frames.ts`, `pipe.ts`, `link.ts`, `host-pipe.ts`, `index.ts`. Wire shapes become schema/combinator definitions; keep the encode/parse pairing per shape. Gate: `test:room-wire` (dual lane).
3. `packages/transport-ws` (~23) and `packages/room-host` (~56): handshake, server, channel, connection parsing; room-host's remote test harness. Gates: `test:transport-ws`, `test:room-host` (both dual lane).
4. `packages/identity` (9), `packages/session`, `packages/games` (~19), `packages/table` (~68 total, but most of table's are bucket B): remaining parse sites. Gates: per-package test scripts.
5. `apps/cli` (~62): the biggest single file, `src/index.ts` (34). Two distinct sub-cases:
   - `parseArgs` narrowing (`typeof parsed.values.game === "string"` etc.): don't hand these to the parsing foundation. Write one typed flag-reading helper (or tighten the `parseArgs` option config so values are already `string | undefined`) and the `typeof` checks fall away.
   - gateway/publish JSON responses (`publish-client.ts`, `publish-documents.ts`, `gateways.ts`): normal boundary parsers via the foundation. Gate: `test:cli`, `test:publish` specs.
6. `apps/gateway` (~38) and `apps/web` (~34): `web/src/server/api.ts` and `identity-directory.ts` parse request bodies with `unknown` + `typeof`; convert to boundary parsers at the route entry. Gates: `test:gateway`, `test:web`.
7. Benchmarks and remaining test harnesses (small counts, same treatment).

After each package: `bun run check` scoped diff, `tsc -b`, package tests, `bun run depcruise` (the foundation lives in core, which everything already imports, so the lattice should be untouched; verify anyway).

## Workstream 3: bucket C test forgeries

31 `no-chained-type-assertions`, concentrated in `games/draw-steel` tests, `table` tests, and `gateway` tests. Most are deliberate hostile-input tests: `{...} as unknown as DsCommand` fed to `decide` to assert rejection. The cast is doing real work there; deleting it naively would weaken the tests.

Resolution order of preference, per site:

1. Route the forged value through the actual boundary parser the production path uses, asserting the parser rejects it. Best: tests then exercise the real defense.
2. Where the test intentionally bypasses the parser to test `decide`'s own guards, give the entry point an explicit unknown-accepting test seam (a named `decideUnchecked`-style helper in the test harness), so the intent is named instead of laundered through a double cast.

Do this workstream together with the `games`/`table` steps of workstream 2, since the parsers it needs will exist by then.

## Sequencing summary

```
WS1 (mechanical, ~61) ──────────────┐
WS0 (decision + ADR) ─→ WS2 (core → wire → transports → games/table → apps)
                                    └─→ WS3 (test forgeries, with games/table)
```

WS1 can land as its own commit set this week. WS0 is a conversation, not code. WS2 is the long pole; each numbered step is a reviewable unit that keeps `tsc -b` and its package tests green. CI's `check` stays red until WS2 finishes, so either hold the plugin-enable commit until the migration lands, or land it with the findings as a known burn-down list.

## Done criteria

- `bun run check` exits 0 with all ten anti-slop rules at `error`.
- At most one file-scoped override exists (option 2's combinator module), or none (option 1).
- No rule severity downgrades, no `oxlint-disable` comments, no new casts.
- Dual-lane suites (`room-wire`, `room-host`, `transport-ws`, conformance) pass under both Bun and Node.
- `bun run depcruise` clean.
