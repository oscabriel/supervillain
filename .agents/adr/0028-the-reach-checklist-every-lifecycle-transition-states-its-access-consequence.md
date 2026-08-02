---
status: accepted
date: 2026-07-30
---

# The reach checklist: every lifecycle transition states its access consequence, separately from ownership

Resolved 2026-07-30, grilling of [#89](https://github.com/oscabriel/supervillain/issues/89), from the exe.dev precedent read (`.agents/research/exe-dev-precedent.md` §12–13). **Ownership** is whose thing it is; **reach** is who can still get to it after a lifecycle event. The sneaky failures live in reach — cancel a plan and lose access to things you still own; revoke a key and kill a link strangers depend on. Before this ADR, exactly one reach consequence was on record ([ADR-0009](./0009-capability-url-and-publish-contract.md)'s edge case: linking two identities must never kill a capability URL). This document is the rest, and it is **the standing checklist**: reach questions get answered here, in rows.

**The header law (the free-tier floor):** whatever the free tier ever is, dropping to it must never break reach to state we hold on a GM's behalf — above all **live capability URLs, whose holders never had accounts and cannot be notified**. This binds future pricing today; pricing is designed under it, not the other way around.

**The standing rule:** any future feature that introduces a lifecycle transition — a kick command, pricing, name expiry or transfer, an account-erasure act — **must add its row to this checklist before it ships**. A transition without a row is an undecided product question, not an implementation detail.

## The rows

**A GM stops paying.** *Bound pinned now; specifics decided-when-pricing-lands.* A lapsed payment may only ever remove the paid convenience — e.g. we stop hosting the room's authority — never reach to anything held on the GM's behalf: live capability URLs stay live, the name registration survives, and the self-host exit (MIT binary + campaign folder) is available at the moment of lapse. For a hosted-authority GM that means **we hand back the campaign folder** — [ADR-0012](./0012-outbound-only-hybrid-drop-iroh-host-dials-out.md)'s company-death test (hosted→self-hosted restore, tested) exercised politely. Grace windows, retention duration for an unrestored folder, and notification are marked **decided-when-pricing-lands**; pricing cannot ship without filling them in.

**A player leaves a table.** *A presence event, not a reach event.* The seat survives — seats are log-derived and belong to the identity; returning next week lands them in the same seat. Their published capability URLs are untouched — publishes belong to the publishing identity, not the table. Their character file stays in the GM's campaign folder, to which the player never had file-level reach; their reach to it is through the table and resumes when they do — same as paper. **Forcible removal (kick/ban) does not exist**; when it lands, it adds its own row (seat, character binding, rejoin rights) per the standing rule.

**A key is revoked from the identity's linked set.** *The identity loses nothing; the key loses everything, prospectively.* Prefs, seats, publishes, name registrations are keyed to the resolved identity and untouched — ADR-0009's linking edge case generalizes: neither linking nor unlinking ever kills a capability URL. From revocation onward the key stops resolving at every authentication surface — SSH connect, host pipe dial, publish challenge ([ADR-0013](./0013-server-data-layer-gateway-owned-identity-and-two-stores.md) made revocation a local gateway read so this is cheap and works with the backend unreachable). A revoked key reappearing is a stranger: a fresh identity on first contact. **Live sessions run to their natural end** — revocation gates authentication and an authenticated session doesn't re-authenticate; the idle/max-hold timeouts bound the exposure. Stated honestly rather than implying teardown we don't do; if stolen-key panic proves real, immediate session teardown is the named upgrade (revisit trigger).

**A room name is released or re-registered by a different owner.** *The law now; the mechanism doesn't exist.* A room name is an **address, not a capability, and carries no state**: a successor owner receives exactly one thing — future knocks. No campaign data, logs, publishes, or seat history transfer; those live with the old owner's identity and machine. The honest cost: players holding the old name are not redirected and not notified — their knocks land on a stranger's door; the security posture bounds the damage (names were never secrets; a successor can receive knocks but cannot reproduce the game or its authority), but it remains a phishing-shaped social surface. Today **no release, expiry, or transfer mechanism exists** — a registered name stays its identity's, and same-identity re-registration just updates the host address ([ADR-0003](./0003-gateway-registration-trusted-stamping-and-guest-actors.md)). **Gate:** any future release/expiry/transfer feature must add its row *and answer the successor-knock problem before shipping* — cooldown, tombstone notice, or an explicit accepted-risk decision.

**The GM deletes the campaign folder.** *Deletion is local, and nothing we hold dies silently.* What dies: the game — the folder is canonical state and no future session of that campaign can run; that is the point of deletion. What survives, explicitly: live capability URLs (copies we hold on the GM's behalf; killing them as a side effect of a local `rm -rf` would violate the header law) and the name registration (it belongs to the identity, not the folder). The corollary out loud: **deleting the folder is not a delete-my-stuff-everywhere act** — publishes are removed by explicit revocation (`publish` revoke exists); vanishing entirely means doing both. A real "forget me entirely" want (GDPR-shaped or grief-shaped) is a new transition needing its own row, not an inference from file deletion.

**Identities are linked** *(pre-existing row, incorporated).* Linking two identities merges reach and must never kill a capability URL — ADR-0009's worked example, the row that proved the checklist pays.

## Consequences

Reach questions now have one home; ADRs and issues answer them by adding or amending rows here. Pricing work inherits two obligations before it can ship (the floor law; the stops-paying row's blanks). Kick/ban, name recycling, and account erasure are named as future transitions that cannot ship rowless.

## Revisit triggers

- Pricing lands — fills the stops-paying row's decided-when-pricing-lands blanks.
- Stolen-key panic in the wild — upgrades key revocation with immediate session teardown.
- Any feature touching the named future transitions (kick/ban, name release/expiry/transfer, forget-me-entirely) — adds its row before shipping, per the standing rule.
