# Bitmap-tier wire cost (deflate level, chunk size, strip budget)

Measured 2026-08-24 for [#134](https://github.com/oscabriel/supervillain/issues/134) against the ADR-0012/NQ-10 gate on `map-kitty.ts`'s three placeholder numbers. Closes the headless leg; one live-leg item stays open (below).

## Harness

```sh
bun packages/table/bench/kitty-bitmap-wire.ts
```

The harness walks `#paintBitmap`'s exact chain — `mapRegionSize` → `pixelViewportSize` → `composeMapCells` → `rasterizeCells` at the fixed 12×24 fallback metrics — over a seeded 200×100 dungeon (terrain mix of `docs/examples/cavern.map`, two tokens), then measures through the production encoder and emitter: `transmitSequences` itself for wire bytes and encode time, a fresh injected-sink `KittyMapSurface` for full-base cost. All byte counts are deterministic; re-runs reproduce exactly.

Three sweeps:

- **Deflate level** 1–9: full-base transmit bytes and median encode time (15 runs, 2 warmups).
- **Chunk size** 1 KiB–64 KiB: sequence count and APC framing overhead.
- **Strip budget**: strip re-encode cost for compact changed rects of 1–100 tiles against the full-base retransmit they avoid.

## Box

|                |                                                    |
| -------------- | -------------------------------------------------- |
| CPU            | AMD Ryzen 7 255 (8 cores / 16 threads)             |
| OS             | Linux 7.1.8-1-cachyos x86_64                       |
| Runtime        | Bun 1.4.0                                          |
| OpenTUI        | 0.4.3 (pin `a0b9064` semantics)                    |
| Cell metrics   | fixed fallback 12×24 (CSI 16 t still parse-and-dropped upstream) |

## Result

### Full-base retransmit (the number that dominates initial load and large changes)

| terminal | grid (cells = tiles) | raw frame | wire @ L3/4096 | wire @ L6/4096 | encode L3 → L6 |
| --- | --- | --- | --- | --- | --- |
| 188×60 | 128×51 = 32×17 | 7.52 MB | 244 KB | **106 KB** | 4.3 → 7.7 ms |
| 80×24 | 20×15 = 5×5 | 0.35 MB | 13 KB | **5 KB** | 0.2 → 0.3 ms |

Level sweep at 188×60 (wire bytes, median encode): L1 375 KB/2.1 ms · L2 250/2.4 · L3 244/4.3 · L4 200/7.2 · L5 188/7.4 · **L6 106/7.7** · L7 93/10.6 · L8 63/17.3 · L9 62/17.1. The terrain is flat-color RGBA, and levels ≥6 exploit it: L6 halves the wire against gloomberb's local-pty level 3 for +3.4 ms once per retransmit; L8–L9 buy another ~40% but double encode again.

### Chunk size

APC framing is ~11 base64-invariant bytes per chunk — 0.6 KB across a 238 KB transmit at 4096, noise at every size swept. What chunking actually moves is sequence count: 238 sequences at 1 KiB down to 4 at 64 KiB (188×60). Whether ssh packetization favors fewer larger chunks is not decidable headlessly.

### Strip budget

At 188×60, no swept rect reached crossover — a 12-tile strip costs ≤6 KB (ratio ≤0.024), and even a 100-tile rect is 43 KB (0.178). At 80×24 the whole grid is 25 tiles; strips stop paying near 16 (ratio 0.93), so the cap is load-bearing exactly there: at 12 tiles the worst case stays 0.555. **MAX_STRIP_TILES = 12 stands.**

## What this pins

- **Deflate level 6** becomes the shipped default in `transmitSequences` (test-pinned in `map-kitty.test.ts`). Level 3 remains reachable via the parameter.
- **Chunk size stays 4096** — framing overhead is noise, and nothing headless argues for changing it.
- **MAX_STRIP_TILES stays 12**, now measured rather than prototype-inherited.

## Reopening triggers

Re-run and date a new result when OpenTUI changes past pin `a0b9064`, native cell-pixel geometry lands (real metrics change raster sizes and therefore every byte count), tile geometry or theme-color emission changes, the terrain mix these maps model shifts materially, or the live leg below contradicts a pick.

**Open live-leg item:** drive the product over a real ssh Door (`create` + `join`, `/map load cavern`) comparing perceived initial-load and pan latency at L3 vs L6, and at 4096 vs 64 KiB chunks, before declaring the chunk-size question closed. The L6 pin is arithmetic-safe regardless — less wire cannot hurt a constrained link — but this doc's chunk verdict awaits that run.
