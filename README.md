# supervillain

A terminal-first virtual tabletop for Draw Steel. Players type `ssh <room>@<host>` and are sitting at a live table, with nothing to install and no account to make. The GM's machine is the authority, and the campaign is a plain append-only log on the GM's disk.

It's being rebuilt small and runs from source for now: chat, names, dice, minimum Draw Steel (a party from hero sheets, monsters from stat blocks, combat with Stamina, conditions, power rolls and resources), a text map with movement and forced movement, and undo. `ASSESSMENT.md` is the plan. The previous build is at tag `archive/2026-09-exploration`.

## Run it

You need [Bun](https://bun.sh) and an OpenSSH client. Run these from the repo root after `bun install`.

**Start a campaign.** A campaign is a folder. `new` makes one with `heroes/` and `monsters/` for sheets and `maps/` for maps; `--example` copies the sample campaign instead (four level-1 heroes, the bandits and the map for one fight, see `examples/campaign/README.md`).

```sh
bun supervillain new ~/campaigns/ford --example
```

**Host a table.** The campaign folder is created if missing and defaults to `./campaign`.

```sh
bun supervillain host ~/campaigns/ford
```

The host prints the command players use and its host key fingerprint, then opens the table in your terminal as the GM; until someone joins, the join command stays in the band at the top (/help shows it too once the party fills the band). Ctrl-C (or `/quit`) leaves the table and shuts the host down. With players at the table, Ctrl-C asks you to press it again first, and each player is told "The GM closed the table." While your seat is open, host logs go to `<campaign>/host.log`.

| Flag | Default | What it does |
|---|---|---|
| `--port` | `2222` | SSH port for players |
| `--bind` | `127.0.0.1` | Address to listen on; `0.0.0.0` lets other machines in |
| `--room` | the folder's name | The room's name, shown in the header and in the join command |
| `--headless` | off | No GM seat: the host runs in the background of this terminal and logs to stdout |

The campaign folder holds `events.jsonl` (the log, one JSON event per line), `events.lock` (held while a host has the campaign open, so only one can), `host_key` and `host.log`. A new campaign folder is made readable by you alone, and the host refuses a `host_key` that other users can read (`chmod 600` it).

Players are capped so one stranger can't take the table down: 8 connections and 16 sessions from one address, 64 of each in all, 20 seconds to log in, and a few lines a second per player. A key is rated as itself wherever it connects from, and guests share one rate per address; keys cost nothing to make, so the connection caps are what bound a flood from one address. Through a tunnel every player arrives from the same address, so they share the per-address caps.

**Join as a player.**

```sh
ssh -p 2222 ford@127.0.0.1
```

Your SSH key is your identity, so there's no account. The first time, the table asks what to call you, and it remembers the name for your key. A name can't look like someone else's (case, lookalike letters from other scripts and invisible characters don't make it different), and can't hold the table's own markers, `(GM)` and `(you)`. Plain text is chat, `/` starts a command, Tab completes, Up and Down recall what you typed, PgUp and PgDn scroll, `/help` lists the commands, and Ctrl-C (or `/quit`) leaves. A refused line stays in the input for you to fix.

**Guests.** A client with no key gets in as a guest, with a new identity for each connection. A guest's name is held only while they're seated, so a guest who reconnects can take it back. To try it from a machine that has keys: `ssh -o PubkeyAuthentication=no -p 2222 ford@127.0.0.1`.

Recent OpenSSH clients warn that the session "may be vulnerable to store now, decrypt later attacks". The table's SSH library offers only elliptic-curve key exchange (curve25519 and the NIST curves), not the post-quantum hybrids that warning asks for; the session is still encrypted and the warning is expected.

**One command at a time.** Put an input line after the ssh command and the table runs it as you, prints the result and exits. A refusal goes to stderr with exit status 1. `roll`, `dist`, `undo`, `redo`, `help` and `sheet` work without their slash; commands that take free text (`/name`, `/me`, `/say`) need it, so chat that starts with "me" or "name" stays chat. With no command and no terminal (`ssh host </dev/null`), the table says to use `ssh -t` and exits.

```sh
ssh -p 2222 ford@127.0.0.1 roll 2d10+3
ssh -p 2222 ford@127.0.0.1 /name Vex
ssh -p 2222 ford@127.0.0.1 "hello everyone"
ssh -p 2222 ford@127.0.0.1 help
```

