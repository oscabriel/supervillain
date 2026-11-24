# supervillain

A terminal-first virtual tabletop for Draw Steel, `set.world`, and PF2e Remaster under the ORC License. Players type `ssh <room>@<host>` and are sitting at a live table, with nothing to install and no account to make. The GM's machine is the authority: it runs the rules, draws every player's screen and keeps the campaign as a plain append-only log (`events.jsonl`) on the GM's disk.

What's in it: chat, names and dice; **Draw Steel** (heroes from YAML sheets, monsters from stat blocks or Steel Compendium import, combat with per-turn action budgets, automatic condition edges/banes, grab tracking, Stamina, power rolls, resources, Malice, and multi-square footprints); **`set.world`** (seeded fighters from set.world's API, logical-clock initiative turns, stamina, dodge/crits, and `/auto foes`); **PF2e Remaster (ORC)** (`rules: pf2e`: 4 degrees of success, 3-action economy with MAP/agile/flurry/sweep/reactions, explicit initiative with `/delay` and `/join`, stateful 5/10/5/10 diagonals, flanking, dying/wounded/doomed, Hero Points, Shield Raise & `/block`, persistent damage, Elite/Weak adjustments, and Pathbuilder JSON import); a tactical map in text or kitty-graphics MEKMODE pictures; a mouse whose clicks send the exact commands you'd type; GM prep panel; `/undo` and `/redo`; and `supervillain relay` with a lobby for whoever comes without a room.

- Player guide: [docs/PLAYING.md](docs/PLAYING.md)
- Host & relay guide: [docs/HOSTING.md](docs/HOSTING.md)
- Rulesets: [docs/rulesets/draw-steel.md](docs/rulesets/draw-steel.md), [docs/rulesets/set-world.md](docs/rulesets/set-world.md), [docs/rulesets/pf2e.md](docs/rulesets/pf2e.md)
- Architecture & ADRs: [docs/how-it-works.md](docs/how-it-works.md), [docs/adr/](docs/adr/), [GLOSSARY.md](GLOSSARY.md)

## Install

**A release binary.** Each release from v0.3.0 on has one self-contained executable per platform (Linux and macOS, x64 and arm64) and `SHA256SUMS`; it needs nothing else installed. [docs/HOSTING.md](docs/HOSTING.md#install) has the download steps.

**From source.** You need [Bun](https://bun.sh) 1.4.5+. In a checkout, run `bun install`, then `bun supervillain …` from the repo root wherever this page says `supervillain …`. `bun run release:build` writes this machine's binary to `dist/supervillain-<os>-<arch>`.

Players need only an OpenSSH client, which macOS, Linux and Windows 10 and later already have.

## Host in one minute

```sh
supervillain new ~/campaigns/ford --example
supervillain host ~/campaigns/ford
```

`new --example` copies the sample Draw Steel campaign: four level-1 heroes, the bandits and the map for one fight (`examples/campaign/README.md` has the file formats). `host` opens a campaign folder that `new` made, prints the join command and the table's host key, and opens the table in your terminal as the GM. Ctrl-C or `/quit` closes it.

By default the table listens only on this machine (`127.0.0.1:2222`). To let others in:

- **Same network or Tailscale:** `supervillain host ~/campaigns/ford --bind 0.0.0.0`.
- **A tunnel:** `bore` or `ssh -R` through a VPS.
- **The relay:** run `supervillain relay` on a small VPS, and `supervillain host ~/campaigns/ford --relay table.example.com --relay-key SHA256:…` dials out to it. Your machine opens no port. Players type `ssh -p 2222 ford@table.example.com`.

[docs/HOSTING.md](docs/HOSTING.md) walks through all three, the relay's systemd unit and firewall, and every flag.

## Join as a player

```sh
ssh -p 2222 ford@127.0.0.1                  # sit at the table
ssh -p 2222 ford@127.0.0.1 roll 2d10+3      # or run one command and leave
```

Your SSH key is who you are, so there's no account; a client with no key comes in as a guest. The first time, the table asks what to call you. Plain text is chat, `/` starts a command, Tab completes, `/help` lists everything, and Ctrl-C leaves. [docs/PLAYING.md](docs/PLAYING.md) is the page to send your players.

## More commands

```sh
supervillain new ~/campaigns/arena --rules set-world         # a set.world campaign
supervillain new ~/campaigns/delve --rules pf2e              # an ORC-licensed PF2e Remaster campaign
supervillain map crossing ~/campaigns/ford --seed 7          # generate a map into maps/ (crossing or keep)
supervillain check ~/campaigns/ford                          # replay a log without opening it
supervillain import ~/data-bestiary-json --into ~/campaigns/ford "Goblin Warrior"
supervillain import pathbuilder ~/Downloads/hero.json ~/campaigns/delve
supervillain relay --dir ~/relay                             # run a relay; `relay forget <room>` releases a claim
supervillain --help                                          # every command and flag
```

`check` works while the host runs and exits 1 if the log has an event it can't apply. `import` reads Steel Compendium's `data-bestiary-json` for Draw Steel monsters, and `import pathbuilder` converts a Pathbuilder JSON export into a `pf2e` PC YAML sheet.

## Develop

```sh
bun install
bun run build          # tsc -b across all workspaces
bun test               # run the full test suite from the repo root
bun run check          # oxfmt --check, strict oxlint (type-aware + Effect + zero-comment/assertion)
bun --filter @supervillain/site build
bun run release:build  # dist/supervillain-<os>-<arch> for this machine (--all for every platform)
bun run release:smoke dist/supervillain-linux-x64
```

`AGENTS.md` describes the workspace layout and strict engineering rules.

## License & Notices

[MIT](LICENSE). See [NOTICE](NOTICE) for third-party attributions (MEKMODE, `@opentui/ssh`, `anti-slop`, Draw Steel Creator License) and [docs/ORC-NOTICE.md](docs/ORC-NOTICE.md) for the Open RPG Creative (ORC) License notice covering the `pf2e` ruleset.

---

supervillain is an independent product published under the DRAW STEEL Creator License and is not affiliated with MCDM Productions, LLC. DRAW STEEL © 2024 MCDM Productions, LLC.
