# Issue 0004: Ruleset v1 Known Scope Limits

## Status

Intentional v1 boundaries across the three playable rulesets; expand only when real play asks for it.

## 1. Draw Steel (`rules: draw-steel`)

- **Minion squads:** One squad occupies a single token on the map, so forced movement moves the squad as one unit and slams hit the squad pool once.
- **GM-adjudicated effects:** Opportunity attacks, splitting a squad's free strike across multiple targets, captain bonus mechanics (`withCaptain` text displays on `/sheet`), and custom ability riders (such as conditional shifts or next-strike edges) are left to the GM and players using standard commands.
- **Tracked in v1:** Per-turn action budgets (`main`, `maneuver`, `move`, `triggered`/round, `dazed`, nat 19–20 extra main action), automatic condition edges/banes (taunted, grabbed, frightened, restrained, prone, weakened), grab holder tracking (`by`, cleared automatically when the holder dies), multi-square footprints (`1×1`–`4×4` + `tiny`), and `"immunity all"` imports.

## 2. `set.world` (`rules: set-world`)

- **Grid mapping is supervillain's own:** Upstream set.world combat is positionless. Speed (`round(5 × walkSpeed)`) and weapon reach by delivery mode (melee 1 / long melee 2 / aura 3 / wave 5 / projectile 10) are supervillain's tactical layer, checked only when both combatants are placed on a map.
- **`/auto foes`:** Host-side foe automation (`apps/supervillain/src/host/AutoFoes.ts`) advances placed foes toward the nearest reachable placed party member and attacks when in reach. It intentionally pauses after `/undo` so it never fights a GM rolling back a mistake.

## 3. `pf2e` Remaster under ORC (`rules: pf2e`)

- **Open tactical core only:** Covers 4 degrees of success (with nat 20/1 shifts), typed bonus/penalty stacking, 3-action economy (`◆◆◇ ↺`) with MAP/agile/flurry/sweep/reaction, explicit initiative order with knockout shifts and `/delay`/`/join`, stateful 5/10/5/10 diagonal parity, dynamic melee flanking, 10-ft diagonal reach, Large `2×2` and Tiny sharing, dying/wounded/doomed/recovery, Hero Points (`/reroll` and Heroic Recovery), Shield Raise and `/block` (linked to the last real hit and restoring pre-knockout state/initiative), persistent damage and DC 15 flat checks, Elite/Weak adjustments, encounter XP budgets, and Pathbuilder JSON import.
- **Not automated in v1:** Spell slot / focus point inventories, area-of-effect templates, cover/concealment line-of-sight, and feat/ancestry passive automation beyond the stats and attacks imported onto the character sheet.
- **ORC compliance:** Zero Paizo trademarks or Reserved Material anywhere in code, commands, events, or docs (see `docs/ORC-NOTICE.md`).
