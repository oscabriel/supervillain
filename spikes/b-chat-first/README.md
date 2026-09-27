# Spike B: chat-first input and one layout (ASSESSMENT Q2, Q3, Q6)

Throwaway. A clickable mock of the table the rebuild would have, served over SSH so two or three people can use it together. The rules are fake and the state lives in memory. It tests three things:

- **Q2:** can a non-terminal person get seated in under 60 seconds without help?
- **Q3:** does "the input line always owns the keyboard" hold up, with zero accidental commands?
- **Q6:** is everyone's state visible on one screen without navigating?

## The design being tested

- **Getting in.** `ssh` in and you land at the table. The input line asks "What should the table call you?", and the answer is remembered by your key. The first person to sit down is the GM; each player after that gets the next free hero.
- **Keyboard.** The input line always has the keyboard. Plain text is chat, and everything else is a `/command`:

  | Key | Does |
  | --- | --- |
  | Tab | Completes commands, names and conditions |
  | ↑↓ | Your input history |
  | PgUp/PgDn | Scroll the feed |
  | Esc, then one key | Quick action: `m` move, `t` start/end my turn, `u` undo, `r` roll 2d10, `?` help. Alt+key does the same, since terminals send a fast Esc-then-key as Alt+key |
  | Click on the map | Moves your token there. The GM clicks a token, then a square |

- **One layout, designed at 100×30 and fitting 80×24:**
  1. a header with the round, who is acting, and who is here;
  2. an initiative band with Stamina meters and conditions;
  3. the map, with two-character cells, and the feed side by side;
  4. a hint row that says what keys do right now;
  5. the input line.
- **Undo.** `/undo` takes back the last change. Players can undo only their own; the GM can undo anything.

## Running it

It uses the OpenTUI install from the archived build, so run `bun install` at the root first.

**For the playtest,** where the GM's terminal is a screen too and sits down first:

```sh
bun spikes/b-chat-first/serve.ts --local
```

Players connect with `ssh -p 2400 <gm-machine>`. From outside your network, use a tunnel: Tailscale, `bore local 2400 --to bore.pub`, or `ssh -R 2400:localhost:2400 <vps>`.

**To watch from the side,** run it without `--local`; then the first player to join is the GM:

```sh
bun spikes/b-chat-first/serve.ts
```

State goes to `spikes/b-chat-first/.state/`:

- `names.json` holds names by key;
- `inputs.jsonl` holds every line anyone entered, with how they entered it (typed, leader or click) and any reply only they saw.

The server log prints `seated: <name> in N s after connecting` for each first-time player.

## The session (about 20 minutes, 2–3 people who don't live in terminals)

Send them only the `ssh` line. Don't explain anything, and start a stopwatch when they press Enter.

1. Get to the table. (The stopwatch stops at the `seated:` log line.)
2. Say hi to everyone.
3. Find out how hurt Goblin 1 is.
4. Start your hero's turn, move next to a goblin, and roll a power roll (2d10 + 2).
5. The goblin takes 9 damage from you. Mark it.
6. The goblin is slowed until the end of its turn. Mark it.
7. End your turn.
8. Oops: undo the damage.
9. Find the full list of what you can do.
10. Change what the table calls you.

Afterwards, ask:

- What did you try first that didn't work?
- How did you move: typing, Esc then `m`, or clicking?
- Did anything happen that you didn't mean to?

## Recording results

Fill in ASSESSMENT §9:

- **Q2:** each person's seconds to seated, and whether they needed help.
- **Q3:** count the accidental commands in `inputs.jsonl`, meaning any line the person didn't mean as that command. Note which input styles people reached for.
- **Q6:** whether anyone had to ask where something was.

Then delete this folder.

## Found while building it

- **Esc as the leader key collides with Alt.** A terminal sends Alt+t as Esc followed by t, so a fast "Esc, t" (or two keystrokes merged in one packet over SSH) arrives as Alt+t. The mock treats Alt+key as leader-then-key. Ctrl-Space avoids the ambiguity but is harder to find.
- **Renaming relabels history.** Names are resolved when the feed is drawn, so `/name` changes past lines too ("Oscar the GM sat down as the GM"). Decide whether that's wanted (Q9).
- **At 80×24 there's no slack.** The map exactly fills its column, and the legend under it only shows at 30 rows or more.
