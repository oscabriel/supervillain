# Harden the SSH edge with post-quantum hybrid KEX, strict verification, and stranger bounds

## Decision

`packages/ssh` serves `ssh2@1.17.0` patched (`patches/ssh2@1.17.0.patch`) to offer only elliptic-curve key exchange with `mlkem768x25519-sha256` first, no compression, and identification `supervillain`. Public-key authentication verifies signatures strictly with `Object.is(key.verify(...), true)` (failing closed if `ssh2` returns an `Error` object). Connections are bounded by per-address and total connection/session caps (counting IPv6 by `/64` or `/48`), connect/session-start rates, login and idle timeouts, keepalives, rekey caps, a 4 MiB unread queue cutoff, and a `300×100` terminal size clamp. Host keys are created mode `0600` and refused if group- or world-readable.

## Why

The SSH server and relay sit open on the public internet. One OpenTUI renderer uses 15–25 MB, so unbounded connections, slow readers, or repeated rekeys would exhaust memory or CPU. Strict `Object.is(..., true)` prevents off-curve or malformed key blobs from failing open.

## What breaks if you change this

- Simplifying `Object.is(key.verify(...), true)` to a boolean truthiness check (`!key.verify(...)`) fails authentication OPEN when `ssh2` returns an `Error` object from crypto verification.
- Dropping `patches/ssh2@1.17.0.patch` causes `kexAlgorithm` in `packages/ssh/src/ssh2Internals.ts` to throw loudly on startup rather than silently downgrading key exchange.
- Raising or removing the 4 MiB unread cutoff lets a stalled TCP peer accumulate unbounded frame buffers in host memory.