**Import monsters.** With a local copy of Steel Compendium's `data-bestiary-json`, `import` writes creatures into a campaign's `monsters/` as monster files. Name the creatures you want (exact name or id first, then a unique start of one), or none for all of them. It never replaces a file that's there unless you pass `--overwrite`, and it lists what it couldn't read. It exits 1 if any creature it found or you named wasn't imported (a JSON file it can't read is listed, not counted). A campaign folder it has to make is readable by you alone.

```sh
bun supervillain import ~/data-bestiary-json --into ~/campaigns/ford "Goblin Warrior" "Goblin Spinecleaver"
```

**Read a campaign.** `check` replays the log without opening it, so it works while the host runs. It prints a summary, the feed and the final state, and lists unknown events it skipped on stderr. It exits 1 if the log has an event it can't apply.

```sh
bun supervillain check ~/campaigns/ford
```

## Draw Steel at the table

**Content.** Heroes are `heroes/<id>.yaml` and monsters `monsters/<id>.yaml` in the campaign folder; the file name is the id. The fields are listed in `examples/campaign/README.md`. The host reads a file when `/hero` or `/add` brings it in, so you can edit one mid-session and bring it in again. A file with a mistake is refused, naming the file and the field (`heroes/vex.yaml: characteristics.might must be a whole number from -5 to 5`); a file that loads is one the table accepts. Text may run over several lines in the file; the table reads it as one. The sheet goes into the log with the event, so replay never reads a file and a later edit can't change the past.

**Naming things.** Commands name a hero or creature by its id or name, its mark on the map (`B`, `b1`; see below), a unique start of an id or name (`bra` for Brann), or a unique start of any word in one (`chief` for `bandit-chief`, `bruiser-1` for `bandit-bruiser-1`). Abilities are named the same way (`smoke` for Strike From Smoke). Added creatures get ids such as `bandit-chief`, `bandit-bruiser-2` and, for a minion squad, `bandit-cutpurse-a`. Tab completes ids, abilities and conditions.

**Who can do what.** The GM (marked GM below) runs the creatures and can change anyone. A player claims a hero with `/play` and from then on is labelled with it, "Alice (Brann)"; a player changes only their own hero, and starts its turn only when it's the heroes' side to act. The one exception is forced movement, which a player's hero can do to anyone, as abilities do (see the map below).

| Party | |
|---|---|
| `/hero <id>` | GM. Bring a hero in from `heroes/<id>.yaml`, or reload its sheet |
| `/play <hero> [player]` | Play a hero; the GM names a player to give them one |
| `/unplay [hero]` | Stop playing your hero; the GM frees any hero |
| `/sheet <who>` | A hero's or creature's sheet, shown to you alone |

