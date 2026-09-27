# Spike A: who renders? (ASSESSMENT Q4)

Throwaway. It answers one question: if the GM's machine renders every player's screen and a dumb relay forwards the bytes, is typing still fast enough? It's done when p95 keystroke echo is under 150 ms from two real networks.

## What's here

| File | Role |
| --- | --- |
| `host.ts` | The GM machine. It owns the log, runs `decide`, and renders one OpenTUI table per SSH session using the archived build's compiled packages. `--dial` connects it out to a relay. |
| `relay.ts` | A dumb TCP forwarder with no dependencies beyond Node's standard library. The host dials in once; each player connection is announced and the host dials back a data connection. SSH runs end to end, so the relay sees only ciphertext (the `ssh -J` variant in §6). `--delay-ms` adds one-way delay on the host leg for local simulation. |
| `probe.ts` | A scripted player. It types a character the table never draws on its own, times the echo, erases it, and repeats. Prints p50, p95, p99 and max. |
| `load.ts` | N scripted players who chat at a human pace, so the relay's log shows GM upload and the host's log shows CPU. |

It imports `packages/*/dist`, so run `bun run build` at the root first. `spikes/` is excluded from lint.

The archived build opens with focus off the input line and moves focus away after every send, so the scripted players press Tab until their typing echoes. This is the Q3 keyboard problem, not a latency cost.

## Local results (2026-09-27, one Linux desktop, loopback)

| Setup | Screens | Echo p50 / p95 / p99 | GM upload | Host CPU / RSS |
| --- | --- | --- | --- | --- |
| Direct to host, no relay | 1 | 1.4 / 2.5 / 3.1 ms | — | 0.3% / 77 MiB |
| Through relay, no delay | 1 | 1.8 / 3.1 / 4.8 ms | — | — |
| Relay, 80 ms RTT host leg, 5 chatting players | 6 | 82.2 / 84.0 / 85.6 ms | 3–10 KiB/s | 2–5% / 90–119 MiB |
| Relay, no delay, 8 chatting players | 9 | 1.5 / 2.8 / 13.6 ms | 6–16 KiB/s | 2–7% / 97–134 MiB |

**Reading:**

- **Latency.** Rendering on the GM's machine adds about 2–4 ms. Echo is roughly the network round trip player → relay → GM → relay → player, plus that.
- **Bandwidth.** GM upload for a busy table is tens of KiB/s, which is trivial.
- **Cost of many screens.** CPU stays in single digits at nine screens.
- **Memory.** Host RSS rose about 35 MiB across the eight-player run. That's not conclusive, but watch it in a three-hour session.

What local runs can't show: real-network jitter, Wi-Fi, and a GM on home upload. That's the real test below.

## The real test

You need a small VPS in a region between the GM and the players, with TCP ports 2222 and 7000 open.

1. On the VPS, with [Bun](https://bun.sh) installed, copy only `relay.ts` and run:
   ```sh
   bun relay.ts --players 2222 --control 7000
   ```
2. On the GM machine, from a clone at this commit after `bun install && bun run build`:
   ```sh
   bun spikes/a-render-location/host.ts ~/tmp/spike-camp --dial <vps>:7000
   ```
3. From two other networks (a friend's home, a phone hotspot), each from a clone:
   ```sh
   bun spikes/a-render-location/probe.ts <vps>:2222 --samples 300
   ```
   While they probe, run `load.ts <vps>:2222 --players 5` from any machine.
4. Also just `ssh -p 2222 <vps>` and type. How it feels matters as much as the number.

Record in ASSESSMENT §9, Q4:

- each network's p95;
- the plain round-trip time from `ping <vps>` on each network, for comparison;
- the relay's GM upload.

Then delete this folder.
