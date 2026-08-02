---
status: accepted
date: 2026-07-30
---

# General spectating: seatless views behind a GM admission-mode toggle

Resolved 2026-07-30, grilling of [#92](https://github.com/oscabriel/supervillain/issues/92). The issue was filed from the exe.dev precedent (`.agents/research/exe-dev-precedent.md` §13) as **support access** — a GM-invoked, per-room, default-off observer toggle so our support staff can see a broken session with consent. Grilling collapsed it into the general feature: **spectating**, the known term for the concept. Support access is not a separate surface — support spectates like anyone else, and every consent property below applies to us first.

**Decision: the vocabulary is spectate/spectator, and a spectator is a seatless, read-only view.** A spectator attaches to a live Room's render stream (the same [ADR-0018](./0018-memory-only-render-fold-checkpoints-and-bounded-replay-tails.md) checkpoint-and-tail path every Table uses) but claims no seat, submits nothing, and **never touches the Room's log** — no seat-claim event, no arrival or departure events. The game record is byte-identical with zero or fifty watchers. Spectator presence is gateway-side only, surfaced in the Table's chrome as a count (`watching: N`) in the status band — sourced from presence, never from the log. Spectator sessions are real render/broker cost, so they **count against the room's session caps**, and [ADR-0012](./0012-outbound-only-hybrid-drop-iroh-host-dials-out.md) NQ-10's honest-refusal rule applies to them before anyone else: at capacity, refuse new spectators at the door; never degrade the live table.

**Decision: time is the differentiator — `/spectate on` flips the room's admission mode.** There is one Door and one grammar (`ssh <room>@supervillain.app`); nothing about an arrival distinguishes a watcher from a player, so the mode does:

- **Before the toggle** (and always, for rooms that never flip it): an arriving new identity claims a player seat — exactly today's log-derived behavior, unchanged.
- **After `/spectate on`**: an arriving identity that **does not already hold a seat** in the room attaches as a spectator.
- **Seat holders always land in their seat.** The seat belongs to the actor and claiming is idempotent, so a player who drops and reconnects while spectating is on gets their seat back, never the gallery. The mode governs only identities with no seat in the log.

The rule matches how sessions actually run: assemble the table, then open the gallery. `/spectate` is GM-only, per-room, **default off**, and the toggle state **dies with the session** — every room starts closed, so there is no "left it on for three weeks" failure mode. Rejected alternatives for the differentiator: a reserved SSH-username grammar (`watch.<room>@` — new door grammar, reserved-prefix enforcement at `create`, one more thing to document) and an arrival interstitial ("join or watch?" — taxes the common case to serve the rare one).

**Decision: `/spectate off` drops all spectators immediately.** Revocation is a real consent act, not a door closing on future arrivals — the GM can eject the entire gallery (our support person included) mid-sentence. The toggle's feed line carries its own revocation (`spectating enabled — /spectate off to close the gallery`), so the off switch is never more than a glance away.

**Decision: the late new player is handled with the toggle, not new machinery.** An invited player arriving after the toggle flipped lands as a spectator; the GM runs `/spectate off`, they join and claim a seat, `/spectate on`. Two commands. A promotion command (`/seat <spectator>` or similar) is recorded as **deliberate non-scope** — obvious future sugar, built when the two-command dance demonstrably annoys.

**Decision: no password, no CLI noun, no `--json`.** The GM's toggle is the gate — an unshared room is unwatchable regardless of who knows its name, so the room-name-enumeration calculus ([ADR-0008](./0008-bare-ssh-lobby-lazy-guest-minting-and-keyed-preference-persistence.md)) does not change: knowing a name still grants only knocking. Selective audiences (a spectate password or invite code) mint a new secret-distribution problem and are deferred — revisit trigger below. No management noun is minted (`/spectate` lives in the room's command grammar, where the GM's hands already are); and per the exe.dev lesson the issue carried, the toggle is a human consent act, **never an automation endpoint** — no `--json`, recorded as a data point for [ADR-0019](./0019-one-vocabulary-doorways-by-authority-command-grammar-and-flag-policy.md)'s flag policy and [#87](https://github.com/oscabriel/supervillain/issues/87)'s agent-surface grilling.

**Decision: copy homes.** The getting-help page ([#37](https://github.com/oscabriel/supervillain/issues/37)'s docs scope) teaches the support use exe.dev-style — identifier first, consent second, revoke in the same paragraph ("share your **room name** with us… optionally `/spectate on`… revoke anytime with `/spectate off`"). The in-table surfaces teach the general feature where it's used: the command menu and the `?` key sheet. Nothing lands in `--help` surfaces — there is no CLI noun to document. The honest-marketing guardrail (ADR-0012 NQ-11) survives contact and gains a sharper true sentence: copy says "we cannot read your campaign folder," never "we cannot see your game" — and now also: **nobody can watch your game unless the GM turns spectating on, and off ejects everyone instantly.**

## Consequences

The glossary gains **Spectator**. The room's admission path gains a mode check (seatless attach vs seat claim) and the gateway gains spectator presence (count, per room, memory-only). The Table's status band gains `watching: N`. The support-access want that filed this issue is satisfied with zero support-specific machinery. #37 inherits the getting-help paragraph and the spectating copy. Session-cap accounting explicitly includes spectator sessions.

## Revisit triggers

- Selective audience: a real GM want for gated spectating (password / invite code / per-spectator approval) reopens the no-password decision.
- The two-command late-player dance drawing real complaints — builds the promotion command.
- Spectator scale: if rooms attract audiences large enough that spectator fan-out dominates gateway cost (streamed one-shots), the render-stream sharing shape and cap policy reopen against R9-style measurements, per NQ-10.
- Named/identified spectators (showing *who* watches, not just how many) — a privacy-facing decision deliberately not made today; the count is the v1 contract.
