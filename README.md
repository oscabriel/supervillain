# supervillain

A terminal-first virtual tabletop for Draw Steel. Players type `ssh <room>@<host>` and are sitting at a live table, with nothing to install and no account to make. The GM's machine is the authority: it runs the rules, draws every player's screen and keeps the campaign as a plain append-only log (`events.jsonl`) on the GM's disk.

What's in it: chat, names and dice; minimum Draw Steel (a party from hero sheets, monsters from stat blocks, combat with Stamina, conditions, power rolls and resources); a text map with movement and forced movement; undo; and a relay, so players can reach a GM's machine that has no open port. It's being rebuilt small and hasn't met a real table yet. `ASSESSMENT.md` is the plan.

## Install

**From source**, for now. You need [Bun](https://bun.sh). In a checkout, run `bun install`, then `bun supervillain …` from the repo root wherever this page says `supervillain …`.

**A binary you build.** `bun run release:build` writes one self-contained executable for this machine, `dist/supervillain-<os>-<arch>`, which needs nothing else installed: copy it to `/usr/local/bin/supervillain`. There is no release of the rebuild yet. The releases on GitHub (v0.1.0 to v0.2.0) are the archived build, with different files. Once a rebuild release is tagged, [docs/HOSTING.md](docs/HOSTING.md#install) has the download steps.

Players need only an OpenSSH client, which macOS, Linux and Windows 10 and later already have.

## Host in one minute

```sh
supervillain new ~/campaigns/ford --example
supervillain host ~/campaigns/ford
```

`new --example` copies the sample campaign: four level-1 heroes, the bandits and the map for one fight (`examples/campaign/README.md` has the file formats). `host` opens a campaign folder that `new` made, and refuses a path that isn't there or a folder with none of `events.jsonl`, `host_key`, `heroes/`, `monsters/` or `maps/`, so a typo can't start an empty table under a new host key. It prints the command players use and the table's host key, then opens the table in your terminal as the GM. While you sit alone, the band at the top of your seat shows the join command and the host key again, and the end of `/help` has them too. Ctrl-C or `/quit` closes it.

By default the table listens only on this machine (`127.0.0.1:2222`). To let others in:

- **Same network or Tailscale:** `supervillain host ~/campaigns/ford --bind 0.0.0.0`.
- **A tunnel:** bore or `ssh -R` through a VPS.
- **The relay:** run `supervillain relay` on a small VPS, and `supervillain host ~/campaigns/ford --relay table.example.com --relay-key SHA256:…` dials out to it. Your machine opens no port. Players type `ssh -p 2222 ford@table.example.com`, and their ssh sees the relay's host key, not your table's.

[docs/HOSTING.md](docs/HOSTING.md) walks through all three, the relay's service and firewall, and every flag.

## Join as a player

```sh
ssh -p 2222 ford@127.0.0.1                  # sit at the table
ssh -p 2222 ford@127.0.0.1 roll 2d10+3      # or run one command and leave
```

Your SSH key is who you are, so there's no account; a client with no key comes in as a guest. The first time, the table asks what to call you. Plain text is chat, `/` starts a command, Tab completes, `/help` lists everything, and Ctrl-C leaves. [docs/PLAYING.md](docs/PLAYING.md) is the page to send your players.

## More commands

```sh
supervillain check ~/campaigns/ford      # replay a log without opening it: summary, feed, final state
supervillain import ~/data-bestiary-json --into ~/campaigns/ford "Goblin Warrior"   # Steel Compendium monsters
supervillain relay --dir ~/relay         # a relay; `relay forget <room>` releases a room's claim
supervillain --help                      # every command and flag
```

`check` works while the host runs and exits 1 if the log has an event it can't apply. `import` reads a local copy of Steel Compendium's `data-bestiary-json` and writes monster files into the campaign's `monsters/`, never replacing one unless you pass `--overwrite`.

## Draw Steel quick reference

**Content.** Heroes are `heroes/<id>.yaml` and monsters `monsters/<id>.yaml` in the campaign folder; the file name is the id. The fields are listed in `examples/campaign/README.md`. The host reads a file when `/hero` or `/add` brings it in, so you can edit one mid-session and bring it in again. A file with a mistake is refused, naming the file and the field (`heroes/vex.yaml: characteristics.might must be a whole number from -5 to 5`); a file that loads is one the table accepts. Text may run over several lines in the file; the table reads it as one. The sheet goes into the log with the event, so replay never reads a file and a later edit can't change the past.

**Naming things.** Commands name a hero or creature by its id or name, its mark on the map (`B`, `b1`; see below), a unique start of an id or name (`bra` for Brann), or a unique start of any word in one (`chief` for `bandit-chief`, `bruiser-1` for `bandit-bruiser-1`). Abilities are named the same way (`smoke` for Strike From Smoke). Added creatures get ids such as `bandit-chief`, `bandit-bruiser-2` and, for a minion squad, `bandit-cutpurse-a`. Tab completes ids, abilities and conditions.

**Who can do what.** The GM (marked GM below) runs the creatures and can change anyone. A player claims a hero with `/play` and from then on is labelled with it, "Alice (Brann)"; a player changes only their own hero, and starts its turn only when it's the heroes' side to act. The one exception is forced movement, which a player's hero can do to anyone, as abilities do (see the map below).

| Party | |
|---|---|
| `/hero <id>` | GM. Bring a hero in from `heroes/<id>.yaml`, or reload its sheet |
| `/play <hero> [player]` | Play a hero; the GM names a player to give them one. `/play` alone lists the heroes free to play. A hero whose guest has left is free to take, since a guest is new every time they connect |
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
| `/rest` | GM. A respite: Stamina and Recoveries back to full, and Victories are added to each hero's XP (on `/sheet`) and reset to 0. The dead don't recover (the GM can `/heal` them) |

| Rolls and Stamina | |
|---|---|
| `/pr <who> <ability\|characteristic\|+N> [edge\|bane\|edge2\|bane2] [on <target>…]` | Power roll: 2d10 plus the bonus, with the tier, what it does (`8 + M (2) = 10 damage`) and the ability's effect. An ability's cost is spent with it, from the hero's resource or the Malice pool. `on chief b1` deals the tier's damage to each target, after weakness and immunity, and names a target past the ability's reach (`Melee 1`). An ability with no power roll (`/pr chief get`) is used: its cost is spent and its effect told. A bleeding creature, a dying hero among them, loses 1d6 + its level Stamina after a main action, a triggered action or a roll with Might or Agility |
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
| `/malice <+N\|-N> [reason]`, `/victory [hero] <+N\|-N>` | GM. Malice, saying what for; Victories for one hero or all the living |

The band above the feed shows the party outside combat, and in combat every combatant in turn order (the side that goes first leading) with a Stamina meter, winded, dying (with the Stamina at which they die) or dead in words, conditions (a dying hero is bleeding) and, for heroes, their resource, Recoveries and surges. The dead, heroes too, fold into one `dead:` line; a hero who dies loses their conditions. When the band is short of room, creatures' names shorten first, keeping their number or squad letter (`…Bruiser 1`), then heroes' Recoveries go (they're on `/sheet`), then each hero keeps one row, its last conditions or resource cut with `…` (the whole of it is on `/sheet`), then the `dead:` line goes. Beside the map, the map gives up its rows before a living enemy is hidden (`/view map` shows it whole), so at 80x24 the sample fight, four heroes beside the chief, two bruisers and two squads, shows every living combatant's Stamina with the feed's three rows. A creature's trait that starts at half Stamina is quoted in the feed when it gets there. Its title has the round, the side to act next, Malice, hero tokens and the living heroes' Victories.

**The map.** A map is a text file, `maps/<id>.txt` in the campaign folder, drawn one character per square: `.` floor, `#` wall, `~` difficult terrain and a space for outside the map, and nothing else, so no square looks like a token. An optional first line `name: The Ford Road` names it; otherwise the id is its name. The file name is the id, so it is lower-case letters, digits and hyphens, at most 40 (`Ford-Road.TXT` is `ford-road`; a file whose name can't be an id isn't a map, and is named when `/map` finds nothing). Rows may be short (the rest of the row is outside), and a map is at most 60 columns by 40 rows and 8 KB. The host reads the file when the GM types `/map <id>` (a unique start of the id is enough), so the GM can fix a map and load it again; a file with a mistake is refused, naming the file and, for a stray character, its line and column (`maps/ford.txt line 3, column 7 is a tab; …`). Like a sheet, the grid goes into the log with the event. The sample campaign has `maps/ford-road.txt`.

A square is its column letter and row number, as on the map's edges: `a1` is the top left, `c5` is the third column of the fifth row, and past `z` the columns go `aa`, `ab` (the map then labels its columns on two rows, the first letter over the second). Tokens are drawn with a mark: a hero's initial in capitals (`B`), and for a creature the initial of its name's last word in lower case, with its number or squad letter (`b2` for Bandit Bruiser 2, `cA` for Bandit Cutpurse A; past 9, its initial and a digit, `b0`), so a block keeps its mark from one fight to the next. The band shows each placed combatant's mark before its name, and commands take a mark as a name, case and all (`/dmg b1 3`; in `/dist` a placed token's mark wins over the square it spells). Your own hero is green, the acting creature is underlined, the dead show as `x` and stay where they fell, and the squares the acting creature can still reach this turn (or, outside its turn, where your hero could reach) are tinted, with a bigger dot, or `≈` on difficult terrain.

A map bigger than its pane follows the acting creature, else your own hero, else the spot where the most tokens can be seen at once. An edge row or column has arrows toward tokens past it only when there are some and room for it, the bottom border names everything out of view, and the title says which rows and columns show (`rows 2-6 of 10`). On a seat, `/view <square|who>` centres the map there (`/view k20`, `/view chief`) until the turn passes; `/view map` shows every panel and gives the map the room, folding the band to two lines; `/view feed` shows every panel but the map, `/view both` shows them all sharing the screen (and stops a `/view <square|who>`), and `/view` alone shows or hides the map; below 80x24 the map is hidden. Alt+1 to Alt+4 show or hide each panel for your seat alone (see [docs/PLAYING.md](docs/PLAYING.md)), and on the GM's seat Alt+5 or `/prep` opens the prep panel, which sets up a game with clicks that send the same commands (see [docs/HOSTING.md](docs/HOSTING.md#preparing-a-game)).

Movement follows Draw Steel's grid. Every step to an adjacent square costs 1, diagonals included, but not past the corner of a wall (the map's edge is no wall). Difficult terrain, and an enemy's square, cost 1 more to enter; allies can be passed through, but nobody ends a move on another living creature. Prone adds 1 per square; slowed makes speed 2, grabbed or restrained 0. `/move` takes the cheapest path. In combat a player moves their hero only on its turn, and that turn's moves add up to no more than its speed; `/move brann j7 main` spends the main action on moving too, for a second speed's worth (Combat, "Main Actions"). The GM moves anyone between turns, and the GM's moves of the acting creature count toward its turn but may go over it; the feed then says "over speed 5".

Forced movement goes the distance less the target's stability, and ignores difficult terrain. A push goes straight away from the source; a pull straight toward it, along whichever of the eight straight lines brings it closest, stopping beside it; a slide goes any way to the square you name. The source is the hero you play, or for the GM the acting creature; `from <who>` names another, and nobody force moves themselves (that's a `/move`). `to <square>` on an empty square picks how far along the line to go; `to` a wall or a creature, a pull's own source included, sends the target into it with everything it has left, as a slide to one does. A target that hits a wall takes 2 damage plus 1 for each square it had left; one that hits a creature takes 1 for each square left, and so does that creature. A diagonal past a wall's corner counts as hitting the wall. The map's edge just stops it, and the feed says so. Range isn't checked, since abilities reach differently, but when the source isn't adjacent the feed says how far it stood (`Kor is pushed 1 square to f1 (Vex is 4 squares away).`), and a free strike's line does the same. A restrained creature can't be force moved; who has a grabbed creature, and size, aren't tracked. `/end` takes the creatures' tokens off the map, and dead heroes'. A minion squad is one token on one square for now.

| Map | |
|---|---|
| `/map <id>\|off\|new crossing\|keep [seed]` | GM. Load `maps/<id>.txt`, put the map away, or generate one into `maps/` and load it |
| `/place <who> <square>` | Put a token on the map; a player places their own hero (in combat, once) |
| `/move <who> <square> [main]` | Move by the cheapest path; `main` spends the main action on moving too, so a bleeding mover bleeds |
| `/dist <who\|square> <who\|square>` | Count the squares between two tokens or squares, for the whole table; never undone |
| `/push <who> <n> [from <who>] [to <square>]`, `/pull …` | Push or pull, less stability |
| `/slide <who> <n> to <square> [from <who>]` | Slide, less stability |
| `/undo [who]`, `/redo` | Take back a change, or put back what the latest undo took |

**Undo.** `/undo` takes back a change to the game: everything one command did, such as a move with the damage its slam dealt. The GM's `/undo` takes back the latest change and can keep going back, up to the last 20; `/undo <who>` takes back that person's latest change. A player's `/undo` takes back their own latest change for 30 seconds, even with someone else's change after it, and after that asks the GM. Either way the changes after it stay, folded again onto the game as it is without it, and a change that depended on it (a push of a creature the undone move put there, even one that slammed it into a wall without moving it) is refused until that one is undone first. A change that rolled dice (a power roll, a save, a turn that rolled for its resource or its saves) is the GM's alone to take back, so nobody rolls again by undoing. `/redo` puts back what the latest undo took, from the log, so its dice are the same; a player redoes only their own undo, and any new change ends the redo. Chat, names, `/roll`, measurements and a player taking or giving up a hero are never taken back. Nothing leaves the log: the undo and the redo are events of their own, and the feed keeps the line taken back and adds one marked ↶ or ↷ (`↶ GM undid: Bandit Bruiser takes 5 damage → 15/20`).

**An example session.** The GM hosts the sample campaign; Alice and Bob join over SSH.

```text
GM     /hero brann
GM     /hero kesh
GM     /token reset          Hero tokens reset to 2, one per hero.
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
Alice  /pr brann driving on bandit-bruiser
                             Brann uses Driving Blow on Bandit Bruiser: [9, 5] +2 = 16 · tier 2 — 5 + M (2) = 7 damage; push 1
                             Bandit Bruiser takes 7 damage → 13/20
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
bun run build          # tsc -b
bun test               # from the repo root
bun run check          # oxlint and oxfmt
bun run release:build  # dist/supervillain-<os>-<arch> for this machine (--all for every platform)
bun run release:smoke dist/supervillain-linux-x64
```

`AGENTS.md` describes the layout and the rules for working in it.

## License

[MIT](LICENSE).

---

supervillain is an independent product published under the DRAW STEEL Creator License and is not affiliated with MCDM Productions, LLC. DRAW STEEL © 2026 MCDM Productions, LLC.
