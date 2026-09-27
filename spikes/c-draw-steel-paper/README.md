# Spike C: Draw Steel combat on paper (ASSESSMENT Q5)

Throwaway. It answers: **what is the minimum Draw Steel a table needs so that nobody reaches for paper during a real combat?** The output is a command list and a list of data sources, both checked against what actually happened at a table. The result goes into ASSESSMENT §9, Q5, and then this folder is deleted.

It has two passes:

1. **On paper, now.** Run one published encounter by hand, with a scribe keeping a tally of every state change and every rules lookup. The tally tells us which commands the tool needs and how often each one is used.
2. **With the tool, after the rebuild.** Run the same encounter with the tool as the only state. It's done when nobody reaches for paper.

This README is the draft for pass 1: how to run it, the tally sheet, and the predicted command list the tally will confirm or correct.

## Running the paper pass

- **Who:** you as Director, 3–4 players, and one scribe. The scribe can be a player who isn't acting, but a separate person is better.
- **What:** one combat-heavy published encounter at level 1, with pregenerated heroes. Pick something with minions and at least one non-minion creature, so squads and Malice both come up.
- **Time:** one combat, start to finish, plus 15 minutes of debrief.
- **Rules:** play as written. When anyone looks something up, the scribe logs it.

**The scribe's one job:** every time a number or state changes on paper, or someone asks "wait, how does X work?", write one row of the tally.

## Tally sheet

One row per event. Columns:

| Column | What goes in it |
| --- | --- |
| Round | 1, 2, 3… |
| Who did it | The player or Director |
| Verb | A short verb for the change: damage, heal, temp, recover, condition on, condition off, save, resource, malice, surge, turn, move, push, roll, victory, other |
| Target | Who it happened to |
| Amount | The number, if any |
| Looked up? | Y if anyone consulted the book or asked a rules question, with a word on what |
| Paper? | Y if it was only tracked on paper or in someone's head (for example a condition timer or a squad's pool) |

A blank printable version is in `tally.csv`. After the session, sort by Verb and count.

## Predicted command list

This is the prediction to check against the tally. Priority means:

- **Must:** Session Zero can't run without it.
- **Should:** it comes up, but a workaround is tolerable.
- **Later:** only when a table asks for it.

The rules each command computes were checked on 2026-09-27 against the rules text on Steel Compendium (`data-rules-md`: The Basics, Combat, Classes; `data-bestiary-md`: Monster Basics). Anything the tool computes, the table stops tracking on paper.

### Must

