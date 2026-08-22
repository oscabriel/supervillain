# R9 capacity rerun — Bun 1.4, current chrome

Measured 2026-08-20, on the Bun 1.3.13 → 1.4.0 runtime upgrade. This rerun supersedes [2026-07-25-r9-capacity.md](2026-07-25-r9-capacity.md) as the baseline the caps are checked against. The caps themselves did not move: every reopening trigger was re-measured and none fired. `apps/gateway/src/capacity.ts` is unchanged by this run.

Two things forced the rerun, and only one of them is the runtime:

1. **Bun 1.4.0** claims 5x lower idle CPU and 20–48% lower server memory. Numbers that size, on a long-running gateway, are exactly what ADR-0012's triggers exist to re-check.
2. **The July baseline had already expired by its own clause** — "the whole document expires when `apps/gateway` changes how it renders per seat" — and nobody noticed. ADR-0030's chrome rework (Message as the sole text-capture surface, the pane focus grammar, pixel map default per ADR-0007/0021) landed across early August. Worse, the harness had rotted against it silently: see the last section.

## The harness

Same harness as July (`apps/gateway/bench/`), with one fix made for this run:

- **chat** seats now tab twice to the Message Pane before typing. Under ADR-0030's chrome a fresh seat on a mapped Room focuses the Map Pane, and bare typing there is pan keys, not chat.
- **map-pan** seats no longer tab at all — they are already on the map. The old single tab now lands on the sidebar.

Everything else — process separation, one gateway process and one Room per cell, real SSH seats through `ssh2`, the plaintext loopback pipe — is unchanged from the July doc, which remains the description of record for the harness's shape.

## The box

|  |  |
| --- | --- |
| CPU | AMD Ryzen 7 255 (16 threads) |
| RAM | 27 GiB |
| OS | Linux 7.1.3-2-cachyos x86_64 |
| Runtimes | Bun **1.4.0** (canonical) and Bun **1.3.14** (attribution run) |
| Terminal per seat | 120×40 |
| Window per cell | 10 s, after a 1.5 s settle |
| Gateway caps during the run | rooms/sessions/PTY opened wide; both output budgets at shipped defaults |

Both matrices ran the same fixed harness on the same box on the same day, so differences between them are the runtime. One caveat on attribution: the 1.4 run used the real `ws` dialer (the Bun-1.4 `checkServerIdentity` workaround in `transport-ws`), the 1.3.14 run used Bun's shim client, because the real client needs 1.4's `node:http`. The pipe is plaintext loopback at ≤15 KiB/s either way; nothing in the matrix is within noise of caring.

Neither matrix is comparable cell-for-cell to July's: the chrome changed underneath it. Where July is quoted below, it is quoted as "old chrome, old harness" context, not as a baseline delta.

## The matrix — Bun 1.4.0 (canonical)

Same units as July: `cpu ms/s` is gateway CPU per wall-clock second (1000 = one core); `p50`/`p95` are key-to-frame for chat and map-pan, broadcast for slow-reader.

