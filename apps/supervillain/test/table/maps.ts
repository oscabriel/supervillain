import type { MapToken, MapView } from "../../src/table/view.ts";

/** A token with quiet defaults: a director's creature named by its id, not the seat's, waiting, alive. */
export const token = (
  over: Partial<MapToken> & Pick<MapToken, "id" | "mark" | "x" | "y">,
): MapToken => ({
  name: over.id,
  side: "director",
  mine: false,
  acting: false,
  dead: false,
  ...over,
});

/**
 * The ford, small enough to fit anywhere: six squares by four, a wall and difficult water, Vex
 * (the seat's, acting) at b2 with where she can reach, a goblin at e3 and a dead ogre at f4.
 */
export const ford: MapView = {
  name: "Ford crossing",
  width: 6,
  height: 4,
  terrain: ["......", "..##..", "..~~..", "......"],
  tokens: [
    token({ id: "vex", mark: "V", x: 1, y: 1, side: "heroes", mine: true, acting: true }),
    token({ id: "goblin-1", mark: "g1", x: 4, y: 2 }),
    token({ id: "ogre", mark: "O", x: 5, y: 3, dead: true }),
  ],
  reach: [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 2, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: 2 },
    { x: 1, y: 2 },
  ],
  reachLabel: "Vex can reach: speed 5",
};

/**
 * A hall far bigger than any pane: forty squares by thirty, all floor. Vex (the seat's, acting)
 * at aj26, Brakka at c4, a goblin at ae6, an ogre at k26 and a dead scout at a1.
 */
export const hall = (over: { readonly acting?: string; readonly mine?: string } = {}): MapView => {
  const acting = over.acting ?? "vex";
  const mine = over.mine ?? "vex";
  const at = (id: string, mark: string, x: number, y: number, more: Partial<MapToken> = {}) =>
    token({ id, mark, x, y, acting: id === acting, mine: id === mine, ...more });
  return {
    name: "Great hall",
    width: 40,
    height: 30,
    terrain: Array.from({ length: 30 }, () => ".".repeat(40)),
    tokens: [
      at("vex", "V", 35, 25, { side: "heroes" }),
      at("brakka", "B", 2, 3, { side: "heroes" }),
      at("goblin", "g", 30, 5),
      at("ogre", "O", 10, 25),
      at("scout", "s", 0, 0, { dead: true }),
    ],
    reach: [],
  };
};

/** A sixteen by twelve courtyard for the App's layout, with Vex acting and her reach labelled. */
export const courtyard: MapView = {
  name: "Courtyard",
  width: 16,
  height: 12,
  terrain: Array.from({ length: 12 }, (_, y) => (y === 5 ? "....####....####" : ".".repeat(16))),
  tokens: [
    token({ id: "vex", mark: "V", x: 3, y: 3, side: "heroes", mine: true, acting: true }),
    token({ id: "bandit-chief", mark: "C", x: 12, y: 8 }),
  ],
  reach: [
    { x: 3, y: 2 },
    { x: 4, y: 3 },
  ],
  reachLabel: "Vex can reach: speed 5",
};

/** The sample campaign's map (examples/campaign/maps/ford-road.txt), with its fight set up on it. */
export const fordRoad: MapView = {
  name: "The Ford Road",
  width: 20,
  height: 10,
  terrain: [
    "  ................  ",
    ".##.###....~~.......",
    ".#.....#...~~..~~...",
    ".......#...~~..~~...",
    "...........~~.......",
    "...........~~.......",
    "....~......~~...#.#.",
    "...~~......~~...#...",
    "...........~~.......",
    "  ................  ",
  ],
  tokens: [
    token({ id: "brann", mark: "B", x: 1, y: 4, side: "heroes", mine: true }),
    token({ id: "ilsa", mark: "I", x: 1, y: 5, side: "heroes" }),
    token({ id: "kesh", mark: "K", x: 2, y: 5, side: "heroes" }),
    token({ id: "wren", mark: "W", x: 1, y: 6, side: "heroes" }),
    token({ id: "bandit-chief", mark: "c", x: 15, y: 5, acting: true }),
    token({ id: "bandit-bruiser-1", mark: "b1", x: 14, y: 4 }),
    token({ id: "bandit-bruiser-2", mark: "b2", x: 14, y: 6 }),
    token({ id: "bandit-cutpurse-a", mark: "cA", x: 15, y: 4 }),
    token({ id: "bandit-slinger-a", mark: "sA", x: 15, y: 6 }),
  ],
  reach: [],
};
