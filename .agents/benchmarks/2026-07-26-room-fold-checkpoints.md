# Room fold checkpoint benchmark — join cost and retained history

Measured 2026-07-26 for issue #77 and proposed [ADR-0018](../adr/0018-memory-only-render-fold-checkpoints-and-bounded-replay-tails.md). This is an R9 history-length extension, not a replacement for the 1/10/50/100 workload matrix in [the capacity baseline](./2026-07-25-r9-capacity.md).

## The harness

Issue #77 adds `--history` to the existing R9 command:

```sh
bun run bench:gateway-capacity -- --sessions 1 --workloads idle --seconds 3 --history 1000,10000 --json /tmp/issue-77-after.json
```

Each cell still gets its own gateway process, real Host pipe, and real SSH seat. Before the measured late join, the Host seeds the Room with the requested number of small chat Envelopes and one warm SSH seat advances the live per-Room fold to a Host-posted marker, then closes. The harness samples the seatless live fold's RSS, opens one measured late join, and records gateway CPU until that Table settles. This removes one-time attachment replay from the late-join number while keeping it in `warmupCpuMs` for honesty.

The comparison build is a clean archive of `main` at `8a053f0`, with only the history-length harness copied in; production source is unchanged. The old 1,000-Envelope cell reached the marker. Its 10,000-Envelope cell did not reach the marker before the harness's 60 s timeout, so that result is a lower bound rather than an invented number.

## The box

|  |  |
| --- | --- |
| CPU | AMD Ryzen 7 255 with Radeon 780M Graphics (16 threads) |
| RAM | 27 GiB |
| OS | Linux 7.1.3-2-cachyos x86_64 |
| Runtime | Bun 1.3.13 |
| Terminal | 120×40 |
| Measurement window | 3 s after a 1.5 s settle |
| Fold policy | one table checkpoint, 100 compacted-prefix FeedLines, 512 raw tail Envelopes |

## Results

`late-join CPU` is gateway CPU from opening the measured SSH seat through the settle sample. `warm CPU` includes the one shared fold initialization plus its warm Table. `fold RSS` is the live gateway after that Table closes, with no seat open. Idle CPU is the following three-second window with the measured seat open.

| build | history Envelopes | late-join CPU | warm CPU | seatless fold RSS | idle CPU ms/s |
| --- | --: | --: | --: | --: | --: |
| before (`8a053f0`) | 1,000 | 18,745 ms | 22,048 ms | 135.4 MiB | 45.8 |
| before (`8a053f0`) | 10,000 | **>60,000 ms; timed out** | **>60,000 ms; timed out** | unavailable | unavailable |
| checkpoint + tail | 1,000 | **106.5 ms** | 193.2 ms | **121.5 MiB** | **10.43** |
| checkpoint + tail | 10,000 | **124.7 ms** | 230.4 ms | **126.5 MiB** | **11.12** |

The post-change late join rises **17.0%** from 1,000 to 10,000 Envelopes, inside ADR-0018's 20% reopening line. Idle CPU rises 6.6%. Seatless fold RSS rises 5.0 MiB (4.1%) across a tenfold Log increase; that process-level difference is allocator/run noise plus current folded value, not retained Envelope history. The dual-lane `RoomFold` test independently asserts the structural ceiling directly: after six Envelopes with tail=2, `length()` is 2 and replay is checkpoint-through-4 + Envelopes 5–6; production uses the same path with 512.

The old 1,000-Envelope setup number is much worse than the original R9 report's 160 ms one-seat setup because this history extension intentionally presents 1,000 feed-producing Envelopes. The old Table rebuilt and redrew its growing ScrollBox once per Envelope. The implementation fixes both multipliers: one shared fold checkpoint avoids per-seat prefix apply, and checkpoint replay batches the bounded initial tail into one projection update rather than one redraw per Envelope.

## What the numbers choose

- **Tail: 512 Envelopes.** It matches the measured session lag budget and is five times the 100-row production PTY ceiling. The measured 1k→10k late-join growth remains below 20%.
- **Compacted-prefix feed suffix: 100 FeedLines.** It matches the production PTY row ceiling, preserving the initially visible feed without retaining arbitrary historical scrollback.
- **Checkpoint starts at Room attachment, not first view.** The shared artifact is warmed independently of an arrival, so the first late join is not volunteered as the Room's replay worker. A 25 ms quiet probe captures the Host's current end because the stream protocol has no backlog marker.

## Reopening triggers

Re-run this command and date a new note when:

- 10,000-Envelope late-join CPU exceeds the 1,000-Envelope result by more than **20%** (baseline: 124.7 vs 106.5 ms, +17.0%);
- seatless fold RSS grows by more than **16 MiB** from 1,000 to 10,000 small Envelopes (baseline: +5.0 MiB), after a repeated run rules out allocator noise;
- ordinary diagnosis demonstrably needs more than 512 raw tail Envelopes, or a production PTY ceiling above 100 rows is adopted;
- `packages/table` changes checkpoint restore, initial replay batching, FeedLine storage, or renderer ownership. Those are the paths these numbers measure.

## Limits

One dev box, one run; these are shape and regression baselines. Chat payloads are small and repetitive. A legitimate current game state can itself grow; the bounded claim is Log-history overhead (one current-state checkpoint + 100 FeedLines + 512 Envelopes), not constant memory for arbitrarily large current state. TLS, network distance, and Host disk I/O remain excluded exactly as in R9.