| workload | seats | cpu ms/s | cpu ms/seat/s | rss MiB | rss KiB/seat | out KiB/seat/s | pipe KiB/s | p50 ms | p95 ms | closed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| idle | 1 | 5.2 | 5.22 | 87 | 12972 | 0.00 | 0.10 | – | – | 0/0 |
| idle | 10 | 5.8 | 0.58 | 110 | 3741 | 0.00 | 0.96 | – | – | 0/0 |
| idle | 50 | 9.0 | 0.18 | 180 | 2150 | 0.00 | 4.83 | – | – | 0/0 |
| idle | 100 | 11.3 | 0.11 | 289 | 2199 | 0.00 | 9.67 | – | – | 0/0 |
| chat | 1 | 18.3 | 18.34 | 92 | 16072 | 3.21 | 0.17 | 8.4 | 10.7 | 0/0 |
| chat | 10 | 174.0 | 17.40 | 134 | 6054 | 3.42 | 1.71 | 8.2 | 36.7 | 0/0 |
| chat | **32** | **519.7** | **16.24** | **258** | **5643** | **5.34** | **5.49** | **15.1** | **100.5** | 0/0 |
| chat | 50 | 923.5 | 18.47 | 468 | 8048 | 3.69 | 8.41 | 186.5 | 393.7 | 0/0 |
| chat | 100 | 988.2 | 9.88 | 612 | 5493 | 3.81 | 14.91 | 484.7 | 1070.3 | 0/0 |
| map-pan | 1 | 67.8 | 67.79 | 106 | 31004 | 2.92 | 0.10 | 6.3 | 7.6 | 0/0 |
| map-pan | 10 | 304.2 | 30.42 | 207 | 13537 | 2.92 | 0.96 | 18.0 | 34.2 | 0/0 |
| map-pan | 50 | 938.5 | 18.77 | 337 | 5366 | 2.92 | 4.83 | 63.4 | 115.4 | 0/0 |
| map-pan | 100 | 1093.9 | 10.94 | 492 | 4271 | 1.91 | 9.67 | 169.3 | 239.2 | 0/0 |
| slow-reader | 1 | 165.1 | 165.14 | 121 | 46556 | 0.00 | 2.43 | – | – | 0/0 |
| slow-reader | 10 | 680.1 | 68.01 | 249 | 17856 | 7.02 | 3.30 | 26.4 | 38.9 | 0/0 |
| slow-reader | 50 | 1111.1 | 22.22 | 468 | 8051 | 0.14 | 6.29 | 144.7 | 192.6 | 0/0 |
| slow-reader | 100 | 1109.7 | 11.10 | 646 | 5847 | 0.14 | 10.30 | 277.4 | 384.7 | 0/0 |

The 32-seat chat cell was run separately at the cap, because the cap was originally read off an interpolation and this chrome's latency curve is too non-linear to interpolate: 36.7 ms at 10 and 393.7 ms at 50 would interpolate to ~230 ms at 32; the measured value is 100.5 ms. Fan-out cost concentrates near thread saturation, and 32 seats sit below the knee.

Raw JSON: `/tmp` at run time; the numbers above are the record.

## The matrix — Bun 1.3.14, same harness, same day

| workload | seats | cpu ms/s | rss MiB | p95 ms |
| --- | --- | --- | --- | --- |
| idle | 1 | 9.1 | 110 | – |
| idle | 100 | 22.2 | 313 | – |
| chat | 10 | 194.0 | 152 | 42.7 |
| chat | **32** | **616.7** | **350** | **120.9** |
| chat | 50 | 953.8 | 495 | 399.3 |
| chat | 100 | 975.4 | 678 | 1012.1 |
| map-pan | 1 | 123.0 | 124 | 6.2 |
| map-pan | 100 | 1128.7 | 541 | 247.0 |
| slow-reader | 100 | 1126.7 | 714 | 430.2 |
| peak RSS across run | | | **714** | |

(Full 16-cell table captured in the run log; the rows above are the ones the attribution below cites.)

## What the runtime upgrade is actually worth

Same chrome, same harness, 1.3.14 → 1.4.0:

- **Idle CPU halves.** 9.1 → 5.2 ms/s at 1 seat (the process floor), 22.2 → 11.3 ms/s at 100 seats. Not the blog's 5x — that was a bare `Bun.serve` hello-world — but a real halving on a process that is mostly SSH sessions at rest.
- **The RSS floor drops ~23 MiB.** 110 → 87 MiB empty-ish, and roughly that same gap holds at every seat count (313 → 289 at 100 idle seats). Peak across the full matrix: 714 → 690 MiB.
- **Latency at the cap improves ~17%.** Chat p95 at 32 seats: 120.9 → 100.5 ms; CPU at the cap 617 → 520 ms/s.
- **Saturation is saturation.** Every heavy cell still plateaus at ~1100 ms/s — the single JS thread — and the saturated p95s (chat 100, slow-reader 100) are within noise of each other across runtimes. Bun 1.4 does not move the one-thread ceiling; it lowers the cost of everything below it.
- **The table's own idle bench** (`bench:table-idle-cpu`, 25 seats, 5 s): on-demand 0.56 → 0.26 ms/seat/s; ambient loop 11.64 → 7.21 ms/seat/s.

## What the chrome rework is worth (July's numbers as context)

