# Glossary

Canonical domain terms for `supervillain`. Use these terms consistently across code, tests, UI copy, ADRs, and documentation.

## Table, Log, and Domain

- **Actor:** An authenticated participant at a table, encoded as `ActorId`: `"gm"`, `"key:SHA256:<fingerprint>"`, or `"guest:<id>"`. Every event carries the submitting actor.
- **Aggregate (`Table`):** The single `@alchemy.run/domain` aggregate instance (`THE_TABLE = "table"`) per campaign log. Owns all command decisions, event folding, and undo/redo history in one total order.
- **Batch:** All events emitted by one accepted submission, sharing one `actor` and one monotonic `timestamp`. Batches are the unit of `/undo` and `/redo`.
- **Campaign:** One directory on the GM's disk (mode `0700`) holding `campaign.yaml`, `events.jsonl`, `host_key`, optional `relay_known`, and content: `table.md`, YAML sheets in `heroes/` and `monsters/`, typed Markdown in `scenes/`, `npcs/`, `handouts/`, `items/`, `ancestries/`, `classes/`, `abilities/`, `party/` and `monsters/`, text maps in `maps/` and pictures in `art/`.
- **Campaign content / Frontmatter:** A campaign's Markdown files: YAML frontmatter decoded by a strict Schema, then a body whose GM notes stay with the GM (ADR 0017). Problems are `{ file, field?, line?, message }`, reported by `supervillain check`.
- **Card (`StageCard`):** The player-safe form of one content file, keyed `<kind>:<id>` (`npc:mara`): title, subtitle, read-aloud, body prose, art, map and tags. Built by the host, carried into the log by `intake`.
- **Codex:** The cards a player may read: every revealed and on-table card. `/codex [card]` lists or reads them.
- **GM notes:** Any section of a content file under a heading starting `GM` or `Game Master`, with every deeper section under it. Never in a card, a sheet, an event or a player's view; the GM's `/codex` shows them, read live from the file.
- **Prose:** Player-safe Markdown parsed into blocks (paragraph, preformatted, list, quote, heading).
- **Stage:** The `stage` slice of the table: revealed and on-table cards, the current scene, trackers and the recap, outside undo (ADR 0018). Its **mode** is `campaign` or `encounter`, following the fight unless the GM's `/stage` holds it until the next fight starts or ends.
- **Content watch (`ContentWatch`):** The host's watcher on a campaign folder that reads edited content again, keeps the last good index when an edit is broken (its problems shown to the GM), syncs changed stage cards unless `table.md` says `sync: manual` (holding back, for the GM to `/sync`, a card whose GM notes shrank as its player text grew), and names the party sheets in play that differ from their files (**stale sheets**).
- **Tier:** How far a piece of content is shown: **gm-only** (not on the stage at all), **revealed** (in the codex) or **on-table** (also on the stage).
- **Tracker:** A clock, counter or quest on the stage, set with `/tracker` and moved with `/tick`; gm-only until shown.
- **Campaign log (`events.jsonl`):** Plain append-only JSONL file, one `{actor, seq, timestamp, type, payload}` envelope per line. The sole source of truth for a campaign.
- **Command:** A typed player or GM intent parsed from an input line (or sent by a click) and executed by `Table` after `intake` enriches any required host facts.
- **Display name / Label:** The human-readable name an actor chooses with `/name` (stored in the log, NFKC-normalized with lookalike checks). A seat's **label** pairs display name with the hero or fighter they play (e.g. `Alice (Brann)`).
- **Entropy:** Per-submission CSPRNG seed passed into `Table` via `Domain.RequestContext`, converted into a pure seeded `Dice` function (`diceOf`). Seeds are never logged; only rolled faces land in events so replay never rolls.
- **Feed:** The chronological transcript projected from the log for each seat.
- **Fold (strict / lenient):** Strict folding (the writer / `JsonlPlatform`) halts on any unknown event or invalid apply. Lenient folding (`readLog` / `supervillain check`) skips unknown or undecodable events loudly while folding everything else.
- **GM:** The local host operator (`actor === "gm"`). Never rate-limited, owns the disk and log, and has access to GM-only commands and the prep panel.
- **Guest:** A keyless SSH client when guests are enabled. Assigned a fresh `guest:<id>` actor per connection; their display name and hero assignment release when they disconnect.
- **Host fact / Host need (`intake`):** External data a command needs before `decide` runs (hero and monster sheets, map files, generated maps, `set.world` rolls, stage cards, currently seated actors). Loaded via `ExternalSystem` ports in `packages/domain/src/intake.ts` and placed into the command payload so replay never performs I/O.
- **Key (identity):** A player's SSH public key fingerprint (`key:SHA256:...`). One key is one permanent identity at a table, independent of display name.
- **Member / Door:** Who may act at a table. The GM, anyone `/admit`ted, and (until `/kick`ed) anyone who already appears in the log are members; the **door** is `knock` (newcomers wait for the GM) or `open` (anyone who connects sits down), set with `/door` and kept in the log (ADR 0016).
- **Knock:** A non-member's request to sit down, made at the door screen with a name checked like `/name`. Held in the host's memory only; the GM answers with `/admit`, `/deny`, the banner's buttons or Alt+Y / Alt+N.
- **Invite:** A token from `/invite [uses] [minutes]`, added after `~` in the table's name (`ssh ana/den~token@…`), that admits a player without a knock. Held in memory only, never logged.
- **Playing a hero / fighter:** Assigning an actor to control a hero, PC, or fighter via `/play` / `/unplay`. Avoid calling this a "claim" (reserve **handle claim** for the relay).
- **Presence (`Seating`):** The live set of actors currently seated at the table. Ephemeral host state, never logged.
- **Refusal (`Refused`):** A clean, user-facing rejection of a command when rules forbid it. Writes nothing to the log and shows only to the submitting seat.
- **Retractable / Rolled:** Events marked retractable can be undone via `core.retracted` / `core.redone` (up to 20 batches deep). A batch containing a **rolled** event (dice) can only be undone by the GM.
- **Ruleset:** One tactical game engine selected in `campaign.yaml` or `table.md` (`draw-steel`, `set-world`, `pf2e`, or `freeform`), dispatched through the closure-erased `RULESETS` registry. Every ruleset's events are always composed so any log replays cleanly.
- **Launcher:** The screen bare `supervillain` opens in a terminal: the campaigns it finds in `./`, `./*/` and `${SUPERVILLAIN_HOME:-~/supervillain}/*/`, newest played first, to open on the relay (or `--local`), and **N** for the New Table wizard (name, rules, the sample for Draw Steel, and a handle when none is saved).
- **Seat:** One live terminal UI session (either the GM's `LocalSeat` or a player's SSH shell), rendering a pure `TableView` projected from `TableState`.
- **Agent (MCP session):** An AI agent seated at a table through MCP (ADR 0020), as the GM (over `mcp.sock`, or `mcp-1` with a key in `gm_keys`) or as a player's own key (over `mcp-1`). It is present like a seat and sends commands through the same `intake`, but has no terminal: it reads the table through tools and `supervillain://` resources.
- **Agent socket (`mcp.sock`):** The `0600` Unix socket an open table listens on for the GM's agents, in the campaign folder or, for a long path, under `$XDG_RUNTIME_DIR/supervillain-<uid>/`. `supervillain mcp <campaign-dir>` connects an agent's stdio to it.
- **Command tool (`cmd_<type>`):** One table command as an MCP tool, its arguments the command's class fields minus its **host-fact keys** (`HOST_FACT_KEYS`), which only `intake` may fill.
- **`gm_keys`:** Optional campaign file (mode `0600`, one `SHA256:` fingerprint per line) naming keys whose agents may act as the GM over `mcp-1`. It grants nothing to shell seats.

