# Sample campaign: a fight at the ford

A ready-to-play campaign folder for trying supervillain: four level-1 heroes, the bandits for one encounter and the map to fight it on. **Everything here is a sample for testing.** The numbers are plausible for level 1 and the ability text is a short paraphrase. None of it is copied from the books, so check it against _Draw Steel: Heroes_ and _Draw Steel: Monsters_ before real play.

## Hosting it

The host writes into the campaign folder: the log (`events.jsonl`), the host key and `host.log`. Make a copy first, so this one stays clean:

```sh
supervillain new ~/campaigns/first-fight --example
supervillain host ~/campaigns/first-fight
```

From a checkout of the source, run `bun supervillain …` from its root instead.

Players join with the `ssh` command the host prints. The table's Draw Steel commands (see `/help`) bring a hero or monster in by its id, the file name without `.yaml`. A unique start of the id is enough: `bra` for `brann`.

## What it plays

`campaign.yaml` at the root says what a campaign plays: `rules: draw-steel` here. The other choice is `rules: set-world`, set.world's characters and fight (see the hosts' guide), which `supervillain new <folder> --rules set-world` makes; this sample is Draw Steel only. A campaign without the file plays Draw Steel.

## What's in it

| Hero | Class | Resource |
| --- | --- | --- |
| `brann` | Censor | wrath, 2 a turn |
| `kesh` | Fury | ferocity, 1d3 a turn |
| `wren` | Shadow | insight, 1d3 a turn |
| `ilsa` | Tactician | focus, 2 a turn |

| Monster | Organization | EV |
| --- | --- | --- |
| `bandit-cutpurse` | minion harrier | 3 for four minions |
| `bandit-slinger` | minion artillery | 3 for four minions |
| `bandit-bruiser` | platoon brute | 3 |
| `bandit-chief` | leader | 12 |

A suggested fight: the chief, two bruisers, four cutpurses and four slingers (24 EV in all).

The map is `maps/ford-road.txt`, The Ford Road, 20 columns (a to t) by 10 rows. The road runs east to west along rows 5 and 6 and crosses a shallow ford, columns l and m, which is difficult terrain from row 2 to row 9. North of the road stands a ruined wall (b2 to h4) with gaps to fight through; rubble (difficult) lies at e7, d8 and e8, brush (difficult) at p3 to q4, and a broken wall at q7 to s8 east of the ford. A good start: the heroes in the west around b5 to b7, the bandits east of the ford around o5 to p7.

```text
     a b c d e f g h i j k l m n o p q r s t
   1     . . . . . . . . . . . . . . . .
   2 . # # . # # # . . . . ~ ~ . . . . . . .
   3 . # . . . . . # . . . ~ ~ . . ~ ~ . . .
   4 . . . . . . . # . . . ~ ~ . . ~ ~ . . .
   5 . . . . . . . . . . . ~ ~ . . . . . . .
   6 . . . . . . . . . . . ~ ~ . . . . . . .
   7 . . . . ~ . . . . . . ~ ~ . . . # . # .
   8 . . . ~ ~ . . . . . . ~ ~ . . . # . . .
   9 . . . . . . . . . . . ~ ~ . . . . . . .
  10     . . . . . . . . . . . . . . . .
```

## Writing your own

One YAML file per hero in `heroes/<id>.yaml` and one per monster in `monsters/<id>.yaml`. The file name is the id. The host reads a file each time a hero or monster is brought in, so you can edit one mid-session and bring it in again. A mistake is reported with the file and the field, for example `heroes/vex.yaml: characteristics.might must be a whole number from -5 to 5`. In those messages `abilities[2]` means the second ability.

Hero fields:

