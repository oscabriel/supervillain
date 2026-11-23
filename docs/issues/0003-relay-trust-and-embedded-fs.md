# Issue 0003: Relay Trust Model, `events.lock` Races, and Embedded FS

## Status

Known architectural limits and operational edge cases.

## 1. The relay terminates player SSH (cleartext & identity vouching)

Players connect to `supervillain relay`, which terminates their SSH session and forwards PTY bytes and their authenticated key fingerprint down the GM's dialed-out link. Consequently:

- The relay observes terminal bytes in transit (it writes none to disk and renders nothing).
- The GM host trusts the pinned relay's word for which SSH key a relayed player presented.

A GM must run their own relay or use one they trust. True end-to-end encryption (an `ssh -J`-style TCP forwarder where the GM host terminates player SSH directly) is deferred until play demands it.

## 2. Three-way stale `events.lock` takeover race

`packages/platform-jsonl` acquires `events.lock` via `link(2)` with the process PID, and renames stale locks aside when the recorded PID is dead. Under extreme contention (three hosts starting simultaneously against a stale lock), two hosts can briefly pass lock acquisition (~2 in 40 trials).

Data corruption is still prevented: before every append, `CampaignLog` verifies that the file size on disk matches its expected byte offset and halts the writer if another process appended first.

## 3. `bun build --compile` embedded sample campaign

`scripts/build.ts` embeds `examples/campaign/` into the compiled binary so `supervillain new --example` works from any directory without a source checkout. Changes to `copyTree` in `apps/supervillain/src/main.ts` MUST be verified against a fresh compiled binary (`bun run release:build && SMOKE_REQUIRE_TTY=1 bun run release:smoke dist/supervillain-<os>-<arch>`), because Bun's virtual `$bunfs` path handling differs subtly from real POSIX directories.
