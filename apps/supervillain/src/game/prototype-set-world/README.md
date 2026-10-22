# PROTOTYPE: fighting with set.world instead of Draw Steel (throwaway)

**The question:** what is a fight at our table like with set.world's characters and rules in place of Draw Steel's?

This lives on the `prototype/set-world` branch only, beside the map-art prototype (`table/prototype-map-art/`), whose looks it shares. Nothing here is meant to merge.

## Run it

```sh
bun apps/supervillain/src/game/prototype-set-world/demo.ts
```

This needs the network. It does three things:
- rolls a party (Ada the Wayguard, Sky the Skirmisher with a sling, Wix the Wizard, Dee the Air Reaver) and three foes (Grub the Dragoon, Mog the Scrollmaster, Nix the Artificer) at set.world, by fixed seeds;
- puts them on the ford in `/tmp/sv-set-world` (a scratch folder, wiped on each run);
- starts the fight and hosts it as your GM seat, on port 2400.

Players join with `ssh -p 2400 ford@127.0.0.1`, then `/take sky`. F2 cycles the map's look.

| Command | Who | What it does |
| --- | --- | --- |
| `/arena <map>` | GM | Loads the map the Set fight is on |
| `/recruit <name> [seed]`, `/foe <name> [seed]` | GM | Rolls a character at set.world: a party member or a foe |
| `/take <name>` | anyone | Plays a party member |
| `/put <who> <square>` | GM, or your own before the fight | Places a fighter |
| `/fight` | GM | Starts the fight. The first turn by initiative begins |
| `/go <who> <square>` | whoever plays it, or the GM | Moves on its turn, up to its speed |
| `/hit <who> <target>` | the same | Attacks once on its turn, if its weapon reaches |
| `/next` | the same | Ends the turn (a turn without an attack is a rest). The next by initiative begins |
| `/sheet <who>` | anyone | Class, flavor, health, stamina, weapon, attributes, stats and gear |

## The rules

**From Set, as written** (AnimaSystem turn-based combat, `set-world-0-15-0-dungeon-initiative-2`, in https://set.world/skills/anima-derived-combat):

- **Turn order.** Each fighter acts every `1000 / initiative` ms of logical time; ties keep the order they joined in.
- **Recovery.** Everyone recovers 10 stamina per second of that time.
- **Attacks.** An attack costs 20 stamina, hit or miss, and a fighter with less cannot attack.
- **A hit.**
  - **The dodge:** a draw against `dodgeRate × (1 − clarity)`.
  - **The critical:** then a draw against `criticalHitChance`, which doubles the hit.
  - **The damage:** `max(1, floor(raw × (1 − reduction) × (1 − globalResistance)))`.

**This prototype's own, since Set's turn-based mode has no positions:**

- **Speed** is `round(5 × walkSpeed)` squares per turn, on our movement rules (walls block, enemies cost extra).
- **Range comes from the weapon's delivery,** from Set's table of every held item (`weapons.ts`):
  - **Melee** reaches 1 square, or 2 for weapons longer than 40 inches.
  - **Projectile** reaches 10.
  - **Wave** reaches 5, as magic.
  - **Aura** reaches 3, as magic.
- **Magic damage.** Magic hits use `magicalDamage` against `magicalDamageReduction`. Set's turn-based mode uses physical damage only.
- **Characters' names** are ours; Set's rolls have none.

The host fetches each roll and puts what the table keeps (class, flavor, weapon, stats, attributes, gear names, seed and `contentVersion`) in the event, so replay never fetches. Set's guide asks a game to keep the whole response; this keeps the part it uses.

## What it showed so far (2026-10-22, scripted, not yet played)

- **It works on our table as it is.** Rolls take about a second each. Turns interleave by initiative, with no rounds. Range and speed refusals read clearly, and `/sheet` is rich: class flavor, eleven pieces of named gear, nine stats.
- **A fight is long.** Hits landed 7 to 19 damage against 150 to 230 health, so dropping one fighter takes 10 to 20 hits. Set's own dungeon plays itself; by hand, a 4-against-3 fight could take well over a hundred turns.
- **A turn offers little choice.** It's move, then hit or rest. There are no abilities, resources or conditions to decide between, which is most of what Draw Steel's turns are made of.
- **Set is rich in content:** classes, flavor text, named gear, prices in orbs, and loot drops (`/api/drop`). That suggests it may serve best as a generator for NPCs, foes and loot feeding a game with tactical rules, rather than as the rules themselves. That's a question for play.
