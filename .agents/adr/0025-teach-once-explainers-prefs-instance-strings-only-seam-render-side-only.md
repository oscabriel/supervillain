---
status: accepted
date: 2026-07-30
---

# Teach-once explainers: a prefs-table instance, a strings-only seam, and a render-side-only rule

Resolved 2026-07-30, grilling of [#98](https://github.com/oscabriel/supervillain/issues/98). `packages/table/DESIGN.md` § Voice in the chrome pins the behavior — first-encounter mechanics get one dim bracketed explainer line in the feed, once per player, persisted gateway-side, no tutorial mode, no popups — but left the store, the seam, and the record-purity rule as definition touchpoints. This ADR pins all three; implementation is deliberately small.

**Decision: the seen-explainers set is an instance of [ADR-0008](./0008-bare-ssh-lobby-lazy-guest-minting-and-keyed-preference-persistence.md)'s keyed preference persistence, not a new store.** It lives in the gateway's existing durable prefs table, keyed by **resolved identity** (the linked-key equivalence class of [ADR-0005](./0005-key-linking-backend-registry-gateway-conduit-and-in-log-linking-events.md)/[ADR-0013](./0013-server-data-layer-gateway-owned-identity-and-two-stores.md)) × **explainer id** — a person learns a mechanic once, not once per key. Every retention and portability question inherits ADR-0008's answers rather than getting fresh ones: durable on the gateway, within the "stateless means no game state" re-pin (a seen-hints set is presentation state, not game state). **Guests stay session-local**, per ADR-0008's deliberate guest amnesia — a returning keyless guest sees explainers again, which is acceptable and even apt (guests are the newest players), and it sharpens the existing "bring a key and it remembers you" pitch. Retention is forever; a reset affordance belongs to the lobby settings screen whenever the preference surface becomes real, and mints **no CLI noun now** — a bespoke reset noun for one niche action would grow the management-noun surface ahead of need.

**Decision: the game-module seam grows one strings-only export — event kind → explainer string — and nothing else.** The wording is game knowledge (Draw Steel mechanics), so the strings live module-side; the trigger ("this identity's first encounter with this event kind"), the store, and the rendering are core/gateway concerns. This is the [ADR-0009](./0009-capability-url-and-publish-contract.md) card-descriptor precedent applied again: the module nominates content as plain strings, the core owns all machinery. A mechanic that someday wants a richer hint than a static one-liner is a future decision to be made then — no extension room is built now.

**Decision: no off switch ships.** The system self-silences — each explainer appears once in a player's lifetime, dimmed, one line — so a veteran's total cost is bounded and small, and a `no-teach` toggle would add a row to a settings screen that is a deliberate stub ([ADR-0008](./0008-bare-ssh-lobby-lazy-guest-minting-and-keyed-preference-persistence.md) amendment (3): inert controls teach users the settings screen lies). Revisit trigger below.

**Decision: explainers are render-side annotations, never part of the game record.** An explainer is a per-player decoration drawn beneath a feed line. It is never written to the Room log, never appears in replay or the [ADR-0018](./0018-memory-only-render-fold-checkpoints-and-bounded-replay-tails.md) checkpoint/tail, never travels to other players' feeds, and never exists as a wire event. The game record is byte-identical whether or not any player saw a hint — this is what keeps "once per player" enforceable at all, since the log is shared and the teaching state is not. Register note: explainers are the _dry_ teaching voice, structural copy under DESIGN.md's restraint rule — not a licensed wit beat, and they add none.

## Consequences

The gateway prefs table gains its first non-toggle dataset — the pattern for future preference-like state is now set by example (identity-keyed, guests amnesiac, inherits ADR-0008 wholesale, no bespoke store). The game-module seam gains exactly one export shape: a strings-only lookup from event kind to explainer line. The feed's render path gains a per-player annotation lane that provably cannot leak into the log. `.agents/CONTEXT.md`'s Gateway entry already covers this state under "presentation prefs" — no glossary change.

## Revisit triggers

- The explainer catalog grows large enough that once-each adds up to real session noise (a full ruleset's worth firing on a veteran's first night) — a `no-teach` preference then joins the settings screen, which will exist by the time this fires.
- A mechanic needs a hint richer than a static string (dynamic values, multi-line, per-context wording) — reopens the strings-only seam shape decision, against the ADR-0009 precedent.
- ADR-0008's existing product-wide-preferences trigger covers this store's migration story; nothing new to add here.
