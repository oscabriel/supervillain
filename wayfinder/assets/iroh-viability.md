# iroh transport viability

_Research and smoke test performed 2026-07-11._

## Verdict

Keep **iroh**. It remains the best fit for “dial a GM by stable identity, connect directly where possible, and transparently relay when NAT traversal fails” without inventing a rendezvous/relay protocol around raw QUIC.

Use `@number0/iroh@1.0.0` **in-process under Bun as the first implementation path**, behind a narrow room-transport interface. The binding installed, imported, created an endpoint, obtained its ID, and shut down cleanly in the local Bun smoke test. This establishes basic N-API viability, not production support. Before committing the runtime shape, require a two-peer direct/forced-relay/reconnect/shutdown test on every shipped OS. If that gate fails, run the same binding in a Node room-host process; if native binding behavior or maintenance disappoints there too, use a small Rust iroh sidecar.

The single biggest risk is that iroh's newly revived 1.0 JS FFI officially targets Node, not Bun: one Linux smoke test cannot establish cross-platform correctness, lifecycle stability, or future Bun compatibility.

## Current JS binding

- npm's canonical record lists `@number0/iroh` **1.0.0**, published **2026-06-15T18:55:55.743Z**, with `engines.node >=20.3.0` and platform-specific native packages. The upstream `iroh-ffi` release is also v1.0.0, dated June 15. [npm registry](https://registry.npmjs.org/%40number0%2Firoh) · [iroh-ffi v1.0.0](https://github.com/n0-computer/iroh-ffi/releases/tag/v1.0.0)
- It is no longer behind stable Rust iroh: core iroh and the Rust crate reached **1.0.0 on the same date**. [core v1.0.0](https://github.com/n0-computer/iroh/releases/tag/v1.0.0) · [crates.io record](https://crates.io/api/v1/crates/iroh)
- Maintenance history still merits caution. In February 2025 a maintainer said `iroh-ffi` was not actively maintained until iroh reached 1.0; work subsequently resumed, with an RC and stable release in June 2026. Publishing/version-generation fixes immediately after release show a young release process. [maintenance statement](https://github.com/n0-computer/iroh-ffi/issues/229#issuecomment-2636211927) · [release history](https://github.com/n0-computer/iroh-ffi/releases) · [npm tag fix](https://github.com/n0-computer/iroh-ffi/pull/252) · [generated-version fix](https://github.com/n0-computer/iroh-ffi/pull/266)
- The package and upstream JS docs claim Node support, not Bun support. Bun says it implements Node-API and that “most” existing Node-API extensions work; that is compatibility evidence, not a guarantee. A focused upstream issue search found no Bun-specific support statement or issue. [iroh JavaScript docs](https://docs.iroh.computer/languages/javascript) · [Bun Node-API docs](https://bun.sh/docs/runtime/node-api)

## Bun smoke test

Environment: Bun `1.3.13`, Linux x64; scratch directory only.

```text
$ bun add @number0/iroh
installed @number0/iroh@1.0.0
3 packages installed [597.00ms]

$ bun run smoke.ts
endpoint b3675bd056d203e97c82ee0f9956ec118ae1bd285b94dd89267bf126ca2ea83e
closed
```

The script imported `Endpoint`, awaited `Endpoint.bind()`, printed `ep.id()`, and awaited `ep.close()`. Package import also exposed the expected connection, stream, endpoint, relay, and preset APIs. This did **not** test a second peer, hole punching, relay use, reconnection, sustained traffic, packaging, or any OS other than the current Linux machine.

## Relay policy and economics

- n0's public relays are free and unauthenticated, but rate-limited, have no SLA or uptime guarantee, support only the latest stable iroh, and are explicitly for development/hobby use. They can observe connection metadata, while payloads remain end-to-end encrypted. They are unsuitable as the product's production availability dependency. [public relay policy](https://docs.iroh.computer/iroh-services/relays/public) · [security and privacy](https://docs.iroh.computer/deployment/security-privacy)
- Self-hosting is credible: the open-source `iroh-relay` runs on a public-IP host with DNS and built-in ACME TLS. Official guidance recommends at least two regions for production; clients fail over automatically and relays are stateless. The documentation claims up to 60,000 concurrent connections per relay. [self-hosting guide](https://docs.iroh.computer/add-a-relay) · [relay concepts](https://docs.iroh.computer/concepts/relays)
- No public, primary-source managed-relay price was found. Production planning must therefore obtain a managed quote or benchmark self-hosted compute and especially bandwidth/egress. Access control for self-hosted relays is also the operator's responsibility.

## Alternatives

### WebRTC data channels

WebRTC is the strongest credible alternative. ICE uses STUN/TURN and can fall back to relay-only candidates, so it can reach peers behind CGNAT. But the standard deliberately leaves signaling to the application, and a terminal host/player needs a native WebRTC runtime. It replaces iroh's QUIC-stream model with a broader signaling, TURN credential, relay, and SCTP/data-channel surface. Reconsider it if browser-native peer transport becomes a primary requirement; it is not simpler for the current terminal-first shape. [W3C WebRTC Recommendation](https://www.w3.org/TR/2024/REC-webrtc-20241008/)

### Tailscale/headscale

Tailscale-style overlays traverse NAT using coordination, STUN, and DERP relay fallback, but every participant must install and register an overlay client. Headscale also requires an Internet-reachable control server. This is credible for private/admin deployments, not zero-configuration public room joining. [headscale getting started](https://headscale.net/0.27.1/usage/getting-started/) · [headscale DERP](https://headscale.net/0.27.1/ref/derp/)

### Plain QUIC + STUN

Not sufficient. Hole punching cannot guarantee a path through restrictive or symmetric NAT; a relay, identity/rendezvous, discovery, failover, and path-management layer is still required. Building those around raw QUIC recreates much of iroh. Iroh already supplies public-key dialing and relay-assisted direct connections. [iroh crate](https://crates.io/crates/iroh) · [relay concepts](https://docs.iroh.computer/concepts/relays)

## Recommended fallback ladder

1. **Bun + `@number0/iroh` in process**, conditional on a CI matrix proving two-peer direct and forced-relay connections, reconnect, clean shutdown, and packaged native binaries on supported Linux/macOS/Windows architectures.
2. **Node room-host process + the same binding** if Bun-specific failures appear. The room host has no OpenTUI dependency, so this preserves the TypeScript implementation while using the supported runtime.
3. **Rust iroh sidecar** if the JS FFI is unstable, incomplete, or lapses in maintenance. Keep the IPC protocol small and versioned; JSON over stdio is suitable for control/events, while sustained room payloads should be measured before committing all bytes to that encoding.
4. **WebRTC + TURN** only if browser-native peer connectivity becomes more valuable than preserving one QUIC-based transport model.

Independently of runtime choice, production must use dedicated managed or self-hosted relays (at least two regions), not n0's public development service.

## Remaining verification

- Cross-platform Bun and Node test matrix, including forced relay and lifecycle stress.
- Whether the JS 1.0 API exposes every relay-selection and observability hook the production host needs.
- Managed relay pricing versus measured self-hosted bandwidth/egress costs.
- Relay capacity claims under supervillain's actual traffic pattern.
