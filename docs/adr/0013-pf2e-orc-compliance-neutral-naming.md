# Keep pf2e strictly ORC-compliant with neutral identifiers and embedded notice

## Decision

The third ruleset uses the neutral key `pf2e` (`rules: pf2e`, slice key `pf`, events `pf.*`, commands `pf-*`, folder `packages/domain/src/rules/pf2e/`). No module, CLI flag, command, or product label uses Paizo trademarks; all tests, fixtures, and examples use original names with zero Paizo Reserved Material. Full ORC attribution and Reserved Material declarations live in `docs/ORC-NOTICE.md` (referenced from `NOTICE`). Imports (`supervillain import pathbuilder`) read only the user's own local file and validate every written YAML sheet by reading it back.

## Why

The Open RPG Creative (ORC) License grants open mechanical rules, not publisher trademarks or Reserved Material. Keeping identifiers neutral and shipping an accurate ORC notice avoids trademark confusion while remaining cleanly compatible with Remaster core rules.

## What breaks if you change this

- Naming commands, packages, or UI headings after publisher trademarks exceeds what the ORC License grants.
- Committing Golarion proper nouns, iconic characters, deities, or OGL text into `examples/`, `test/`, or `packages/site/` violates Reserved Material boundaries.
- Skipping round-trip validation on Pathbuilder or Steel Compendium imports lets broken YAML reach a live table.
