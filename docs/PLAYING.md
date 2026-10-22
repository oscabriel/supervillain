# Playing at a supervillain table

You need a terminal and `ssh`, which macOS, Linux and Windows 10 and later already have. There's nothing to install and no account to make.

## Sit down

Your GM gives you one command. Paste it into a terminal:

```sh
ssh -p 2222 first-fight@gm.example.net
```

The part before the `@` is the room, and after it is where the table is. The GM may give you a different port, or none.

The first time, ssh asks whether you trust the table's key:

```
ED25519 key fingerprint is SHA256:gkYn722z8+JIXdkwJa/9amF10Y2+zkGdElyWlj0LZHk.
Are you sure you want to continue connecting (yes/no/[fingerprint])?
```

Check that the fingerprint matches the one your GM sent you, then type `yes`. After that ssh remembers the key. If ssh ever says the key has changed, stop and ask your GM. If the table goes through a relay, the key ssh shows is the relay's, not the GM's machine's: check it against the relay's fingerprint, which your GM gets from whoever runs the relay.

If your GM's table goes through a relay, a few things can come back instead of the table:

- `The table first-fight isn't open right now.` The GM's machine isn't linked. Try again once they say it's up.
- `There's no table called first-fight here.` Check the room name before the `@` with your GM.
- `The table first-fight is full right now.` The room has all the players the relay carries for one table. Try again when someone leaves.
- `The table closed.` or `The GM closed the table.` The table went away while you were seated. Run the same command again when it's back; your name and hero are kept for your key.
- `The relay is shutting down.` The relay is restarting, usually for an upgrade. Run the same command again in a moment.
- `Connection reset by peer`, before anything else. Your address has as many connections open as the table or relay allows (8), or opened them too fast. Close the others or wait a minute.

If your terminal looks garbled after the table drops (odd characters when you move the mouse, no cursor), type `reset` and press Enter.

## Who you are

- **If you have an SSH key** (`~/.ssh/id_ed25519` or similar), it is who you are. The table remembers your name and your hero for that key, so use the same key every time. Make one with `ssh-keygen -t ed25519` if you'd like the table to remember you.
- **If you don't have one,** you come in as a guest. You don't need a password. A guest is new every time they connect, so your name lasts only until you leave. When you come back, pick your name again and `/play` your hero: a hero whose guest has left is free to take. To come in as a guest even if you have a key, add `-o PubkeyAuthentication=no`.
- **If your key is RSA** and your ssh is set to sign with `rsa-sha2-512` only (`PubkeyAcceptedAlgorithms rsa-sha2-512` in `~/.ssh/config`), ssh skips the key: you come in as a guest, or see `Permission denied (publickey)`. The table's SSH library never offers `rsa-sha2-512`. ssh's defaults fall back to `rsa-sha2-256` and work, so add `-o PubkeyAcceptedAlgorithms=+rsa-sha2-256` to the command, or make an ed25519 key.

The table asks **what should the table call you?** the first time. Type a name and press Enter. Change it later with `/name Ilsa`. Names are 1 to 24 characters, and nobody can take a name that looks like someone else's.

## The keyboard

The input line at the bottom always has the keyboard. Nothing you type does anything until you press Enter, and no single key is a shortcut.

| Key | What it does |
| --- | --- |
| Enter | Send the line |
| Tab, Shift-Tab | Complete a command or a name; press again for the next match |
| Up, Down | Go back through lines you've sent |
| PgUp, PgDn | Scroll the feed, or a sheet you opened |
| Esc | Cancel a completion or close a message |
| Ctrl-A, Ctrl-E | Jump to the start or end of the line |
| Ctrl-W, Ctrl-U | Delete a word, or everything before the cursor |
| Ctrl-C, Ctrl-D on an empty line, or `/quit` | Leave the table |

Plain text is chat. Anything that starts with `/` is a command. `/help` lists them all, and `/help move` explains one. A bare `help`, `exit` or `quit` is answered first (did you mean `/help`?); press Enter again to say it to the table. When the table refuses a line, it says why and empties the input, so your next line starts clean; press Up to get the refused one back and fix it.

## What you'll type

Your GM brings heroes and monsters in, starts combat and runs the Director's side. You run your hero. You can only change your own hero, so the GM applies damage to monsters.

