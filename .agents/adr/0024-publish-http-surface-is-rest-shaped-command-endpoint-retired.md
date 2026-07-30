---
status: accepted
date: 2026-07-30
---

# The publish HTTP surface is REST-shaped; the command endpoint is retired to a churn row

Located 2026-07-30, during the head review of the publish wave. [ADR-0019](./0019-one-vocabulary-doorways-by-authority-command-grammar-and-flag-policy.md) pinned the backend's HTTP surface as one command endpoint whose body carries the command line exactly as typed, and rejected "a parallel REST resource design" by name. What shipped — [#104](https://github.com/oscabriel/supervillain/issues/104)'s ingest/list/revoke, [#105](https://github.com/oscabriel/supervillain/issues/105)'s CLI client, [#107](https://github.com/oscabriel/supervillain/issues/107)'s regeneration — is REST-shaped: `POST /api/publish/challenge`, then `POST`/`GET`/`DELETE /api/publish` with JSON bodies, plus `POST /api/publish/og`. Both implementation waves flagged the divergence instead of papering over it; this ADR resolves it on the record rather than leaving the definition and the code disagreeing.

**Decision: the shipped REST shape is the contract; ADR-0019's command-endpoint decision is corrected in place.** The correction is made on the merits, not to ratify an accident — implementation surfaced three facts the command-endpoint design didn't have:

- **"One endpoint" was already false the moment authentication landed.** ADR-0005's challenge–signature flow (the house pattern the pipe uses, carried to HTTP by ADR-0023) requires a per-request challenge round-trip — a second endpoint with server-side one-use state. The design's headline property (one endpoint, no surface to drift) did not survive contact with the auth shape the same definition mandates.
- **The command encoding relocates the drift it was bought to prevent.** A body that "is the command line" makes the backend parse command lines — a second parser, duplicating the CLI's flag grammar server-side. The rejected-alternatives table feared two APIs drifting; the command endpoint guarantees two *parsers* drifting, which is the same failure one layer down. The REST shape keeps exactly one command-line parser (the CLI's) and gives the backend closed, validated JSON.
- **The payload was never the command line.** `publish` push carries a document up to the ADR-0009 cap; ADR-0019 already conceded "a payload part used only by publish push". A surface that is "the command line, plus a 10 MB attachment, plus three signature headers, plus a challenge round-trip" holds the debuggability property in name only.

The property that paid for the original design — a failing call is reproducible by pasting the line you ran — survives where users actually stand: the CLI *is* the public surface (the distribution invariant puts it a curl away from any machine that can script), `--json` parity is CLI-level contract, and pasting the failing `supervillain publish ...` line reproduces the HTTP exchange exactly. Machine callers get `--help --json` introspection per ADR-0019's rule 2, which stands untouched.

**Decision: what stands, what moves.** Everything else in ADR-0019 stands unchanged: one vocabulary, doorways by authority, the flag policy table (`--qr` on push and `--yes` on revoke shipped as contract in #105), the recorded-exception clause, no SSH one-shot wire, the no-PTY honesty notice, and the honest-limits page obligation ([#37](https://github.com/oscabriel/supervillain/issues/37) inherits it against the REST surface's limits: timeout, the artifact cap, no interactivity, no streaming). Authentication remains the key signature — possession of the key is ownership; the token-handle rule still routes through [#87](https://github.com/oscabriel/supervillain/issues/87). Below the contract line, the REST surface keeps ADR-0019's original freedom: paths and encodings may change without reopening this ADR, so long as the CLI remains the sole promised client.

**Churn row (explicit demand trigger):** a command-vocabulary HTTP encoding — reopened only if a real third-party machine caller appears that needs the backend without the CLI and for whom JSON-over-REST plus `--help --json` introspection measurably fails. Agents are the expected source, and #87's propose-vs-run grilling is where that evidence would surface. Symmetry with exe.dev is not a reason; it was the original design's weakest load-bearing member.

## Alternatives rejected

- **Rework the shipped surface to the command endpoint:** rewrites three spec-covered, gate-green surfaces (#104/#105/#107) to buy back a property already forfeited by the auth round-trip and the payload part, and installs the server-side command parser whose drift the design existed to prevent.
- **Leave the divergence unrecorded:** the definition and the code disagreeing silently is exactly the failure mode AGENTS.md names; two implementation waves flagged it, and a flag answered with silence teaches workers to stop flagging.
- **A dual surface (command endpoint wrapping the REST handlers):** two encodings of one vocabulary is the drift-guaranteed shape ADR-0019's own rejection table describes.

## Consequences

ADR-0019 gains an amendment pointer to this document; its fourth decision paragraph and the "parallel REST resource design" rejection row are corrected by it. The publish API's REST shape (`/api/publish/challenge`, `/api/publish`, `/api/publish/og`) is now the recorded contract at the same "implementation may move below the line" strength the command endpoint had. #37's honest-limits page targets the REST surface. The piped-stdin gateway dispatcher churn row in ADR-0019 is unaffected — it concerns the gateway's SSH door, not the backend.
