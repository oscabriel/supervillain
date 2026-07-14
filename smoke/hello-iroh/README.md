# hello-iroh compiled-binary smoke

This isolated package tests the native-addon edge of the CLI artifact. It is not a
root workspace member and must not become the product transport dependency.

`@number0/iroh` is pinned to the current npm release, `1.0.0`. Each entry point
bypasses its napi-rs platform loader and directly requires the native artifact:

```ts
const iroh = require("@number0/iroh-linux-x64-gnu/iroh.linux-x64-gnu.node");
```

Build and run the entry matching the native machine:

```sh
bun install --frozen-lockfile
bun build --compile ./linux-x64.ts --outfile ./hello-iroh
./hello-iroh
```

The program binds an iroh endpoint, prints its ID, closes it, and exits. Bun embeds
the directly required `.node` file in the executable's `$bunfs` root. Keep the
CommonJS `require` shape: with Bun 1.3.13, an ESM default import embedded the addon
but emitted a call to an undefined `__require` at runtime. Direct `require` both
embeds and loads it successfully from `$bunfs`.

## Platform gate

The workflow builds on native runners, rather than cross-compiling native addons:

| Triple      | Runner             | Entry point      | Published 1.0.0 artifact |
| ----------- | ------------------ | ---------------- | ------------------------ |
| linux-x64   | `ubuntu-latest`    | `linux-x64.ts`   | yes                      |
| linux-arm64 | `ubuntu-24.04-arm` | `linux-arm64.ts` | yes                      |
| macos-x64   | `macos-15-intel`   | `macos-x64.ts`   | **no**                   |
| macos-arm64 | `macos-latest`     | `macos-arm64.ts` | yes                      |

The macOS x64 job is intentionally present and currently fails at build time:
`@number0/iroh@1.0.0` neither lists nor publishes a matching 1.0.0 optional native
package. npm only has an old `@number0/iroh-darwin-x64@0.22.1-test1`, which is not a
valid substitute for the pinned 1.0.0 API. This is an upstream release-coverage
blocker, not a runner-label workaround.

## Adoption by `packages/transport-iroh`

The transport package should copy the per-target direct `require` pattern (or
generate equivalent target-specific CLI entry points), retain native per-triple CI,
and test the compiled executable itself. It must not rely on `@number0/iroh`'s
runtime platform loader inside a compiled binary. Preserve the `$bunfs` test and do
not replace a missing same-version artifact with an older platform package.