| Encounter | |
|---|---|
| `/add <id> [xN] [as <name>]` | GM. Add creatures from `monsters/<id>.yaml`; minions form squads of up to 8 |
| `/start` | GM. Start combat: a d10 says who picks the first side; heroes gain their Victories as resource, the Director Malice |
| `/first heroes\|director` | GM. The side that goes first every round |
| `/turn [who]` | Start a turn (your hero's by default); the turn before ends |
| `/done` | End the current turn: EoT conditions end, each save-ends condition rolls a save |
| `/round` | GM. Start the next round now |
| `/end` | GM. End combat: creatures leave; heroic resources, surges and Malice are lost; temporary Stamina and every condition end |
| `/rest` | GM. A respite: Stamina and Recoveries back to full, Victories become XP and reset to 0. The dead don't recover (the GM can `/heal` them) |

| Rolls and Stamina | |
|---|---|
| `/pr <who> <ability\|characteristic\|+N> [edge\|bane\|edge2\|bane2]` | Power roll: 2d10 plus the bonus, with the tier and what it does (`8 + M (2) = 10 damage`). An ability's cost is spent with it, from the hero's resource or the Malice pool |
| `/save <who> [condition]` | A save (d10, 6+) against save-ends conditions |
| `/dmg <who> <n> [type]` | Damage, after immunity and weakness, temporary Stamina first |
| `/fs <creature> <target> [type] [xN]` | GM. A creature's free strike, of a damage type if named; `xN` minions of a squad strike together as one strike |
| `/heal <who> <n>`, `/temp <who> <n>` | Regain Stamina; gain temporary Stamina (the larger stays) |
| `/recover <hero> [ally]` | Spend a Recovery. A dying hero can't Catch Breath in combat, so needs `ally` there |
| `/cond <who> [-]<condition> [eot\|save\|end]` | Set a condition (to the end of the encounter unless `eot` or `save`), or remove it with `-` |

| Resources | |
|---|---|
| `/res <hero> <+N\|-N>`, `/surge <hero> <+N\|-N>` | Heroic resource (not below 0 unless the sheet sets `resource.min`); surges |
| `/token <+N\|-N\|reset>` | A player with a hero spends hero tokens; the GM adds them or resets to one per hero |
| `/malice <+N\|-N> [reason]`, `/victory [hero] <+N\|-N>` | GM. Malice, saying what for; Victories for one hero or all |

The band above the feed shows the party outside combat, and in combat every combatant in turn order (the side that goes first leading) with a Stamina meter, winded, dying (with the Stamina at which they die) or dead in words, conditions (a dying hero is bleeding) and, for heroes, their resource, Recoveries and surges. Dead creatures fold into one `dead:` line. When the band is short of room, creatures' names shorten first, keeping their number or squad letter (`…Bruiser 1`), before any hero loses a number. Its title has the round, the side to act next, Malice, hero tokens and Victories.

**The map.** A map is a text file, `maps/<id>.txt` in the campaign folder, drawn one character per square: `.` floor, `#` wall, `~` difficult terrain and a space for outside the map, and nothing else, so no square looks like a token. An optional first line `name: The Ford Road` names it; otherwise the id is its name. The file name is the id, so it is lower-case letters, digits and hyphens, at most 40 (`Ford-Road.TXT` is `ford-road`; a file whose name can't be an id isn't a map, and is named when `/map` finds nothing). Rows may be short (the rest of the row is outside), and a map is at most 60 columns by 40 rows and 8 KB. The host reads the file when the GM types `/map <id>` (a unique start of the id is enough), so the GM can fix a map and load it again; a file with a mistake is refused, naming the file and, for a stray character, its line and column (`maps/ford.txt line 3, column 7 is a tab; …`). Like a sheet, the grid goes into the log with the event. The sample campaign has `maps/ford-road.txt`.

A square is its column letter and row number, as on the map's edges: `a1` is the top left, `c5` is the third column of the fifth row, and past `z` the columns go `aa`, `ab` (the map then labels its columns on two rows, the first letter over the second). Tokens are drawn with a mark: a hero's initial in capitals (`B`), a creature's in lower case with its number or squad letter (`b2`, `bA`; past 9, its initial and a digit, `b0`). The band shows each placed combatant's mark before its name, and commands take a mark as a name, case and all (`/dmg b1 3`; in `/dist` a placed token's mark wins over the square it spells). Your own hero is green, the acting creature is underlined, the dead show as `x` and stay where they fell, and the squares the acting creature can still reach this turn (or, outside its turn, where your hero could reach) are tinted, with a bigger dot, or `≈` on difficult terrain.

A map bigger than its pane follows the acting creature, else your own hero, else the spot where the most tokens can be seen at once. An edge row or column has arrows toward tokens past it only when there are some and room for it, and the bottom border names everything out of view. On a seat, `/view <square|who>` centres the map there (`/view k20`, `/view chief`) until the turn passes; `/view map` gives the map the room, folding the band to two lines; `/view feed` hides it, `/view both` splits again (and stops a `/view <square|who>`), and `/view` alone shows or hides it; below 80x24 the map is hidden.

Movement follows Draw Steel's grid. Every step to an adjacent square costs 1, diagonals included, but not past the corner of a wall (the map's edge is no wall). Difficult terrain, and an enemy's square, cost 1 more to enter; allies can be passed through, but nobody ends a move on another living creature. Prone adds 1 per square; slowed makes speed 2, grabbed or restrained 0. `/move` takes the cheapest path. In combat a player moves their hero only on its turn, and that turn's moves add up to no more than its speed; `/move brann j7 main` spends the main action on moving too, for a second speed's worth (Combat, "Main Actions"). The GM moves anyone between turns, and the GM's moves of the acting creature count toward its turn but may go over it; the feed then says "over speed 5".

Forced movement goes the distance less the target's stability, and ignores difficult terrain. A push goes straight away from the source; a pull straight toward it, along whichever of the eight straight lines brings it closest, stopping beside it; a slide goes any way to the square you name. The source is the hero you play, or for the GM the acting creature; `from <who>` names another, and nobody force moves themselves (that's a `/move`). `to <square>` on an empty square picks how far along the line to go; `to` a wall or a creature, a pull's own source included, sends the target into it with everything it has left, as a slide to one does. A target that hits a wall takes 2 damage plus 1 for each square it had left; one that hits a creature takes 1 for each square left, and so does that creature. A diagonal past a wall's corner counts as hitting the wall. The map's edge just stops it, and the feed says so. Range isn't checked, since abilities reach differently, but when the source isn't adjacent the feed says how far it stood (`Kor is pushed 1 square to f1 (Vex is 4 squares away).`), and a free strike's line does the same. A restrained creature can't be force moved; who has a grabbed creature, and size, aren't tracked. `/end` takes the creatures' tokens off the map, and dead heroes'. A minion squad is one token on one square for now.

