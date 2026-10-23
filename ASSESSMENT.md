# supervillain: an honest assessment

_Written 2026-09-25 against `main` at `a713cee`, which is 8 commits ahead of `origin/main`. Nothing was treated as settled, including the product definition that `AGENTS.md` says never to reopen. This document reopens it on purpose._

**How I examined it:**

- **Docs read:**
  - the product definition, the glossary, and the seam spec
  - all 36 ADRs and the 16 wayfinder tickets
  - the research corpus (65 files, about 1.5 MB)
  - the benchmarks, the plans, and the open issues
- **Code:** read every package and app.
- **Checks:** built, typechecked, linted, and ran every test suite.
- **Played it:**
  - hosted a Draw Steel table from the CLI and ran a local gateway;
  - joined over SSH as a player with a fresh key;
  - chatted, rolled, and loaded a map;
  - read the resulting `events.jsonl` line by line.
- **Bugs:** every bug stated as fact below was reproduced. Five review passes ran in parallel (ADRs, research, engine, rendering, apps/infra).

Three of those passes, plus my own hands-on testing, independently reached the same central architectural recommendation (§6).

---

## 1. The verdict

**The kernel is real, and small.** Five ideas in this repo are true and worth building a product on:

1. A player types `ssh <room>@<host>` and is sitting at a live table. There is nothing to install and no account to make.
2. The campaign is a plain, append-only JSONL log on the GM's disk that the GM owns outright.
3. All randomness is resolved when a command is accepted and written into the event, so replaying the log never re-rolls or reads files.
4. The GM's machine is the authority, because a game has a GM anyway. It dials out, so no port forwarding is needed.
5. Your SSH key is your account.

A sixth is a strong pitch that costs nothing to build: plain files mean any coding agent can work with your campaign.

**The build is not a tabletop yet, and it is not close.** After 174 commits and about 26k lines of product TypeScript:

- **No damage:** in the Draw Steel module you cannot deal damage, heal, or track current Stamina.
- **Unreachable commands:** eight of its 14 commands exist in the rules code but can't be reached from any key or command. Enemies are just names.
- **No names:** players show up as `player-1`.
- **Typing breaks the game:** chat typed while focus is off the message line fires single-key commands. Those commands write permanent events into a log that cannot be undone. I did this three times by accident in my first ten minutes.
- **Nothing is live:** supervillain.app has no DNS address record, and the deploy workflow has never run.
- **CI has been red on `main` since Aug 22.**
- **No one has ever played it.** The usability playtest issue (#124) is open and unassigned.

**Why it ended up here:** decisions replaced play as the feedback loop.

- 36 ADRs and about 284k words of agent docs were produced in about two months.
- They answered, with finality, questions no user has asked yet: self-hosting TLS postures, key-equivalence graphs, operator takedown policy, capacity caps, authority handoff, three map rendering tiers.
- Each decision was reasonable locally. Together they are why the game can't deal damage.

**The single biggest architectural call:** today the gateway renders every player's screen. Instead, **the GM's machine should render, and the gateway should be a dumb relay of terminal bytes.**

- That one move deletes most of the transport and gateway complexity.
- It ends version skew between the hosted gateway and GM binaries.
- It makes hosting nearly free again.

(§6)

**The plan:**

1. **Freeze.** Archive the current tree.
2. **Hill-climb eleven basic questions** until each is settled: who plays first, how they get in, how the keyboard works, who renders, how much Draw Steel, what's on screen, what the map is, undo, names, the log contract, reachability. Settle them with cheap throwaway prototypes and play, not with ADRs and not by patching the archived build.
3. **Rebuild small:** one game, one layout, one relay, roughly a quarter of today's code.
4. **Play every week.** Earn every platform feature back only when a real table asks for it.

---

## 2. The state of things, by the numbers

|  |  |
| --- | --- |
| History | 174 commits, 2026-07-11 → 2026-09-10. 81 of them in one week (W30); 3 in the four weeks since Aug 28; none in the last 15 days |
| Product code | ~25.6k lines of non-test TypeScript, ~23.4k lines of tests. The Draw Steel module is 1,770 lines, about 6% |
| Agent docs | ~284k words under `.agents/` (research included). 36 ADRs ≈ 39k words, median about 1,000 words each |
| The "spine" | `product-definition.md` is 9.3k words with **55 inline "Correction" paragraphs**. Several claims are corrected more than once; understanding the current product means mentally applying every patch |
| Decision churn | 30 ADRs in 52 days. 12 were amended by later ADRs. 8 describe features that do not exist (spectating, explainers, takedown, per-identity rate limits, layout persistence, the web map font, the viewport floor, `--json` everywhere) |
| Source comments | ~380 ADR/issue references in `src/` comments. Several are policy essays: _"pull is pillar infrastructure, free at every rung of the sovereignty ladder"_ |
| CI | Red on `main` since Aug 22; last green Aug 12. `bun run check` fails with 933 lint errors and 27 unformatted files |
| Tests | All suites pass locally (~750 tests). Clean build 1.3 s. TypeScript 7 native is the one tooling bet that clearly pays off |
| Live | `supervillain.app`: no A/AAAA record. Deploy workflow: 0 runs. The web landing page reads "under construction." The README tells GMs to hand players `ssh <room>@supervillain.app`, which doesn't resolve |
| Releases | v0.1.0, v0.1.1, v0.2.0 (last on Jul 27). The binary reports version `0.0.0` |
| Users / playtests | 0 / 0 |
| Commit style | Mean subject line 156 characters, longest 2,371. All of the last 15 are 310–2,371 characters, so `git log --oneline` is unusable |

---

## 3. What happened when I sat down at the table

The core loop works, and that deserves credit.

- **As GM:** `supervillain create <folder>` opened a clean TUI.
- **As a player:** I ran a local gateway (`supervillain gateway serve`), re-hosted through it, and `ssh`'d in with a brand-new key.
- **Chat:** messages round-tripped both ways.
- **The log:** `events.jsonl` is legible, greppable, and exactly what the pitch promises:

```jsonl
{"actor":"a3b7…4235","payload":{"gameId":"draw-steel"},"seq":1,"timestamp":"…","type":"core.room-created"}
{"actor":"a3b7…4235","payload":{"modifier":2,"notation":"2d10+2","rolls":[4,1],"total":7},"seq":3,"timestamp":"…","type":"core.dice-rolled"}
```

Then, in the first ten minutes:

- **Chat became game actions.** Pressing Enter in the message line sends focus back to the pane you came from. Letters typed there are single-key commands, and every result is permanent.
  - As GM, I sent `/roll 2d10+2`, then typed "the goblins ambush you at the bridge". The Initiative panel read that as keys: it **started an encounter and added a hero named "mbush you at the bridge"**. Both are now in the log forever.
  - As a player, I typed "ok rolling now". `r` opened roll setup, `i` picked Intuition, and Enter **rolled a real power roll** that everyone saw.
  - At startup focus sits on the Feed, so typing `/map load cavern` there collapsed the Feed (`c`) and changed the layout (`v`).
  - ADR-0030 names exactly this as the condition for reopening the focus design ("if players' first instinct is to type and their words vanish into hotkeys"). No one ever ran the test.
- **Nobody has a name.** Seats are `gm`, `player-1`, `player-2`, and the feed reads `player-1: hi, is this thing on?`. The sidebar's tab label is the internal id `[ds-initiative]`.
- **Remote players see the GM as absent** (a hollow ○) while the GM is sitting at the table on the local terminal.
- **Draw Steel is a turn tracker and a dice calculator.**
  - What works from the keyboard: start and end an encounter, add a named combatant, take a turn, power roll, and page through sheets.
  - Conditions, heroic resources, recoveries, surges and victories have rules code, events and render strings, but no key or command reaches them.
  - Stamina is shown as a maximum; current Stamina doesn't exist.
  - Enemies are a name and a side, with no stats.
  - There is no Malice and no initiative roll.
- **The map is hard to read.**
  - The default "pixel" tier draws with Unicode 16 octant characters, which many terminal fonts render as empty boxes, and nothing detects this.
  - At 80×24 it shows a 5×5-tile window of the map with no indicator of what's off-screen.
  - Token letters are replaced by decorative pictograms (the `V` for Vex is not a V). Your own token is the same green as difficult terrain, and a goblin is the same colour as a door.
  - Switching to the text tier shows the honest ASCII map, pinned top-left in a mostly empty frame.
- **The lobby greets every newcomer with an error.** Bare `ssh supervillain.app` always sends your local Unix username, so the first line is _"no table named 'oscargabriel' is registered here."_ Its "become a GM" screen also tells people to run `supervillain create <name>`, but the command takes a folder.
- **The sidebar ignores the game's colours.** `chrome.ts:1092` joins the text runs and drops their styling, so Draw Steel's accents never reach the screen.
- **The Feed rebuilds everything on every event.** Measured against the real renderer, adding one chat line costs **0.55 ms with 20 lines of history and 119 ms with 1,500**. That cost is per seat, on the gateway's single thread, and three hours of play gets there.

A player who has used Owlbear Rodeo or Foundry would leave within a minute. So would a terminal enthusiast who loves lazygit or btop: there are more borders than information on screen.

---

## 4. Why it ended up here

These are root causes, not symptoms. Every one is fixable.

**1. Decisions replaced play as the feedback loop.** The loop was: surface a question, "grill" it with an agent, ratify it in an ADR, build it, then correct the ADR.

- The only real signal that loop can produce is internal consistency.
- Many "revisit triggers" can only fire from user data the project never collects: tofu reports from real terminals, "more than 1 in 5 join attempts land on an offline host", playtest gates.
- The research corpus actually found the right answers:
  - rules depth beats presentation (Alchemy is the cautionary tale);
  - illegibility is the #1 complaint across every SSH app studied;
  - the unit of adoption is the whole table, and any friction for the least technical player kills it.

  The build then went the other way: three map rendering tiers, and a Draw Steel module with no damage.

**2. "Never reopen, only correct" turned the docs into layers of sediment.** `AGENTS.md` forbids re-deriving the definition, so the only allowed move was to append a dated correction.

- The definition is now a pile of patches, many of them corrections of corrections. ADR-0012 contains a correction explaining that "DB" meant "DEFINITION BUGS", not database.
- ADRs amend ADRs: 0029 amends seven, 0030 amends five, 0026 lasted five days.
- The docs describe history, not the present. For both humans and agents, reading them costs more than reading the code.

**3. It studied builders, not players.**

- About 400 KB went to late.sh, an SSH chat app whose only hard public number is 56 opt-in profiles.
- About 37 KB went to Foundry and the entire VTT market.
- There were zero interviews and zero playtests.
- The research folder is also gitignored, while 12 tracked ADRs link into it, so those links are dead in the public MIT repo.

**4. The platform came before the product.** Everything below was built or specified before one table was playable:

- identity: key-equivalence graph, device and adoption link codes, identity aliases, revocation lineage, and a loopback "identity conduit" HTTP server;
- self-hosting: three TLS modes, hand-rolled X.509/ASN.1, pairing codes with pinned fingerprints, a `forget` verb, and a gateway role in the same binary;
- publishing: a TanStack Start + Hono + Drizzle web app, capability tokens with an HMAC key escrowed off-box, OG cards, operator takedown, and publisher-warranty policy;
- infrastructure: Ansible, Litestream, restic drills on every CI push, and capacity benchmarks;
- governance docs: a "sovereignty ladder", a "reach checklist", and an authority-handoff design.

Each is defensible on its own. Together they explain the missing damage command.

**5. Having the gateway render is the complexity engine.** Because every player's TUI is drawn on the gateway, the gateway must:

- contain the view code of every game (`apps/gateway/src/index.ts` statically imports Draw Steel and the fake test game);
- keep a replica of every live room's state, with checkpoints, lag budgets and grace windows;
- catch up over a stop-and-wait credit protocol (one round trip per event, invisible on loopback, slow over a real network);
- live under a single-JS-thread ceiling of about 1,100 ms of CPU per second (the R9 benchmark: p95 key-to-frame of 100 ms at 32 chatting seats, 394 ms at 50);
- carry a privacy policy for game content it reads but promises not to store.

It also means **the hosted gateway's version of Draw Steel decides what every player sees, not the GM's binary**. If a GM runs a newer release than the gateway, the gateway silently skips the new event types. No ADR addresses this.

**6. The tooling is sized for a team of ten, and some of it only looks like it's working.**

- The dependency-cruiser boundary rules ("the lattice, mechanically enforced from day one") can't resolve 116 of 134 workspace imports (#140). For a stretch they checked zero modules while reporting green.
- Keeping them running requires three installed TypeScripts (5.9, 6.0, 7.0) and a postinstall symlink.
- A dual Bun/Node test lane protects a Node runtime nobody uses.
- A custom "anti-slop" lint plugin with every rule at `error` turned CI red the day it landed, and fails its own format check.
- The backup job never backed up the web database: Litestream watched `*.db`, and the file was named `web.sqlite`.
- One benchmark measured silence for three weeks and read it as a 60× speedup.
- CI red for six weeks teaches everyone to ignore CI.

**7. The writing style is itself a cost.**

- ADRs run legalistic, as in _"The header law (the free-tier floor)…"_.
- Commit subjects are paragraphs.
- User-facing `--help` text cites "ADR-0015".
- The glossary coins a word for everything (Pane, Panel, Slot, Rail, Door, Role, Posture, Rung, Ladder, Egress, Handoff, Offer, Standing decision), and then has to fence each one off from the others with "_Avoid_:" lists.

---

## 5. The kernel: what survives

### Ideas that are true

| Idea | Keep as |
| --- | --- |
| **`ssh room@host` puts you at the table.** Zero install is the whole wedge, and the only real "wow" in the product today | The first thing everything is judged against. The friction target is **the least technical player at the table** |
| **The campaign is a plain append-only log.** Envelope `{actor, seq, timestamp, type, payload}`, JSONL, replay = fold | The data model. Spec it on one page; it outlives the product |
| **Randomness and derived facts go in the payload.** Replay never rolls and never reads files | A hard rule of the engine |
| **The GM's machine is the authority, and it dials out** | The topology. Strengthened in §6: it renders too |
| **Your SSH key is your account** | Kept, simplified: one key, one identity. Names are separate (§7, Q9) |
| **Plain files are an agent surface** | A pitch line and a folder README. No machinery |
| **The GM is always in the loop** | Nothing auto-resolves; the GM can fix anything. That now includes **undo** (§7, Q8) |
| **Writers halt, readers tolerate** | Three lines in the log spec, not an ADR |

### The founding "pillars", re-judged

| Pillar | Verdict |
| --- | --- |
| "Your key is your account" | **Keep**, minus the equivalence-class machinery |
| "You own your campaign" | **Keep.** The strongest promise, and true by construction |
| "GM-hosted is the center of gravity" | **Keep, and go further:** GM-hosted _and_ GM-rendered |
| "Free core, forever" | **Moot until someone plays.** A dumb relay costs bytes, not CPU, so "it costs us almost nothing" becomes honest again |
| "System-agnostic core, Draw Steel first" | **Demote to aspiration.** Be the best Draw Steel table. Extract a seam when a second real game exists; a fake module is not a second game |
| "Three surfaces" | **One surface** (the table over SSH) plus the CLI. The web waits |
| "Pinned verbs `create`/`join`/`publish`" | **Meaningless.** Design the CLI from what GMs actually do |
| "Sovereignty invariant" | **Keep as a design taste** (it works on a LAN with no internet), not a review gate |
| Name, domain, restrained brand voice | **Keep.** Don't spend time here |

### Code worth lifting into the rebuild (copy with care, not wholesale)

- **The log mechanics:** append, fsync, strict replay, and the fold tests. Fix the writer (§11, bugs 2 and 6).
- **The map file format:** the parser/validator and the pure token folds in `packages/core/src/map.ts`. The format is good: plain text, NetHack-ish, hand-editable.
- **Dice:** the notation parser and roller.
- **Draw Steel:** the power-roll tier math and the character-file validator.
- **Identity:** key generation in `packages/identity`. One ed25519 key doubles as an OpenSSH key, which is clever and worth keeping.
- **Terminal abstraction:** `packages/session`'s `TerminalConnection`. It's exactly the right abstraction for §6.
- **Parsers:** the input-line parser in `packages/table/src/input.ts`.
- **Release:** `install.sh` and the release pipeline (four platforms, checksums, codesign). They work.
- **Tooling:** Bun, TypeScript 7 native with `tsc -b`, and oxlint/oxfmt on defaults.
- **Libraries:** OpenTUI as the renderer and `@opentui/ssh` as the SSH server. Keep the two small patches only if they're still needed.
- **Copy:** the honest status lines ("whether the command landed is unknown").

### What goes (to the archive tag, not the bin, so nothing is lost)

| Thing | Verdict | Why |
| --- | --- | --- |
| Gateway rendering, per-room fold replicas, checkpoints, lag budgets, grace windows | **Replace** | §6 |
| The multiplexed pipe: frames, 32 KiB chunking, credits, custom heartbeats, round-robin "fairness" | **Delete** | WebSocket or SSH already do all of it. The fairness claim is false because the sender never reads `bufferedAmount`. Inbound reassembly is unbounded, which lets a peer exhaust memory |
| The direct RoomStore protocol plus its test copies (~1,400 lines) | **Delete** | Zero production callers |
| Hand-rolled X.509/ASN.1, pairing codes, pinned-fingerprint store, three TLS modes, `gateway forget` | **Delete** | Use SSH for the Host link (§6), or a real certificate |
| Key linking, equivalence graph, adoption codes, aliases, identity conduit on `:3002`, revocation lineage | **Freeze** | One key, one identity. Bring linking back when a real GM asks. Notably, **linking already fails for game commands** (§11, bug 3) |
| `apps/web`, publish API, capability tokens, escrowed HMAC key, OG cards, Drizzle, takedown and warranty policy | **Freeze** | No one to share with. Replace with `supervillain export` to a self-contained HTML or Markdown file |
| `infra/` (Ansible, Litestream, restic, healthchecks) and the CI backup drills | **Delete** | The relay's durable state is at most a table of room names. One systemd unit or container will do when it's needed |
| Pixel-glyph and kitty bitmap map tiers, the atlas, MEKMODE, `live-leg-wizard.sh` | **Freeze** | ~33% of table/atlas effort for three encodings of five terrain types. MEKMODE ships on informal permission only, a licence risk. Make the text tier great instead |
| Rails, the six-stage "demotion ladder", three layouts, focus-marker preference, presentation-prefs table, teach-once explainers | **Delete** | One good layout (§7, Q6) |
| `Offer`, standing decisions, `EventGrammar`, key-surface types in core, the four-entry-point module lattice, the fake game in production | **Delete or defer** | One game, written concretely. `offers` is a good idea for later ("eligibility lives in one place") |
| Spectating, authority handoff, `campaign pull` as built, sovereignty ladder, reach checklist, capacity caps and R9 re-runs | **Delete the docs** | Revisit when a user's problem points at them. `campaign pull` today copies a local folder the caller already has |
| dependency-cruiser + TS 6 pin + postinstall symlink, dual Node lane, macOS-x64 CI gate, anti-slop plugin at `error` | **Delete** | Package boundaries plus `tsc -b` project references enforce what matters |
| The ADR corpus, the glossary as written, the product definition | **Archive** | Replace with one short, living doc that describes the present (§9) |

---

## 6. The big call: the GM's machine renders, the gateway relays

Three independent review passes converged on this, and so did I.

```
TODAY
  player ──ssh──▶ GATEWAY ──────────────── wss pipe ───────────── HOST (GM machine)
                  terminates SSH                                  owns log, runs decide
                  replicates every room's state (apply)
                  imports every game's view code
                  renders one OpenTUI screen per player  ◀── the cost, the skew, the policy
                  checkpoints, lag budgets, grace windows
                  multiplexed frames, chunking, credits, custom TLS pinning

PROPOSED
  player ──ssh──▶ RELAY ─────────── one SSH connection (dialed out) ─────────── HOST
                  terminates SSH (to learn player key + room)                    owns log, runs decide
                  forwards raw PTY bytes + resize + player key                   renders one screen per player
                  knows nothing about games, logs, or rendering                  (local GM is just another screen)
```

**What disappears:**

- the gateway's copy of every room's state, and its checkpoints;
- `RoomFold`, the credit protocol, frames and chunking;
- the gateway's game imports, and with them all **version skew** (the GM's binary is the single source of truth for what everyone sees);
- the render-CPU capacity ceiling and its benchmarks;
- most of `room-wire` and much of `apps/gateway`;
- the rule "the gateway never imports `decide`", which becomes moot.

