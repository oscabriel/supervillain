# Draw Steel Ruleset (`rules: draw-steel`)

Default ruleset for campaigns without a `campaign.yaml` or with `rules: draw-steel`.

## Sheets and Import

- **Heroes (`heroes/<id>.yaml`):** five characteristics (Might, Agility, Reason, Intuition, Presence), Stamina, Recoveries (`recoveryValue = ⌊max/3⌋`), speed, stability, optional `size` (`1T`, `1S`, `1M`, `1L`, `2`, `3`, `4`), heroic resource (`name`, `perTurn: "1d3" | n`, `min`), Victories, immunities/weaknesses (including `all`), and abilities.
- **Monsters (`monsters/<id>.yaml`):** same core stats plus `organization` (`minion`, `horde`, `platoon`, `elite`, `leader`, `solo`), `withCaptain`, and free-strike damage.
- **Steel Compendium import:** `supervillain import <bestiary-dir> --into <campaign>` converts a GM's local `data-bestiary-json` copy into YAML (including `size` and `"immunity all"`), then loads every written file back through the sheet validator so converter bugs fail at import time, never at the table.

## Combat, Turn Budget, and Power Rolls

- **Initiative:** `/start` rolls a d10 (`6+` lets players choose `/first`); sides alternate turns, skipping a side with nobody left.
- **Malice & resources:** Combat starts with `Malice = Victories` and heroes' resource equal to Victories. Each round adds `heroes + round` Malice; each hero turn adds their `perTurn` resource (dice rolled into the event).
- **Turn budget:** Each turn grants 1 main action, 1 maneuver, and 1 move, plus 1 triggered action per round (reset at the creature's own turn). A spent maneuver or move falls back to the main action. `dazed` limits the creature to 1 action total and no triggered actions. Players are enforced on their turn; the GM can always override.
- **Power rolls (`/pr`):** `2d10 + best characteristic (or flat bonus)` → Tier 1 (`≤11`), Tier 2 (`12–16`), Tier 3 (`17+`). Single edge/bane is `±2`; double edge/bane shifts a tier. Natural 19–20 forces Tier 3 and, on a main action, grants an extra main action.
- **Automatic condition modifiers:** `/pr` automatically applies `weakened` (bane), `prone` (bane on strikes/targeted rolls), `restrained` (bane on rolls; edge against), `frightened by` (bane targeting source; edge from source), `taunted by` (double bane when not targeting source), and `grabbed by` (bane when not targeting source), combining with typed edges/banes capped at 2 each before netting.
- **Stamina & death:** Weakness adds before highest applicable immunity subtracts; temp Stamina absorbs damage first (non-stacking). Heroes are winded at `≤ ⌊max/2⌋`, dying at `≤ 0`, dead at `≤ −winded`. Creatures die at `0`. Minions share a squad pool (up to 8 per squad), losing one minion per full minion's Stamina.
- **Conditions & grab holder:** The nine core conditions (`bleeding`, `dazed`, `frightened`, `grabbed`, `prone`, `restrained`, `slowed`, `taunted`, `weakened`) with `eot`, `save` (d10 `6+` at end of turn), or `end` duration. `grabbed`, `frightened`, and `taunted` accept `by <who>`. Only the grab holder (or GM) may force-move a grabbed creature; when a holder dies, all conditions held `by` them clear automatically.

## Grid, Footprints, and Forced Movement

- Every step costs `1` (diagonals included); difficult terrain and enemy squares cost `+1`. Only walls block corners (table ruling: one wall square on either side fills a diagonal corner).
- Creature `size` maps to a `1×1`–`4×4` footprint anchored top-left. Placement, movement, `/dist` (edge-to-edge), and forced movement check every covered square.
- Push, pull, and slide subtract stability; colliding with a wall deals `2 + remaining` slam damage, and colliding with a creature deals `1` per remaining square to both.
