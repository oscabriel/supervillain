---
title: Playing at a table
summary: You need a terminal and ssh. Paste the command your GM sends, check the key once, and you're seated.
order: 1
---

You need a terminal and `ssh`, which macOS, Linux and Windows 10 and later already have. There's nothing to install and no account to make.

## Sit down

Your GM gives you one command. Paste it into a terminal:

```sh
ssh -p 2222 first-fight@gm.example.net
```

The part before the `@` is the room, and after it is where the table is. The GM may give you a different port, or none.

The first time, ssh asks whether you trust the table's key:

```text
ED25519 key fingerprint is SHA256:gkYn722z8+JIXdkwJa/9amF10Y2+zkGdElyWlj0LZHk.
Are you sure you want to continue connecting (yes/no/[fingerprint])?
```

Check that the fingerprint matches the one your GM sent you, then type `yes`. After that ssh remembers the key. If ssh ever says the key has changed, stop and ask your GM. If the table goes through a relay, the key ssh shows is the relay's, not the GM's machine's: check it against the relay's fingerprint, which your GM gets from whoever runs the relay.

### The lobby

If your GM's table goes through a relay, you can come without the room's name: `ssh -p 2222 lobby@relay.example.net`, or a bare `ssh -p 2222 relay.example.net`. Either way you get the lobby. If you've sat at a table there before with your key, it lists the tables open right now that know it: Up and Down move the pick, or type a table's number; Enter sits you at it. A table knows your key once you've done something there with it, such as setting your name or rolling.

The first time you come, or as a guest, nothing is listed and the lobby says how to sit down instead: type the room's name your GM gave you and press Enter. That works with tables listed too.

### When the table doesn't answer

- `The table first-fight isn't open right now.` The GM's machine isn't linked to the relay. Try again once they say it's up.
- The lobby, when you expected the table, or `There's no table called first-fight here.` in it. Check the room name with your GM, and type the right one there.
- `The table first-fight is full right now.` Try again when someone leaves.
- `The table closed.` The table went away while you were seated. Run the same command again when it's back; your name and hero are kept for your key.
- `Connection reset by peer`, before anything else. Your address has as many connections open as the table allows, or opened them too fast. Close the others or wait a minute.

If your terminal looks garbled after the table drops, type `reset` and press Enter.

## Who you are

- **If you have an SSH key** (`~/.ssh/id_ed25519` or similar), it is who you are. The table remembers your name and your hero for that key, so use the same key every time. Make one with `ssh-keygen -t ed25519` if you'd like the table to remember you.
- **If you don't have one,** you come in as a guest, with no password. A guest is new every time they connect, so your name lasts only until you leave. When you come back, pick your name again and `/play` your hero: one whose guest has left is free to take.
- **If you have several keys,** ssh offers them in turn and the table takes the first. Pin one for the table in `~/.ssh/config`:

```text
Host gm.example.net
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
```

The first time, the table asks what to call you. Type a name and press Enter, and change it later with `/name Ilsa`. Names are 1 to 24 characters, and nobody can take a name that looks like someone else's or like a hero's in play.

## The keyboard

The input line at the bottom always has the keyboard. Nothing you type does anything until you press Enter, and no single key is a shortcut.

| Key | What it does |
| --- | --- |
| Enter | Send the line |
| Tab, Shift-Tab | Complete a command or a name; press again for the next match |
| Up, Down | Go back through lines you've sent |
| PgUp, PgDn | Scroll the feed, or a sheet you opened |
| Alt+1 to Alt+4 | Show or hide the band, the map, the feed, or a reply you opened |
| Esc | Cancel a completion, close the mouse's menu, or close a message |
| Ctrl-C, or `/quit` | Leave the table |

Between the header and the input line are panels: the band (who's here, your party or the fight), the map, the feed, and a reply just for you, such as a sheet or `/help`. Each panel's title starts with its key as a small number, and Alt with that digit shows or hides it. The choice is your seat's alone.

Plain text is chat. Anything that starts with `/` is a command; `/help` lists them all, and `/help move` explains one. When the table refuses a line, it says why and empties the input; press Up to get the refused line back and fix it.

## The mouse

Click your hero's token on the map, or its row in the band, and a menu opens with what it can do: Move (or Place), each of its abilities, and End turn while it's its turn. A click sends exactly the line you could have typed, and Up shows it afterward, so the menu is a way to learn the commands too. With no menu open, clicking a token types its mark where the cursor is, and clicking a square types its name.

Hold Shift while you drag to select and copy text as usual. `/mouse off` gives your terminal its mouse back, for your seat alone.

## What you'll type

Your GM brings heroes and monsters in, starts combat and runs the Director's side. You run your hero, and you can change only your own hero.

| Command | What it does |
| --- | --- |
| `hello all` | Say something to the table |
| `/me draws her sword` | Act something out |
| `/roll 2d10+3` | Roll dice for everyone to see |
| `/play brann` | Play a hero the GM brought in; `/play` alone lists the free ones |
| `/sheet brann` | Show a hero's or creature's sheet, to you alone |
| `/turn`, `/done` | Start your hero's turn, or end it |
| `/pr brann driving on b1` | Power roll with an ability; the tier's damage goes to each target after `on` |
| `/move brann f5` | Move your token along the cheapest path |
| `/move brann f5 main` | Move again, using your main action |
| `/dist brann bandit-chief` | Count the squares between two tokens or squares |
| `/push bandit-chief 2` | On your turn, push a creature away from your hero |
| `/recover brann` | Spend a Recovery |
| `/undo`, `/redo` | Take back your latest change, or put it back |

The [front page](/) has a small fight you can play with these in the browser. For `set.world` and `pf2e` (ORC) commands, see [Rulesets](/docs/rulesets).

## The map

Squares are a column letter and a row number, like `c5`. Row 1 is the top row. On the map, `·` is floor, a solid block is wall and `~` is difficult terrain. A hero's token is a capital letter (`B` for Brann), a creature's a small one from the last word of its name (`b` for the Bandit Bruiser), with a digit when two would share a letter. A mark works in commands wherever a name does, and it's case-sensitive.

When you're about to move, the squares you can reach are tinted. A move costs 1 a square, diagonals too, and difficult terrain or an enemy's square costs 1 more. In combat you move only on your own turn, up to your speed over the whole turn.

In a terminal that shows kitty graphics (Ghostty, kitty or WezTerm, not inside tmux), the map is drawn in MEKMODE's pixel pictures by default. `/view text` switches to the text map, and `/view pictures` switches back.

## Taking things back

`/undo` takes back your latest change within 30 seconds, even if someone else has done something since, and `/redo` puts it back. A change that rolled dice can only be undone by the GM, so nobody can roll again by undoing. Chat, names and `/roll` are never taken back. Nothing leaves the log: the undo is an event of its own.

## One command at a time

Anything you can type at the table also works as one command from your shell, without sitting down:

```sh
ssh -p 2222 first-fight@gm.example.net '/roll 2d10'
ssh -p 2222 first-fight@gm.example.net 'running late, start without me'
```

The table needs at least 72 columns and 20 rows; about 100 by 30 shows a whole fight comfortably.
