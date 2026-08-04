---
status: accepted
date: 2026-08-03
---

# Publish authority, automation, consent, and operator takedown

Resolved 2026-08-03, grilling of [#87](https://github.com/oscabriel/supervillain/issues/87), from the exe.dev precedent read (`.agents/research/exe-dev-precedent.md` §9.5, §10, §13–14). The issue originally required these questions to settle before Publish shipped; the timing inverted — [#100–#107](https://github.com/oscabriel/supervillain/issues/100) and [ADR-0024](./0024-publish-http-surface-is-rest-shaped-command-endpoint-retired.md) landed first. The decisions below therefore ratify most shipped behavior, add the missing operator lifecycle and policy obligations, and name the few follow-up changes rather than pretending this is still greenfield.

**Decision: agent authorization belongs to the agent harness, not supervillain.** There is no product-maintained propose-versus-run command list and no human-versus-agent permission boundary in the CLI. `supervillain publish <type> ...` remains non-interactive, keeps `--json`, and may run unattended when the user's harness permits it; no confirmation or `--yes` is added to publish push. The shipped revoke asymmetry remains: `publish revoke` is permanently destructive and keeps its interactive confirmation plus explicit `--yes` bypass. Agent-facing campaign-folder documentation must say plainly that Publish copies campaign data to the hosted web service, that an agent may execute it when its harness allows, and that the harness — not supervillain — owns approval policy. This accepts that convention is not a capability boundary without manufacturing one in the product.

**Decision: Publish authority rests with the GM; there is no per-character consent mechanism.** A GM may publish a character bound to another player's Seat, and that player receives neither an opt-in gate nor a revoke right. [ADR-0020](./0020-web-stack-tanstack-start-pages-mounted-hono-api-one-process-on-the-vps.md)'s scope cut is reaffirmed: no consent flag enters the character sidecar or snapshot schema. A flag in a GM-controlled file would only restate the GM's assertion, would not prove player consent, and would leave the harder case — a published Log containing every player's chat — untouched.

**Decision: minors do not create a distinct product path.** There is no age gate, minor-specific feature restriction, or parental-consent mechanism; minors and adults are treated alike. The reason is not that published content cannot contain personal information: character names and Log chat are free-form and may contain it even though key-as-account collects no profile fields. Responsibility sits with the publisher warranty below. This is a product posture, not a legal conclusion; counsel must review the launch policy language, and a legal requirement to change it reopens this decision.

**Decision: every Publish carries a publisher warranty.** By executing Publish, the authenticated GM warrants that they own the content or hold every permission and consent needed to publish it, including content concerning or contributed by third parties, regardless of age. The Terms carry the full counsel-approved language; `publish --help` and Publish documentation summarize it without adding a prompt. supervillain claims no ownership in published content.

**Decision: the operator reserves a discretionary takedown right, not an obligation.** The operator may remove any published Artifact without the GM's consent and with or without prior notice; `abuse@supervillain.app` is the launch abuse and takedown contact. The no-profile identity model provides no reliable notification channel, so launch promises neither notice nor a structured appeal surface. Reports and disputes use that mailbox.

**Decision: operator takedown is the same permanent URL lifecycle as owner revoke.** It writes the existing token-hash tombstone forever, deletes the Artifact row, Snapshot document, and OG card, removes the Artifact from `publish list`, and leaves the Capability URL on ADR-0022's indistinguishable generic 404. A mistaken takedown cannot restore the old URL. Ownership nevertheless stays with the GM, and takedown targets only that Artifact: the identity and `(type, name)` are not blocked, so a later Publish may mint a fresh URL immediately. Repeated-abuse suspension or service termination is a separate future lifecycle decision, not hidden inside takedown; if built, it must add its own [ADR-0028](./0028-the-reach-checklist-every-lifecycle-transition-states-its-access-consequence.md) row.

**Decision: ADR-0022's token-handle pre-commitment is reaffirmed.** Any future short or pretty form is a handle validated through the real capability token on every use, never a second capability secret. The real token remains the one revocation point and its tombstone kills every handle. No handle ships on speculation; `--qr` is the preferred already-shipped answer until real short-link demand appears.

## Consequences

The shipped publish push, `--json`, Capability URL, and token design stand. The implementation gap is operator takedown: the store already funnels owner revoke through one tombstone function, and the operator surface must land on that same lifecycle rather than create disable/restore state. Launch policy and documentation gain the no-ownership clause, publisher warranty, discretionary takedown right, no-notice posture, abuse address, free-form-content privacy honesty, and the agent-harness boundary. ADR-0009, ADR-0013, ADR-0019, ADR-0020, ADR-0022, ADR-0027, and ADR-0028 are amended by this decision; the product definition and glossary gain matching corrections.

## Revisit triggers

- Counsel finds that the no-age-gate/no-minor-specific-path posture or warranty is insufficient for launch.
- Repeated abuse demonstrates a need for identity-wide publish suspension or service termination; that is a new reach transition with its own policy, storage, notice, and recovery questions.
- A real request for short or pretty links fires ADR-0022's handle shape, or is answered by `--qr` without minting another form.
- A reliable publisher contact channel later exists and creates evidence for promised takedown notice or a structured appeal surface.
