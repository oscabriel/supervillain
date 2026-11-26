# Issue 0003: Relay Trust Model, `events.lock` Takeover, and Embedded FS

## Status

Known architectural limits and operational edge cases.

## 1. The relay terminates player SSH (cleartext & identity vouching)

Players connect to `supervillain relay`, which terminates their SSH session and forwards PTY bytes and their authenticated key fingerprint down the GM's dialed-out link. Consequently:

- The relay observes terminal bytes in transit (it writes none to disk and renders nothing).
- The GM host trusts the pinned relay's word for which SSH key a relayed player presented.

A GM must run their own relay or use one they trust. True end-to-end encryption (an `ssh -J`-style TCP forwarder where the GM host terminates player SSH directly) is deferred until play demands it.

The same trust covers agents (ADR 0020): a relayed `mcp-1@supervillain.sh` session acts as the key the relay names in `SV_ACTOR`, and a key in the host's `gm_keys` that the relay names is the GM. The host keeps the subsystem allowlist narrow so a relay's word is only ever taken where it has to be: `relaySubsystems` (`knows-1`) open only on a connection from a pinned relay key, `subsystems` (`mcp-1`) open on a direct connection as its own key or on a relayed one only with `SV_ACTOR` set, and every other name is refused. The relay's player-facing server registers `mcp-1` and nothing else, so a player can never ask the relay, or through it a host, for `knows-1`.

## 2. A leftover `events.lock.takeover` needs a manual delete

`packages/platform-jsonl` acquires `events.lock` via `link(2)` with the process PID. A stale lock (dead PID) is removed only by a host holding an exclusive `events.lock.takeover` link, after it re-reads the lock's owner, so a live lock is never removed and two hosts never both pass acquisition.

A host killed in the few system calls while it holds `events.lock.takeover` leaves that file behind. The next host to meet a stale lock refuses to start and names the file to delete; nothing is written until someone does. A host that loses the race for the takeover link is told another host is taking over, not which PID.

Before every append, `CampaignLog` still verifies that the file size on disk matches its expected byte offset and halts the writer if another process appended first.

## 3. `bun build --compile` embedded sample campaign

`scripts/build.ts` embeds `examples/campaign/` into the compiled binary so `supervillain new --example` works from any directory without a source checkout, and so the relay's sandbox tables (Issue 0005) read their sheets and map from it. Changes to `examplePath` or `copyTree` in `apps/supervillain/src/content/newCampaign.ts` MUST be verified against a fresh compiled binary (`bun run release:build && SMOKE_REQUIRE_TTY=1 bun run release:smoke dist/supervillain-<os>-<arch>`), because Bun's virtual `$bunfs` path handling differs subtly from real POSIX directories.