| Map | |
|---|---|
| `/map <id>\|off` | GM. Load `maps/<id>.txt`, or put the map away |
| `/place <who> <square>` | Put a token on the map; a player places their own hero (in combat, once) |
| `/move <who> <square> [main]` | Move by the cheapest path; `main` spends the main action on moving too |
| `/dist <who\|square> <who\|square>` | Count the squares between two tokens or squares, for the whole table; never undone |
| `/push <who> <n> [from <who>] [to <square>]`, `/pull …` | Push or pull, less stability |
| `/slide <who> <n> to <square> [from <who>]` | Slide, less stability |
| `/undo [who]`, `/redo` | Take back a change, or put back what the latest undo took |

**Undo.** `/undo` takes back a change to the game: everything one command did, such as a move with the damage its slam dealt. The GM's `/undo` takes back the latest change and can keep going back, up to the last 20; `/undo <who>` takes back that person's latest change. A player's `/undo` takes back their own latest change for 30 seconds, even with someone else's change after it, and after that asks the GM. Either way the changes after it stay, folded again onto the game as it is without it, and a change that depended on it (a push of a creature the undone move put there) is refused until that one is undone first. A change that rolled dice (a power roll, a save, a turn that rolled for its resource or its saves) is the GM's alone to take back, so nobody rolls again by undoing. `/redo` puts back what the latest undo took, from the log, so its dice are the same; a player redoes only their own undo, and any new change ends the redo. Chat, names, `/roll`, measurements and a player taking or giving up a hero are never taken back. Nothing leaves the log: the undo and the redo are events of their own, and the feed keeps the line taken back and adds one marked ↶ or ↷ (`↶ GM undid: Bandit Bruiser takes 5 damage → 15/20`).

**An example session.** The GM hosts the sample campaign; Alice and Bob join over SSH.

```text
GM     /hero brann
GM     /hero kesh
Alice  /play brann           Alice takes Brann.
Bob    /play kesh            Bob takes Kesh.
GM     /map ford             The map is The Ford Road, 20 by 10.
GM     /add bandit-bruiser
GM     /add bandit-chief
Alice  /place brann b5       Brann is placed at b5.
Bob    /place kesh b7        Kesh is placed at b7.
GM     /place bandit-bruiser h5
GM     /place bandit-chief p5
GM     /start                Combat begins, round 1. d10: 7, so the players pick who goes first …
GM     /first heroes
Alice  /turn                 Brann's turn. wrath +2 → 2.
Alice  /move brann k5        Refused: Brann can't move that far: k5 takes 9 squares of movement, and Brann's speed is 5.
Alice  /move brann f5        Brann moves to f5 (4 squares of movement).
Alice  /undo                 ↶ Alice (Brann) undid: Brann moves to f5 (4 squares of movement).
Alice  /move brann g5        Brann moves to g5 (5 squares of movement).
Alice  /pr brann driving     Brann uses Driving Blow: [9, 5] +2 = 16 · tier 2 — 5 + M (2) = 7 damage; push 1
GM     /dmg bandit-bruiser 7 Bandit Bruiser takes 7 damage → 13/20
Alice  /push bandit-bruiser 1
                             Bandit Bruiser is pushed but doesn't move (push 1, stability 2).
Alice  /dist brann bandit-bruiser
                             Alice (Brann) measures Brann (g5) to Bandit Bruiser (h5): 1 square.
Alice  /done                 Brann's turn ends.
GM     /turn bandit-chief
GM     /move bandit-chief k5 Bandit Chief moves to k5 (7 squares of movement, over speed 5).
GM     /undo                 ↶ GM undid: Bandit Chief moves to k5 (7 squares of movement, over speed 5).
GM     /move bandit-chief n5 Bandit Chief moves to n5 (2 squares of movement).
GM     /done
Bob    /turn                 Kesh's turn. ferocity +2 (1d3: 2) → 2.
…
GM     /end                  Combat ends. Heroic resources, surges and Malice are lost; …
```

Every command works one at a time over exec too, with its slash: `ssh -p 2222 ford@127.0.0.1 "/sheet brann"`.

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
