---
status: closed
type: research
assignee: pi:iroh
blocked-by: []
---

# iroh transport viability

## Question

GM-hosted rooms are the product's center of gravity, and the old plan pinned them on
iroh (dial-by-NodeId + holepunching + relay fallback; connections only — no gossip,
docs, or blobs; single-writer host assigns seq). Is that still the right call in 2026,
and what is the concrete integration path? Specifically:

- Current state of `@number0/iroh` (or successor) npm bindings: maintenance, release
  lag vs the Rust crate, and **Bun compatibility** (the old risk: napi-based, built
  for Node, "likely works in Bun" — verify, don't hope).
- Fallback shapes if bindings disappoint: room-host under Node (it has no OpenTUI
  dependency), or a small Rust sidecar (dumbpipe pattern) speaking JSON over stdio.
- Relay economics/policy: n0 public relays today, self-hosting story.
- Any credible alternative that delivers "GM's laptop behind CGNAT becomes reachable
  with zero config" (e.g. plain WebRTC data channels, Tailscale-style overlays) —
  or confirmation iroh remains the only serious fit.

Output: markdown asset with a verdict and recommended integration shape. Web research
plus, if cheap, a spike-level smoke test of the bindings under Bun (allowed under this
repo's prototyping convention).

## Resolution

Keep iroh and begin with `@number0/iroh@1.0.0` in-process under Bun, behind a narrow
transport seam: the local Bun smoke test installed/imported the native binding and
successfully bound and closed an endpoint. Gate that choice on cross-platform,
two-peer direct/forced-relay lifecycle tests; fall back first to a Node room-host
process, then to a Rust sidecar. Production requires dedicated relays because n0's
public relays are explicitly rate-limited, no-SLA development infrastructure.

Full evidence, alternatives, fallback ladder, and remaining verification:
[../assets/iroh-viability.md](../assets/iroh-viability.md).
