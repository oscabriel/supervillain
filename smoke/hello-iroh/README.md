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

| Triple      | Runner             | Entry point      |
| ----------- | ------------------ | ---------------- |
| linux-x64   | `ubuntu-latest`    | `linux-x64.ts`   |
| linux-arm64 | `ubuntu-24.04-arm` | `linux-arm64.ts` |
| macos-arm64 | `macos-latest`     | `macos-arm64.ts` |

macos-x64 is not in the matrix: `@number0/iroh@1.0.0` neither lists nor publishes a
darwin-x64 native package (npm only has an old `@number0/iroh-darwin-x64@0.22.1-test1`,
not a valid substitute for the pinned 1.0.0 API), and the triple was dropped from the
v0 GM platform set — see `.agents/adr/0001-drop-macos-x64-from-v0-gm-platforms.md`. Do
not substitute an older platform package for a missing same-version artifact.

## Adoption by `packages/transport-iroh`

The transport package should copy the per-target direct `require` pattern (or
generate equivalent target-specific CLI entry points), retain native per-triple CI,
and test the compiled executable itself. It must not rely on `@number0/iroh`'s
runtime platform loader inside a compiled binary. Preserve the `$bunfs` test and do
not replace a missing same-version artifact with an older platform package.