| Command | What the tool computes | Data it needs |
| --- | --- | --- |
| `/start` | Rolls a d10 for the whole table: on 6+ the players pick which side goes first, otherwise the Director does. That side goes first every round. Each hero gains their heroic resource equal to their Victories. The Director gains Malice equal to average Victories per hero, plus the round-start Malice for round 1 | Victories per hero |
| `/turn <who>` · `/turn` | Sides alternate one creature at a time; on the Director's side, a creature or group. When one side runs out, the other side's remaining creatures act back to back. **Round start:** Malice + number of living heroes + round number. **Hero turn start:** resource + 1d3. **Turn end:** conditions marked EoT end; save-ends conditions prompt a save | Initiative sides, groups |
| `/pr <hero> <ability or +N> [edge\|bane\|edge2\|bane2]` | 2d10 + characteristic, with tiers at ≤11, 12–16 and 17+. A natural 19–20 is always tier 3. An edge is +2 and a bane −2; a double edge or bane moves the tier one step instead. An edge and a bane cancel. Prints the named ability's result for that tier | Characteristics; each ability's name, characteristic, and tier 1/2/3 text |
| `/dmg <who> <n> [type]` | Temporary Stamina absorbs first. Weakness adds, then the single highest immunity subtracts, applied last. Heroes: winded at half or below, dying at 0 or below (bleeding, can't Catch Breath), dead at minus the winded value. Creatures die at 0. Minion squads: see `/add` | Stamina max; immunities and weaknesses by type |
| `/heal <who> <n>` | Caps at max. Minions can't regain Stamina | — |
| `/temp <who> <n>` | Temporary Stamina doesn't stack; keeps the larger. Minions can't gain it | — |
| `/recover <hero>` | Spends one Recovery and heals the recovery value, one third of max rounded down. As Catch Breath it's refused while the hero is dying, but an ally's ability can still let a dying hero spend one, so the command needs a way to say which | Recoveries max; Stamina max |
| `/cond <who> <condition> [eot\|save\|end]` | EoT lasts to the end of the target's next turn, or its current turn if imposed during it. Save ends: d10 at the end of each of its turns, 6+ ends it. End of encounter otherwise | The nine conditions |
| `/save <who>` | The d10 for a save-ends effect, if the table wants to roll by hand | — |
| `/res <hero> ±N` · `/malice ±N` | Spending, and class-specific gains the tool doesn't know about | Resource name per class |
| `/add <creature> [×N]` | Adds from a stat block. Minions form squads of up to 8 sharing a pool of one minion's Stamina × squad size; one minion dies for each full minion's worth lost. Overflow from a non-area attack kills the nearest other minions. Immunity and weakness apply once per squad | Stat block: level, organization, Stamina, speed, stability, free strike, characteristics, immunities, weaknesses, abilities |
| `/end` | Ends combat: surges are lost, end-of-encounter conditions end | — |
| `/undo` | Takes back the last change (Q8) | — |
| `/move` and the map | See Q7 | Positions |

### Should

| Command | What the tool computes | Data it needs |
| --- | --- | --- |
| `/surge <hero> ±N` | Spend up to 3 on one damage roll for + the hero's highest characteristic each, or 2 to raise a potency by 1. Lost at the end of combat | Characteristics |
| `/token ±N` | The party's hero-token pool, which starts each session at the number of heroes. Spending effects stay manual: 2 surges, pass a failed save, reroll a test, or 2 tokens to heal the recovery value | Hero count |
| `/push` · `/pull` · `/slide <who> <n>` | Stability reduces the distance. Ignores difficult terrain, never vertical, never provokes | Stability; map |
| `/fs <creature> <target>` | A monster's free strike is fixed damage with no roll | Free strike value |
| `/victory ±N` | Victories, which feed the next `/start` | — |

### Later (only when a table asks)

- Ability costs that spend heroic resource automatically.
- Potency checks against the target's characteristic.
- Area templates, line of effect, and counting squares for bursts and lines.
- Tracking each creature's one triggered action per round.
- The critical hit's extra main action (natural 19–20 on a main-action ability roll).

### What to watch for at the table

The tally should show whether:

- round-start Malice and per-turn resource gains are worth automating, or players prefer to say them aloud;
- save-ends saves get forgotten without a prompt;
- minion squads are the biggest source of paper (predicted: yes);
- anyone uses edges and banes often enough to need them in `/pr` rather than doing the math aloud.

## Data sources

### Heroes

| Source | What it gives | Cost | Verdict |
| --- | --- | --- | --- |
| **Our own small hero file**, hand-written: name, class, resource name, characteristics, Stamina max, Recoveries max, Victories, and each ability's name, characteristic, cost and tier 1/2/3 text | Exactly the fields the commands above use | A guess of 15 minutes per pregen, typed from the book | **Session Zero.** The paper pass confirms the field list |
| **Forge Steel export** (`.ds-hero`, JSON, GPL-3.0 app by Andy Aiken). Top-level fields: `name, ancestry, culture, career, class, complication, features, state, …` | What players actually use to build heroes | There's no top-level Stamina, Recoveries or characteristics field. Characteristics are under `class.characteristics[]`, abilities under `class.abilities`, and max Stamina and Recoveries have to be computed from class, kit and level. `state` holds only damage, temporary Stamina, Recoveries used, surges, hero tokens and conditions | **Should, after Session Zero.** Reading a user's exported file is fine under the GPL. Don't copy Forge Steel's code or its TypeScript data files, which would make ours GPL-3 |

### Monsters

| Source | What it gives | Cost | Verdict |
| --- | --- | --- | --- |
| **Typed by the Director** from _Draw Steel: Monsters_ into a small stat-block file | The few creatures in tonight's encounter | Minutes per creature | **Session Zero** |
| **Steel Compendium** `data-bestiary-json` (also `-yaml` and `-md`; the newer `data-bestiary` repo is work in progress). Each creature has `level`, `roles` (e.g. "Minion Harrier"), `ev` ("3 for four minions"), `stamina`, `speed`, `stability`, `free_strike`, `with_captain`, the five characteristics, and `features[]` with `effects[{roll, tier1, tier2, tier3}]` | Every published monster, structured | `ev` and `stamina` are strings, and organization and role share one string, so it needs parsing. Each data repo's LICENSE contains only the Creator License notice, and GitHub reads it as NOASSERTION, meaning no licence for the compendium's own formatting work | **Should.** Importing from a GM's local copy is clean. Bundling their files needs the maintainers' OK first |
| **Forge Steel monster data** (`src/data/monsters/*.ts`, 57 files) | Structured monsters | GPL-3 TypeScript modules | **No.** The licence is incompatible with bundling |

### Licence (from `.agents/wayfinder/assets/draw-steel-license.md`, rechecked against the licence page, last edited 2026-06-09)

- The DRAW STEEL Creator License allows reusing rules text, mechanics, names and stat values from the listed documents only:
  - _Draw Steel: Heroes_
  - _Draw Steel: Monsters_
  - Backer Packets #1 and #2
  - _The Beastheart_
  - _The Summoner_
- It allows free or paid products.
- It forbids art, page screenshots, and the MCDM and main DRAW STEEL logos.
- It requires the exact independent-product notice, both in the product and on its web page.
- Anything we bundle must trace to one of those documents. Help text quoting the rules is allowed; screenshots are not.

## What to record in §9

- The tally counts by verb, sorted.
- Which predicted commands never came up, and which unpredicted ones did.
- Every "Paper? Y" row: each one is something the tool must hold.
- Every "Looked up? Y" row: each one is either a command that should compute the rule, or a line of help text.
- Whether the data sources held up: did the pregens and the stat blocks have every field the table needed?