**What gets simpler:**

- **The Host link can be SSH itself.** The Host dials the relay with its ed25519 key, and the relay opens one channel per player. SSH brings mutual key auth, `known_hosts`-style first-use trust, multiplexing, flow control and keepalives. That replaces the custom handshake, the custom TLS and the custom framing.
- **LAN play needs no relay:** the GM's binary is the SSH server, so players run `ssh -p 2222 gm-laptop.local`.
- **Self-hosting the relay** means running a few hundred lines anywhere.

**What it costs, honestly:**

- **Latency.** Each keystroke now travels player → relay → GM → relay → player, where today it's player → gateway → player. With a relay in the right region that's roughly 40–120 ms instead of 20–60 ms. For a turn-based game that's likely fine, but it's the first thing to measure (Spike A).
- **GM upload bandwidth.** Measured frames are about 340 bytes per chat line per seat and 3–5 KiB/s per active seat. Six players is tens of KiB/s, which is trivial.
- **GM CPU:** negligible for up to 8 screens.
- **Privacy is unchanged by default:** the relay sees terminal bytes where today's gateway sees events. A free upgrade path to true end-to-end is `ssh -J relay room`, where the relay forwards TCP and the GM's binary terminates SSH, so the relay sees only ciphertext.

**The even-simpler version for the first playtest** needs no relay at all: the GM runs `create`, which listens on a port exposed through Tailscale, `bore`, or `ssh -R` to any VPS. It's ugly, and it's playable this week.