Old chrome + old harness on 1.3.13 vs current chrome + fixed harness on 1.3.14 conflates harness fixes with chrome cost, so read these as direction, not deltas:

- **Chat above the cap got more expensive.** p95 at 50 seats was 151 ms in July, is ~395 ms now on either runtime. Pixel map default, rails, and panels made a per-seat redraw cost more. At and below the cap it is unchanged (~100 ms at 32, which is what the cap was chosen on).
- **Idle RSS per seat improved.** ~3.5–5.6 MiB/seat in July, ~2.2 MiB/seat now at 50–100 seats, on both runtimes — a chrome effect, further helped by 1.4's lower floor.
- **Slow-reader render coalescing sharpened.** Per-seat output at 50–100 seats collapses to 0.14 KiB/s under saturation (July: 1.9–4.0). Fast readers still never close (0/0 everywhere) and broadcast p95 stays under 430 ms, so NQ-5 holds; the renderer simply merges more frames when behind.

## The caps, re-checked

Every trigger from the July doc, measured against this run (Bun 1.4.0, current chrome):

| cap | trigger | measured | verdict |
| --- | --- | --- | --- |
| `sessionsPerRoom` 32 | p95 at cap > 250 ms, or CPU at cap > 80% of a core | **100.5 ms**, **52%** | holds |
| `roomsPerIdentity` 8 | seatless Room > 5 KiB/s pipe or measurable CPU | ~0.10 KiB/s, none | holds |
| `sessionBudget` 512 | any `view-dropped` in production | zero across the matrix | holds |
| `sessionOutputBytes` / `sessionStallMs` | (superseded 2026-07-25, #62 — reopens against `@opentui/ssh` backpressure) | healthy seats ≤ 7 KiB/s | holds |
| `pty` 300×100 | a measured PTY-size sweep | still not done — every seat 120×40 | unchanged, still unswept |
| NQ-2 (wss pipe) | > ~1 MiB/s sustained on the one pipe | 14.91 KiB/s at the busiest cell | holds, factor ~70 below |

**One box, roughly, restated:** a gateway process still wants about one core for a busy Room, but a hundred idle seats now cost ~11 ms/s of CPU and ~290 MiB of RSS (~2.2 MiB/seat over an ~87 MiB floor). July's "a core and a gigabyte for a hundred seats" is now conservative on memory by about a third.

## Reopening triggers

The July doc's triggers carry forward with these baselines substituted:

- `sessionsPerRoom` reopens above **250 ms p95 at the cap** (baseline now a *measured* 100.5 ms, not an interpolation) or **80% of a core at the cap** (baseline 52%).
- The pipe (NQ-2), `roomsPerIdentity`, and `sessionBudget` triggers are unchanged; their measured values above are the new comparison points.
- **This document expires the way the last one did**: when `apps/gateway` changes how it renders per seat — and, learned this round, *when the Table's key grammar changes*, because the harness types at the chrome and silently measures the wrong thing when the chrome moves under it. A chrome-behavior change that lands without a harness check is the same bug twice.
- A **runtime upgrade** of the shipped binary (the Bun version `bun build --compile` embeds) is a rerun trigger. This run is the precedent.

## What this run found that is not a number

**The harness had been measuring a fiction since early August.** The July chrome focused the message input on join; ADR-0030's chrome focuses the Map Pane when a map is loaded, and Message became the sole text-capture surface. From then until this run, the chat workload's typed lines were being consumed as map pan keys and a token pickup — chat cells produced *zero* posts (pipe traffic identical to idle), and nobody was measuring fan-out at all. The tell that finally surfaced it: a "Bun 1.4 rerun" showed chat p95 *improving* 60x, which was not speed, it was silence. Two lessons worth keeping:

1. A benchmark whose workload drives a UI needs an in-run assertion that the workload did what it claims — the chat cells should fail loudly when the pipe carries no posts. The harness does not have that yet; it should.
2. An expiry clause in a benchmarks doc is only as good as whoever re-reads it. The chrome rework tripped the July doc's expiry clause three weeks before anyone looked.

## What this run does not measure

Unchanged from July: TLS on the pipe, a real Host, real network, the web backend, sustained hours. The PTY-size sweep the July doc deferred is still deferred.
