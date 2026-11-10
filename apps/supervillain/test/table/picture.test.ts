import { describe, expect, test } from "bun:test";
import { NativeImage } from "@opentui/core";
import {
  cellPixels,
  FALLBACK_TILE,
  figureOf,
  letterAt,
  outOfView,
  paintPicture,
  pictureRowsWanted,
  pictureWindow,
  REACH,
  SIDES,
  TILE,
  tileFor,
  TONES,
  VOID,
} from "../../src/table/picture.ts";
import type { MapView } from "../../src/table/view.ts";
import { ford, hall, token } from "./maps.ts";

/** The colour at a square's top-left corner pixel: its ground, under any glyph. */
const corner = (map: MapView, x: number, y: number) =>
  paintPicture(map, pictureWindow(map, 99, 99)).get(x * TILE, y * TILE);

describe("which squares the picture shows", () => {
  test("the whole map when it fits", () => {
    expect(pictureWindow(ford, 10, 10)).toEqual({ x0: 0, y0: 0, cols: 6, rows: 4 });
  });

  test("else centred on the seat's /view, else whoever acts, kept on the map", () => {
    expect(pictureWindow(hall(), 10, 6, { x: 20, y: 15 })).toEqual({
      x0: 16,
      y0: 13,
      cols: 10,
      rows: 6,
    });
    // Vex acts at aj26, near the bottom-right corner: the view stops at the map's edge.
    expect(pictureWindow(hall(), 10, 6)).toEqual({ x0: 30, y0: 23, cols: 10, rows: 6 });
    expect(outOfView(hall(), pictureWindow(hall(), 10, 6)).map((t) => t.mark)).toEqual([
      "B",
      "g",
      "O",
    ]);
  });

  test("a pane wants two rows a square, the column letters and its border", () => {
    expect(pictureRowsWanted(ford)).toBe(4 * 2 + 1 + 2);
  });
});

describe("the painted squares", () => {
  test("a plain map's terrain stands in as ground, brick and rough mounds", () => {
    expect(letterAt(ford, 0, 3)).toBe("q");
    expect(letterAt(ford, 2, 1)).toBe("s");
    expect(letterAt(ford, 2, 2)).toBe("E");
    expect(corner(ford, 2, 1)).toEqual(TONES.stone.bg);
    expect(corner(ford, 2, 2)).toEqual(TONES.ground.bg);
  });

  test("a mekmode map draws its own letters in their tones; outside is void", () => {
    const ruin: MapView = {
      name: "Ruin",
      width: 3,
      height: 2,
      terrain: [".# ", ".~ "],
      dressing: ["us ", "uz "],
      tokens: [],
      reach: [],
    };
    expect(letterAt(ruin, 1, 1)).toBe("z");
    expect(corner(ruin, 0, 0)).toEqual(TONES.grass.bg);
    expect(corner(ruin, 1, 0)).toEqual(TONES.stone.bg);
    expect(corner(ruin, 1, 1)).toEqual(TONES.water.bg);
    expect(corner(ruin, 2, 0)).toEqual(VOID);
  });

  test("reach is tinted; the acting token is framed in white; tokens wear their side's colour", () => {
    expect(corner(ford, 0, 0)).toEqual(REACH);
    // Vex acts at b2: the frame's corner is white.
    expect(corner(ford, 1, 1)).toEqual([255, 255, 255]);
    // The goblin waits at e3: its square is tinted toward the Director's purple.
    const goblin = corner(ford, 4, 2);
    expect(goblin[2]).toBeGreaterThan(TONES.ground.bg[2]);
    expect(goblin).not.toEqual(TONES.ground.bg);
    const picture = paintPicture(ford, pictureWindow(ford, 99, 99));
    const pixels = (sx: number, sy: number) => {
      const seen: string[] = [];
      for (let y = 0; y < TILE; y++)
        for (let x = 0; x < TILE; x++) seen.push(picture.get(sx * TILE + x, sy * TILE + y).join());
      return new Set(seen);
    };
    expect(pixels(4, 2).has(SIDES.director.join())).toBe(true);
    expect(pixels(1, 1).has(SIDES.mine.join())).toBe(true);
  });

  test("goes to the terminal as a PNG of exactly its pixels, a small part of their size", () => {
    const picture = paintPicture(hall(), pictureWindow(hall(), 12, 8));
    const png = picture.png();
    const image = NativeImage.decode(png);
    expect(image.info().format).toBe("png");
    const decoded = image.raw().data;
    image.dispose();
    expect(decoded).toEqual(picture.pixels);
    expect(png.length).toBeLessThan(picture.pixels.length / 100);
  });

  test("a figure is the token's own, by id, from its side's figures", () => {
    const a = figureOf({ id: "goblin-1", side: "director" });
    expect(figureOf({ id: "goblin-1", side: "director" })).toBe(a);
    expect(figureOf(token({ id: "vex", mark: "V", x: 0, y: 0, side: "heroes" }))).toMatch(
      /[0-9&@]/,
    );
  });
});

