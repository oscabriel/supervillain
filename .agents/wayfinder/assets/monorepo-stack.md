# Monorepo shape & stack

_Grilled and locked 2026-07-13 (ticket 015). Inputs: the four-entry-point lattice and 015 handoff from [game-module-seam](game-module-seam.md), the tiers from ticket 014, the transport-neutral session contract from [browser-terminal-bridge](browser-terminal-bridge.md), and the iroh fallback ladder from [iroh-viability](iroh-viability.md). bts facts verified against a fresh clone (e1bf536f, v3.36.x, 2026-07-08)._

## The better-t-stack verdict: there is no invocation

better-t-stack is wrong for this product; the workspace is hand-rolled. The destination's "exact invocation" clause resolves to: **no invocation; the replacement is a hand-rolled Bun workspace whose first commit is the core package + fake game module + dependency-cruiser lattice check**, per the 006 handoff.

Why, grounded in source research:

- `bts add` only adds addons, and only to bts-created projects (it detects `bts.jsonc`) — there is no path to scaffold an app into a foreign workspace. The imagined "use bts for apps/web at v1" is transplant-shaped, not invocation-shaped.
- bts has **no generic library-package generator** and **no dependency-cruiser** anywhere. Everything v0 actually consists of — core, room-host, transport-iroh, session, identity, table, games/draw-steel, games/fake, the lattice enforcement — is hand-written under either answer. The only bts contribution at v0 would be ~30 lines of workspace root.
- **The opentui addon, noted and dismissed** (so future-us doesn't reopen this): it is a thin shell-out to OpenTUI's own create-tui starter dropped at `apps/tui`, zero integration with bts packages, and a local single-process TUI shape — not an SSH gateway with room lifecycle. It doesn't change the verdict.
- Milestone 1 has no web surface at all (ticket 014): v0 is gateway + CLI + packages. Centering the scaffold on the workspace's least load-bearing, latest-arriving app would let a generator that knows nothing about the lattice dictate every apps/packages convention.

What survives from bts: **conventions as reference, not its generator** — a `packages/config` carrying the shared strict tsconfig base and per-package `composite: true` / `tsc -b` project references. At v1, apps/web arrives either by grafting from a throwaway bts scaffold or by hand-rolling against its then-current templates as reference — decided then.

## Workspace inventory

```
apps/
  gateway/           # SSH session adapter, name registry, iroh proxy
  cli/               # supervillain: host embedding, campaign nouns, local attach
packages/
  config/            # strict tsconfig base, dependency-cruiser rules, shared tool config
  core/              # envelope, log, registries (interfaces), seam interfaces,
                     # TableView, theme-token types
  table/             # the shared client: renderer fold, core chrome (feed, layout
                     # slots, focus routing, rejection feedback), token→ANSI resolution
  room-host/         # single-writer host: decide loop, JSONL persistence,
                     # in-process RoomStore adapter
  transport-iroh/    # iroh endpoint behind the narrow transport seam
  session/           # transport-neutral session contract
  identity/          # ed25519 key-as-account primitives (SSH key ↔ NodeId)
  games/draw-steel/  # model / authority / view / content
  games/fake/        # conformance fixture, all four entry points
```

Structural calls, made explicit:

- **`packages/table` is the shared client.** 014 committed "two player doors, one client": direct `supervillain join` renders the table locally, so the renderer fold, core chrome, and theme-token→ANSI resolution cannot live in apps/gateway without the CLI door duplicating them — and v3's browser terminal feeds "the same renderer/room factory," a third consumer. table imports core + OpenTUI + game view entries; **table is the only OpenTUI consumer outside game view entries, and table never imports `decide`.** Conservative capability detection (prototype lesson) applies at each door's resolution step.
- **The room host is a package, not an app.** Three consumers: CLI in-process at v0 (`supervillain create` _is_ the host), gateway in-process at v3 (the RoomStore seam's second adapter), and the 008 Node-fallback bin as a thin wrapper if it lands that way. Host-as-app would bake the process shape in prematurely.
- **Registries compose in the apps.** Core defines the registry interfaces; apps/cli and apps/gateway do the static imports of game packages and register entries (host side: model+authority; table side: model+view). room-host receives its authority registry injected and stays game-agnostic.
- **`session` is real on day one, not hypothetical**: the gateway's SSH adapter and the CLI's local-TTY attach are two genuine adapters of the same contract at v0 (loopback fixture in core tests if local attach turns out degenerate). Never typed to ssh2 (see [browser-terminal-bridge](browser-terminal-bridge.md)); v3's WebSocket adapter is the third.
- **Theme-token types in core; resolution-to-ANSI in table** — game view entries stay platform-free per 006.
- **No `apps/web` until v1** — an empty placeholder app is the workspace version of a hypothetical seam.

## Tooling

- **Plain Bun workspaces, no Turborepo.** Root scripts + `tsc -b` cover this size; task caching is named churn for when the graph actually hurts.
- **TypeScript 7** (GA 2026-07-08 — native tsc, ~10×, cross-project parallel `tsc -b`). Every package `composite: true` off the `packages/config` strict base. **All packages emit js + d.ts via tsc** — no bundler, no source-only workspace imports; apps consume built output.
- **Emit discipline as the hedge's first enforcer:** the Node-compat set compiles under `module`/`moduleResolution: nodenext` — emitted output is Node-loadable by construction. Compiler options first, tests second, dependency-cruiser third (below).
- **oxlint + oxfmt.** oxlint 1.x is mature; its type-aware mode (tsgolint) rides the same tsgo core as TS7. oxfmt is beta with 100% Prettier JS/TS conformance at ~3× Biome's speed. Rider: oxfmt is 0.x with the Prettier port finishing Q3 2026 — pin versions, absorb format churn deliberately.
- **dependency-cruiser rules in `packages/config`, CI from day one.** The ruleset, enumerated from 006 + the inventory above:
  1. `games/*` are imported only by apps (registries compose in apps; room-host and table receive injected registries).
  2. `@opentui/*` is importable only by `packages/table` and `games/*/view`.
  3. Nothing on the table side imports `decide`/authority entries.
  4. `games/*/content` imports `games/*/model` only; `model` imports nothing.
  5. **The hedge's third door:** `bun:*` and `@opentui/*` are banned across the Node-compat set (core, room-host, transport-iroh, session, identity, games' model/authority/content).
  6. Only apps/gateway imports `bun:sqlite` — "the gateway is the only thing touching a DB" is mechanically checkable. (v3's gateway-hosted rooms revisit the gateway's edges via the RoomStore seam — a deliberate future widening, not a rule to pre-relax.) _(Correction 2026-07-25, [ADR-0013](../../adr/0013-server-data-layer-gateway-owned-identity-and-two-stores.md): the stated intent is now false — the web backend touches its own SQLite store via Drizzle. The rule's real and narrower purpose is that **apps/gateway is the only thing touching the gateway's store**, and the rule text is reworded to say so. Its bypass is also closed: the rule matched `^bun:sqlite$` while `doNotFollow: node_modules` meant a Drizzle SQLite driver would import straight past the fence without firing.)_
- **Test discipline — the runner is the runtime claim.** Bun-bound code (table, gateway, cli, game view entries) → `bun test`. The Node-compat set → vitest run under Node. **transport-iroh and room-host — where the fallback lands — run the same spec files under both runners; that dual lane IS the 008 CI matrix** (two-peer direct / forced-relay / reconnect / shutdown, cross-platform), which is milestone 1's gate per ticket 014. Near-free complement: a CI smoke importing each Node-compat package's **built** entry under Node, since vitest transforms source and never loads the emitted artifacts.

## The CLI artifact

**A compiled Bun binary** (`bun build --compile`). GMs are the CLI's audience; "host your table from one file you downloaded" matches the self-hosting pillar. The CLI statically imports the game packages, so Draw Steel's packaged content rides inside the binary — desirable: a GM's binary version pins their content version, consistent with payload-derived replay.

- **The road is paved upstream, not novel:** OpenTUI core ships explicit `$bunfs` handling (including the Windows `B:\~BUN` form) — it is built to run from `bun build --compile` output and extracts its own Zig library from the embedded root. The binary's two native artifacts are OpenTUI (solved upstream) and iroh (the smoke below).
- **The iroh wrinkle, sharpened to a test:** Bun documents `.node` embedding as supported, with the caveat that loader-resolved addons must require the `.node` directly — `@number0/iroh`'s napi-rs platform loader is exactly that pattern. Scaffold smoke: compile a hello-iroh binary per target with a direct platform-specific `.node` import.
- **Distribution invariant, named:** the GM artifact is self-contained and degrades one-file → one-archive (compiled CLI + sidecar `.node` beside the binary) — **never to "install a runtime."** Consequence for the 008 ladder: the Node rung is a dev/CI hedge and the gateway's option (our infra; also where v3 gateway-hosted rooms land), not a GM-shippable artifact. If Bun+iroh fails on GM machines, the shipping fallback is the archive shape, then the Rust sidecar rung.
- **Platforms: v0 GM platforms are linux-x64, linux-arm64, macos-arm64 (three triples); Windows GMs via WSL2.** macos-x64 was dropped from the original four-triple set when the hello-iroh smoke surfaced that upstream publishes no darwin-x64 iroh artifact (ADR since deleted with iroh; macos-x64 returns per [ADR-0012](../../adr/0012-outbound-only-hybrid-drop-iroh-host-dials-out.md)); revisit trigger: a real Intel-Mac GM cohort plus a same-version artifact. For Windows the rationale is verification surface and audience priority, _not_ capability — OpenTUI ships win32-x64/win32-arm64 packages, so native Windows is upstream-capable today. Named churn with a revisit trigger: a real Windows GM cohort. Players are unaffected (any ssh client, any OS).
- **Release mechanics:** build each triple on its native CI runner (the runners the iroh matrix already requires) rather than cross-compiling with embedded native artifacts; checksums published with the curl installer; the documented macOS codesign step (JIT entitlements) in the pipeline from day one. Distribution: GitHub releases + curl installer at v0; brew tap / npm shim deferred.

## The data edge

**The product's canonical durable data is the event log — plain files** (campaign folder now; gateway room logs via the RoomStore seam at v3). Server-side databases are only ever **lookup/index state**, so ORM pressure never develops there.

- **Gateway store: SQLite via `bun:sqlite`, directly — no ORM.** v0 schema is the name→NodeId registry (~one table); v3 adds grant redemption + a room-log index to the same store. Drizzle-or-similar is named churn attached to the v1 web backend. _(Correction 2026-07-25, [ADR-0013](../../adr/0013-server-data-layer-gateway-owned-identity-and-two-stores.md): the gateway store keeps this posture exactly, and grows the **key-equivalence graph**, revoked keys, and link codes alongside name→owner identity and the ADR-0008 prefs table — identity is gateway-owned so it survives the no-backend self-hosted posture. The **backend store** is a second SQLite store with **Drizzle** as a typed query layer (churn row cashed), holding published artifacts, capability tokens, and dead-token tombstones; snapshot documents are files on disk under `/var/lib/supervillain/` with rows pointing at them. The backend reads identity through a narrow interface — local and remote implementations — never its own copy of the graph.)_
- **Migration discipline without the ORM:** a ten-line `PRAGMA user_version` + idempotent-steps helper in the gateway from day one — schema versioning is real even at one table; drizzle-kit is not the answer to it. _(Correction 2026-07-25, [ADR-0013](../../adr/0013-server-data-layer-gateway-owned-identity-and-two-stores.md): this verdict was written about the gateway and is now decided on its own merits for the backend as well — **one migration mechanism governs both stores**, and drizzle-kit is not adopted. Drizzle earns its place on typed queries, which needs none of its migration tooling; two mechanisms would mean every schema change starts with "which store, therefore which ritual." Required mitigation: a startup-or-test-time assertion that the Drizzle schema matches the SQL, so drift fails loudly instead of silently.)_
- **The web slot's standing constraints** (recorded now so v1's framework pick is mechanical): SSR pages (marketing, docs, artifact pages); OG image generation; a DB meaning **ingest endpoint + unguessable capability-URL routes + snapshot storage** — publish is push-ingest per 013: the CLI pushes snapshots, **the web backend never reads campaign folders** (006's physical enforcement, extended); no auth at launch but **passkey-ready** — the auth slot must exist even while empty (don't pick a framework that fights better-auth-style passkey wiring); it is the "one backend service beside the gateway" from 013.
- **Web's lattice edge:** if apps/web imports game packages at all, it's **model + content only — never authority, never view.** And "neither" stays live for 013/016: the payload philosophy that makes replay self-contained suggests published snapshots should be self-describing — if they are, web imports no game package at all and terminology bakes in at publish time. The rule sits ready regardless.

## Verify-at-scaffold list

Caveats to burn down in the new repo's first days, not blockers:

1. TS7 `declarationMap` emit (absent at RC) — built-output consumption makes cross-package go-to-definition depend on it.
2. dependency-cruiser pins its own `typescript@6` for parsing while tsc 7 builds — no stable TS7 programmatic API until 7.1.
3. The hello-iroh compile smoke per triple (direct platform-specific `.node` import inside `bun build --compile` output).
4. oxfmt 0.x pinning; absorb format churn deliberately when the Prettier port lands.

## First commit (the 006 handoff, restated as this repo's genesis)

The scaffold holds host / gateway / CLI / (web at v1) plus game-modules-as-packages with entry-point boundaries enforceable by dependency-cruiser. **The first commit is the core package (envelope, log, registries, seam interfaces) + the fake game module

- the dependency-cruiser lattice check — before any feature.**