| Field | What goes in it |
| --- | --- |
| `name`, `class` | Text |
| `level` | 1 to 10 |
| `characteristics` | `{ might: 2, agility: 1, reason: 0, intuition: 0, presence: -1 }`, each from -5 to 5 |
| `stamina`, `recoveries`, `speed` | Whole numbers |
| `recoveryValue` | Optional: a third of `stamina` rounded down if left out |
| `stability` | Optional, 0 if left out |
| `resource` | `{ name: wrath, perTurn: 2 }`, where `perTurn` is a number or dice such as `1d3`. Add `min: -3` for a class that may spend below 0 (a Talent's clarity goes to -(1 + Reason)) |
| `victories` | Optional, 0 if left out |
| `immunities`, `weaknesses` | Optional damage types with numbers: `{ fire: 5 }`. `all` matches every type |
| `abilities` | A list, below |

Monster fields: `name`, `level`, `organization` (minion, horde, platoon, elite, leader or solo), an optional `role`, an optional `ev`, `stamina` (for a minion, one minion's), `speed`, `stability` (optional, 0 if left out), `freeStrike`, `characteristics`, `immunities`, `weaknesses`, an optional `withCaptain` and `abilities`.

A text field may run over several lines (a folded `>` or literal `|` block); the table reads it as one line. Names are one line of up to 40 characters.

If you edit a monster file mid-fight and `/add` it again, creatures already in the fight take its new abilities and modifiers, but a squad keeps the Stamina per minion it was added with.

Ability fields: `name`, then any of `kind` (main action, maneuver…), `characteristics` (a hero's: `might` or `[might, agility]`), `bonus` (a monster's flat roll bonus), `cost` (spent when the ability is rolled: the hero's resource or the Director's Malice), `keywords` (`Melee, Strike, Weapon`), `distance`, `target`, `tier1`, `tier2`, `tier3` and `effect`. A tier's damage written as `5 + M damage` or `5 + M or A damage` (the best of them) is what `/pr … on` deals; damage with dice in it is left to the table.

## Drawing your own map

One text file per map in `maps/<id>.txt`; the file name is the id, in lower-case letters, digits and hyphens, at most 40. An optional first line `name: <name>` names the map (up to 40 characters); otherwise the id is its name. Then each line is a row of squares, top to bottom, one character per square:

| Character | Square |
| --- | --- |
| `.` | Floor |
| `#` | Wall: nobody stands there or moves through it |
| `~` | Difficult terrain: costs 1 more to enter |
| space | Outside the map, like the end of a short row |

No other character may be a square, so nothing on the map looks like a token; the name line may hold any plain ASCII. A map is at most 60 columns by 40 rows, and the file at most 8 KB. The host reads the file each time the GM types `/map <id>`, so you can fix a map and load it again; tokens already placed are lost when a new map loads. A mistake is reported with the file and, for a stray character, its line and column: `maps/ford.txt line 3, column 7 is "B" (U+0042); draw maps with . floor, # wall, ~ difficult terrain and space for outside.`

## Maps in MEKMODE letters

A map can also be drawn in the letters of MEKMODE's Ding Mode, MEK.txt's pixel font, so a seat that shows pictures (see `/view pictures` in the players' guide) draws each square as its own picture: grass, a conifer, brick, an archway, rapids. Put a line `style: mekmode` under the name line (or first), then write each row in these letters. The rules see only floor, wall and difficult terrain; the text map draws those as it always does.

| Letters | Floor | Wall | Difficult |
| --- | --- | --- | --- |
| Ground and plants | `q` `Q` bare ground, `e` hillocks, `y` a field, `u` grass, `w` low scrub | `T` rock outcrop | `W` thick scrub, `U` tall grass and reeds, `E` rough mounds, `r` scree, `R` rubble, `t` boulders |
| Trees | | `i` broadleaf, `o` conifer, `p` trees, `P` deep wood, `Y` cypress | `I` sapling, `O` young conifer |
| Built | `a` cobbled road, `A` flagstones, `d` archway | `s` brick, `S` planks, `f` roof, `g` doorway front, `G` `h` `H` houses, `j` hut, `D` colonnade, `J` statue, `k` pillar, `K` obelisk, `l` twin columns, `n` window, `N` shut door, `m` fence, `B` iron grate | `L` fallen column, `M` stairs |
| Water and floors | `c` `C` dirt and packed floors, `v` tiled floor, `V` mosaic, `b` chequered floor | | `z` shallow water, `Z` water, `x` rapids, `X` deep water, `F` still water |

A space is outside the map. MEK groups the Ding Mode letters by keyboard row (nature on `q` to `p`, structures on `a` to `l`, shapes on `z` to `m`); what each one depicts within its row is this table's reading. A mekmode map has the same limits as any other, and a stray character is named the same way: `maps/ruin.txt line 3, column 2 is "." (U+002E); a mekmode map is drawn in Ding Mode letters`.

`supervillain map` writes one for you, from a seed:

```sh
supervillain map crossing ~/campaigns/first-fight --seed 7
supervillain map keep ~/campaigns/first-fight
```

A `crossing` is a river the road fords, with reeds, woods, boulders and a ruin; a `keep` is a curtain wall with towers, a gate west, a breach east, a roofed hall, a well and a statue. The same kind and seed always make the same map, every map can be crossed from west to east, and the outer three columns are room for each side to start. It writes `maps/<kind>-<seed>.txt` (or `--id`), never over a map that's there, prints it with where each side can start, and says how to load it: `/map keep-7`. At the table, `/map new keep 7` (or the prep panel's + keep) writes the same file and loads it at once; leave the seed out and the host picks one. Edit the file as you like afterwards.

## Importing monsters from Steel Compendium

If you have a local copy of Steel Compendium's `data-bestiary-json`, the import command turns its creatures into monster files:

```sh
supervillain import ~/data-bestiary-json --into ~/campaigns/first-fight "Goblin Warrior"
```

It looks for a creature's exact name or id first, then a unique start of one. It never overwrites a file that's already there unless you pass `--overwrite`. Anything it can't read is left out, listed in the file's header comments and reported when the import finishes. Their data stays on your disk: supervillain doesn't bundle it.
