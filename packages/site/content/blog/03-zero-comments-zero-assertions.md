---
title: Zero comments, zero type assertions, and the auth bug it caught
summary: We deleted 2,605 comments, removed 468 type assertions, and enabled 616 type-aware lint rules across 294 files. Here is what went into docs, what broke, and the security bug the audit uncovered.
date: 2026-11-22
---

Code comments rot faster than code, and type assertions (`as Foo`, `value!`) are quiet lies told to the compiler. As part of hardening supervillain to match our strict Effect 4 standards, we went all the way: zero comments and zero non-`as const` type assertions across every tracked source, test, config, YAML, CSS, HTML, and shell file in the repository, enforced on every run of `bun run check`.

That sounds extreme until you look at what actually happened when we did it.

## 2,605 comments did not disappear, they got filed

Deleting comments blindly destroys institutional memory. Before touching a single line, we inventoried all 2,605 comment lines across the workspace and sorted every one into six buckets:

- **Architecture decisions** became 14 concise ADRs in `docs/adr/`, covering everything from the fixed JSONL envelope and opaque state schema to undo refolding and post-quantum SSH key exchange.
- **Library quirks and workarounds** went into `docs/issues/`, so the next person touching `ssh2` or OpenTUI finds the real reason in one place instead of hunting across five files.
- **Domain terms and third-party attributions** moved into `GLOSSARY.md`, `NOTICE` (including MEKMODE font hashes and permissions), and `docs/ORC-NOTICE.md` for our ORC-licensed `pf2e` ruleset.
- **Rule summaries and operational caveats** went into `docs/rulesets/` and `docs/how-it-works.md`.
- **Dead TODOs and line-by-line narration** (`increment seq`, `check null`) were deleted outright.

Everything left in source files is executable TypeScript, checked by `oxlint` (`typeAware: true`, `denyWarnings: true`, 616 active rules combining Ultracite, `@effect/tsgo`, a vendored `anti-slop` plugin, and our own `supervillain/no-comments` rule) plus a standalone scanner for YAML, TOML, CSS, HTML, and shell scripts.

## 468 type assertions replaced by schemas and guards

Type assertions hide boundary mismatches. Replacing 468 `as` casts and `!` non-null assertions forced every untrusted boundary to prove its shape:

- **External JSON and YAML** now decode through Effect `Schema` or explicit runtime predicates instead of casting `JSON.parse` or `Bun.YAML.parse`.
- **Internal `ssh2` hooks** (socket backpressure checks, channel manager limits, outbound socket injection for the relay) now pass through structural type guards instead of `as any` casts.
- **OpenTUI Solid JSX** got a one-line `type Node = BaseRenderable` declaration in `apps/supervillain/src/table/jsx.d.ts`, stopping Solid's JSX namespace from silently collapsing to `any` in a non-DOM TypeScript project.

One subtle catch came up in our YAML loaders: wrapping `Bun.YAML.parse` inside `Schema.Json` turned valid YAML non-finite numbers (`.nan`, `.inf`) into generic "invalid YAML" errors instead of field-level validation messages. Parsing to `unknown` first and folding with `Predicate` restored the exact per-field errors while keeping zero assertions.

## The real security bug the audit caught

The best moment of the entire hardening pass happened during an adversarial code review of `packages/ssh/src/server.ts`.

Before hardening, SSH public-key signature verification read:

```ts
if (key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) {
	return ctx.reject();
}
```

A strict-boolean lint cleanup simplified `!== true` to `!key.verify(...)`, because `@types/ssh2` declares `ParsedKey.verify()` as returning `boolean`.

That type definition is wrong. Inside `ssh2`'s `keyParser.js`, when Node's crypto layer throws on malformed key material or an off-curve ECDSA signature, `verify()` catches the exception and **returns the `Error` object**. In JavaScript, `!error` evaluates to `false`. Simplifying `!== true` to `!` silently turned a crypto failure into a **fail-open authentication bypass**.

Our review caught it, we switched the check to `!Object.is(key.verify(...), true)`, added a regression test with an off-curve ECDSA signature in `packages/ssh/test/identity.test.ts`, and documented the `ssh2` quirk in `docs/issues/0001-ssh2-internals-and-crypto-quirks.md`.

## What stayed fast and what got measured

A second review catch reminded us to benchmark cleanups too: replacing four indexed writes in our picture-map `Canvas.set()` with `this.pixels.set([...c, 255], i)` allocated a fresh array on every pixel and made map painting 18x slower (88 ms vs. 3.9 ms for a 40x30 hall). Going back to four indexed writes brought it right back to 5 ms with zero lint warnings.

Today the whole workspace sits at 294 checked files, 0 warnings, 0 errors, 0 comments, 0 non-`as const` assertions, and 1,138 passing tests. Every line of documentation lives where people actually look for it, and every type in the program means what it says.