| Command | What it does |
| --- | --- |
| `hello all` | Say something (the same as `/say hello all`) |
| `/me draws her sword` | Act something out |
| `/roll 2d10+3` | Roll dice for everyone to see |
| `/play brann` | Play a hero the GM brought in. A unique start of a name is enough: `/play bra`. `/play` alone lists the heroes nobody plays |
| `/sheet brann` | Show a hero's or creature's sheet, to you alone |
| `/turn` | Start your hero's turn; `/done` ends it |
| `/pr brann Judgment Strike` | Make a power roll with an ability: 2d10 plus the characteristic, the tier's result and the ability's effect. An ability with no roll is used, its cost spent |
| `/pr brann driving on b1` | The same at a target: the tier's damage goes to each target named after `on` |
| `/pr brann +2 edge` | Make a power roll with a bonus, and an edge or bane (`edge`, `bane`, `edge2`, `bane2`) |
| `/dmg brann 7 fire`, `/heal brann 5`, `/temp brann 4` | Take damage, regain Stamina, or gain temporary Stamina |
| `/recover brann` | Spend a Recovery |
| `/cond brann slowed eot`, `/cond brann -slowed` | Set a condition (`eot`, `save` or `end`), or remove it |
| `/save brann` | Roll a save against save-ends conditions |
| `/res brann +2`, `/surge brann -1` | Gain or spend your heroic resource or surges |
| `/token -1` | Spend a hero token |
| `/move brann f5` | Move your token along the shortest path |
| `/move brann f5 main` | Move again, using your main action |
| `/dist brann bandit-chief` | Count the squares between two tokens or squares |
| `/push bandit-chief 2 from brann` | Push a creature (also `/pull`, and `/slide … to <square>`) |
| `/undo`, `/redo` | Take back your latest change, or put it back |

## The map

Squares are written as a column letter and a row number, like `c5`. Columns run `a` to `z` from the left, then `aa`, `ab` and so on. Row 1 is the top row. The letters are along the top of the map and the numbers down its side.

On the map, `·` is floor, a solid block is wall and `~` is difficult terrain. Tokens are marks: a hero's is a capital letter (`B` for Brann), a creature's a small one from the last word of its name (`c` for the Bandit Chief), with a digit when two would share a letter (`b1`, `b2`). In combat the band at the top shows each token's mark beside its name. A mark works in commands wherever a square does, and it's case-sensitive: `/dist B b`. When you're about to move, the squares you can reach are tinted and marked `•`, or `≈` on difficult terrain. A move costs 1 a square, diagonals too, and difficult terrain or an enemy's square costs 1 more. In combat you move only on your own turn, up to your speed over the whole turn.

On a map bigger than your screen, the view follows whoever is acting. `/view f5` or `/view bandit-chief` centres it until the turn passes. `/view map` gives the map more room, `/view feed` hides it, and `/view` switches it on and off.

## Taking things back

`/undo` takes back your latest change within 30 seconds, even if someone else has done something since. Then `/redo` puts it back. The feed says what was undone.

- A change that rolled dice (a power roll, a save, a turn that rolled your resource) can only be undone by the GM, so nobody can roll again by undoing.
- If something that happened later depends on your change, the table refuses and says what to undo first.
- Chat, names and `/roll` are never taken back.

The GM can undo anyone's latest change with `/undo <who>`.

## "widen your terminal"

The table needs at least 80 columns and 24 rows. On a smaller window it shows `widen your terminal to 80x24 · it is 60x20` and only the feed and the input line. Make the window bigger or the font smaller, and the table comes back right away without reconnecting. 80x24 works, but a fight with a map is tight there: about 100x30 shows the whole band, more of the map and a longer feed.

## One command at a time

Anything you can type at the table also works as one command from your shell, without sitting down. `roll`, `dist`, `undo`, `redo`, `help` and `sheet` work without their slash; the rest need it, so chat that starts with "me" or "name" stays chat. A refusal comes back on stderr with exit status 1.

```sh
ssh -p 2222 first-fight@gm.example.net '/roll 2d10'
ssh -p 2222 first-fight@gm.example.net 'running late, start without me'
```
