# Playing at a supervillain table

You need a terminal and `ssh`, which macOS, Linux and Windows 10 and later already have. There's nothing to install and no account to make.

## Sit down

Your GM gives you one command. Paste it into a terminal:

```sh
ssh ana/first-fight@relay.example.net
```

Before the `@` is the table: the GM's handle (`ana`), a `/` (or a `.`), and the table's name. After it is the relay that carries the table. A GM who hosts on their own network gives you their machine's address and port instead (`ssh -p 2222 first-fight@192.168.1.20`), and there the part before the `@` doesn't matter.

The first time, ssh asks whether you trust the table's key:

```
ED25519 key fingerprint is SHA256:gkYn722z8+JIXdkwJa/9amF10Y2+zkGdElyWlj0LZHk.
Are you sure you want to continue connecting (yes/no/[fingerprint])?
```

Check that the fingerprint matches the one your GM sent you, then type `yes`. After that ssh remembers the key. If ssh ever says the key has changed, stop and ask your GM. If the table goes through a relay, the key ssh shows is the relay's, not the GM's machine's: check it against the relay's fingerprint, which your GM gets from whoever runs the relay.

### At the door

The first time you come to a table, you're at its door, not at the table: it says the table lets players in by knocking, shows the start of your key's fingerprint, and asks what the table should call you. The name follows the same rules as `/name`, and one already used at the table is refused there. Once you press Enter you're knocking: the GM sees your name and fingerprint at the top of their screen and lets you in, or not. Let in, the table takes the screen. Turned away, you're told so and can knock again in 10 minutes; a knock nobody answers for 10 minutes ends by itself, and the door closes if you don't knock within 2 minutes. Ctrl-C leaves the door.

After that your key is at the table: you come straight in each time, until the GM removes you with `/kick`. A table whose GM opened the door (`/door open`) seats anyone, and a table you played at before knocking existed still knows you.

A GM can also give you an invite, which goes after the table's name with a `~` (`ssh ana/first-fight~5k2q…@relay.example.net`): you name yourself at the door and sit straight down. An invite is good for the uses and minutes the GM chose. One-off commands (`ssh … roll 2d10`) work only once you're at the table.

### Coming back

Once a table knows your key, the table's name alone finds it: `ssh first-fight@relay.example.net` seats you at the one open table of that name, or of that GM handle, that knows you. If two do, you get the lobby with both to pick from. If none does, the lobby says to use the full name.

### The lobby

If your GM's table goes through a relay, you can come without the table's name: `ssh lobby@relay.example.net`, or a bare `ssh relay.example.net`. Either way you get the four-tab lobby (`1`–`4`, `Tab`/`Shift-Tab`, `←`/`→`, `F1`–`F4`, or `Alt+1`–`Alt+4` switch tabs; `q`, `Ctrl-C`, or `Ctrl-D` leaves):

- **1 Tables**: lists the tables open right now that know your key on the left, with details on the right, plus a join-by-name action (`/` or `Enter`) to enter `<handle>/<table>` directly.
- **2 Try a Table**: launches a private, in-memory Draw Steel sandbox table right over SSH with nothing installed and nothing saved.
- **3 Create a Table**: lets future GMs claim a handle bound to their SSH key and get a copy-ready install and setup command for their own machine (`c` re-copies the commands via OSC 52).
- **4 Session**: shows your SSH key fingerprint (`c` copies it), claimed GM handle, terminal info, and direct/host CLI commands whenever you want to inspect them.

On **Tables**, if you've sat at a table before with your key, it looks like this:

```
 1 Tables · 2     2 Try a Table     3 Create a Table                        4 Session
━━━━━━━━━━━━━━───────────────────────────────────────────────────────────────────────

open tables                          ana/first-fight
 ana/first-fight            ● 3      ● 3 seated · open now
 bo/the-keep                ● 1
                                      sit down   enter
 + join another table…
                                     direct    ssh ana/first-fight@…

─────────────────────────────────────────────────────────────────────────────────────
             ↑/↓ pick   enter sit down   / join by name   1-4 tabs   q quit
```

