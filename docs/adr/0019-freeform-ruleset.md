# A freeform ruleset: named stats and resources, checks, a map and a turn order, nothing more

## Decision

`rules: freeform` is a fourth ruleset (`packages/domain/src/rules/freeform/`, slice `ff`, events `ff.*`, commands `ff-*`). A character's sheet (`FfSheetSchema`) is a name, optional pronouns, concept, check dice (default `d20`), `stats` and `resources` keyed `^[a-z][a-z0-9-]{0,15}$` (never integer-like, so their order is the file's), tags, a portrait and player-safe notes as `Prose`; it comes from `party/<id>.md` or `monsters/<id>.md`, its body's player-safe part becoming the notes. `/pc <id>` brings a character into the party (`ff.pc-joined`; again, it reloads the sheet: a stat whose base in the file is unchanged keeps its current value, a stat whose base changed takes the new base, and a resource keeps its current value clamped to its new maximum), `/add [n] <id>` (or `/add <id> xN`) brings up to 12 numbered foes (`ff.figures-added`); `decide` refuses what `apply` would halt on, so `/pc` of a foe's id, more than 12 foes or a malformed tag is a refusal, never a halted log, `/play` and `/unplay` hand characters to players, `/stat <who> <key> +n|-n|=n` changes a stat (within 9999) or a resource (within 0 and its maximum), `/tag <who> +tag|-tag` marks a figure, and `/check [who] <stat> [dice]` rolls the dice plus the stat (`ff.checked`, rolled, so only the GM undoes it). `/map`, `/place`, `/move` and `/remove` use the shared board with no speed or reach; `/start [who...]` starts turns (named, or the party then the foes), `/next` passes the turn (the GM, or whoever plays the acting figure) and starts a new round after the last, and `/end` ends them. Every ruleset now also answers `party` (the stage's party panel), `inCombat`, `fightLines(encounter)` (the lines that set up a scene's fight: `/map` and its own `/add` or `/foe`) and `resyncLines(state, changed)` (the lines that reload changed sheets in play: Draw Steel's `/hero`, PF2e's and freeform's `/pc`; set.world rolls its characters, so none).

## Why

- Many tables play a home system, a story game or a one-shot whose rules fit on a card; they still want the map, the turn order, the dice and the stage.
- Named stats and resources cover hit points, stress, luck and ammunition alike without the table knowing what they mean.
- Keeping the ruleset small keeps every refusal and fold check in one readable place, and leaves judgement to the GM.

## What breaks if you change this

- Allowing integer-like stat keys reorders a sheet's stats in every view, since JavaScript sorts such keys first.
- Re-joining a character from scratch on `/pc` loses the damage and tags it took in play.
- Rolling inside `apply`, or trusting a check's total without re-adding it, breaks replay's guarantee that the log alone decides the result.