---

## 7. Hill-climbing: the basic details to settle first

Each question below comes with my current recommendation and a concrete test. **Settle them by building throwaway prototypes and playing, not by writing ADRs.** Work top to bottom; later questions depend on earlier ones.

"Dead-set" means the test was run with real people and passed. Record the outcome in §9 of this file in one or two sentences, replacing the recommendation.

**Q1. Who is the first table, and what is the first session?**

- **Recommendation:** your own Draw Steel group, or any three to five friends, for one real, combat-heavy session of about three hours. Everything else serves this.
- **Test:** a date on the calendar and a named group.
- **Dead-set when:** that's scheduled.

**Q2. What does a player type, and what do they see in the first ten seconds?**

- **Recommendation:** `ssh <room>@<host>`. The first run asks "what should the table call you?", the name is remembered by key, and then you're at the table. No lobby on the direct path.
- **Test:** three non-terminal friends and a stopwatch.
- **Dead-set when:** all three are seated in under 60 seconds without help.

**Q3. How does the keyboard work?**

- **Recommendation:** chat first, as MUD and IRC clients have done for thirty years.
  - The input line always owns the keyboard.
  - Everything is a `/command` with tab completion, including `/dmg vex 7`, `/cond goblin-2 slowed eot`, and `/turn`.
  - Panes scroll with PgUp/PgDn and the mouse.
  - Single-letter hotkeys exist only behind an explicit leader key (Esc, or Ctrl-Space).
  - Panels become displays first and controls second.
- **Test:** a clickable prototype and the same three friends.
- **Dead-set when:** a full session produces zero accidental commands.

**Q4. Who renders?**

- **Recommendation:** the Host (§6).
- **Test (Spike A):** serve today's local-TTY table over SSH from the GM machine through a throwaway relay on a real VPS. Measure keystroke-echo latency from two real networks and GM upload with five simulated players.
- **Dead-set when:** p95 echo is under 150 ms. If it fails, fall back to gateway rendering (simplified), or to a local-render `join` client.

**Q5. What is the minimum Draw Steel that runs a real combat?**

- **Recommendation:**
  - heroes from files, or imported from Forge Steel (check its licence);
  - monsters from stat blocks, with Steel Compendium as a possible data source (check licence and provenance);
  - initiative with sides alternating;
  - current and temporary Stamina, damage and healing, winded and dying;
  - conditions with durations (end of turn, save ends);
  - heroic resources and Director's Malice;
  - power rolls tied to a named ability, with the tier result printed;
  - recoveries and victories.
- **Details that worked in the dropped 1a patch:**
  - a creature is added as "Goblin 15", and a trailing number is its Stamina;
  - commands name targets by exact name first, then a unique prefix. An ambiguous prefix is refused with the candidates ("'gob' could be Goblin or Goblin Archer");
  - a player may change only their own hero's Stamina; the GM may change anyone's.
- **Test (Spike C):** run a published Draw Steel encounter start to finish on paper, then with the tool as the only state.
- **Dead-set when:** nobody reaches for paper.

**Q6. What is on screen?**

- **Recommendation:** one layout, designed at 100×30 and checked at 80×24:
  - a top band with initiative and Stamina meters (`Vex ▐██████▌ 14/21 · slowed`);
  - the map;
  - a feed with names;
  - the input line.
- **Test:** screenshot review, then the playtest.
- **Dead-set when:** every combatant's state is visible without navigating anywhere.

**Q7. What is the map, minimally?**

- **Recommendation:** the text tier, done well.
  - Two-character-wide cells so squares look square; auto-fit and centre; off-screen markers.
  - Letters for tokens, with role colours (hero, enemy, GM) that never collide with terrain.
  - The GM moves anything; players move their own token.
  - `/dist a b` shows distance, and moving a token highlights where it can reach.
- **Test:** the playtest encounter.
- **Dead-set when:** players answer "can I reach him?" from the screen.

**Q8. What happens after a mistake?**

