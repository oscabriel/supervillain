# PROTOTYPE: the battlemap as pictures (throwaway)

**The question:** should the map draw bigger, livelier tokens and terrain with MEKMODE pictures over the kitty graphics protocol, and if so, which look, at what cost on the wire?

This lives on the `prototype/map-art` branch only. Nothing here is tested or meant to merge. Once the question is answered, the winning look gets rebuilt properly in `table/`, and this folder stays on the branch as the record.

MEKMODE is MEK.txt's 8x12 pixel font. `dings.ts` and `text.ts` are its glyphs, baked to 1-bit bitmaps by the archived build (`archive/2026-09-exploration`, `packages/atlas`). They're used with MEK's permission (Oscar, 2026-10-22).

## Run it

```sh
bun apps/supervillain/src/table/prototype-map-art/demo.ts
```

This sets up the sample fight at the ford in `/tmp/sv-map-art` (a scratch folder, wiped on each run), in combat on Brann's turn, and hosts it in your terminal as the GM. Players join with `ssh -p 2399 ford@127.0.0.1`. Use a terminal with kitty graphics (Ghostty, kitty, WezTerm) to see the pictures.

| Key | What it does, for this seat only |
| --- | --- |
| F2 | Next look: text (today) → A painted → B miniatures → C text + sprites |
| F3 | Image protocol: auto → kitty → sixel → blocks |
| F4 | How kitty images travel: zlib (compressed) or raw |

The map's title shows the look, the protocol asked for and the one in use, and, on an SSH seat, the bytes sent since the map last changed. Read that number right after a move.

## The looks

- **A painted.** A DOS-tile scene: MEKMODE dings for floor, walls and the ford, and each token as a figure in its side's colour with its mark in the corner.
- **B miniatures.** A flat board with a grid and stone walls. Each token is a round base with its mark in big letters.
- **C text + sprites.** Today's text terrain at the bigger square size, with each token as a figure sprite.

Every look has 4x2-cell squares (about square, and big enough for a picture), with column letters and row numbers around them. The view follows whoever is acting.

## What it showed so far (2026-10-22, Ghostty 1.x over our SSH seat, 130x42, the ford map)

- **Kitty works through our SSH seats.** OpenTUI 0.6.6's `<image>` picked kitty by itself (`auto → kitty`).
- **Bytes per token move, per seat:**

  | Look | raw | zlib |
  | --- | --- | --- |
  | A painted | 1017 KB | 35 KB |
  | B miniatures | 1017 KB | 25 KB |
  | C text + sprites | 49 KB | 7 KB |
  | text (today) | 2 KB | 2 KB |

  - OpenTUI re-sends a whole image whenever it changes, and defaults to raw pixels. `renderer.kittyImageTransport = "zlib"` is what makes the pictures affordable.
  - With 8 seats, A costs about 280 KB per move against about 16 KB today.
- **A fourth look didn't work out.** Painted terrain sent once as a background, with sprites over it, cost more than A (24 to 53 KB a move): OpenTUI re-sent the background anyway. It also dropped the token sprites, so it's gone.
- **The block fallback can't be read.** A terminal without kitty graphics (macOS Terminal.app, Windows Terminal, tmux) gets coloured blocks, and the tokens' marks turn to noise. Players type those marks in commands, so the real build should show the text map wherever an image would fall back to blocks.

## Still to learn, at a table

- Which look people want, if any, against the text map.
- Whether the marks read at a glance in each look.
- What the GM's upload is like with real players on real networks.
