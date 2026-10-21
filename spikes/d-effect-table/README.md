# Spike D: Effect table (PROTOTYPE, throwaway)

Throwaway. Nothing here binds the rebuild; lift lessons, not code. Delete any `PROTOTYPE-wipe-me-*` folder it leaves behind.

## What it answers

Does "Effect at the host edge, pure rules, SSH all the way down, one command contract for every surface" hold up as a runnable table? It covers:

- pure `decide`/`apply` in `game/`, with an Effect host that supplies dice, time, the log and concurrency;
- one `CommandSpec` registry that drives parsing, Tab completion and `/help`;
- an @opentui/ssh server with one Effect Scope per SSH session, and the same App in the GM's own terminal;
- an SSH-in-SSH relay, where the GM dials out and stays the SSH server.

`CONTRACT.md` holds the types and ownership.

## Run it

Run `host` from this folder: `bunfig.toml` preloads the Solid JSX transform. `relay` and `check` never load the table, so they run from anywhere. A host holds `<campaign>/events.lock` while it runs; a second host on the same folder is refused.

| Mode | Command |
|---|---|
| Host with the GM's seat (Ctrl-C quits and shuts down) | `bun cli.ts host /tmp/PROTOTYPE-wipe-me-campaign` |
| Host without a local seat | `bun cli.ts host /tmp/PROTOTYPE-wipe-me-campaign --headless` |
| Player, direct | `ssh -p 2222 127.0.0.1` |
| Relay | `bun cli.ts relay` (players on 2200, GMs on 7000) |
| Host behind the relay | `bun cli.ts host /tmp/PROTOTYPE-wipe-me-campaign --relay 127.0.0.1:7000 --room den` |
| Player, through the relay | `ssh -p 2200 den@127.0.0.1` |
| Read a campaign (read-only replay) | `bun cli.ts check /tmp/PROTOTYPE-wipe-me-campaign` |

At the table: plain text is chat, `/` starts a command, Tab completes, Up/Down recalls history, PgUp/PgDn scrolls, `/state` shows the debug pane, and Ctrl-C leaves. Only the local seat (actor `gm`) can use `/add`, `/dmg` and `/heal`. Display names are unique: you can't take a name, or a fingerprint label, that someone else answers to.

With the GM's seat open, host logs go to `<campaign>/host.log`. Headless, they go to stdout. The campaign folder holds `events.jsonl` (the log) and `host_key`.

## Architecture

- `game/` is pure. `decide(state, actor, command, dice)` returns events or a refusal, and `apply(state, envelope)` folds them. `rules.ts` holds the one GM-only table; `commands.ts` is a `Record` keyed by command type and reads GM-only from rules. `events.ts` has `parseLog`, the one log reader. `bun run lint` (oxlint, `.oxlintrc.json`) keeps `game/` to `effect/Schema` and its own files.
- `host/CampaignLog` replays (through `parseLog`) and appends `events.jsonl` (one write plus fsync), and holds `events.lock`. `host/Room` is the single writer: behind a Semaphore it runs decide, applies to a copy, appends, then sets a SubscriptionRef that it exposes only as a read-only view. Dice come from Effect's `Random` and timestamps from `DateTime.now`.
- `host/Seat` mounts `table/App` on any renderer. The RoomView's `state()` is a Solid signal fed from `SubscriptionRef.changes`, batched to 16ms with `groupedWithin`. `submit` runs `Room.submit` through a FiberSet runtime, and a Refusal comes back as a message.
- `host/TableServer` forks one scoped fiber per SSH session from a host-level `FiberSet.makeRuntime`. The scope closes on `session.onClose`, which drops presence, the stream fiber and in-flight submits. `host/LocalSeat` gives the GM's terminal the same App as actor `gm`.
- `relay/` holds the SSH-in-SSH relay and the internals it needs from @opentui/ssh 0.6.6. `attach.ts` explains those internals.

```
 player ── ssh :2222 ─────────────────────────┐
                                              v
 player ── ssh :2200 ─> relay        GM machine: bun cli.ts host
                        (SSH server) ┌───────────────────────────────────┐
                          │ room=den │ @opentui/ssh  one Scope/session   │
                          │          │  actor = key:<fp> or SV_ACTOR     │
                          │ SSH      │  (SV_ACTOR only from relay key)   │
                          │ client   │        ^ injectSocket             │
                          └─ TCP ────┼─ GM dials :7000, gets OK <fp>     │
                                     │                                   │
 GM terminal ─ LocalSeat (gm) ──────>│ Seat: App <── state signal (16ms) │
                                     │        │ submit(line)    ^        │
                                     │        v                 │        │
                                     │ Room: lock, decide, apply, set    │
                                     │        │ append + fsync           │
                                     │        v                          │
                                     │ CampaignLog: events.jsonl         │
                                     └───────────────────────────────────┘
```