- **Recommendation:** the GM can undo any event with a corrective event (e.g. `core.retracted {seq}`), which the fold honours. Append-only does not have to mean no undo. Players can retract their own last command within a short window.
- **Shape that worked in the dropped 1a patch:**
  - undo takes back the latest batch (every event from one submission), newest first;
  - the fold keeps a bounded stack of state snapshots (20 deep) taken before each retractable event, and a retraction restores the one before the lowest seq;
  - game, map and token events are retractable; chat, dice, seats and names never are;
  - the feed says what was undone: "↶ Oscar undid: Vex takes 14 damage → 7/21 · winded".
- **Test:** deliberately fat-finger things during the playtest.
- **Dead-set when:** every accident is reversible with one command.

**Q9. Names and identity.**

- **Recommendation:**
  - One key is one identity.
  - The display name lives in the log (`core.name-set`), so it replays and travels with the campaign.
  - Keyless guests pick a name for the session and nothing more: no adoption codes, no linking.
  - Optional later: fetch `github.com/<user>.keys` to show `alice (Vex)`.
  - A name is trimmed, whitespace-collapsed, 1–24 characters with no control characters. The feed labels an actor by name, then seat, then key prefix.
- **Dead-set when:** the feed reads like people talking.

**Q10. What is the log contract?**

- **Recommendation:**
  - keep the envelope;
  - write a one-page spec: fields, the ordering guarantee, "readers tolerate unknown types", and shipped shapes stay readable;
  - compute the next state _before_ writing, so a crashing rule can't corrupt the log;
  - on open, cut a half-written last line back to the last newline;
  - use one fold with a `strict` flag, not three copies.
- **Test:** kill -9 the Host mid-write, and throw inside a rule, in automated tests.
- **Dead-set when:** those tests pass and a real session's log reads cleanly by eye and with `jq`.

**Q11. How does the first table reach the GM?**

- **Recommendation:** for prototype sessions, a tunnel (Tailscale, `bore`, or `ssh -R`). For Session Zero, the §6 relay on a small VPS behind a real DNS name.
- **Dead-set when:** the friends reached the table without the GM on the phone walking them through it.

**Explicitly deferred, with the trigger that reopens each:**

| Deferred | Reopens when |
| --- | --- |
| Sharing or publishing | A player asks to share a sheet or a recap |
| Multi-device keys | A GM hosts from two machines |
| Public self-hosting docs | Someone asks |
| Hosted persistence and a paid tier | Tables regularly fail because the GM's machine is off |
| A second game | Draw Steel is deep enough that its players stop asking for things |
| A website beyond one static page | There's something to launch |

---

## 8. The plan

**Phase 0: stop and archive (a day)**

- Push the 8 unpushed commits. Tag the current `main` as `archive/2026-09-exploration`; nothing is lost.
- Freeze the backlog: close or label every open issue `frozen`. Stop writing ADRs and research.
- Rewrite `AGENTS.md` as one page:
  - docs describe the present and get rewritten freely, since git holds the history;
  - no ADR without code in the same change;
  - product decisions come from play;
  - commit subjects are at most 72 characters;
  - a red CI gets fixed or the rule gets turned off the same day.

_Status (2026-09-27): commits pushed and `archive/2026-09-exploration` tagged and pushed; `AGENTS.md` rewritten. Backlog freeze pending._

**Phase 1: hill-climb (about two weeks)**

- **1a. Spike A**, the render location (Q4). Throwaway code.
- **1b. Spike B**, chat-first input plus the one-layout mock, clicked through by two or three people (Q2, Q3, Q6).
- **1c. Spike C**, Draw Steel combat on paper, producing a command list and data sources (Q5).
- **Output:** §9 below, filled in and dead-set. No other documents.

_Spikes A and B import the archived packages, so they live at tag `archive/2026-09-spikes` and run from a worktree of it (`git worktree add ../supervillain-spikes archive/2026-09-spikes`). Spike C is paper only and stays in `spikes/`._

_Dropped (2026-09-27): a scratch session on the archived build. Four patches (input-line focus, `/name`, `/dmg` and `/heal`, GM `/undo`) worked end to end but cost about 1,240 lines across 21 files plus about 30 rewritten tests. That is editing the old code, which this plan exists to stop. The design lessons are folded into Q5, Q8 and Q9. The code is in `git stash` as "phase-1a scratch patches (dropped 2026-09-27)"._

**Phase 2: rebuild small (about three to five weeks, a guess)**

_Status (2026-10-21): started, in parallel with Phase 1 rather than after it. The tree on `main` was cleared to a fresh skeleton; the first milestone is a table friends can sit at, not the product. It has fewer packages than the sketch below: `packages/engine`, `packages/ssh` (our SSH server on ssh2) and `apps/supervillain`, with the table, Draw Steel and the relay as folders in the app until a boundary hurts. The architecture is the one Spike D tested (§9). Slices 1 to 6 are done, test-first: the engine (the log reader, the fold, `CampaignLog` and the single-writer `Room`); the SSH table with names and chat (`supervillain host`, with exec for one command at a time); the chat-first input and layout; minimum Draw Steel (sheets, import, combat and the band); undo and the text map; and the relay (`supervillain relay`, `host --relay`) with release binaries for Linux and macOS (`scripts/`, `.github/workflows/release.yml`) and the player and host guides in `docs/`. Session Zero now needs people and a date (Q1), a small VPS with a DNS name running the relay (Q11), and one real-network latency run through it (Q4)._

A starting sketch, to be revised by Phase 1:

```
packages/
  engine/       envelope, log append/replay, room reducer {core, game},
                host loop, core commands as a module     (target ≈ 800 lines)
  draw-steel/   rules as decide/apply + its panels, one package, no entry-point lattice
  table/        OpenTUI UI as components over one store; text map; chat-first input
apps/
  supervillain/ one binary: create (host + render + dial the relay), export, check
  relay/        dumb SSH relay, ≈ 300–500 lines (or `supervillain relay` in the same binary)
```

- **Tooling:** Bun, TypeScript 7, `tsc -b`, oxlint and oxfmt on defaults, `bun test`. CI on one OS: build, test, lint. Keep the existing release pipeline.
- **Size:** a rough target of 6–8k lines, against about 26k today, with more game in it.
- **Milestone, Session Zero:** the group from Q1 plays a real Draw Steel session on the rebuilt table, reaching it at `ssh <room>@<relay>`, with no paper and no one walking anyone through setup.

**Phase 3: play every week**

A standing session. After each one, fix what the table hit, and keep a short "what we learned" list in §9. Features get built because a session needed them.

**Phase 4: earn the platform back, only on triggers**

In likely order:

1. The public relay at supervillain.sh and a one-page static site.
2. `supervillain export` to HTML or Markdown recaps.
3. Everything in §7's deferred list, each when its trigger fires.

