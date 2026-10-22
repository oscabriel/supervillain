import { describe, expect, test } from "bun:test";
import {
  figureOf,
  letterAt,
  outOfView,
  paintPicture,
  pictureRowsWanted,
  pictureWindow,
  REACH,
  SIDES,
  TILE,
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

  test("a figure is the token's own, by id, from its side's figures", () => {
    const a = figureOf({ id: "goblin-1", side: "director" });
    expect(figureOf({ id: "goblin-1", side: "director" })).toBe(a);
    expect(figureOf(token({ id: "vex", mark: "V", x: 0, y: 0, side: "heroes" }))).toMatch(
      /[0-9&@]/,
    );
  });
});
