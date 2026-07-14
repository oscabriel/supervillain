# Prototype lessons

Lessons retained from the scrapped SSH-table prototype. These are evidence and architectural constraints, not inherited product scope or code.

## Proven state-model seams

- Model a room as an append-only JSONL event log reduced by a pure `apply`/replay function; rebuild room state by replaying the log at boot.
- Keep presence transient and outside durable events. Connect/disconnect flapping must not grow campaign history.
- Preserve the dispatch boundary: the prototype's `onDispatch` persistence hook proved a clean seam and is the natural boundary for a future remote transport/backend.
- Lazy room loading must be single-flight. Concurrent first access previously produced split-brain in-memory stores; review found and fixed the race.
- Adopt a guest identity into a key identity by appending a linking event rather than rewriting prior events. Historical attribution remains immutable while progress becomes reachable through the durable identity.

_Sources: `/tmp/supervillain-handoff.md` (verified implementation and review findings); `opentui-ssh-vtt-plan.md` (event-log/reducer model and future RoomStore backend analysis)._

## OpenTUI gotchas

- `<span>` receives text as children, not through a `content` prop.
- Guard `input.onSubmit` values with `typeof value === "string"`.
- Bordered boxes require an explicit height.
- Scrollbox visual options live under `style.*Options`.
- Remote capability detection is conservative; design for exact ANSI-16 even if a local SSH renderer happens to emit truecolor.
- A box title cannot independently color only part of its title.

_Sources: `/tmp/supervillain-handoff.md`; `opentui-ssh-vtt-plan.md` (remote capability constraint)._

## Verification technique that works

- Boot against a scratch `DATA_DIR` so checks are isolated and disposable.
- Exercise the real path with `ssh -tt`, `StrictHostKeyChecking=no`, and a disposable known-hosts file.
- Give the PTY a non-zero window size; otherwise OpenTUI may render nothing.
- For headless interaction, send timed `printf` keystrokes through `script`.
- Use a pyte-based PTY harness for screen assertions. Naively stripping ANSI sequences scrambles terminal cell updates.
- Treat the JSONL log as the authoritative result: assert durable events first and rendered screen state second.

_Source: `/tmp/supervillain-handoff.md` (end-to-end verification procedure)._

## Old-plan facts still true vs superseded

### Still sound analysis

- The iroh role is narrow: connections (dial by NodeId, hole punching, relay fallback), not gossip, docs, or blobs for the initial room protocol.
- Room authority is a single-writer host that validates commands and assigns sequence numbers; replicas consume ordered events and reconnect by requesting events after a known sequence.
- SSH username routing and a stable shared host key require the gateway to terminate SSH, so renderers remain at the gateway while room authority can sit behind the RoomStore seam.
- Ed25519 public keys remain the unifying identity primitive across SSH keys and iroh NodeIds. This aligns with the new map's key-as-account decision, guest adoption, and cross-device linking.

### Superseded or remade by the new map

- The old `v0`/`v1` scope and milestone sequence is not a roadmap. New scope tiers are defined independently by the wayfinder effort.
- `supervillain.now` is superseded by the locked canonical domain, **supervillain.app**.
- The old plan treated web, Convex, and iroh as deferred around an SSH-only test. The new product has three explicit surfaces: SSH tabletop, GM CLI, and web; launch web includes marketing, docs, and read-only artifact pages.
- The old plan's Draw-Steel-shaped room and static character wizard are not the core model. The base is system-agnostic; Draw Steel is the first game module, with other systems expected.
- The old gateway-only-first framing is superseded by both hosting modes with GM-hosted rooms as the center of gravity. The gateway stores only gateway-hosted logs and the name registry.
- The old room JSONL focus is broadened into GM-owned campaign folders and character artifacts. Maps are explicitly deferred from the launch noun set.
- The old guest-upgrade question is resolved: guest-to-key adoption is required, and cross-device key linking is launch-tier.
- The old plan did not define the current business or web boundaries: core/self-hosting is free; paid hosting and browser access are later; launch has no payments or web accounts, and artifact sharing uses capability URLs.

_Sources: `opentui-ssh-vtt-plan.md` (iroh and old scope analysis); `wayfinder/map.md` (current decisions and explicit deltas)._

## Process lessons

Delegated implementation worked when workers owned strictly disjoint files, shared contracts were copied verbatim into briefs, and the head retained barrel/index edits, integration, review, and verification. This prevented conflicts without outsourcing architectural coherence.

_Source: `/tmp/supervillain-handoff.md` (M1–M3 delegation retrospective)._
