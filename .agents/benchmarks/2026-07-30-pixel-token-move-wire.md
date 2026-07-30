# Pixel-mode token-move wire diff

Measured 2026-07-30 for [#68](https://github.com/oscabriel/supervillain/issues/68), against [#38](https://github.com/oscabriel/supervillain/issues/38)'s **0.1–2 KB per token move** FrameBuffer changed-run range.

## Harness

```sh
bun packages/table/bench/pixel-token-move-wire.ts
```

The harness mounts the production `MapSurfaceRenderable` over an in-memory byte-recording terminal, paints a 200×100 representative floor map in pixel-glyph mode, clears the initial frame, moves one `K` token one map cell, and counts every emitted byte. It uses the production table-chrome budget and production 4×3 pixel viewport at both acceptance terminal sizes. `TERM=xterm-256color` and `remote: false` stand in for a terminal that answered OpenTUI's capability query; the in-memory input pipe cannot answer it itself.

The harness fails if a move emits a truecolor SGR or falls outside 100–2048 bytes. The checked test in `packages/table/test/map-region.test.ts` holds the same range at both resulting map-region sizes.

## Box

|                |                                                    |
| -------------- | -------------------------------------------------- |
| CPU            | AMD Ryzen 7 255 (8 cores / 16 threads)             |
| OS             | Linux 7.1.5-1-cachyos x86_64                       |
| Runtime        | Bun 1.3.13                                         |
| OpenTUI        | 0.4.3                                              |
| Atlas geometry | MEKMODE 8×12, octants, 4×3 terminal cells per tile |

## Result

| terminal | map-region cells | visible map tiles | one-cell token-move diff | #38 range |
| --- | --- | --- | --- | --- |
| 188×60 | 156×51 | 39×17 | **261 bytes** | inside 100–2048 bytes |
| 80×24 | 48×15 | 12×5 | **261 bytes** | inside 100–2048 bytes |

Both byte streams used indexed ANSI colors below slot 16 and contained no `38;2` or `48;2` truecolor SGR.

The terminal-size equality is expected: OpenTUI emits changed runs, and the same old/new 4×3 token tiles changed in both viewports. The larger stable map did not repaint.

## What this pins

Pixel-glyph mode's measured one-cell token move is **261 bytes on the pinned runtime**, inside #38's 0.1–2 KB range. The acceptance guard remains that range rather than an exact 261-byte snapshot: cursor position, terminal cursor-address length, or a safe OpenTUI encoding improvement may change the exact byte count without changing the product contract.

#38 described its range as a source-derived estimate pending a byte-capture harness. This run is the byte-capture measurement for the pixel tier; it does not retroactively turn #38's earlier text-tier estimate into a measurement.

## Reopening triggers

Re-run and date a new result when OpenTUI changes, octant packing or 4×3 geometry changes, `MapSurfaceRenderable` stops using changed-run diffing, theme-color emission changes, or the benchmark crosses either edge of 100–2048 bytes. Any truecolor SGR is a contract failure, not a reason to widen the range.