describe("a square's size in pixels", () => {
  test("is the seat's cells, from its window in pixels and its size in cells", () => {
    expect(cellPixels({ width: 2560, height: 1600 }, 128, 40)).toEqual({ width: 20, height: 40 });
    // A window with padding past the cells still gives whole cells.
    expect(cellPixels({ width: 1294, height: 811 }, 128, 40)).toEqual({ width: 10, height: 20 });
    expect(cellPixels(null, 128, 40)).toBeUndefined();
  });

  test("is unknown for a seat at the SSH size cap, whose window may hold more cells", () => {
    // A 4K screen of 10x20 cells is 384x108, but an SSH seat's renderer stops at 300x100.
    expect(cellPixels({ width: 3840, height: 2160 }, 300, 100)).toBeUndefined();
    expect(cellPixels({ width: 3440, height: 1000 }, 300, 50)).toBeUndefined();
    expect(cellPixels({ width: 2990, height: 1980 }, 299, 99)).toEqual({ width: 10, height: 20 });
  });

  test("is exactly a square's cells, glyphs at the biggest whole scale that fits", () => {
    expect(tileFor({ width: 20, height: 40 })).toEqual({ width: 80, height: 80, scale: 6 });
    expect(tileFor({ width: 10, height: 20 })).toEqual({ width: 40, height: 40, scale: 3 });
    expect(tileFor({ width: 9, height: 19 })).toEqual({ width: 36, height: 38, scale: 3 });
  });

  test("falls back to TILE when the cells are unknown, implausible or too big a picture", () => {
    expect(tileFor(undefined)).toEqual({ width: TILE, height: TILE, scale: 3 });
    expect(tileFor({ width: 1, height: 2 })).toBe(FALLBACK_TILE);
    expect(tileFor({ width: 4000, height: 9000 })).toBe(FALLBACK_TILE);
    expect(tileFor({ width: 20, height: 40 }, 60 * 40)).toEqual(tileFor({ width: 20, height: 40 }));
    expect(tileFor({ width: 48, height: 96 }, 60 * 40)).toBe(FALLBACK_TILE);
  });

  test("a picture painted for 20x40 cells is 80 pixels a square, its glyphs at 6x", () => {
    const tile = tileFor({ width: 20, height: 40 });
    const picture = paintPicture(ford, pictureWindow(ford, 99, 99), tile);
    expect([picture.width, picture.height]).toEqual([6 * 80, 4 * 80]);
    expect(picture.get(2 * 80, 1 * 80)).toEqual(TONES.stone.bg);
    expect(picture.get(1 * 80, 1 * 80)).toEqual([255, 255, 255]);
    // Every lit pixel of a terrain glyph is one of 6x6 blocks: the wall at c2 is drawn at 6x.
    const glyph = (x: number, y: number) => picture.get(2 * 80 + 16 + x, 1 * 80 + 4 + y).join();
    const lit = new Set<string>();
    for (let y = 0; y < 72; y++) for (let x = 0; x < 48; x++) lit.add(glyph(x, y));
    expect(lit.has(TONES.stone.fg.join())).toBe(true);
    for (let y = 0; y < 72; y += 6)
      for (let x = 0; x < 48; x += 6)
        for (let j = 0; j < 6; j++)
          for (let i = 0; i < 6; i++) expect(glyph(x + i, y + j)).toBe(glyph(x, y));
  });
});
