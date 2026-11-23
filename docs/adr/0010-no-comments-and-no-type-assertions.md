# Tracked source files carry no comments and no type assertions

## Decision

Tracked source files carry no comments of any kind (line, block, JSDoc, JSX, shebangs, or disable directives) and no type assertions (`as T`, `<T>x`, or `!`; `as const` is the one exception). `bun run check` enforces this via `supervillain/no-comments`, `tools/oxlint/supervillain/comments.ts` (for CSS, HTML, YAML, TOML, JSONC, shell, Dockerfiles, and TSX directives), `typescript/no-non-null-assertion`, and `anti-slop/require-safety-comment-for-type-assertion` (which demands a `SAFETY:` comment that cannot be written). Design rationale goes in `docs/adr/`, workarounds in `docs/issues/`, domain vocabulary in `GLOSSARY.md`, and third-party attributions in `NOTICE`.

## Why

Inline comments drift out of sync with code, disable directives hide real bugs, and type assertions bypass the compiler at the exact seams where runtime shapes disagree with typings (such as `ssh2`'s `key.verify()` returning an `Error` object despite `@types/ssh2` typing it `boolean`).

## What breaks if you change this

- Adding any comment, shebang, `as T`, `!`, or `oxlint-disable` directive fails `bun run check`.
- Allowing `SAFETY:` comments creates an exception to both `supervillain/no-comments` and `comments.ts`.
- Libraries with incomplete types (like `ssh2` internals) must be typed via `declare module` augmentation or narrowed with runtime guards (`Object.is`, `Predicate`, `Schema`).
