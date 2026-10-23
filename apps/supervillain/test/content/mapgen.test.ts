import { describe, expect, test } from "bun:test";
import { MAP_KINDS, readMapText } from "../../src/game/drawSteel/map.ts";
import { LEGEND } from "../../src/game/drawSteel/mekmode.ts";
import { generateMap, mapFileText } from "../../src/content/mapgen.ts";

const SEEDS = Array.from({ length: 40 }, (_, i) => i * 7919 + 1);

/** Whether the west edge reaches the east edge over squares that aren't wall or outside. */
function crossable(terrain: ReadonlyArray<string>): boolean {
  const h = terrain.length;
  const w = terrain[0]!.length;
  const open = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < w && y < h && terrain[y]![x] !== "#" && terrain[y]![x] !== " ";
  const seen = new Set<number>();
  const stack: [number, number][] = [];
  for (let y = 0; y < h; y++) if (open(0, y)) stack.push([0, y]);
  while (stack.length) {
    const [x, y] = stack.pop()!;
    if (!open(x, y) || seen.has(y * w + x)) continue;
    seen.add(y * w + x);
    if (x === w - 1) return true;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  return false;
}

describe("generated maps", () => {
  test("a kind and a seed always make the same map; another seed, another", () => {
    for (const kind of MAP_KINDS) {
      expect(generateMap(kind, 7)).toEqual(generateMap(kind, 7));
      expect(generateMap(kind, 7).lines).not.toEqual(generateMap(kind, 8).lines);
    }
  });

  test("every map is a mekmode map file the table loads: legend letters, a name, the size asked", () => {
    for (const kind of MAP_KINDS)
      for (const seed of SEEDS) {
        const map = generateMap(kind, seed);
        expect(map.lines).toHaveLength(14);
        for (const line of map.lines) {
          expect(line).toHaveLength(24);
          for (const letter of line) expect(LEGEND[letter]).toBeDefined();
        }
        const grid = readMapText(`${kind}-${seed}`, mapFileText(map));
        expect(grid).toMatchObject({ name: map.name, dressing: map.lines });
      }
  });

  test("every map can be crossed from west to east, and each side has room to deploy", () => {
    for (const kind of MAP_KINDS)
      for (const seed of SEEDS) {
        const map = generateMap(kind, seed);
        const grid = readMapText("m", mapFileText(map));
        if ("refusal" in grid) throw new Error(grid.refusal);
        expect(crossable(grid.terrain)).toBe(true);
        expect(map.deploy.west.length).toBeGreaterThanOrEqual(6);
        expect(map.deploy.east.length).toBeGreaterThanOrEqual(6);
        for (const { x, y } of [...map.deploy.west, ...map.deploy.east])
          expect(grid.terrain[y]![x]).not.toBe("#");
        expect(map.deploy.west.every((s) => s.x < 3)).toBe(true);
        expect(map.deploy.east.every((s) => s.x > 20)).toBe(true);
      }
  });

  test("each kind has what makes it that place", () => {
    const has = (lines: ReadonlyArray<string>, letters: string) =>
      [...letters].some((l) => lines.some((line) => line.includes(l)));
    for (const seed of SEEDS) {
      const crossing = generateMap("crossing", seed).lines;
      expect(has(crossing, "zZxX")).toBe(true); // the river
      expect(has(crossing, "a")).toBe(true); // the road
      expect(has(crossing, "s")).toBe(true); // the ruin's walls
      const keep = generateMap("keep", seed).lines;
      expect(has(keep, "s")).toBe(true); // the curtain wall
      expect(has(keep, "kK")).toBe(true); // its towers
      expect(has(keep, "d")).toBe(true); // the gate
      expect(has(keep, "f")).toBe(true); // the hall's roof
    }
  });
});
