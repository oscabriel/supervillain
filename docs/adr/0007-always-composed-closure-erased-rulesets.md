# Compose all rulesets always; dispatch via a closure-erased registry

## Decision

Every ruleset's events (`core.*`, `ds.*`, `sw.*`, `pf.*`) are always composed into `Table` so any log replays regardless of `campaign.yaml`. The campaign's `rules:` setting (`draw-steel`, `set-world`, or `pf2e`) selects commands, intake, and UI projections through `RULESETS` (`packages/domain/src/Ruleset.ts`), built with a closure-erased `defineRuleset<S>(slice, impl)` typed via `satisfies Record<RulesetName, Ruleset>`.

## Why

Always composing every module means `supervillain check` and reopened tables never need per-ruleset log parsers. Hiding the slice type `S` inside `defineRuleset`'s closures eliminates correlated-union variance traps and lets all nine dispatch sites compile with zero type assertions.

## What breaks if you change this

- Replacing `defineRuleset` with a generic `Ruleset<Slice>` indexed by `RulesetName` fails strict TypeScript without unsafe casts.
- Sharing a command `type` across rulesets (instead of giving each its own internal command tag like `map`, `set-map`, `pf-map` while sharing the typed `/map` name) collides in `Table.aggregate.ts`.
