# Freeform Ruleset (`rules: freeform`)

A rules-light table: characters with whatever stats and resources the GM names, checks, a map and a turn order. Make one with `supervillain new <dir> --rules freeform`; it writes `table.md`, `party/`, `monsters/`, `scenes/` and `maps/`.

## Sheets

`party/<id>.md` and `monsters/<id>.md` hold a sheet in their frontmatter; the body is the sheet's notes, which players see unless they sit under a `## GM Notes` heading.

```markdown
---
name: Rook
pronouns: she/her
concept: Disgraced duelist
dice: d20
stats: { might: 1, wits: 2 }
resources: { hp: 10 }
tags: [brave]
items: [brass-key]
---
Owes the Gilded Hand a debt.
```

- `stats` are named whole numbers; `resources` are named by their maximum and start full. A key is a lower-case letter, then up to 15 lower-case letters, digits or hyphens.
- `dice` is what checks roll (default `d20`); a check adds the stat.
- `ancestry`, `class`, `items` and `abilities` link files in `ancestries/`, `classes/`, `items/` and `abilities/` by id; `supervillain check` follows every link.

## Commands

| Command | Who | What |
| --- | --- | --- |
| `/pc <id>` | GM | Bring a character in from `party/<id>.md`, or reload its sheet. |
| `/add [n] <id>` | GM | Add 1 to 12 figures from `monsters/<id>.md` (`/add <id> xN` too). |
| `/play <who>`, `/unplay [who]` | anyone | Play a party member, or stop. |
| `/stat <who> <key> +n\|-n\|=n` | its player, GM | Change a stat (within 9999) or a resource (within 0 and its maximum). |
| `/tag <who> +tag\|-tag` | its player, GM | Put a tag on or take it off. |
| `/check [who] <stat> [dice]` | its player, GM | Roll the dice plus the stat. |
| `/map`, `/place`, `/move`, `/remove` | GM; `/place` and `/move` for its player too | The shared board, with no speed or reach. |
| `/start [who...]`, `/next`, `/end` | GM; `/next` for the acting figure's player | Turns in the named order (else the party, then the foes), rounds after the last. |

## The Stage

A freeform table, like every table, has the campaign stage (ADR 0018): `/show`, `/reveal`, `/hide` and `/unpin` cards from the campaign's Markdown, `/tracker` and `/tick` clocks, `/recap` the session, and `/codex` to read what has been shown. While turns are going, the stage shows the encounter.
