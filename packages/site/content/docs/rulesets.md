---
title: Rulesets
summary: A campaign plays one ruleset: Draw Steel, set.world, PF2e Remaster under the ORC licence, or a lightweight freeform table, all sharing one log and campaign stage.
order: 3
---

A campaign plays one ruleset, declared in `table.md` frontmatter (or legacy `campaign.yaml`):

```yaml
---
title: The Ford Road
rules: draw-steel
---
```

`supervillain new` writes it (`draw-steel` unless you pass `--rules set-world`, `--rules pf2e`, or `--rules freeform`), and a campaign without one defaults to Draw Steel. Naming `rules:` in both `table.md` and `campaign.yaml` is rejected so there is never ambiguity.

The ruleset chooses which combat commands, character sheets and tactical views the table offers. Chat, names, dice, knock-to-join membership, the Campaign Stage, `/codex` and `/undo` work identically at every table. Every ruleset is always compiled into the engine, so one binary replays any campaign log.

| Ruleset | `rules:` | Best for |
| --- | --- | --- |
| Draw Steel | `draw-steel` | Tactical heroic fantasy (default) |
| set.world | `set-world` | Seeded continuous-clock skirmishes with optional auto-foes |
| PF2e Remaster (ORC) | `pf2e` | Three-action d20 tactical encounters under the ORC licence |
| Freeform | `freeform` | Narrative play, custom systems, or light grid tracking |

## Draw Steel

[Draw Steel](https://mcdmproductions.com) is MCDM's tactical fantasy game and supervillain's default ruleset:

- **Typed Markdown or YAML sheets.** Put heroes in `party/*.md` (or `heroes/*.yaml`), monsters in `monsters/*.md` (or `monsters/*.yaml`), and reusable abilities, items, ancestries and classes in their own folders. `supervillain import` converts Steel Compendium bestiary JSON into validated stat blocks.
- **Combat and turn budgets.** `/start` rolls for first side; heroes gain Victories as starting heroic resource and the Director gains Malice. Turns track main action, maneuver, move and triggered action (including dazed limits and natural 19-20 extra main actions), and `/done` rolls saves for save-ends conditions.
- **Power rolls and conditions.** `/pr brann driving on b1` rolls 2d10 plus characteristic, applies automatic edges and banes from active conditions (taunted, grabbed, frightened, restrained, prone, weakened), deals tier damage after weakness and immunity, and spends the ability's cost.
- **Footprints and forced movement.** Stamina, winded/dying/dead states, Recoveries, Respite, minion squads, 1x1 to 4x4 footprints, and push/pull/slide with wall and creature slam damage.

supervillain is an independent product published under the DRAW STEEL Creator License and is not affiliated with MCDM Productions, LLC. DRAW STEEL © 2024 MCDM Productions, LLC.

## set.world

[set.world](https://set.world) rolls fighters from a seed over its free API: class, weapon, stats, combat attributes and named gear. A `set-world` campaign needs no stat sheets, only maps and optional campaign stage Markdown.

| Command | What it does |
| --- | --- |
| `/recruit Ada 101`, `/foe Grub 501` | Roll a party member or foe from set.world, by seed or random |
| `/map ford-road`, `/place ada b5` | Load a map and place fighters |
| `/start`, `/end` | Start or end the fight |
| `/move ada c5`, `/attack ada grub`, `/done` | Act on a fighter's turn |
| `/auto foes [on\|off]` | Let the host run enemy turns automatically |

Fights follow set.world's continuous logical clock (`1000 / initiative` ms per turn, 10 stamina recovered per logical second, 20 stamina per attack) with grid reach based on weapon delivery. Every API roll is recorded in `events.jsonl` once, so replay never hits the network.

## PF2e Remaster (ORC)

`rules: pf2e` implements open Remaster tactical rules published under the [ORC licence](https://paizo.com/orclicense), using open mechanics and zero Reserved Material:

```sh
supervillain new ~/supervillain/delve --rules pf2e
supervillain import pathbuilder ~/Downloads/ari.json ~/supervillain/delve
supervillain host ~/supervillain/delve
```

- **Three actions and a reaction (`◆◆◆ ↺`).** Strikes track Multiple Attack Penalty automatically (`0 / -5 / -10`, agile `-4 / -8`, flurry, sweep), melee flanking applies off-guard, and `/shield` + `/block` resolve Shield Block cleanly against the last hit.
- **Four degrees of success.** Every d20 check resolves critical success (+10), success, failure, and critical failure (-10) with natural 20/1 shifts and typed status, circumstance and item bonus/penalty stacking.
- **Initiative and 5-ft grid.** Explicit turn order with `/delay`, `/join` and knockout initiative shifts; alternating 5/10/5/10 diagonal parity across Strides; 10-foot reach exception; Tiny sharing through Gargantuan 4x4 footprints.
- **Dying, Hero Points and prep.** Dying, wounded, doomed and flat recovery checks, persistent damage with DC 15 flat checks, Hero Point `/reroll` and Heroic Recovery, Elite/Weak templates, and encounter XP threat ratings.

## Freeform

`rules: freeform` is a lightweight, system-agnostic ruleset built for narrative games, rules-light RPGs, or homebrew systems where you want the Campaign Stage, party strip, shared dice and optional grid tokens without heavy combat math:

```sh
supervillain new ~/supervillain/story --rules freeform
```

Put characters in `party/*.md` and NPCs or threats in `monsters/*.md` with arbitrary named stats, bounded resources (like HP, Stress or Luck), tags, and a default check dice formula (`2d6`, `d20`, `2d10`).

| Command | What it does |
| --- | --- |
| `/pc wren`, `/add 2 guard` | Bring party members or figures into play |
| `/play wren`, `/unplay` | Claim or release a character |
| `/stat wren grit +1`, `/stat wren hp =8` | Adjust or set any stat or resource |
| `/tag wren +winded`, `/tag wren -winded` | Add or remove status tags |
| `/check grit`, `/check wits 2d10` | Roll a stat check using the sheet's default dice or an override |
| `/map`, `/place`, `/move`, `/remove` | Optional tactical grid positioning with no rigid step-cost math |
| `/start [ids...]`, `/next`, `/end` | Lightweight turn spotlight order |

## Why one log holds every ruleset

Each ruleset is a pure module of `decide` and `apply` functions whose events live in distinct namespaces (`core.*`, `ds.*`, `sw.*`, `pf.*`, `ff.*`). Commands can share natural names (`/move`, `/start`, `/end`) while every event stays unambiguous in `events.jsonl`. See [How it fits together](/guide/architecture).
