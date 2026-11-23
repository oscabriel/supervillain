---
title: How it fits together
summary: One binary on the GM's machine holds the rules, the SSH server and the log. A relay, when you use one, only carries bytes between players and that machine.
order: 4
---

supervillain is one program. On the GM's machine it is the table: the rules, an SSH server, every player's screen and the campaign log. On a VPS it can be a relay. Nothing else runs anywhere, and players run nothing at all.

```text
 players' ssh ──> ┌──────────────── GM's machine ────────────────┐
                  │  SSH server ─> seat ─> input line            │
                  │                         │                    │
                  │                         v                    │
                  │  rules: decide ─> events ─> events.jsonl     │
                  │         apply  <────────────┘                │
                  │                         │                    │
                  │  table view ─> every seat redraws            │
                  └──────────────────────────────────────────────┘
```

## The GM's machine is the authority

Every seat, the GM's terminal included, sends lines of text. The host turns a line into a command, the rules decide it, and the events they return are appended to the log. Then every seat draws its screen again from the new state. Players never hold game state; their terminal shows frames and sends keys.

That makes the host a single writer. Only one host at a time writes to a campaign (`events.lock` makes sure of it), and a host that finds the log changed under it halts rather than guess.

## The rules are pure

A ruleset is a module of plain functions:

- `decide(state, actor, command, dice)` returns events, or a refusal with a reason the table shows the player.
- `apply(state, envelope)` folds one event into the state.

The rules have no Effect runtime, no I/O, no clock and no `Math.random`. Randomness and facts from outside, such as a hero's sheet, a generated map or a set.world roll, are gathered by the host before the command is decided and go into the event's payload. Replay never rolls and never reads a file, so the log alone rebuilds the table, and `supervillain check` can replay one while the table is running.

## The log is a text file

The campaign is `events.jsonl`, one JSON object per line:

```json
{"actor":"gm","seq":9,"timestamp":"2026-10-22T16:23:16.573Z","type":"ds.moved","payload":{"id":"brann","path":[{"x":2,"y":4},{"x":3,"y":4},{"x":4,"y":4},{"x":5,"y":4}],"cost":4,"speed":5}}
```

The envelope is always `actor`, `seq`, `timestamp`, `type` and `payload`. The file is only ever appended to. An undo doesn't delete anything: it is an event of its own that names the changes it takes back, and the fold leaves them out. A reader skips an event type it doesn't know, loudly; the writer halts on one it can't apply.

You can read your campaign with `cat`, search it with `grep`, back it up with `cp` and keep it in git.

## A domain model over that file

The table is an aggregate in [@alchemy.run/domain](https://github.com/alchemy-run/alchemy): its commands, its events and the decide and evolve functions that connect them. The storage under it is ours, `@supervillain/platform-jsonl`, which keeps the aggregate's stream in that one `events.jsonl` instead of a database. The domain layer gets typed commands and events and tests written as stories; the campaign stays a file a GM can read.

## Effect runs the edge

[Effect 4](https://effect.website) owns everything that isn't rules: the log file and its single writer, the SSH server, each session's lifetime and the relay link. Each is a service with a layer, so a test can swap the real file or the real network for a fake one. When a player disconnects, their session's scope closes and everything it opened goes with it.

## SSH that expects strangers

The SSH server is our own, on [ssh2](https://github.com/mscdex/ssh2). It is open to strangers, so it is built defensively:

- It offers only elliptic-curve key exchange, with ML-KEM's post-quantum hybrid (`mlkem768x25519-sha256`) first. Stock ssh2 lacks that hybrid, so supervillain patches it in, with ML-KEM from `@noble/post-quantum`.
- It caps connections and sessions per address and in all, rate-limits new sessions, times out logins and idle sessions, and cuts peers that stop reading or rekey too often.
- A key is an identity. A client with no key can come in as a guest.

## One app for every seat

The table's screen is one Solid app on OpenTUI, rendered once for the GM's terminal and once for each SSH seat. It sees only a read-only view of the table, never the room, the log or Effect. In terminals with kitty graphics, the map can be drawn as pictures from MEKMODE's tiles, sent to that seat as small PNGs.

## The relay

`supervillain relay` renders nothing and keeps no record of play. A GM's host dials out to it and holds a link open; the relay takes players' SSH connections on its public port and passes each one down that link. The host pins the relay's key, so nobody else can pretend to be the relay. The relay's own state is two keys and `rooms.json`, a list of which GM host key holds which room name.

Because players' SSH ends at the relay, the relay sees play in the clear and vouches for which key each player holds. A GM runs their own relay or uses one they trust. The [blog](/blog/cloudflare-tcp-vs-vps) explains why the relay runs on a small VPS and not on a serverless platform.