`↑`/`↓` (or `j`/`k`) move the selection; `Enter` sits you at the highlighted table, exactly as if you had typed its name before the `@`. A table knows your key once the GM has let you in (or you've done something there with it at a table whose door is open), and a GM can keep their table off the list with `--no-lobby`.

The first time you come, or as a guest, there's nothing to list, so **Tables** shows a clean join-by-name prompt on the left and pointers to **Try a Table** and **Create a Table** on the right. Press `Enter` or `/` to type the table's full name your GM gave you (`ana/first-fight`), then `Enter` to join (`Esc` cancels back to navigation). That works with tables listed too, for one that isn't on your list, and a bare table name picks it from your list. A name that isn't open is answered on the screen (`ana/first-fight isn't open right now.`, or `No open table called first-fight knows your key…`), and after five of those the relay shows the join hint below and lets go.

`q`, `Ctrl-C`, or `Ctrl-D` leaves, and after a minute without a key pressed the relay says goodbye. Open **4 Session** at any time to check your SSH key's fingerprint, your claimed GM handle, or guest setup (`ssh-keygen -t ed25519`). Asked with a command (`ssh lobby@relay.example.net help`), the relay has no screen to draw: it prints the list and the command to join one, or the join hint when there's nothing to list, and runs nothing.

If your GM's table goes through a relay, a few things can come back instead of the table:

- `ana/first-fight isn't open right now.` The GM's machine isn't linked, or no GM uses that name there. Check it with your GM, and try again once they say it's up.
- `No open table called first-fight knows your key. Join with its full name, ssh <handle>/first-fight@… (your GM has it).` You typed a bare table name in the lobby, and no open table that knows your key has it.
- `To join a table, put its name before the @ (ssh <handle>/<table>@…). Your GM has it.` You ran a command without a table, so ssh sent your own username instead, or you used the shorthand and no open table of that name knows your key yet (the relay says the same whether or not one is open); or you tried five names in the lobby and none was open. With a shorthand that works, the relay says `Joining ana/first-fight…` first.
- `This table lets players in by knocking: connect interactively and wait for the GM.` A one-off command at a table that hasn't let you in. Connect without a command and knock.
- `ana/first-fight is full right now.` The table has all the players the relay carries for one table. Try again when someone leaves.
- `The table closed.` or `The GM closed the table.` The table went away while you were seated. Run the same command again when it's back; your name and hero are kept for your key.
- `The relay is shutting down.` The relay is restarting, usually for an upgrade. Run the same command again in a moment.
- `Connection reset by peer`, before anything else. Your address has as many connections open as the table or relay allows (8), or opened them too fast. Close the others or wait a minute.
- `channel 0: open failed`, right after connecting. Your address started sessions too fast (20, then 1 a second) or has its most open. Wait a moment.

If your terminal looks garbled after the table drops (odd characters when you move the mouse, no cursor), type `reset` and press Enter.

## Who you are

- **If you have an SSH key** (`~/.ssh/id_ed25519` or similar), it is who you are. The table remembers your name and your hero for that key, so use the same key every time. Make one with `ssh-keygen -t ed25519` if you'd like the table to remember you. If you have several keys, ssh offers them in turn and the table takes the first, which may not be the one you used last time. Pin one for the table in `~/.ssh/config`:

  ```
  Host gm.example.net
      IdentityFile ~/.ssh/id_ed25519
      IdentitiesOnly yes
  ```
- **If you don't have one,** you come in as a guest. You don't need a password. A guest is new every time they connect, so your name lasts only until you leave. When you come back, pick your name again and `/play` your hero or fighter: one whose guest has left is free to take. To come in as a guest even if you have a key, add `-o PubkeyAuthentication=no`.
- **If your key is RSA** and your ssh is set to sign with `rsa-sha2-512` only (`PubkeyAcceptedAlgorithms rsa-sha2-512` in `~/.ssh/config`), ssh skips the key: you come in as a guest, or see `Permission denied (publickey)`. The table's SSH library never offers `rsa-sha2-512`. ssh's defaults fall back to `rsa-sha2-256` and work, so add `-o PubkeyAcceptedAlgorithms=+rsa-sha2-256` to the command, or make an ed25519 key.

The table asks **what should the table call you?** the first time. Type a name and press Enter. Change it later with `/name Ilsa`. Names are 1 to 24 characters, without brackets, and nobody can take a name that looks like someone else's or like a hero's or creature's in play.

Once you have a name, a player without a hero sees the free ones on the hint row above the input line (`free to play: Brann, Kesh · /play <name> takes one`). On your hero's turn, that row says `your turn · /done ends it`.

## The keyboard

The input line at the bottom always has the keyboard. Nothing you type does anything until you press Enter, and no single key is a shortcut: digits type digits, and only Alt with a digit shows or hides a panel.

| Key | What it does |
| --- | --- |
| Enter | Send the line |
| Tab, Shift-Tab | Complete a command or a name; press again for the next match |
| Up, Down | Go back through lines you've sent |
| PgUp, PgDn | Scroll the feed, or a sheet you opened |
| Alt+1, Alt+2, Alt+3, Alt+4 | Show or hide the band, the map, the feed, or a reply you opened |
| Esc | Cancel a completion, close the mouse's menu, or close a message |
| Ctrl-A, Ctrl-E | Jump to the start or end of the line |
| Ctrl-W, Ctrl-U | Delete a word, or everything before the cursor |
| Ctrl-C, Ctrl-D on an empty line, or `/quit` | Leave the table |

Between the header and the input line are panels, top to bottom: the band (who's here, your party or the fight), the map, the feed, and a reply just for you, such as a sheet or `/help`. Each panel's title starts with its key as a small number, `¹` for the band to `⁴` for a reply, and Alt with that digit shows or hides it, like btop. Hidden panels give their rows to the others. If you hide them all, one line under the header says which keys bring them back (click one to show its panel), and `/view both` brings back every one. The choice is your seat's alone and lasts until you leave. A reply you hide waits on one line until Alt+4 shows it or Esc drops it, and the next reply you ask for opens again. The map and a reply take turns: showing one puts the other away. The GM's seat has a fifth panel, `⁵` GM prep, a column beside the map that Alt+5 or `/prep` opens: the GM's way to set up a game with the mouse (see [HOSTING.md](HOSTING.md#preparing-a-game)). On a player's seat Alt+5 says it's the GM's.

On a Mac, Option with a digit types a symbol (`¡`) unless the terminal sends Option as Alt: Terminal's "Use Option as Meta key", iTerm2's "Esc+" for Option, Ghostty's `macos-option-as-alt`. Some terminals take Alt and a digit to switch tabs (GNOME Terminal among them); there, change that shortcut in the terminal, or click a panel's title to hide it and its name on the hint row to show it.

Plain text is chat. Anything that starts with `/` is a command. `/help` lists them all, and `/help move` explains one. A bare `help`, `exit` or `quit` is answered first (did you mean `/help`?); press Enter again to say it to the table. When the table refuses a line, it says why and empties the input, so your next line starts clean; press Up to get the refused one back and fix it.

## The mouse

Click your hero's token on the map, or its row in the band, and a menu opens just above the hint row with what it can do: Move (or Place, while a map is loaded that it isn't on yet), each of its abilities, and End turn while it's its turn. At a set.world table the menu is Move, Attack, and Done on its turn. The GM can click any token; a creature's menu has its free strike too.

- **Move**, then click a square: the table sends `/move brann f5`.
- **Place**, for a token not on the loaded map yet, then click a square: `/place brann b5`.
- **An ability**, then click each target on the map or in the band (click one again to take it back), then **Roll**: `/pr brann Driving Blow on bandit-bruiser-1`. Roll with no target clicked uses the ability with none.
- **Free strike** or **Attack**, then click the target: `/fs bandit-chief brann`, `/attack ada grub`.
- **End turn** or **Done** sends `/done`.

A click sends exactly the line you could have typed, and Up shows it afterward, so the menu is a way to learn the commands too. What the table refuses typed it refuses clicked, with the same reason; the menu offers what your token has, not only what it can do this moment. Esc or Cancel closes the menu, and clicking anywhere else on the map closes it as well.

With no menu open, clicking any other token types its mark where the cursor is, and clicking a square types its name: type `/dist ` and click two things to get `/dist B c5`.

Click a panel's title to hide that panel, as Alt with its digit does. The panels you've hidden are listed at the end of the hint row (`· show ¹ band`); click one to show it again. The wheel scrolls the feed or a reply under the pointer, a few lines at a time, and PgUp and PgDn still move a page.

While the mouse is on, your terminal hands clicks to the table, so a plain drag doesn't select text. Hold Shift while you drag to select and copy as usual: Ghostty, kitty and WezTerm do this out of the box, and so do most terminals. `/mouse off` gives your terminal its mouse back, for your seat alone, `/mouse on` returns it to the table, and a bare `/mouse` switches it. The table asks your terminal for clicks, drags and the wheel only, never every movement of the pointer, so the mouse adds next to nothing to what goes over the network.

## What you'll type

Your GM brings heroes and monsters in, starts combat and runs the Director's side. You run your hero. You can only change your own hero, so the GM applies damage to monsters.

| Command | What it does |
| --- | --- |
| `hello all` | Say something (the same as `/say hello all`) |
| `/me draws her sword` | Act something out |
| `/roll 2d10+3` | Roll dice for everyone to see |
| `/play brann` | Play a hero the GM brought in. A unique start of a name is enough: `/play bra`. `/play` alone lists the heroes nobody plays |
| `/unplay` | Stop playing your hero, so someone else can take it |
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
| `/place brann b5` | Put your hero's token on the map (in combat, once) |
| `/move brann f5` | Move your token along the shortest path |
| `/move brann f5 main` | Move again, using your main action |
| `/dist brann bandit-chief` | Count the squares between two tokens or squares |
| `/push bandit-chief 2` | On your turn, push a creature away from your hero (also `/pull`, and `/slide … to <square>`) |
| `/undo`, `/redo` | Take back your latest change, or put it back |

### At a set.world table

Some campaigns play set.world's rules instead of Draw Steel; `/help` shows which commands your table has. The GM rolls fighters at [set.world](https://set.world) and gives them names, and you play one from the party.

| Command | What it does |
| --- | --- |
| `/play ada` | Play a party member nobody else plays, or one whose guest has left; `/unplay` lets it go |
| `/sheet ada` | Show a fighter's sheet: class, health, stamina, weapon, stats and gear |
| `/move ada c5` | Move on your fighter's turn, up to its speed |
| `/attack ada grub` | Attack once on your turn, if your weapon reaches |
| `/done` | End your turn; a turn without an attack is a rest |

There are no rounds: each fighter's turns come as often as its initiative says, so a quick fighter may act twice before a slow one acts once. The feed shows the clock with each turn. An attack costs 20 stamina, hit or miss, and stamina comes back with time, so a tired fighter rests. A sword reaches the next square, a long blade two, a bow or sling 10 squares, and a wand or staff 5 as magic.

### At a `pf2e` (ORC) table

Campaigns with `rules: pf2e` run open Remaster tactical combat under the ORC License (`docs/ORC-NOTICE.md`). You get three actions (`◆◆◇`) and one reaction (`↺`) per turn, four degrees of success (`crit` / `hit` / `miss` / `fumble`), and alternating 5/10/5/10 diagonal movement.

| Command | What it does |
| --- | --- |
| `/play ari` | Play a PC the GM brought in; `/unplay` lets it go |
| `/sheet ari` | Show a character or creature sheet: HP, AC, saves, Perception, skills, attacks and shield |
| `/move ari f5` | Stride (1 action) along the cheapest path, tracking 5/10/5/10 diagonal parity across Strides |
| `/strike ari gob [weapon]` | Strike (1 action) with automatic MAP (`0 / -5 / -10`, or `-4 / -8` agile), flanking, and crit doubling |
| `/check ari <skill\|perception\|save> [dc N]` | Roll a skill, Perception, or saving throw against an optional DC |
| `/shield ari` | Raise your shield (1 action, +2 circumstance bonus to AC until your next turn) |
| `/block ari` | Spend your reaction (`↺`) to Shield Block the hit you just took |
| `/delay`, `/join` | Defer your turn before acting, then re-enter initiative after another turn ends |
| `/reroll` | Spend a Hero Point to reroll your last d20 check |
| `/done` | End your turn (rolls persistent damage and DC 15 flat checks) |

See [docs/rulesets/pf2e.md](rulesets/pf2e.md) for the full command list.

### At a `freeform` table

Campaigns with `rules: freeform` give you the Campaign Stage, party strip, shared dice, and lightweight characters with custom stats, bounded resources, tags, and optional grid movement (`/pc`, `/stat`, `/tag`, `/check`, `/move`, `/next`). See [docs/rulesets/freeform.md](rulesets/freeform.md).

## Bring an agent

Once your SSH key is admitted at a table, you can connect Claude Code, Codex, Cursor, or T3 Code straight to your seat with zero install using `ssh -T <handle>/<table>@supervillain.sh -s mcp-1@supervillain.sh`. See [docs/AGENTS-SETUP.md](AGENTS-SETUP.md) for configs and copy-paste prompts.

## The map

Squares are written as a column letter and a row number, like `c5`. Columns run `a` to `z` from the left, then `aa`, `ab` and so on. Row 1 is the top row. The letters are along the top of the map and the numbers down its side.

On the map, `·` is floor, a solid block is wall and `~` is difficult terrain. Tokens are marks: a hero's is a capital letter (`B` for Brann), a creature's a small one from the last word of its name (`c` for the Bandit Chief), with a digit when two would share a letter (`b1`, `b2`). In combat the band at the top shows each token's mark beside its name. A mark works in commands wherever a name does, and it's case-sensitive: `/dist B b`. When you're about to move, the squares you can reach are tinted and marked `•`, or `≈` on difficult terrain. A move costs 1 a square, diagonals too, and difficult terrain or an enemy's square costs 1 more. In combat you move only on your own turn, up to your speed over the whole turn.

On a map bigger than your screen, the view follows whoever is acting. `/view f5` or `/view bandit-chief` centres it until the turn passes. `/view map` shows every panel and gives the map more room, `/view feed` shows every panel but the map, `/view both` shows them all sharing the screen, and `/view` (like Alt+2) switches the map on and off.

Out of a fight, a campaign the GM has put on the stage shows it in the map's place: the scene, with a boxed read-aloud, the people, handouts and items on the table, the trackers and the last few lines of the recap. The party sits in the band's place, one line each; click someone for their sheet. When a fight starts your seat shows the band and the map, and when it ends it goes back to the stage. `/view board` looks at the map instead, and `/view stage` at the stage, just for your seat, until the next fight starts or ends. `/codex` opens the codex there: everything the GM has shown the table, a click away from being read, with Esc to close it.

In a terminal that shows kitty graphics (Ghostty, kitty or WezTerm, not inside tmux), the map is drawn in MEKMODE's pixel pictures by default: each square bigger, each token a figure in its side's colour with its mark in the corner. Commands still take the same squares and marks; `/view text` switches to the text map, and `/view pictures` returns to pictures. Each move sends your seat a picture of about 5 to 10 kilobytes, against a couple for text, and on a HiDPI (Retina) screen, where the picture is painted at its finer pixels to stay sharp, about twice that; a change that leaves the map as it was sends none. Elsewhere the map stays text, since pictures there would come out as coloured blocks whose marks can't be read.

## Taking things back

`/undo` takes back your latest change within 30 seconds, even if someone else has done something since. Then `/redo` puts it back, if it was the table's latest change and nothing has changed since. The feed says what was undone.

- A change that rolled dice (a power roll, a save, a turn that rolled your resource) can only be undone by the GM, so nobody can roll again by undoing.
- If something that happened later depends on your change, the table refuses and says what to undo first.
- Chat, names, `/roll` and who plays which hero are never taken back.

The GM can undo anyone's latest change with `/undo <who>`.

## "widen your terminal"

The table needs at least 72 columns and 20 rows. On a smaller window it shows only the feed and the input line, and the hint row says which side is short: `widen your terminal to 72 columns · it is 71 wide`, or `make your terminal 72x20 · it is 60x16`. Make the window bigger or the font smaller, and the table comes back right away without reconnecting. 80x24 works, but a fight with a map is tight there: about 100x30 shows the whole band, more of the map and a longer feed.

## One command at a time

Anything you can type at the table also works as one command from your shell, without sitting down. `roll`, `dist`, `undo`, `redo`, `help` and `sheet` work without their slash; the rest need it, so chat that starts with "me" or "name" stays chat. A refusal comes back on stderr with exit status 1.

```sh
ssh -p 2222 first-fight@gm.example.net '/roll 2d10'
ssh -p 2222 first-fight@gm.example.net 'running late, start without me'
```
