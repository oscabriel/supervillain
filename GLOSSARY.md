# Glossary

Canonical domain terms for `supervillain`. Use these terms consistently across code, tests, UI copy, ADRs, and documentation.

## Table, Log, and Domain

- **Actor:** An authenticated participant at a table, encoded as `ActorId`: `"gm"`, `"key:SHA256:<fingerprint>"`, or `"guest:<id>"`. Every event carries the submitting actor.
- **Aggregate (`Table`):** The single `@alchemy.run/domain` aggregate instance (`THE_TABLE = "table"`) per campaign log. Owns all command decisions, event folding, and undo/redo history in one total order.
- **Batch:** All events emitted by one accepted submission, sharing one `actor` and one monotonic `timestamp`. Batches are the unit of `/undo` and `/redo`.
- **Campaign:** One directory on the GM's disk (mode `0700`) holding `campaign.yaml`, `events.jsonl`, `host_key`, optional `relay_known`, and content folders (`heroes/`, `monsters/`, `maps/`).
- **Campaign log (`events.jsonl`):** Plain append-only JSONL file, one `{actor, seq, timestamp, type, payload}` envelope per line. The sole source of truth for a campaign.
- **Command:** A typed player or GM intent parsed from an input line (or sent by a click) and executed by `Table` after `intake` enriches any required host facts.
- **Display name / Label:** The human-readable name an actor chooses with `/name` (stored in the log, NFKC-normalized with lookalike checks). A seat's **label** pairs display name with the hero or fighter they play (e.g. `Alice (Brann)`).
- **Entropy:** Per-submission CSPRNG seed passed into `Table` via `Domain.RequestContext`, converted into a pure seeded `Dice` function (`diceOf`). Seeds are never logged; only rolled faces land in events so replay never rolls.
- **Feed:** The chronological transcript projected from the log for each seat.
- **Fold (strict / lenient):** Strict folding (the writer / `JsonlPlatform`) halts on any unknown event or invalid apply. Lenient folding (`readLog` / `supervillain check`) skips unknown or undecodable events loudly while folding everything else.
- **GM:** The local host operator (`actor === "gm"`). Never rate-limited, owns the disk and log, and has access to GM-only commands and the prep panel.
- **Guest:** A keyless SSH client when guests are enabled. Assigned a fresh `guest:<id>` actor per connection; their display name and hero assignment release when they disconnect.
- **Host fact / Host need (`intake`):** External data a command needs before `decide` runs (YAML hero/monster sheets, map files, generated maps, `set.world` rolls, currently seated actors). Loaded via `ExternalSystem` ports in `packages/domain/src/intake.ts` and placed into the command payload so replay never performs I/O.
- **Key (identity):** A player's SSH public key fingerprint (`key:SHA256:...`). One key is one permanent identity at a table, independent of display name.
- **Playing a hero / fighter:** Assigning an actor to control a hero, PC, or fighter via `/play` / `/unplay`. Avoid calling this a "claim" (reserve **room claim** for the relay).
- **Presence (`Seating`):** The live set of actors currently seated at the table. Ephemeral host state, never logged.
- **Refusal (`Refused`):** A clean, user-facing rejection of a command when rules forbid it. Writes nothing to the log and shows only to the submitting seat.
- **Retractable / Rolled:** Events marked retractable can be undone via `core.retracted` / `core.redone` (up to 20 batches deep). A batch containing a **rolled** event (dice) can only be undone by the GM.
- **Ruleset:** One tactical game engine selected in `campaign.yaml` (`draw-steel`, `set-world`, or `pf2e`), dispatched through the closure-erased `RULESETS` registry. Every ruleset's events are always composed so any log replays cleanly.
- **Seat:** One live terminal UI session (either the GM's `LocalSeat` or a player's SSH shell), rendering a pure `TableView` projected from `TableState`.

## Network and Relay

- **Link:** The persistent outbound TCP + SSH connection dialed from a GM's `supervillain host --relay ...` to `supervillain relay`.
- **Lobby:** The relay's ANSI selection screen shown to a keyed player who connects without naming an active room (`ssh lobby@host` or bare `ssh host`).
- **Knows question (`knows-1@supervillain.sh`):** The SSH subsystem the relay uses to ask linked hosts whether they recognize a player's key, sending a random 16-byte nonce and HMAC-SHA256 of the key so hosts never see unknown keys.
- **Relay (`supervillain relay`):** Stateless SSH forwarding bridge between players and GMs' hosts. Renders nothing beyond the lobby screen, stores only `host_key`, `relay_key`, and `rooms.json`.
- **`relay_known`:** File in a campaign directory pinning trusted relay key fingerprints (populated via `--relay-key` or trust-on-first-use).
- **Room claim:** Entry in `rooms.json` binding a room name to the first GM host key that linked it, with a 180-day inactivity lapse and per-subnet claim rate limits.

## Screen, Map, and Prep