## Network and Relay

- **Link:** The persistent outbound TCP + SSH connection dialed from a GM's `supervillain host --relay ...` to `supervillain relay`.
- **Handle:** A GM's name on a relay (`ana` in `ssh ana/den@relay`), held by the GM's `gm_key` and up to three more of their machines' keys (ADR 0015).
- **Table address:** `<handle>/<table>` (or `<handle>.<table>`), what a player types before the `@` on a relay. A bare `<table>` is the **returning player's shorthand**: it seats a key at the one open table of that name that knows it.
- **Lobby:** The relay's ANSI screen shown to anyone with a terminal who connects without naming an open table (`ssh lobby@host` or bare `ssh host`), in four tabs switched with `1`–`4`, `Tab`, `Shift+Tab`, `←`/`→` or `F1`–`F4`: **Tables** (the open tables that know their key, to pick from, and a prompt that takes a table's name), **Try a Table** (a sandbox), **Create a Table** (claim a handle and get a pairing code), and **Session** (your key's fingerprint, your handle, and your terminal). Bare `supervillain` on your own machine draws the same four tabs.
- **Knows question (`knows-1@supervillain.sh`):** The SSH subsystem the relay uses to ask linked hosts whether they recognize a player's key, sending a random 16-byte nonce and HMAC-SHA256 of the key so hosts never see unknown keys.
- **Agent subsystem (`mcp-1@supervillain.sh`):** The SSH subsystem that opens an MCP session (ADR 0020): `ssh -s <handle>/<table>@<relay> mcp-1@supervillain.sh`, or on the table's own server. The relay routes it like a seat without the lobby and names the player to the host in `SV_ACTOR`.
- **Relay (`supervillain relay`):** SSH forwarding bridge between players and GMs' hosts. Renders only the lobby and its sandbox tables, and stores only `host_key`, `relay_key`, and `handles.json`.
- **`relay_known`:** File in a campaign directory pinning trusted relay key fingerprints (populated via `--relay-key` or trust-on-first-use).
- **Handle claim:** Entry in `handles.json` binding a handle to the GM keys that hold it (the first to claim it, in the lobby or by linking a table, then any added with a pairing code), with a 180-day inactivity lapse (30 if it never linked a table) and per-subnet claim rate limits.
- **Pairing code (`sv-…`):** A single-use code, good for 15 minutes, that the relay mints for a key holding a handle (the lobby's Create a Table tab shows one with the `supervillain new … --claim` command to run). A host that links with `--claim <code>` adds its GM key to the handle, proving the code with an HMAC bound to that key rather than sending it; also called a claim code.
- **Sandbox (Try a Table):** A private, throwaway Draw Steel table the relay runs in its own memory for a lobby visitor, who sits as the GM of the sample encounter. Nothing is saved; it closes after 5 minutes idle or 20 in all, and the relay holds at most a few (Issue 0005).
- **GM key (`gm_key`):** The GM's per-machine SSH key in `$XDG_CONFIG_HOME/supervillain/` (else `~/.config/supervillain/`), presented on relay links instead of the campaign's `host_key`, which direct players still see.
- **`gm.json`:** The GM's saved settings beside `gm_key` (`{handle, relay}`, mode `0600`): the handle the launcher and `supervillain new --open` link tables under, saved the first time one is given.

## Screen, Map, and Prep

- **Band:** The top combat/party status panel showing combatants, health meters, conditions, turn order, and active action budget.
- **Dressing / MEKMODE:** Printable ASCII characters from MEKMODE's Ding Mode used on `style: mekmode` maps (`LEGEND`) to paint rich terrain glyphs while mapping to pure rule terrain (`.`, `#`, `~`, outside).
- **Footprint:** The `n×n` square space (`1`, `2`, `3`, or `4`) occupied by a map token, anchored at its top-left square.
- **Map:** The tactical grid loaded into play (prefer "map" over "board" in user-facing copy). Rendered as text (`MapPane`) or kitty-graphics PNG (`PictureMap`).
- **Map token:** A figure placed on the map with a short case-sensitive **mark** (e.g. `B`, `b1`). Always say **hero tokens** for Draw Steel's party pool to avoid collision.
- **Mouse menu (`TokenAction`):** Context menu opened by clicking a map token or band row; every choice submits the exact slash-command line typing would send.
- **Panel:** One toggleable UI region (`Alt+1`–`Alt+5` or `/view` presets): band (or the party strip), map (or the stage pane), feed, state (GM-only), and prep (GM-only).
- **Prep panel:** GM-only side column listing setup steps (map, party, foes, start), next-click placement target, heroes, monsters, and encounter threat, then the campaign's scenes, NPCs, handouts, items and trackers with Show, Codex, Hide and ▶ fight, a sync row for stale sheets, and any problems in the campaign's files.
- **Party strip:** The band's place out of a fight on the campaign stage: one row per party member with player, health meter and conditions; a click asks for the sheet.
- **Stage pane:** The map's place out of a fight: the scene card with its read-aloud box, the cards on the table, trackers (clocks as `○◔◑◕●`) and the last three recap lines; the GM's seat also shows each card's GM notes. The **codex view** in the same place lists the codex and reads one card.
- **Peek (`/view stage`, `/view board`):** One seat looking at the stage pane or the map instead of what the stage's mode shows, until the mode changes.
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
