# set.world Ruleset (`rules: set-world`)

Implements `set.world`'s turn-based combat rules (`set-world-0-15-0-dungeon-initiative-2`) on supervillain's tactical grid.

## Fighters and Deterministic Replay

- A `set-world` campaign has no YAML hero/monster folders—only `maps/`.
- `/recruit <name> [seed]` and `/foe <name> [seed]` fetch a rolled character from `set.world` via the `SetWorld` external port (10 s timeout, seed-echo verified) and store the complete character in the `sw.fighter-joined` event. Replay never touches the network.
- `sw.fight-started` records the rules stamp (`set-world-0-15-0-dungeon-initiative-2`). Replay halts cleanly if a log names an unknown stamp.

## Combat Math

- **Logical clock:** There are no rounds. Each fighter acts every `1000 / initiative` ms of logical time, starting one interval in. Exact ties go to the party first, then foes, in join order.
- **Stamina recovery:** At each `sw.turn-began`, every living fighter recovers `10` stamina per logical second elapsed since the previous turn, up to maximum (fractional stamina retained, shown rounded down).
- **Attacks:** One attack per turn, costing `20` stamina hit or miss.
  - Dodge roll: `d1000 ≤ round(dodgeRate × (1 − clarity) × 1000)`.
  - Critical roll: `d1000 ≤ round(criticalHitChance × 1000)` doubles damage.
  - Landed damage: `max(1, ⌊raw × (1 − reduction) × (1 − globalResistance) × crit⌋)`, capped at target health. Wave and aura deliveries use magical damage and magical damage reduction.
- **End of fight:** Ends automatically when one side has no living fighters left. Stamina refills; health persists.

## Table Grid Rulings and `/auto foes`

`set.world`'s own duels have no positions, so the table defines grid movement and reach:
- **Speed:** `round(5 × walkSpeed)` squares per turn on the standard 1/1 diagonal movement metric.
- **Weapon delivery reach:** melee `1` square (`2` past `40"` reach), projectile `10`, wave `5`, aura `3` (unknown mainhand defaults to melee `1`). Reach is checked only when both fighters are placed on the map.
- **`/auto foes [on|off]`:** Optional GM-only host-side driver (never inside pure rules, never written to `events.jsonl`). When enabled, whenever a foe's turn arrives in an active fight, the host submits ordinary GM commands (`set-attack` nearest placed party member in reach, else `set-move` closer, else `set-done` to rest), pausing briefly between turns and halting automatically on a party turn, fight end, refusal, or GM `/undo`.
