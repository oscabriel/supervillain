# The v1 pipe handshake is ratified as the wire contract

Resolved in the 2026-07-25 grilling session. [ADR-0012](./0012-outbound-only-hybrid-drop-iroh-host-dials-out.md) (NQ-3) said only "challenge-signature auth" and pinned no exchange, so [#55](https://github.com/oscabriel/supervillain/issues/55) had to design one, flagged it loudly, and [#57](https://github.com/oscabriel/supervillain/issues/57) built on it before it had been reviewed. This ADR is that review's verdict: the exchange as implemented in `packages/transport-ws/src/handshake.ts` is ratified, verbatim, as the v1 wire contract.

**The contract (v1, mutual, one round trip):** each side sends a hello `{v: 1, id: <hex ed25519 public key>, nonce: <32 random bytes, hex>}`, then sends a proof `{v: 1, signature}` where the signature is over the domain-tagged blob `"supervillain/transport-ws/1\n" + <peer's nonce> + "\n" + <own claimed public key>`. Each side verifies the peer's proof against the peer's claimed key and returns that key as the authenticated identity. Both halves run the identical exchange — the gateway proves itself to a Host exactly as a Host proves itself to the gateway. Bumping `v` is a breaking wire change, not a tunable.

**Why it is sound:** the three properties that matter are all present. Fresh random nonces per connection mean a signature can never be replayed onto a later connection. The domain tag means a signature minted here can never be repurposed in any other protocol that this key also signs for. Binding the signer's _own claimed key_ into the signed blob means a proof cannot be relayed under a different claimed identity. Signing the peer's nonce before verifying the peer is a deliberate ordering (both proofs cross in flight, saving a round trip); the domain tag is what makes handing out such signatures safe.

**Division of labour with TLS ([ADR-0014](./0014-tls-for-the-host-pipe-caddy-hosted-self-signed-tofu-self-hosted.md)):** TLS authenticates the _gateway machine_ (certificate pinning self-hosted, CA trust hosted) and provides the channel's confidentiality and integrity; this handshake authenticates the _ed25519 identities_ inside that channel. Neither substitutes for the other.

**Known gaps, accepted with named owners — not defects:**

- **No channel binding.** The signed blob does not include the TLS certificate, so on a connection that is _already_ unpinned or plaintext (which today warns and connects), an on-path attacker could relay the identity exchange. On pinned or CA-verified connections the attack does not apply. The stated fix is a v2 that binds the served certificate's fingerprint into the signed blob, and the trigger for building it is the ADR-0012 NQ-9 pairing-code/TOFU-fingerprint work — whichever issue takes that on takes v2 with it.
- **Strict version check.** A future v2 peer is refused with a generic "peer hello is invalid" rather than a versioned refusal. Fine while exactly one version exists; the first issue that introduces v2 owes the explicit version-mismatch error alongside it.

**Consequences:** none in code — this ADR changes nothing, it makes the existing contract a decision instead of an improvisation. [#57](https://github.com/oscabriel/supervillain/issues/57)'s dependence on the exchange is now on ratified ground.

**Revisit triggers:** the NQ-9 pairing-code work (brings v2 channel binding); any second consumer of the signing key beyond this handshake and the room log (re-examine the domain-separation inventory); a cryptographic result against ed25519 (out of our hands, but named for honesty).
