# supervillain

A terminal-first virtual tabletop for Draw Steel. Players type `ssh <room>@<host>` and are sitting at a live table, with nothing to install and no account to make. The GM's machine is the authority, and the campaign is a plain append-only log on the GM's disk.

It's being rebuilt small and runs from source for now: chat, names and dice so far, with Draw Steel next. `ASSESSMENT.md` is the plan. The previous build is at tag `archive/2026-09-exploration`.

## Run it

You need [Bun](https://bun.sh) and an OpenSSH client. Run these from the repo root after `bun install`.

**Host a table.** The campaign is a folder; it's created if missing and defaults to `./campaign`.

```sh
bun supervillain host ~/campaigns/den
```

The host prints the command players use and its host key fingerprint, then opens the table in your terminal as the GM; until someone joins, the join command stays in the band at the top. Ctrl-C (or `/quit`) leaves the table and shuts the host down. With players at the table, Ctrl-C asks you to press it again first, and each player is told "The GM closed the table." While your seat is open, host logs go to `<campaign>/host.log`.

| Flag | Default | What it does |
|---|---|---|
| `--port` | `2222` | SSH port for players |
| `--bind` | `127.0.0.1` | Address to listen on; `0.0.0.0` lets other machines in |
| `--room` | the folder's name | The room's name, shown in the header and in the join command |
| `--headless` | off | No GM seat: the host runs in the background of this terminal and logs to stdout |

The campaign folder holds `events.jsonl` (the log, one JSON event per line), `events.lock` (held while a host has the campaign open, so only one can), `host_key` and `host.log`. A new campaign folder is made readable by you alone, and the host refuses a `host_key` that other users can read (`chmod 600` it).

Players are capped so one stranger can't take the table down: 8 connections and 16 sessions from one address, 64 of each in all, 20 seconds to log in, and a few lines a second per player. Through a tunnel every player arrives from the same address, so they share the per-address caps.

**Join as a player.**

```sh
ssh -p 2222 den@127.0.0.1
```

Your SSH key is your identity, so there's no account. The first time, the table asks what to call you, and it remembers the name for your key. A name can't look like someone else's (case, lookalike letters from other scripts and invisible characters don't make it different), and can't hold the table's own markers, `(GM)` and `(you)`. Plain text is chat, `/` starts a command, Tab completes, Up and Down recall what you typed, PgUp and PgDn scroll, `/help` lists the commands, and Ctrl-C (or `/quit`) leaves. A refused line stays in the input for you to fix.

**Guests.** A client with no key gets in as a guest, with a new identity for each connection. A guest's name is held only while they're seated, so a guest who reconnects can take it back. To try it from a machine that has keys: `ssh -o PubkeyAuthentication=no -p 2222 den@127.0.0.1`.

**One command at a time.** Put an input line after the ssh command and the table runs it as you, prints the result and exits. A refusal goes to stderr with exit status 1. `roll` and `help` work without their slash; commands that take free text (`/name`, `/me`, `/say`) need it, so chat that starts with "me" or "name" stays chat. With no command and no terminal (`ssh host </dev/null`), the table says to use `ssh -t` and exits.

```sh
ssh -p 2222 den@127.0.0.1 roll 2d10+3
ssh -p 2222 den@127.0.0.1 /name Vex
ssh -p 2222 den@127.0.0.1 "hello everyone"
ssh -p 2222 den@127.0.0.1 help
```

**Read a campaign.** `check` replays the log without opening it, so it works while the host runs. It prints a summary, the feed and the final state, and lists unknown events it skipped on stderr. It exits 1 if the log has an event it can't apply.

```sh
bun supervillain check ~/campaigns/den
```

## Develop

```sh
bun install
bun run build
bun test
bun run check
```

## License

[MIT](LICENSE).

---

supervillain is an independent product published under the DRAW STEEL Creator License and is not affiliated with MCDM Productions, LLC. DRAW STEEL © 2026 MCDM Productions, LLC.
