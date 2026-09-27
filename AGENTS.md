# supervillain

A terminal-first virtual tabletop. Players type `ssh <room>@<host>` and are sitting at a live table, with nothing to install and no account to make. The GM's machine is the authority, and the campaign is a plain append-only JSONL log on the GM's disk. Draw Steel is the game.

## Where things stand

We are rebuilding small. `ASSESSMENT.md` at the root is the plan: why, what survives, the eleven questions to settle, and the rebuild sketch. Its §9 is the one living record of decisions.

- The previous build is tagged `archive/2026-09-exploration`. Treat it as a reference to copy from with care (ASSESSMENT §5 lists what's worth lifting), not as a base to patch.
- `.agents/` (wayfinder, ADRs, research, benchmarks, CONTEXT.md) is the record of that exploration. Read it for context; nothing in it binds.
- The issue backlog from that phase is frozen. New issues come from play.

## Rules

- **Product decisions come from play.** Settle them with throwaway prototypes and real people at a table, then record them in ASSESSMENT §9 as the decision plus its evidence (date and what happened).
- **Docs describe the present.** Rewrite them freely; git holds the history. Don't append corrections.
- **No ADR without code in the same change.**
- **Commit subjects are at most 72 characters.** Detail goes in the body.
- **A red CI gets fixed, or the rule gets turned off, the same day.**
- **Commit only when the user asks.**

## Engine invariants (from the kernel)

- The log envelope is `{actor, seq, timestamp, type, payload}`, one JSON object per line.
- Randomness and derived facts go in the payload when a command is accepted. Replay never rolls and never reads files.
- The writer halts on an event it can't apply; readers skip unknown events loudly.
- Your SSH key is your identity: one key, one identity. Display names are separate (ASSESSMENT Q9).

## Stack

Bun workspaces, TypeScript 7 with `tsc -b`, oxlint and oxfmt, `bun test`, OpenTUI as the renderer, `@opentui/ssh` as the SSH server. Build with `bun run build`; check with `bun run check`.

## References

- Old prototype: `~/Developer/projects/supervillain-old`. Read-only, lessons only, never code.
- OpenTUI source (API truth, never guess): `~/Developer/clones/github.com/anomalyco/opentui` @ `a0b9064`.
- Issues: GitHub (oscabriel/supervillain) via `gh`. External PRs are not a request surface.