- **Band:** The top combat/party status panel showing combatants, health meters, conditions, turn order, and active action budget.
- **Dressing / MEKMODE:** Printable ASCII characters from MEKMODE's Ding Mode used on `style: mekmode` maps (`LEGEND`) to paint rich terrain glyphs while mapping to pure rule terrain (`.`, `#`, `~`, outside).
- **Footprint:** The `n×n` square space (`1`, `2`, `3`, or `4`) occupied by a map token, anchored at its top-left square.
- **Map:** The tactical grid loaded into play (prefer "map" over "board" in user-facing copy). Rendered as text (`MapPane`) or kitty-graphics PNG (`PictureMap`).
- **Map token:** A figure placed on the map with a short case-sensitive **mark** (e.g. `B`, `b1`). Always say **hero tokens** for Draw Steel's party pool to avoid collision.
- **Mouse menu (`TokenAction`):** Context menu opened by clicking a map token or band row; every choice submits the exact slash-command line typing would send.
- **Panel:** One toggleable UI region (`Alt+1`–`Alt+5` or `/view` presets): band, map, feed, state (GM-only), and prep (GM-only).
- **Prep panel:** GM-only side column listing setup steps (map, party, foes, start), next-click placement target, heroes, monsters, and encounter threat.
- **Reach:** Highlighted squares a combatant can move to on the current turn, computed by Dijkstra over the ruleset's step-cost function.

## Draw Steel (`draw-steel`)

- **Hero / Creature / Combatant:** Heroes belong to the party (YAML under `heroes/`); creatures belong to the Director (stat blocks under `monsters/`).
- **Hero tokens:** Shared party meta-currency pool (`/token`, reset to 1 per hero on respite).
- **Heroic resource:** Per-hero combat resource gained from Victories at combat start and per turn (`/res`).
- **Malice:** Director's combat resource gained at start (Victories) and each round (`heroes + round`, `/malice`).
- **Minion squad:** Group of minions sharing one Stamina pool (`minionsLeft` drops per full minion's Stamina lost).
- **Power roll (`/pr`):** `2d10 + characteristic/bonus` resolving into Tier 1 (`≤11`), Tier 2 (`12–16`), or Tier 3 (`17+`), modified by edges/banes (±2 single, tier shift double) and natural 19–20 criticals (Tier 3 + extra main action on a main action).
- **Recovery / Respite:** Heroes spend Recoveries (`/recover`, healing `⌊max/3⌋`) or take a Respite (`/rest`, resetting Stamina/Recoveries and converting Victories to XP).
- **Stamina / Winded / Dying / Dead:** Primary health meter; winded at `≤ ⌊max/2⌋`, dying at `≤ 0`, dead at `≤ −winded` (creatures die at `0`).
- **Turn budget:** Per-turn Draw Steel actions: 1 main action, 1 maneuver, 1 move (plus 1 triggered action per round; `dazed` cuts to 1 action total and no triggered action).

## set.world (`set-world`)

- **Auto foes (`/auto foes`):** Optional GM-only host driver that plays foes' turns on a `set-world` table using ordinary logged GM commands.
- **Delivery:** Weapon attack delivery class (`melee`, `projectile`, `wave`, `aura`) determining tactical grid reach and physical vs. magical damage.
- **Fighter:** Character rolled from a seed via the `set.world` API (`/recruit` for party, `/foe` for foes).
- **Logical clock:** Continuous millisecond clock advancing by `1000 / initiative` per fighter turn, recovering `10` stamina per logical second.
- **Rules stamp:** Version identifier (`set-world-0-15-0-dungeon-initiative-2`) recorded on `sw.fight-started` and verified during replay.

## PF2e Remaster (`pf2e`, ORC License)

- **Action (`◆`) / Reaction (`↺`):** Three-action turn economy plus one reaction per round, modified by `slowed`, `stunned`, and `quickened`.
- **Degree of success:** `crit-success` (`≥ DC + 10`), `success` (`≥ DC`), `failure` (`< DC`), or `crit-failure` (`≤ DC − 10`), shifted one step up on natural 20 or down on natural 1.
- **Diagonal parity:** Turn-wide alternating `5 ft / 10 ft / 5 ft / 10 ft` diagonal movement state carried across Strides.
- **Dying / Wounded / Doomed:** PC death spiral at `0 HP`: `dying 1` (`2` on crit) `+ wounded`, recovery flat check `DC 10 + dying`, dead at `dying ≥ 4 − doomed`.
- **Elite / Weak:** Creature level and stat template adjustments (`±2` rolls/AC/DCs/damage, level-bracketed HP, `±1` or `±2` level at extremes).
- **Flanking:** Dynamic melee condition computed at Strike time when an attacker and ally sit on opposite sides or corners of a target within melee reach, making the target `off-guard` (`−2` circumstance AC) to those flankers.
- **Hero Point:** PC meta-currency (max 3) spent for a fortune `/reroll` (checks only, never stacking with fortune/misfortune) or Heroic Recovery (`/recover` when dying).
- **Multiple Attack Penalty (MAP):** Cumulative penalty on `attack`-trait actions within a turn (`0 / −5 / −10`, agile `0 / −4 / −8`, flurry `0 / −3 / −6` or `0 / −2 / −4`; reaction strikes take no MAP).
- **Shield Block (`/block`):** Manual reaction spending `↺` against the combatant's unblocked `lastHit`, subtracting Hardness and splitting remaining damage between shield HP and wearer (recomputing from pre-hit HP/temp/dying/initiative).
