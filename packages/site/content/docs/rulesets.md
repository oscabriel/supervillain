---
title: Rulesets
summary: A campaign plays one ruleset. Draw Steel is the default, and set.world and PF2e Remaster under the ORC licence are playable beside it on the same log.
order: 3
---

A campaign plays one ruleset, named in `campaign.yaml` at its root:

```yaml
rules: draw-steel
```

`supervillain new` writes it (`draw-steel` unless you pass `--rules set-world` or `--rules pf2e`), and a campaign without one plays Draw Steel. The host reads it when it starts and refuses a ruleset it doesn't know, naming the file.

The ruleset decides which commands the table offers (`/help` and Tab show only those) and what the band, the map and `/sheet` show. Chat, names, dice and `/undo` work the same at every table. Every ruleset's rules are always loaded, so one program replays any campaign's log.

| Ruleset | `rules:` | State |
| --- | --- | --- |
| Draw Steel | `draw-steel` | Playable |
| set.world | `set-world` | Playable |
| PF2e Remaster (ORC) | `pf2e` | Playable |

## Draw Steel

[Draw Steel](https://mcdmproductions.com) is MCDM's tactical fantasy game, and supervillain's default ruleset:

- **A party from hero sheets.** Each hero is a YAML file in `heroes/`. The host reads it when the GM brings the hero in with `/hero`, and the whole sheet goes into the log with the event, so a later edit can't change the past.
- **Monsters from stat blocks.** `/add bandit-bruiser x2` brings creatures in from `monsters/`; minions form squads. `supervillain import` reads Steel Compendium's bestiary data into that folder, including size and `immunity all`.
- **Combat and turn budgets.** `/start` rolls for who picks the first side; heroes gain their Victories as resource, the Director Malice. Turns track main, maneuver, move and triggered actions (plus dazed limits and a natural 19-20 extra main action), and `/done` ends a turn, rolling saves for save-ends conditions.
- **Power rolls and conditions.** `/pr brann driving on b1` rolls 2d10 plus the characteristic, applies automatic edges and banes from conditions (taunted, grabbed, frightened, restrained, prone, weakened), deals tier damage after weakness and immunity, and spends the ability's cost. Grabs track who holds whom and clear automatically if the holder falls.
- **Stamina, resources and multi-square footprints.** Winded, dying and dead in words, temporary Stamina, Recoveries, heroic resources, surges, hero tokens, Malice, and footprints from tiny through 4x4 on the tactical grid with forced movement and slam damage.

supervillain is an independent product published under the DRAW STEEL Creator License and is not affiliated with MCDM Productions, LLC. DRAW STEEL © 2024 MCDM Productions, LLC.

## set.world

[set.world](https://set.world) rolls characters from a seed over its free API: a class with its flavour, a weapon, nine stats, the attributes the fight reads, and named gear. A set.world campaign has no sheets to write.

| Command | What it does |
| --- | --- |
| `/recruit Ada 101`, `/foe Grub 501` | Roll a party member or a foe at set.world, by seed or at random |
| `/map ford-road`, `/place ada b5` | Load a map and put fighters on it; the map is optional |
| `/start`, `/end` | Start the fight, or end it early |
| `/move ada c5`, `/attack ada grub`, `/done` | Act on a fighter's turn |
| `/auto foes [on\|off]` | Let the host drive foes automatically on their turns |

The fight follows Set's turn-based rules. There are no rounds: each fighter acts every `1000 / initiative` milliseconds of a logical clock, so a quick fighter may act twice before a slow one acts once. An attack costs 20 stamina, hit or miss, and stamina comes back with time. A hit is a dodge draw, a critical draw doubles it, and damage is reduced by the target's resistances. Set's own fights have no positions, so the grid is the table's: a sword reaches the next square, a long blade two, a bow or sling 10, and a wand or staff 5.

The host fetches each roll once, when the GM asks for it, and the roll goes into the log. Replay never asks set.world again. Turn on `/auto foes on` for brisk solo or quick-play fights; it pauses on `/undo` so it never fights a rollback.

## PF2e Remaster (ORC)

A third ruleset (`rules: pf2e`) implements open Remaster tactical rules published under the [ORC licence](https://paizo.com/orclicense), using neutral mechanics and zero Reserved Material:

```sh
supervillain new ~/campaigns/delve --rules pf2e
supervillain import pathbuilder ~/Downloads/ari.json ~/campaigns/delve
supervillain host ~/campaigns/delve
```

- **Three actions and a reaction (`◆◆◇ ↺`).** Strikes track Multiple Attack Penalty automatically (`0 / -5 / -10`, or `-4 / -8` agile, flurry, sweep), flanking applies off-guard in melee, and Shield Raise (`/shield`) and Shield Block (`/block`) use your reaction against the hit you just took.
- **Four degrees of success.** Every d20 roll checks critical success (+10), success, failure, and critical failure (-10), with natural 20 and natural 1 shifting the degree by one step. Typed status, circumstance and item bonuses stack properly.
- **Explicit initiative and alternating diagonals.** `/start` rolls Perception (or a chosen skill) into explicit turn order, with `/delay` and `/join` and knockout initiative shifts. Strides track 5/10/5/10 diagonal parity across moves on the same turn, with 10-foot diagonal reach, Large 2x2 footprints, and Tiny sharing.
- **Dying, Hero Points and encounter prep.** Dying, wounded, doomed and flat recovery checks, persistent damage with DC 15 flat checks, Hero Point `/reroll` and Heroic Recovery, Elite and Weak creature templates, and encounter XP threat ratings.

## Why one log can hold any of them

Each ruleset is a module of pure rules: `decide(state, actor, command, dice)` returns events or a refusal, and `apply(state, event)` folds one event. Two rulesets may type a command the same way (`/move` works in Draw Steel, set.world and `pf2e`) because the events they write carry distinct namespaced types (`ds.*`, `set.*`, `pf.*`). Since every module is always composed into the table's rules, replaying a log never needs to know in advance which game it holds. [How it fits together](/docs/architecture) has the rest.
