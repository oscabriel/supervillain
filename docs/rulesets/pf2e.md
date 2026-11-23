# PF2e Remaster Ruleset (`rules: pf2e`, ORC License)

Implements tactical encounter rules compatible with the ORC-licensed Remaster core rules (Player Core, GM Core, Monster Core). See `docs/ORC-NOTICE.md` for full license attribution and Reserved Material notices.

## Sheets and Pathbuilder Import

- **PCs (`heroes/<id>.yaml`) & Creatures (`monsters/<id>.yaml`):** Store finished totals as printed (`level`, `size`, `attributes`, `hp`, `speed`, `perception`, `ac`, `saves`, `classDc`, `skills`, `shield`, `strikes`, `abilities`, `spells`, `immunities`, `weaknesses`, `resistances`).
- **Pathbuilder import:** `supervillain import pathbuilder <file.json> <campaign-dir>` converts a player's local Pathbuilder 2e JSON export into a PC YAML sheet, validates it by reading it back through the loader, and reports any skipped fields.

## Core Mechanics

- **Four degrees of success:** `≥ DC + 10` critical success, `≥ DC` success, `≤ DC − 10` critical failure, else failure; natural 20 raises one step and natural 1 lowers one step, clamped.
- **Typed stacking:** Highest circumstance, status, and item bonus; worst circumstance, status, and item penalty; untyped penalties stack. Modifier parts are recorded in event payloads.
- **Three-action economy (`◆◆◆ ↺`):** 3 actions + 1 reaction per turn (`slowed N` and `stunned N` reduce granted actions, with `stunned` overriding `slowed` and decrementing; `quickened` adds 1). Players are checked on their turn; the GM overrides freely.
- **Multiple Attack Penalty (MAP):** `0 / −5 / −10`, agile `0 / −4 / −8`, flurry `0 / −3 / −6` (`0 / −2 / −4` agile). `sweep` grants `+1` circumstance after striking any other target this turn. Reaction strikes (`reaction`) neither take nor increment MAP.
- **Damage:** Immunity, then highest weakness, then highest resistance (including `physical`). Crits double damage; `deadly dX` adds its die after doubling; `fatal dX` upsizes weapon dice, doubles, and adds one die.
- **Initiative & Delay:** Explicit initiative order (`order` + `delayed`). High to low; foes win PC-vs-foe ties. A PC knocked to `0 HP` moves just before the acting creature's turn (leaving `delayed` if delaying). `/delay` is allowed only before acting this turn; end-of-turn effects run once when the delayed turn finishes after `/join`.
- **Dying, Wounded, Doomed & Hero Points:** Temp HP absorbs first and never stacks. At `0 HP`, PCs gain `dying 1` (`2` on crit) `+ wounded` and `unconscious`; recovery checks roll flat `DC 10 + dying` at turn start; death occurs at `dying ≥ 4 − doomed`. Hero Points (max 3) fuel fortune `/reroll` (checks only, never stacking with fortune/misfortune) and Heroic Recovery (`/recover` while dying).
- **Shields:** `/shield` raises a shield (`+bonus` circumstance AC until start of next turn). `/block` spends `↺` against the combatant's unblocked `lastHit`, subtracting Hardness, splitting remaining damage between shield HP and wearer, marking the shield broken at its Broken Threshold, and recomputing HP/temp/dying/initiative cleanly from pre-hit values.
- **End-of-turn order:** Persistent damage ticks → DC 15 flat checks → `frightened` decrements by 1 → `eot` conditions expire. `sot` conditions expire at the source's next turn start.
- **Elite / Weak & Threat:** `/add <id> [xN] [elite|weak]` applies `±2` to AC, attacks, DCs, saves, Perception, skills, and damage, level adjustments (`+2` for elite at `-1`/`0`, `-2` for weak at `1`), and GM Core HP brackets (Elite `+10/+15/+20/+30` at `≤1/≤4/≤19/20+`; Weak `−10/−15/−20/−30` at `≤2/≤5/≤20/21+`). The GM prep panel computes encounter XP threat (`Trivial` through `Extreme`) for the party size.

## 5-ft Grid, Diagonals, and Flanking

- Diagonals alternate `5 ft / 10 ft / 5 ft / 10 ft` across all movement in a turn via a stateful `Walk<0 | 1>` stepper on the shared board Dijkstra.
- Difficult terrain adds `+5 ft`; Step and Crawl always cost `5 ft` (flipping parity) and Step cannot enter difficult terrain. Enemies block; allies pass.
- `10 ft` reach covers two squares orthogonally and diagonally (PF2e reach exception).
- Flanking is derived dynamically on melee Strikes when the line between attacker and ally space centres crosses opposite sides or corners of the target's space while both are in melee reach, applying `off-guard` (`−2` circumstance AC) to those flankers.
- Sizes map to footprints: Tiny (`1×1`, shares squares), Small/Medium (`1×1`), Large (`2×2`), Huge (`3×3`), Gargantuan (`4×4`).