---

## 9. Decisions (living; fill in as each question is settled)

_Each entry: the question, what was decided, and the evidence (a date and what happened at the table). Rewrite entries in place when evidence changes them; don't append corrections._

- Architecture — **decided.**
  - Rules are pure `decide`/`apply` functions, and one command registry drives parsing, completion and help on every surface.
  - Effect 4 (exact pin) runs the host edge: the log file, the single writer, and one scope per SSH session. Solid and OpenTUI 0.6.6 render one App on the GM's terminal and every SSH seat.
  - Evidence (2026-10-20): Spike D (`spikes/d-effect-table/`). Two adversarial test rounds with real OpenSSH clients passed all nine behaviour claims: seated in about 100 ms; plain text never fires a command; replay never rolls; 800 concurrent rolls without a duplicate `seq`; `kill -9` mid-burst reopens cleanly. Then a live run by hand, which worked.
  - The relay's trust handshake, Spike D's open question, is built (see Q4 and Q11): no trust comes from plaintext, the relay pins each room's GM host key and the GM pins the relay's key. Our SSH server (`packages/ssh`, on ssh2) replaced the `@opentui/ssh` internals Spike D leaned on.
- Q1 — _open_
- Q2 — _open_
- Q3 — _open_
- Q4 — _open._ Local run (2026-09-27): rendering on the GM machine adds about 2–4 ms over the network round trip. Performance run on this build (2026-10-21, 8 seats at 120x40 with the ford map loaded, direct and through the relay alike): 8 seats chatting once a second cost 93.5 KB/s of GM upload, and with a combat running 105–107 KB/s (0.86 Mbit/s; 1 s p95 129–132 KB/s). Per event per seat that's about 1.6 KB for chat and 2.4 KB for a combat event on the ford map; on a 60x40 map at 120x40, 364 B for chat and 616–810 B for a move. A realistic 1–2 events a second with 8 seats is about 15–40 KB/s. Host time per seat per event, after the band and the map stopped being rebuilt on every change (bench, 8 seats at 120x40, 60x40 map, 30 tokens, in combat): about 2 ms for a chat line and 4 ms for a move, against 11 ms for either before; steady RSS in that bench fell from about 820 MB to 350 MB. Spike D's SSH-in-SSH relay (2026-10-20) adds about 0.5–2 ms per hop on loopback. Built so far (2026-10-21, from tests and live runs, not yet play): the GM's binary renders every seat, and `supervillain relay` only carries bytes. Each player's session is a channel on the room's one GM link, with the player's key as `SV_ACTOR`, their pty, window changes, data both ways, EOF and exit status. End-to-end tests run a real relay, a headless host and OpenSSH players (exec and a pty) as separate processes, and the compiled linux-x64 binary did the same by hand. The real-network run is still to do; see `spikes/a-render-location/README.md` at tag `archive/2026-09-spikes`.
- Q5 — _open._ Built so far (2026-10-21, from a three-round live run of the sample fight and a read of the rules text, not yet play with friends): `/end` loses unspent heroic resources, surges and Malice, and ends temporary Stamina and every condition (Combat, "End of Combat"); a respite (`/rest`) skips the dead and turns Victories into XP; an ability's cost is spent with its power roll, from the hero's resource or the Malice pool, and an ability with no roll is used through `/pr` (its cost spent, its effect told); the roll's line carries the ability's effect, and `/pr … on <targets>` deals the tier's damage to each target and names one past the ability's reach (the rehearsal's scribe tally counted about 45 copies of a roll into `/dmg` across two encounters); bleeding (a dying hero's included) costs 1d6 + level Stamina after a main action (`/move … main` included), a triggered action or a Might or Agility roll, rolled into a `ds.bled` event; a creature's half-Stamina trait is quoted when it gets there; XP is kept per hero and shown on `/sheet`; a hero who dies loses their conditions, and Victories go to the living; a resource goes below 0 only where the sheet sets `resource.min`; a squad's minions free strike together with `/fs … xN`, typed if the GM names a type. Not modelled yet: splitting a squad's free strike across targets, opportunity attacks, an effect's mechanics (Form Up's shift, an edge on the next strike), a squad's captain (its `withCaptain` text shows on `/sheet`, the GM applies it), "immunity all" from imports, and a squad's minions as separate tokens (see Q7).
- Q6 — _open._ Built so far (2026-10-21, from the Session Zero rehearsal at 80x24 and the tests): when the band is short of room, creatures' names shorten, then heroes' Recoveries go, then each hero keeps one row (its last conditions or resource cut with `…`, all of it on `/sheet`), then the `dead:` line (dead heroes too) goes before any living row; beside the map, the map gives up rows before a living enemy is hidden, so at 80x24 the sample fight (four heroes, the chief, two bruisers and two squads) shows every living combatant's Stamina, healthy or mid-fight, with the feed's three rows (the rehearsal had hidden up to every creature, the chief included). A cropped map names the rows and columns it shows in its title.
- Q7 — _open._ Built so far (2026-10-21, from review, the tests and live runs of the sample map and a 50x30 keep at 100x30 and 80x24 with a GM and players, not yet play): maps are text files (`maps/<id>.txt`, the file name a lower-case id: `.` floor, `#` wall, `~` difficult, space outside and nothing else, so no square passes for a token; up to 60x40), loaded by the host into the event; replay checks only a grid's shape, not today's limits. Squares are typed `c5`, columns `a`… then `aa`, labelled on two rows past `z`. Cells are two columns wide; heroes, the Director's creatures and your own hero have their own colours, terrain only greys and olive; reach is a tint plus `•`, or `≈` on difficult terrain. Marks are names: commands take `b1` or `B` (case-sensitive), a placed token's mark wins over the square it spells in `/dist`, and the band shows each placed combatant's mark; a creature's mark starts with the initial of its name's last word, so a block keeps its mark between fights (the rehearsal saw the same squad as `bA` in one fight and `cA` in the next); past 9 it is that initial and a digit. Movement costs 1 a square, diagonals too, with difficult terrain and enemies' squares +1; only walls fill a corner. In combat a player moves only on their hero's turn, up to its speed over the whole turn, twice that with `main` (the main action as a move, Combat, "Main Actions"); the event stores what the turn has spent, and the reach shows what's left. Push, pull and slide take stability off and slam per the rules text; nobody force moves themselves; a pull without `to` takes the straight line that ends closest; `to` a wall or creature (a pull's own source included) slams with everything left; the map's edge stops it and the feed says so; range isn't checked, but the feed says how far a non-adjacent source or free striker stood. Rulings and gaps: a diagonal past one wall square is a slam ("completely fills the corner" read as one wall square on either side); who holds a grabbed creature and size (Combat, "Big Versus Little") aren't modelled; a minion squad is one token on one square, so a push moves the squad and a slam hits its pool once, unlike the rules' one creature per minion (Combat, "Size and Space"). The map stacks between band and feed and edges give rows to markers only toward tokens past them; a big map follows the acting creature, else the seat's hero, else the spot showing the most tokens, and `/view <square|who>` centres it until the turn passes; `/view map` folds the band to two lines. At 80x24 the sample fight shows 4 of the ford's 10 rows beside a full band, which takes the rows its living combatants need first (tests, 2026-10-21), with no blank marker rows, and 9 in `/view map` (live run, 2026-10-21); on a 50x30 keep the GM sees the heroes' cluster between turns, other tokens named with arrows in the bottom border. Pictures and generated maps (2026-10-22, built from three prototypes on the `prototype/map-art`, `prototype/set-world` and `prototype/map-gen` branches, not yet play): a seat in a terminal with kitty graphics, outside a multiplexer, may draw the map in MEKMODE's pictures (`/view pictures`), squares four columns by two, tokens a figure in their side's colour with their mark; elsewhere the map stays text, since the prototype's block fallback made marks unreadable. The picture goes zlib-compressed, about 25–35 KB a move per seat on the ford against about 1 MB raw (prototype, Ghostty over our SSH seat). Each seat's picture is painted at its terminal's cell size in pixels, when the terminal says it, so the terminal doesn't scale MEKMODE's pixels blurry; until it does, and on an SSH seat at the 300x100 size cap, a square is 36 pixels as in the prototype. Measured in a bench (2026-10-22, zlib at its fastest level and base64, as sent), a ford picture with eight tokens is 36 KB at 36 pixels a square, 43 KB at 10x20-pixel cells and 121 KB at HiDPI's 20x40 (4.9 MB raw), and a generated 24x14 crossing 139, 152 and 367 KB, so a HiDPI seat costs about three times as much a move. Maps may be written in MEKMODE's Ding Mode letters (`style: mekmode`), which the legend turns into the rules' terrain, the letters riding in the map event for the pictures; `supervillain map crossing|keep` generates one from a seed. MEKMODE (MEK.txt) is used with MEK's permission, given to Oscar (recorded 2026-10-22). Set.world's characters and rules, tried on the `prototype/set-world` branch as a game beside Draw Steel (turns offer only move, hit or rest, and a fight would run past a hundred turns by hand), are now a ruleset a campaign chooses in its `campaign.yaml` (`rules: set-world`; built 2026-10-22, not yet played): every module is always composed so any log replays, the ruleset picks the commands, band, map and `/sheet`, the shared acts keep Draw Steel's words, and the host fetches each roll and puts it in the event.
- Q8 — _open._ Built so far (2026-10-21, from review, the tests and live runs, not yet play): `/undo` writes `core.retracted` naming one batch, and the fold restores the slices from before it and folds every later batch again on top, 20 batches deep. Every later batch must come out exactly as it did (the same feed lines), or the undo is refused, naming them ("A later change depends on it: GM's \"Vex takes 6 damage (5 to temporary Stamina) → 10/21 · winded\". Undo that first, or ask the GM."), and the fold halts on a retraction that would change one, so the feed, the band and replay never disagree and nobody's undo rewrites someone else's result. `/redo` is held to the same: it puts a batch back only if it reads as it did. The GM takes back the latest batch or, with `/undo <who>`, that person's latest; a player takes back their own latest within 30 seconds of the host's clock (which the host puts in the command), even with others' changes after it. A batch with dice in it (power rolls, saves, combat's start, a turn that rolled for its resource or saves) is the GM's alone to take back, so a player can't roll again by undoing. `/redo` writes `core.redone` and puts back the latest undone batch's own events, dice and all; a player redoes only their own undo, and a new change ends the redo. Chat, names, `/roll`, measurements and hero claims are never taken back; a claim on a hero an older batch brought in leaves that batch's snapshot as it is. A batch is a run of retractable events with one actor and timestamp; the room stamps every submission later than the one before, so two submissions never share one. A forced move stores where its target stood, so a slam that went nowhere still depends on the move that put the target there (the rehearsal undid such a move and kept the slam's damage).
- Q9 — _open._ Built so far (2026-10-21, from review, not yet play): a key's name is held for good; a guest's only while that guest is seated, since a guest is a new actor every connection; the default label of anyone seated is held too. Names are stored in NFKC form, refuse invisible and control characters and the table's markers, and are compared on what they look like (case, Cyrillic and Greek lookalikes, 0 and 1 for o and l, a capital I for l, rn for m, spaces and punctuation ignored: the rehearsal let "AIice" sit beside "Alice"). The GM's label is always drawn in the GM's colour. A first name reads "Alice joins the table." rather than naming the fingerprint. A hero whose guest has left is free to take, since a guest is a new actor every connection (the rehearsal's guests needed the GM after every drop).
- Q10 — _open._ The room stamps each submission's envelopes with one timestamp, a millisecond after the last if the clock hasn't moved or went back, so a submission is its actor and timestamp. A lenient reader tells the rules what it skipped, so a retraction naming a skipped event still applies. Engine tests (2026-10-20, `packages/engine`) pass for both automated halves: a host killed with `kill -9` mid-append reopens cleanly (a real child process; about a third of kills leave a half-written line, which is cut on open), and a rule that throws writes nothing. Still to do: read a real session's log by eye and with `jq`.
- Q11 — _open._ Built so far (2026-10-21, from tests and live runs, not yet play): all three routes exist. Same network or Tailscale with `--bind 0.0.0.0`; a tunnel (bore or `ssh -R`, in `docs/HOSTING.md`); and the relay: the GM's host dials `supervillain relay` (`host --relay table.example --room den`) and players type `ssh -p 2222 den@table.example`. The first GM host key to link a room claims it in the relay's `rooms.json`, and another key is refused (`relay forget <room>` releases it). The host trusts the relay's key from `--relay-key` or `<campaign>/relay_known`, which the first link fills; a different key is refused loudly and not redialed until the GM fixes the file. A dropped link is redialed with backoff from 1 s to 30 s, and players on it are told "The table closed.". The end-to-end tests cover each of these: a relay restart with the host redialing, a second GM refused, and a relay with the wrong key refused. Release binaries need nothing else installed. The relay sees play in the clear and vouches for every relayed player's key, so a GM runs one or uses one they trust; an `ssh -J`-style relay that forwards only TCP would end that, and isn't built. Claims cost only a link: one address (an IPv6 /64) claims 3 rooms, then one an hour, and an IPv6 /48 10, then 4 an hour, counted only when a claim is made after the login proves the host key, so failed logins don't use up the burst. A claim no GM has linked for 180 days (`--claim-days`) lapses, a default chosen so a monthly group or one taking a season off keeps its room's name, built so far and not decided by play; and a relay holds at most 1024, a full one dropping the claim linked longest ago, never one with a GM linked now. A claim too fast, a full registry and the relay's most links are answered on the hello line with ERR and the reason, before any login, so the host's band names it and its redial backs off; a link that can't be kept claims nothing. A host started with `--relay-key` writes it to `relay_known` when there's none, so a later start without the flag stays pinned. Still to do: a VPS and a DNS name, and friends reaching it without help.

---

## 10. Wild ideas, ranked by how seriously I mean them

**Do now, as part of the hill-climb:**

1. **Chat-first input** (Q3). MUD clients solved multiplayer in a terminal long ago; a tabletop is mostly conversation.
2. **Undo via corrective events** (Q8). Without it, an append-only log punishes every typo forever.
3. **Tactical legibility, Brogue-style.** Reachable squares light up when you pick up a token, with a path preview, distance, and area templates in reverse video, all within 16 ANSI colours. This could be the real wow moment, not pixel art.
4. **Drop "system-agnostic" as a present-tense goal.** Be the Draw Steel table. A good second game will tell you what the seam should be; a fake one can't.

**Test soon:**

5. **The feed in the terminal's native scrollback** ("split-footer", spike #99). Players get search, copy and `less` for free, and history survives a disconnect.
6. **Attention outside the window:** the terminal title and a desktop notification (OSC 9/777, or the bell) say "your turn" when a player has alt-tabbed away.
7. **Import from the existing Draw Steel ecosystem** (Forge Steel heroes, Steel Compendium data) instead of hand-written JSON and a v2 "builder". Licences first.
8. **Session replay and export.** The log is deterministic and so is the render, so `supervillain replay <folder>` can re-watch last session, a join can show "previously on…", and export can produce a self-contained HTML recap. This replaces the whole web app for the sharing use case.

**Someday, after people play:**

9. **"The VTT your coding agent can sit at."** Commands and the log already make a clean agent interface. An agent could run the goblins, fill an empty seat, or co-GM a solo game. Terminal-native is agent-native, and no browser VTT can say that. Build it only after the human table is good.
10. **Play-by-post.** The log is the ideal substrate for asynchronous play, and it dissolves the "GM's laptop is asleep" objection without hosted authority.
11. **Whoever's awake hosts.** Any seated player holds the log, so authority can move with an in-log handoff. It's already designed (ADR-0034); build it only if availability actually hurts.
12. **A Discord bridge.** Mirror rolls and the feed into the group's Discord, since most tables already use Discord for voice.
13. **Layouts composed in the player's own multiplexer:** `supervillain feed`, `supervillain map` and `supervillain sheet vex` as separate panes in tmux or zellij. Power users arrange the table themselves, and the layout engine disappears.

---

## 11. Bugs found during this review

Useful even if everything is rebuilt, because several are shapes the rebuild must not repeat.

| # | Bug | Evidence |
| --- | --- | --- |
| 1 | Typing outside the input line fires panel hotkeys that write permanent events (an encounter started, a combatant added, a power roll) | Hands-on: GM and player sessions; `events.jsonl` |
| 2 | A game `apply` that throws deterministically leaves two events with the same `seq`; the room can never be reopened | Probe: seq `4 fake.visit-counted` then `4 core.chat-posted`. The 2c070b0 fix covers only one-shot throws |
| 3 | A key linked to the GM is refused by Draw Steel (`"You do not hold a seat"`) while core commands accept it | Probe: `TableView.actor` is the raw key; `authority.ts` compares strings |
| 4 | Two in-flight submits with the same submission id both apply | `room-wire/src/submissions.ts:293-316`: check, then await, then remember |
| 5 | `snapshot()` returns live mutable state; rejected strangers pollute `actors()`, which then diverges from replay | Probe; `room-host.ts`, `core/src/actors.ts` |
| 6 | A half-written log line is unrecoverable: no truncation on open, and a bare `SyntaxError` with no line number | `room-host.ts:805-817, 1006-1023` |
| 7 | The Feed rebuilds fully on every event: 0.55 ms at 20 lines, 119 ms at 1,500, per seat | Measured against `runChrome` |
| 8 | The Sidebar drops all game styling | `packages/table/src/chrome.ts:1092` |
| 9 | Remote players see the GM as absent while the GM is at the local terminal | Hands-on |
| 10 | The lobby's first line on bare `ssh` is "no table named '<your unix user>'"; the "become a GM" screen gives the wrong `create` usage | Hands-on; `lobby-screens.ts:170` |
| 11 | `create --name` without a gateway writes `events.jsonl` before failing; an empty `SUPERVILLAIN_GATEWAY` is treated as an address | `apps/cli/src/index.ts:1097` vs `:1128`; hands-on |
| 12 | The identity conduit is hardwired to port 3002, so a second gateway on the same box crashes with a raw stack trace | `apps/gateway/src/index.ts:131, :1132` |
| 13 | The binary reports `0.0.0`; the fake test game ships in production registries | `apps/cli/src/index.ts:164`, `:172-205`; gateway `:133-151` |
| 14 | Pipe inbound reassembly is unbounded (memory exhaustion for any keyed peer); "fair" interleaving never checks `bufferedAmount`; catch-up is one round trip per event | `room-wire/src/pipe.ts`, `transport-ws/src/connection.ts:483-495`, `gateway-pipe.ts:258-264` |
| 15 | In the pixel tier, token letters render as pictograms and roles collide with terrain colours | `packages/table/src/map-pixel.ts:39-41`, `map.ts:70, 85-86` |
| 16 | The README promises `ssh <room>@supervillain.app`, which doesn't resolve; `publish` defaults to the same dead domain | `dig`; `apps/cli/src/index.ts:169` |
| 17 | `.agents/research/` is gitignored, yet linked from 12 tracked ADRs | `.gitignore:8` |
| 18 | CI red since Aug 22, 8 commits unpushed, `bun run check` failing with 933 errors | `gh run list`; `git rev-list` |

---

## 12. One last thing

The instinct behind this project is right: a VTT should be something your players reach in five seconds, and your campaign should be a file you own. The repo already proves the hard part is possible: a player typed one command and was at a table the GM's machine ran.

What went wrong is ordinary and fixable: the project kept deciding instead of playing. The way out is to get five people around that table, find out what breaks, and let the next thousand lines of code be the ones those five people needed.
