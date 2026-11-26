---
title: Playing at a table
summary: You need a terminal and ssh. Paste the command your GM sends, knock at the door once, and you're seated.
order: 1
---

You need a terminal and `ssh`, which macOS, Linux and Windows 10 and later already have. There is nothing to install and no account to make.

## Sit down

Your GM gives you one command. Paste it into a terminal:

```sh
ssh ana/first-fight@supervillain.sh
```

Before the `@` is the table address: your GM's handle (`ana`), a `/` (or `.`), and the table's name. After it is the relay carrying the table. A GM hosting directly on your local network or Tailscale gives you their machine's address and port instead (`ssh -p 2222 first-fight@192.168.1.20`).

The first time, ssh asks whether you trust the host key:

```text
ED25519 key fingerprint is SHA256:gkYn722z8+JIXdkwJa/9amF10Y2+zkGdElyWlj0LZHk.
Are you sure you want to continue connecting (yes/no/[fingerprint])?
```

Check that the fingerprint matches what your GM sent (or the one shown under **What is this?** on the [front page](/)), then type `yes`. After that ssh saves the host's public key in `~/.ssh/known_hosts` to protect future sessions against tampering. Run `cat ~/.ssh/known_hosts` anytime to inspect the saved key on your machine. If ssh ever warns that the key changed, stop and ask your GM.

## The lobby

Running `ssh supervillain.sh` with no table address opens the supervillain lobby (and installing the local binary and running `supervillain` opens the exact same screen on your own machine). Use `1` through `4`, `Tab`, or `←`/`→` to switch tabs, and `q` to leave:

- **1 Tables:** lists every open table that knows your SSH key, plus `/` or `Enter` to type any `<handle>/<table>` address directly.
- **2 Try a Table:** drops you into a private, in-memory Draw Steel sandbox encounter right in your terminal with nothing installed and nothing saved.
- **3 Create a Table:** lets GMs claim a handle bound to their SSH key and get a one-line setup command (or create a local campaign folder when run from the CLI).
- **4 Session:** shows your SSH key fingerprint, claimed GM handle, terminal info, and CLI quick reference.

### Knock at the door

New tables open with the door set to knock. The first time you join, you see the door instead of the table: pick the display name you want the table to call you and press Enter. Your GM sees your name and the start of your SSH key fingerprint at the top of their screen and lets you in.

Once admitted, your SSH key enters directly on every future session until the GM removes you with `/kick`. If your GM gives you an invite link with a `~` token (`ssh ana/first-fight~5k2q…@supervillain.sh`), you pick your name and sit straight down without waiting.

### Coming back

Once a table knows your key, two shortcuts work:

- **Short name:** `ssh first-fight@supervillain.sh` takes you straight in if exactly one live table of that name knows your key. If two do, the lobby opens filtered to those two.
- **Lobby:** `ssh supervillain.sh` shows every live table that knows your key under **1 Tables**.

### When the table doesn't answer

- `ana/first-fight isn't open right now.` The GM's machine is offline or isn't linked yet. Try again once they open the table.
- `ana/first-fight is full right now.` Try again when someone leaves.
- `The table closed.` The GM closed the table or their link dropped. Run the same command again when it comes back; your name and character are kept for your key.
- `This table lets players in by knocking: connect interactively and wait for the GM.` You sent a one-off command before being admitted. Connect normally and knock first.
- `Connection reset by peer`, before anything else. Your address hit the connection cap or rate limit. Close extra sessions or wait a minute.

If your terminal looks garbled after a drop, type `reset` and press Enter.

## Who you are

- **If you have an SSH key** (`~/.ssh/id_ed25519` or similar), it is your permanent identity at every table. The table remembers your admission, display name and character for that key. Make one with `ssh-keygen -t ed25519` if you don't have one yet.
- **If you don't have one,** you join as a guest with no password. Guests get a fresh identity each connection, so your name and character assignment last only until you leave.
- **If you have several keys,** pin one in `~/.ssh/config` so ssh offers the same key every time:

```text
Host supervillain.sh
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
```

If you use OpenSSH `ControlPath` multiplexing with `%r`, switch to `%C` so the `/` in `<handle>/<table>` doesn't look like a subdirectory.

Change your display name at any time with `/name Ilsa`. Names are 1 to 24 characters and can't imitate another player or a character in play.

## Campaign stage and battlemap

A table holds your whole campaign, not only fights:

- **Party strip:** always shows every player character, their stats or meters, and active conditions. Click a row (or run `/sheet brann`) to inspect a full sheet.
- **Campaign stage:** outside combat, the GM pins what you should see right now: the active scene and read-aloud text, NPCs you're talking to, handouts, sketches or region maps, clocks and trackers, and recent recap beats. Anything the GM keeps under `## GM Notes` never leaves their machine.
- **Codex (`/codex`):** lists every scene, NPC, handout or item the GM has revealed so far so you can re-read them any time.
- **Battlemap:** when the GM starts combat, every seat switches cleanly to the tactical map and turn band. When the fight ends, everyone returns to the campaign stage with updated health, resources and conditions. Run `/view stage` or `/view board` to peek at the other view on your own seat.

## The keyboard

The input line at the bottom always owns the keyboard. Nothing runs until you press Enter, and no bare letter is a shortcut.

| Key | What it does |
| --- | --- |
| Enter | Send the line |
| Tab, Shift-Tab | Complete a command, name, or revealed codex card |
| Up, Down | Step through lines you've sent |
| PgUp, PgDn | Scroll the feed or an open reply |
| Alt+1 to Alt+4 | Show or hide the party/band, stage/map, feed, or reply panel |
| Esc | Cancel completion, close the mouse menu, or dismiss a reply |
| Ctrl-C, or `/quit` | Leave the table |

Plain text is chat. Commands start with `/`. `/help` lists every command for the table's ruleset, and `/help move` explains one. If the table refuses a line, press Up to bring it back and edit it.

## The mouse

Click your character's token on the map or its row in the band to open its action menu (Move, Place, abilities, End turn). Every click sends the exact slash command you could have typed, so Up shows it afterward. With no menu open, clicking a token types its mark into the input line and clicking a square types its coordinates.

Hold Shift while dragging to select and copy text as usual. `/mouse off` returns mouse control to your terminal for your seat alone.

## Common commands

Your GM stages scenes, adds foes and runs their side. You run your character.

| Command | What it does |
| --- | --- |
| `hello all` | Say something to the table |
| `/me draws her sword` | Act something out |
| `/roll 2d10+3` | Roll dice for everyone to see |
| `/play brann` | Claim a hero or PC the GM brought in (`/play` lists free ones) |
| `/sheet brann` | Show a sheet to you alone |
| `/codex` | Browse cards the GM has revealed to the table |
| `/turn`, `/done` | Start or end your turn |
| `/pr brann driving on b1` | Draw Steel power roll; applies tier damage to targets after `on` |
| `/move brann f5` | Move along the cheapest path (`main` uses your main action in Draw Steel) |
| `/dist brann bandit-chief` | Measure squares between two tokens or squares |
| `/push bandit-chief 2` | Force-move a creature on your turn |
| `/recover brann` | Spend a Recovery |
| `/undo`, `/redo` | Take back your latest change within 30 seconds, or put it back |

The [front page](/) has a live Draw Steel skirmish you can try in the browser. For `set.world`, `pf2e` (ORC), and `freeform` commands, see [Rulesets](/guide/rulesets).

## The map

Squares are a column letter and row number like `c5` (row 1 at the top). On a text map, `·` is floor, solid blocks are walls, and `~` is difficult terrain. Hero marks are uppercase (`B` for Brann); creature marks are lowercase (`b1` for a Bandit Bruiser), case-sensitive wherever a name works.

In terminals with kitty graphics (Ghostty, kitty or WezTerm, outside tmux), maps render in MEKMODE pixel tiles by default. Use `/view text` and `/view pictures` to switch.

## Taking things back

`/undo` reverts your latest change within 30 seconds, even if someone else acted after you, and `/redo` restores it. Changes that rolled dice can only be undone by the GM. Chat, names and `/roll` are never undone. Every undo is itself a logged event; the log is never rewritten.

## Bring an agent

You don't have to memorize commands to play. You can attach Claude Code, Codex, Cursor or T3 Code directly to your seat over SSH with nothing installed, using the exact same SSH key and player permissions. See [Connect an agent](/guide/agents).

## One command at a time

Once admitted, anything you can type at the table also runs as a one-off SSH command:

```sh
ssh ana/first-fight@supervillain.sh '/roll 2d10'
ssh ana/first-fight@supervillain.sh 'running late, start without me'
```

The table needs at least 72 columns and 20 rows; 100 by 30 gives the stage and map plenty of room.
