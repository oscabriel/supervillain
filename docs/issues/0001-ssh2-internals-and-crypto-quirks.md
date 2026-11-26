# Issue 0001: `ssh2` Internals, Verification Quirks, and KEX Patch

## Status

Open workarounds tracked in `packages/ssh/` and `patches/ssh2@1.17.0.patch`.

## 1. Post-quantum hybrid KEX patch (`mlkem768x25519-sha256`)

Stock `ssh2@1.17.0` does not implement `mlkem768x25519-sha256` key exchange. `patches/ssh2@1.17.0.patch` (applied via `bun patch`) adds it using `@noble/post-quantum` (`ml_kem768`), and `packages/ssh` advertises only elliptic-curve KEX algorithms with the ML-KEM hybrid first.

Whenever `ssh2` is upgraded, verify the patch applies cleanly and re-run `bun test packages/ssh`.

## 1a. `Client.subsys()` sends no environment

Stock `Client.prototype.subsys(name, cb)` opens a session channel and asks for the subsystem straight away, so unlike `exec` and `shell` it can't send `env` requests first. The relay needs that to name the player (`SV_ACTOR`) when it opens `mcp-1@supervillain.sh` on a host (ADR 0020). The same patch makes it `subsys(name, opts, cb)`: when `opts.env` is an object it calls `reqEnv` before `reqSubsystem`, exactly as `exec` does, and the two-argument `subsys(name, cb)` still works. `packages/ssh/src/ssh2Internals.ts` declares the three-argument overload, and `packages/ssh/test/client.test.ts` checks a relayed subsystem sees `SV_ACTOR`.

## 2. `key.verify()` returns `Error` on crypto failures despite `@types/ssh2`

`@types/ssh2` types `ParsedKey.verify()` as returning `boolean`, but `ssh2`'s `keyParser.js` returns an `Error` instance when the underlying Node crypto call throws (for example, an off-curve ECDSA signature or malformed key material).

In JavaScript, `!err` evaluates to `false`, so `!key.verify(...)` **fails open** and accepts invalid signatures. `packages/ssh/src/server.ts` MUST check `!Object.is(key.verify(...), true)` (covered by the off-curve ECDSA regression test in `packages/ssh/test/identity.test.ts`).

## 3. RSA `rsa-sha2-512` is not offered by `ssh2`

`ssh2` does not offer `rsa-sha2-512` for public-key authentication. OpenSSH clients configured strictly with `PubkeyAcceptedAlgorithms rsa-sha2-512` skip their RSA key and fall back to guest or fail auth. Players on RSA keys should use OpenSSH defaults (`+rsa-sha2-256`) or generate an Ed25519 key.

## 4. Private socket and channel backpressure inspection

To prevent a slow or malicious peer from exhausting host memory (unbounded write buffers), `packages/ssh` caps buffered bytes at 4 MiB on both the underlying TCP socket and individual SSH channels, and cuts peers that rekey excessively. `packages/ssh/src/server.ts` and `packages/ssh/src/client.ts` validate `ssh2` runtime fields with structural type guards rather than type assertions so `bun run check` stays zero-assertion.

## 5. `attach()` injects a pre-dialed socket into `ssh2.Server`

The GM host dials out to `supervillain relay`, then serves SSH over that outbound socket via `attach()`. Because `ssh2.Server` expects to `listen()` on a net server, `packages/ssh` injects the connected socket directly using `ssh2`'s connection handler (`emit("connection", socket)`).

## 6. `@types/ssh2` brings a second copy of Node's typings

`@types/ssh2@1.15.6` depends on `@types/node@^18`, while the workspace compiles against the `@types/node@26` that `@types/bun` brings. Both copies declare the `net` and `events` modules, and TypeScript merges them, so every program that reaches `ssh2`'s types (`packages/ssh` and `apps/supervillain`) sees two things that are not true at runtime:

- `node:events` loses `InternalEventEmitter` (the version 18 copy declares the module with `export =`), so `node:net`'s `Server` has no `on`, `once` or `removeListener` in the type checker, although every `net.Server` is an `EventEmitter`.
- `ssh2`'s `Server.injectSocket()` takes the version 18 `net.Socket`, which the version 26 `net.Socket` every caller holds is not assignable to.

`packages/ssh/src/ssh2Internals.ts` holds both workarounds, and nothing else in the workspace narrows for this reason:

- `serverEvents(server)` returns a `net.Server` as its `EventEmitter` after an `instanceof EventEmitter` check, and throws if the check fails. The check is always true at runtime; it is there because the type checker cannot see it. `packages/ssh/src/server.ts`, `apps/supervillain/src/relay/server.ts` and `apps/supervillain/src/mcp/socket.ts` listen for a server's `error` event through it.
- The `declare module "ssh2"` block adds an `injectSocket(socket: Socket)` overload that takes the workspace's `net.Socket`, beside the `Client.subsys` overload from §1a. `injectSocket()` in the same file is the one caller.

Both go away when the workspace resolves a single `@types/node`: an `"@types/node"` entry under `overrides` in the root `package.json` that matches the version `@types/bun` uses, followed by `bun install`. Then `serverEvents` can return its argument unchecked and the `injectSocket` overload can be deleted.
