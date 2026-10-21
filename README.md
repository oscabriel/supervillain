# supervillain

A terminal-first virtual tabletop for Draw Steel. Players type `ssh <room>@<host>` and are sitting at a live table, with nothing to install and no account to make. The GM's machine is the authority, and the campaign is a plain append-only log on the GM's disk.

It's being rebuilt small and runs from source for now: chat, names, dice and minimum Draw Steel (a party from hero sheets, monsters from stat blocks, combat with Stamina, conditions, power rolls and resources). `ASSESSMENT.md` is the plan. The previous build is at tag `archive/2026-09-exploration`.

## Run it

You need [Bun](https://bun.sh) and an OpenSSH client. Run these from the repo root after `bun install`.

**Start a campaign.** A campaign is a folder. `new` makes one with `heroes/` and `monsters/` for sheets; `--example` copies the sample campaign instead (four level-1 heroes and the bandits for one fight, see `examples/campaign/README.md`).

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

**One command at a time.** Put an input line after the ssh command and the table runs it as you, prints the result and exits. A refusal goes to stderr with exit status 1. `roll`, `help` and `sheet` work without their slash; commands that take free text (`/name`, `/me`, `/say`) need it, so chat that starts with "me" or "name" stays chat. With no command and no terminal (`ssh host </dev/null`), the table says to use `ssh -t` and exits.

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

**Naming things.** Commands name a hero or creature by its id or name, a unique start of either (`bra` for Brann), or a unique start of any word in one (`chief` for `bandit-chief`, `bruiser-1` for `bandit-bruiser-1`). Abilities are named the same way (`smoke` for Strike From Smoke). Added creatures get ids such as `bandit-chief`, `bandit-bruiser-2` and, for a minion squad, `bandit-cutpurse-a`. Tab completes ids, abilities and conditions.

**Who can do what.** The GM (marked GM below) runs the creatures and can change anyone. A player claims a hero with `/play` and from then on is labelled with it, "Alice (Brann)"; a player changes only their own hero, and starts its turn only when it's the heroes' side to act.

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

**An example session.** The GM hosts the sample campaign; Alice and Bob join over SSH.

```text
GM     /hero brann
GM     /hero kesh
Alice  /play brann           Alice takes Brann.
Bob    /play kesh            Bob takes Kesh.
GM     /add bandit-cutpurse x4
GM     /add bandit-chief
GM     /start                Combat begins, round 1. d10: 7, so the players pick who goes first …
GM     /first heroes
Alice  /turn                 Brann's turn. wrath +2 → 2.
Alice  /pr brann driving     Brann uses Driving Blow: [9, 2] +2 = 13 · tier 2 — 5 + M damage; push 1
GM     /dmg bandit-cutpurse-a 7
                             Bandit Cutpurse A takes 7 damage → 13/20 · 1 minion dies, 3 left
Alice  /cond brann slowed save
Alice  /done                 Brann's turn ends. Save against slowed: 6, it ends.
GM     /turn bandit-chief
GM     /fs bandit-chief kesh Bandit Chief free strikes: Kesh takes 4 damage → 20/24
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
