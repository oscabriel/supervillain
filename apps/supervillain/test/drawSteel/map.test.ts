import { describe, expect, test } from "bun:test";
import {
  formatSquare,
  type MapGrid,
  mapView,
  parseSquare,
  readMapText,
} from "../../src/game/drawSteel/index.ts";
import type { StatBlock } from "../../src/game/drawSteel/sheets.ts";
import { completeMapArgs } from "../../src/game/drawSteel/map.ts";
import { commands } from "../../src/game/index.ts";
import type { MapView } from "../../src/table/view.ts";
import {
  ALICE,
  ARCHER,
  BOB,
  fixedDice,
  GM,
  GOBLIN,
  party,
  RUNNER,
  table,
  type Table,
  VEX,
} from "./harness.ts";

/**
 * The test cave, 10 columns (a-j) by 6 rows. A wall runs down column c from row 2 to row 4,
 * difficult terrain fills f3:g4, the bottom row is wall under a-c and outside the map past h.
 *
 *     a b c d e f g h i j
 *   1 . . . . . . . . . .
 *   2 . . # . . . . . . .
 *   3 . . # . . ~ ~ . . .
 *   4 . . # . . ~ ~ . . .
 *   5 . . . . . . . . . .
 *   6 # # # . . . . .
 */
const CAVE = [
  "name: Test Cave",
  "..........",
  "..#.......",
  "..#..~~...",
  "..#..~~...",
  "..........",
  "###.....",
  "",
  "",
].join("\n");

const grid = (): MapGrid => {
  const read = readMapText("cave", CAVE);
  if ("refusal" in read) throw new Error(read.refusal);
  return read;
};

/** Runs one typed line through the command registry, as a seat would, and returns any refusal. */
function type(t: Table, actor: string, line: string, dice = fixedDice()): string | undefined {
  const [, name = "", args = ""] = /^\/(\S+)\s*(.*)$/.exec(line) ?? [];
  const spec = table.commands.find((c) => c.name === name);
  if (spec === undefined) throw new Error(`no command /${name}`);
  const command = spec.parse(args);
  if ("refusal" in command) return command.refusal;
  return t.submit(actor, command, dice);
}

function ok(t: Table, actor: string, line: string, dice = fixedDice()): void {
  const refusal = type(t, actor, line, dice);
  if (refusal !== undefined) throw new Error(`refused: ${refusal}`);
}

/** Vex (Alice) and Kor with a goblin warrior, the cave loaded and nobody placed. */
function cave(): Table {
  const t = party();
  t.run(GM, { type: "add", monster: "goblin-warrior", count: 1, sheet: GOBLIN });
  t.run(GM, { type: "map", id: "cave", grid: grid() });
  return t;
}

const where = (t: Table, id: string) => {
  const square = t.ds.map?.tokens[id];
  return square === undefined ? undefined : formatSquare(square);
};

describe("squares people type", () => {
  test("column letters then the row number, from a1; past z the columns go aa, ab", () => {
    expect(parseSquare("a1")).toEqual({ x: 0, y: 0 });
    expect(parseSquare("c5")).toEqual({ x: 2, y: 4 });
    expect(parseSquare("z1")).toEqual({ x: 25, y: 0 });
    expect(parseSquare("aa3")).toEqual({ x: 26, y: 2 });
    expect(parseSquare("AB10")).toEqual({ x: 27, y: 9 });
    expect(parseSquare("ba1")).toEqual({ x: 52, y: 0 });
    for (const bad of ["", "a", "5", "5c", "a0", "c-1", "c 5", "é1", "a1b"])
      expect(parseSquare(bad)).toBeUndefined();
  });

  test("formatting is the inverse", () => {
    expect(formatSquare({ x: 0, y: 0 })).toBe("a1");
    expect(formatSquare({ x: 25, y: 0 })).toBe("z1");
    expect(formatSquare({ x: 26, y: 2 })).toBe("aa3");
    expect(formatSquare({ x: 51, y: 0 })).toBe("az1");
    expect(formatSquare({ x: 52, y: 39 })).toBe("ba40");
  });
});

describe("map files", () => {
  test("an optional name line, then one row per line; short rows are outside past their end", () => {
    expect(readMapText("cave", CAVE)).toEqual({
      name: "Test Cave",
      terrain: ["..........", "..#.......", "..#..~~...", "..#..~~...", "..........", "###.....  "],
    });
    expect(readMapText("hall", "..\n.#\n")).toEqual({ name: "hall", terrain: ["..", ".#"] });
  });

  test("too big, empty, or characters a cell can't draw are refused", () => {
    const wide = ".".repeat(61);
    expect(readMapText("big", wide)).toEqual({
      refusal: "maps/big.txt is 61 columns wide; keep maps to 60 columns and 40 rows.",
    });
    expect(readMapText("tall", ".\n".repeat(41))).toEqual({
      refusal: "maps/tall.txt is 41 rows tall; keep maps to 60 columns and 40 rows.",
    });
    expect(readMapText("none", "name: Nothing\n\n")).toEqual({
      refusal: "maps/none.txt has no rows.",
    });
    const legend = "draw maps with . floor, # wall, ~ difficult terrain, space for outside.";
    expect(readMapText("tab", "..\t..")).toEqual({
      refusal: `maps/tab.txt row 1, column 3 is a character a map can't draw; ${legend}`,
    });
    expect(readMapText("wide", "..é..")).toEqual({
      refusal: `maps/wide.txt row 1, column 3 is a character a map can't draw; ${legend}`,
    });
    // A letter would look like a token, so only the terrain characters draw a map.
    expect(readMapText("letters", "..B.x..")).toEqual({
      refusal: `maps/letters.txt row 1, column 3 is "B"; ${legend}`,
    });
  });
});

describe("maps in MEKMODE letters", () => {
  const RUIN = "name: Ruin\nstyle: mekmode\nqsk\nuzT";
  /** Folds one more event straight into the log, as an old or odd log would hold it. */
  const replayWith = (t: Table, type: string, payload: unknown) => {
    t.envelopes.push({ actor: GM, seq: t.envelopes.length + 1, timestamp: t.now, type, payload });
    return t.ds;
  };

  test("`style: mekmode` maps are written in Ding Mode letters; the rules see each letter's terrain", () => {
    expect(readMapText("ruin", RUIN)).toEqual({
      name: "Ruin",
      terrain: [".##", ".~#"],
      dressing: ["qsk", "uzT"],
    });
    // The header lines in either order, short rows outside past their end.
    expect(readMapText("ruin", "style: mekmode\nname: Ruin\nqsk\nu")).toEqual({
      name: "Ruin",
      terrain: [".##", ".  "],
      dressing: ["qsk", "u  "],
    });
  });

  test("a character that isn't a map letter is refused, by row and column", () => {
    expect(readMapText("bad", "style: mekmode\nq1q")).toEqual({
      refusal:
        'maps/bad.txt row 1, column 2 is "1", which isn\'t a map letter; see "Maps in MEKMODE letters" in the campaign README.',
    });
    expect(readMapText("dot", "style: mekmode\nq.q")).toMatchObject({
      refusal: expect.stringContaining('column 2 is "."'),
    });
  });

  test("/map carries the letters in the event, and the map view hands them to the table", () => {
    const t = party();
    const ruin = readMapText("ruin", RUIN) as MapGrid;
    t.run(GM, { type: "map", id: "ruin", grid: ruin });
    expect(t.envelopes.at(-1)).toMatchObject({
      type: "ds.map-loaded",
      payload: { terrain: [".##", ".~#"], dressing: ["qsk", "uzT"] },
    });
    expect(mapView(t.ds, GM)).toMatchObject({ terrain: [".##", ".~#"], dressing: ["qsk", "uzT"] });
    // A plain map has no letters.
    t.run(GM, { type: "map", id: "cave", grid: grid() });
    expect(mapView(t.ds, GM)?.dressing).toBeUndefined();
  });

  test("replay refuses letters that don't fit the grid, never a letter today's legend lacks", () => {
    const base = { id: "ruin", name: "Ruin", terrain: [".##", ".~#"] };
    expect(() => replayWith(party(), "ds.map-loaded", { ...base, dressing: ["qsk"] })).toThrow(
      /letters/,
    );
    expect(() =>
      replayWith(party(), "ds.map-loaded", { ...base, dressing: ["qsk", "uz\u0007"] }),
    ).toThrow(/letters/);
    // A letter the legend may drop one day still replays: only its shape is checked.
    expect(() =>
      replayWith(party(), "ds.map-loaded", { ...base, dressing: ["qs1", "uzT"] }),
    ).not.toThrow();
  });
});

describe("/map", () => {
  test("the GM loads a map the host read; replay carries the grid", () => {
    const t = party();
    expect(type(t, GM, "/map cave")).toBe("No map for 'cave' was loaded.");
    t.run(GM, { type: "map", id: "cave", grid: grid() });
    expect(t.envelopes.at(-1)).toMatchObject({
      type: "ds.map-loaded",
      payload: { id: "cave", name: "Test Cave", terrain: grid().terrain },
    });
    expect(t.ds.map).toMatchObject({ id: "cave", name: "Test Cave", tokens: {} });
    expect(t.lastFeed()).toEqual(["The map is Test Cave, 10 by 6."]);
    expect(type(t, ALICE, "/map off")).toBe("Only the GM can use /map.");
    ok(t, GM, "/map off");
    expect(t.ds.map).toBeUndefined();
    expect(t.lastFeed()).toEqual(["The map is put away."]);
    expect(type(t, GM, "/map off")).toBe("No map is loaded.");
    expect(type(t, GM, "/map")).toBe("Usage: /map <map id>|off|new crossing|keep [seed]");
  });

  test("/map new names a kind and maybe a seed; the rules refuse it until the host generates it", () => {
    const t = party();
    const parse = (args: string) => commands.find((c) => c.type === "map")!.parse(args);
    expect(parse("new crossing")).toEqual({ type: "map", generate: { kind: "crossing" } });
    expect(parse("NEW Keep 42")).toEqual({ type: "map", generate: { kind: "keep", seed: 42 } });
    expect(parse("new")).toEqual({ refusal: "Usage: /map <map id>|off|new crossing|keep [seed]" });
    expect(parse("new cave")).toEqual({
      refusal: "There's no kind of map called 'cave'; there are: crossing, keep.",
    });
    expect(parse("new keep 4294967296")).toEqual({
      refusal: "A map's seed is a whole number from 0 to 4294967295.",
    });
    expect(parse("new keep 1 2")).toEqual({
      refusal: "Usage: /map <map id>|off|new crossing|keep [seed]",
    });
    // Only the host writes map files: a /map new it hasn't generated loads nothing, and leaves
    // a loaded map as it is.
    t.run(GM, { type: "map", id: "cave", grid: grid() });
    expect(type(t, GM, "/map new keep 7")).toBe(
      "No map was generated for that; the host generates a /map new.",
    );
    expect(t.ds.map?.id).toBe("cave");
    expect(type(t, ALICE, "/map new keep")).toBe("Only the GM can use /map.");
  });

  test("Tab after /map offers off and new, then the kinds", () => {
    expect(completeMapArgs("")).toEqual(["off", "new "]);
    expect(completeMapArgs("n")).toEqual(["new "]);
    expect(completeMapArgs("new ")).toEqual(["new crossing", "new keep"]);
    expect(completeMapArgs("NEW k")).toEqual(["new keep"]);
    expect(completeMapArgs("ford ")).toEqual([]);
  });

  test("a grid that breaks the limits is refused even if the host sent it", () => {
    const t = party();
    expect(t.submit(GM, { type: "map", id: "big", grid: { name: "Big", terrain: [] } })).toBe(
      "maps/big.txt has no rows.",
    );
  });

  test("a new map clears every token", () => {
    const t = cave();
    ok(t, GM, "/place vex a1");
    t.run(GM, { type: "map", id: "cave", grid: grid() });
    expect(t.ds.map?.tokens).toEqual({});
  });
});

describe("/place", () => {
  test("the GM places anyone on an empty floor square", () => {
    const t = cave();
    expect(type(t, GM, "/place vex a1")).toBeUndefined();
    expect(t.envelopes.at(-1)).toMatchObject({
      type: "ds.placed",
      payload: { id: "vex", at: { x: 0, y: 0 } },
    });
    expect(t.lastFeed()).toEqual(["Vex is placed at a1."]);
    ok(t, GM, "/place goblin e3");
    expect(where(t, "goblin-warrior")).toBe("e3");
    expect(type(t, GM, "/place kor e3")).toBe("e3 is taken by Goblin Warrior.");
    expect(type(t, GM, "/place kor c2")).toBe("c2 is a wall.");
    expect(type(t, GM, "/place kor i6")).toBe("i6 is outside the map.");
    expect(type(t, GM, "/place kor k1")).toBe("k1 is outside the map.");
    expect(type(t, GM, "/place kor 5c")).toBe("'5c' isn't a square like c5.");
  });

  test("a player places only their own hero, and not again once a combat runs", () => {
    const t = cave();
    expect(type(t, ALICE, "/place kor b1")).toBe("You can only place your own hero.");
    expect(type(t, BOB, "/place vex b1")).toBe("You can only place your own hero.");
    ok(t, ALICE, "/place vex b1");
    ok(t, ALICE, "/place vex b2");
    expect(where(t, "vex")).toBe("b2");
    t.run(GM, { type: "start" }, fixedDice(7));
    expect(type(t, ALICE, "/place vex b3")).toBe("Vex is on the map already; /move instead.");
  });

  test("nothing to place on without a map", () => {
    const t = party();
    expect(type(t, GM, "/place vex a1")).toBe("No map is loaded; the GM loads one with /map.");
  });
});

describe("/move (Combat, 'Movement')", () => {
  test("around a wall: diagonals cost 1, but never past a wall's corner", () => {
    const t = cave();
    ok(t, GM, "/place vex a3");
    // Over the top: a3 b2 b1 c1 d1 d2 d3, since b2 to c1 and c1 to d2 cut the wall's corner.
    ok(t, GM, "/move vex d3");
    expect(t.envelopes.at(-1)).toMatchObject({
      type: "ds.moved",
      payload: { id: "vex", cost: 6, speed: 5 },
    });
    expect(where(t, "vex")).toBe("d3");
    expect(t.lastFeed()).toEqual(["Vex moves to d3 (6 squares of movement, over speed 5)."]);
  });

  test("difficult terrain costs 1 more to enter, so the path goes around it", () => {
    const t = cave();
    ok(t, GM, "/place kor e3");
    ok(t, GM, "/move kor h3");
    expect(t.envelopes.at(-1)).toMatchObject({
      type: "ds.moved",
      payload: {
        id: "kor",
        path: [
          { x: 5, y: 1 },
          { x: 6, y: 1 },
          { x: 7, y: 2 },
        ],
        cost: 3,
      },
    });
    expect(t.lastFeed()).toEqual(["Kor moves to h3 (3 squares of movement)."]);
    ok(t, GM, "/move kor g3");
    expect(t.envelopes.at(-1)).toMatchObject({ payload: { cost: 2 } });
  });

  test("through an ally freely, through an enemy as difficult terrain, never ending on either", () => {
    const t = cave();
    ok(t, GM, "/place vex a5");
    ok(t, GM, "/place kor b5");
    ok(t, GM, "/place goblin c5");
    expect(type(t, GM, "/move vex b5")).toBe("b5 is taken by Kor.");
    // b5 (Kor, an ally) 1, c5 (the goblin, an enemy) 2, d5 1.
    ok(t, GM, "/move vex d5");
    expect(t.envelopes.at(-1)).toMatchObject({
      payload: {
        path: [
          { x: 1, y: 4 },
          { x: 2, y: 4 },
          { x: 3, y: 4 },
        ],
        cost: 4,
      },
    });
  });

  test("walls and the map's edge stop a move that has no way round", () => {
    const t = cave();
    ok(t, GM, "/place vex a1");
    expect(type(t, GM, "/move vex c3")).toBe("c3 is a wall.");
    expect(type(t, GM, "/move vex a1")).toBe("Vex is at a1 already.");
    expect(type(t, GM, "/move kor b1")).toBe("Kor isn't on the map; /place them first.");
  });

  test("in combat a player's move can't exceed speed; slowed is speed 2 (Classes, 'Slowed')", () => {
    const t = cave();
    ok(t, GM, "/place vex a3");
    ok(t, GM, "/place goblin j1");
    t.run(GM, { type: "start" }, fixedDice(7));
    t.run(GM, { type: "first", side: "heroes" });
    t.run(ALICE, { type: "turn" });
    expect(type(t, ALICE, "/move vex d3")).toBe(
      "Vex can't move that far: d3 takes 6 squares of movement, and Vex's speed is 5.",
    );
    expect(type(t, ALICE, "/move goblin i1")).toBe("You can only move your own hero.");
    ok(t, ALICE, "/move vex a1");
    t.run(GM, { type: "cond", who: "vex", condition: "slowed" });
    // Slowed after moving 2: the 2 it has spent are all of its speed now.
    expect(type(t, ALICE, "/move vex d1")).toBe(
      "Vex can't move that far: d1 takes 3 squares of movement, and Vex has 0 of speed 2 left this turn; add main to move again with the main action.",
    );
    t.run(GM, { type: "cond", who: "vex", condition: "restrained" });
    expect(type(t, ALICE, "/move vex b1")).toBe("Vex can't move: speed 0 (restrained).");
    // The GM may move anything any distance; the feed says how far.
    ok(t, GM, "/move goblin a2");
    expect(t.lastFeed()).toEqual([
      "Goblin Warrior moves to a2 (9 squares of movement, over speed 6).",
    ]);
  });

  test("a prone creature crawls: each square costs 1 more (Classes, 'Prone')", () => {
    const t = cave();
    ok(t, GM, "/place kor e1");
    t.run(GM, { type: "cond", who: "kor", condition: "prone" });
    ok(t, GM, "/move kor g1");
    expect(t.envelopes.at(-1)).toMatchObject({ payload: { cost: 4 } });
  });
});

describe("/dist: every adjacent square is 1, diagonals too (Combat, 'Movement')", () => {
  test("between tokens and squares, walls or not", () => {
    const t = cave();
    ok(t, GM, "/place vex a1");
    ok(t, GM, "/place goblin e3");
    ok(t, ALICE, "/dist vex goblin");
    expect(t.envelopes.at(-1)).toMatchObject({
      type: "ds.measured",
      payload: {
        from: { id: "vex", at: { x: 0, y: 0 } },
        to: { id: "goblin-warrior" },
        distance: 4,
      },
    });
    expect(t.lastFeed()).toEqual([
      "abcdefgh (Vex) measures Vex (a1) to Goblin Warrior (e3): 4 squares.",
    ]);
    ok(t, GM, "/dist a1 c5");
    expect(t.envelopes.at(-1)).toMatchObject({ payload: { distance: 4 } });
    ok(t, GM, "/dist vex j6");
    expect(t.envelopes.at(-1)).toMatchObject({ payload: { distance: 9 } });
    ok(t, GM, "/dist b2 a1");
    expect(t.lastFeed()[0]).toEndWith("b2 to a1: 1 square.");
    expect(type(t, GM, "/dist kor a1")).toBe("Kor isn't on the map; /place them first.");
    expect(type(t, GM, "/dist vex")).toBe("Usage: /dist <who|square> <who|square>");
  });
});

describe("forced movement (Combat, 'Forced Movement')", () => {
  test("a push moves straight away from the source, the full distance when nothing's in the way", () => {
    const t = cave();
    ok(t, GM, "/place kor e5");
    ok(t, GM, "/place goblin f5");
    ok(t, GM, "/push goblin 3 from kor");
    expect(t.envelopes.at(-1)).toMatchObject({
      type: "ds.force-moved",
      payload: { id: "goblin-warrior", kind: "push", source: "kor", distance: 3, stability: 0 },
    });
    expect(where(t, "goblin-warrior")).toBe("i5");
    expect(t.lastFeed()).toEqual(["Goblin Warrior is pushed 3 squares to i5."]);
  });

  test("stability reduces the distance ('Stability')", () => {
    const t = cave();
    ok(t, GM, "/place goblin d1");
    ok(t, GM, "/place vex e1");
    ok(t, GM, "/push vex 3 from goblin");
    expect(where(t, "vex")).toBe("g1");
    expect(t.lastFeed()).toEqual(["Vex is pushed 2 squares to g1 (push 3, stability 1)."]);
    ok(t, GM, "/push vex 1 from goblin");
    expect(where(t, "vex")).toBe("g1");
    expect(t.lastFeed()).toEqual([
      "Vex is pushed but doesn't move (push 1, stability 1; Goblin Warrior is 3 squares away).",
    ]);
  });

  test("into a wall: 2 damage plus 1 for each square left ('Slamming Into Objects')", () => {
    const t = cave();
    ok(t, GM, "/place kor e2");
    ok(t, GM, "/place goblin d2");
    ok(t, GM, "/push goblin 3 from kor");
    expect(t.envelopes.slice(-2)).toMatchObject([
      { type: "ds.force-moved", payload: { path: [], slam: { into: "wall", remaining: 3 } } },
      { type: "ds.damaged", payload: { id: "goblin-warrior", amount: 5, dealt: 5 } },
    ]);
    expect(t.creature("goblin-warrior").stamina).toBe(10);
    expect(t.lastFeed(2)).toEqual([
      "Goblin Warrior is pushed but doesn't move and slams into a wall with 3 squares to go.",
      "Goblin Warrior takes 5 damage → 10/15",
    ]);
  });

  test("into a creature: both take 1 damage for each square left ('Slamming into Creatures')", () => {
    const t = cave();
    ok(t, GM, "/place vex e1");
    ok(t, GM, "/place goblin f1");
    ok(t, GM, "/place kor h1");
    ok(t, ALICE, "/push goblin 3 from vex");
    expect(where(t, "goblin-warrior")).toBe("g1");
    expect(t.creature("goblin-warrior").stamina).toBe(13);
    expect(t.hero("kor").stamina).toBe(22);
    expect(t.lastFeed(3)).toEqual([
      "Goblin Warrior is pushed 1 square to g1 and slams into Kor with 2 squares to go.",
      "Goblin Warrior takes 2 damage → 13/15",
      "Kor takes 2 damage → 22/24",
    ]);
  });

  test("a pull comes straight toward the source and stops beside it", () => {
    const t = cave();
    ok(t, GM, "/place kor h1");
    ok(t, GM, "/place goblin h5");
    ok(t, GM, "/pull goblin 5 from kor");
    expect(where(t, "goblin-warrior")).toBe("h2");
    expect(t.lastFeed()).toEqual([
      "Goblin Warrior is pulled 3 squares to h2 (Kor is 4 squares away).",
    ]);
  });

  test("a push or pull to a square goes that far along a straight line, or is refused", () => {
    const t = cave();
    ok(t, GM, "/place kor e5");
    ok(t, GM, "/place goblin f5");
    ok(t, GM, "/push goblin 3 from kor to g5");
    expect(where(t, "goblin-warrior")).toBe("g5");
    expect(type(t, GM, "/push goblin 3 from kor to h3")).toBe(
      "h3 isn't in a straight line from g5.",
    );
    expect(type(t, GM, "/push goblin 3 from kor to f5")).toBe(
      "A push moves Goblin Warrior away from Kor, and f5 isn't.",
    );
    expect(type(t, GM, "/push goblin 2 from kor to j5")).toBe(
      "j5 is 3 squares away, and the push is 2.",
    );
  });

  test("a slide goes any way to the square, ignoring difficult terrain", () => {
    const t = cave();
    ok(t, GM, "/place goblin e3");
    ok(t, GM, "/slide goblin 2 to g3");
    expect(where(t, "goblin-warrior")).toBe("g3");
    expect(t.lastFeed()).toEqual(["Goblin Warrior is slid 2 squares to g3."]);
    expect(type(t, GM, "/slide goblin 2 to j3")).toBe("j3 is 3 squares away, and the slide is 2.");
    expect(type(t, GM, "/slide goblin 2")).toBe("Say where: /slide goblin 2 to <square>.");
  });

  test("a slide to a creature's square ends beside it in a slam", () => {
    const t = cave();
    ok(t, GM, "/place goblin e1");
    ok(t, GM, "/place kor g1");
    ok(t, GM, "/slide goblin 3 to g1");
    expect(where(t, "goblin-warrior")).toBe("f1");
    expect(t.lastFeed(3)).toEqual([
      "Goblin Warrior is slid 1 square to f1 and slams into Kor with 2 squares to go.",
      "Goblin Warrior takes 2 damage → 13/15",
      "Kor takes 2 damage → 22/24",
    ]);
  });

  test("who may force move, and who can't be", () => {
    const t = cave();
    ok(t, GM, "/place vex e1");
    ok(t, GM, "/place kor a1");
    ok(t, GM, "/place goblin f1");
    expect(type(t, ALICE, "/push goblin 2 from kor")).toBe(
      "You can only force move with your own hero.",
    );
    expect(type(t, GM, "/push goblin 2")).toBe("Push from where? /push goblin 2 from <who>.");
    // A player's own hero is the source when none is named.
    ok(t, ALICE, "/push goblin 1");
    expect(where(t, "goblin-warrior")).toBe("g1");
    t.run(GM, { type: "cond", who: "goblin", condition: "restrained" });
    expect(type(t, ALICE, "/push goblin 1")).toBe(
      "Goblin Warrior is restrained and can't be force moved.",
    );
  });

  test("in combat the acting creature is the source when none is named", () => {
    const t = cave();
    ok(t, GM, "/place kor e5");
    ok(t, GM, "/place goblin f5");
    t.run(GM, { type: "start" }, fixedDice(7));
    t.run(GM, { type: "first", side: "heroes" });
    t.run(GM, { type: "turn", who: "kor" }, fixedDice(2));
    ok(t, GM, "/push goblin 1");
    expect(where(t, "goblin-warrior")).toBe("g5");
  });
});

describe("mapView", () => {
  test("terrain, tokens with their marks, and the seat's own hero's reach", () => {
    const t = cave();
    t.run(GM, { type: "add", monster: "goblin-runner", count: 4, sheet: RUNNER });
    ok(t, GM, "/place vex a1");
    ok(t, GM, "/place kor b1");
    ok(t, GM, "/place goblin-warrior e3");
    ok(t, GM, "/place goblin-runner-a j5");
    t.run(GM, { type: "cond", who: "vex", condition: "slowed" });
    const view: MapView | undefined = mapView(t.ds, ALICE);
    expect(view).toEqual({
      name: "Test Cave",
      width: 10,
      height: 6,
      terrain: grid().terrain,
      tokens: [
        {
          id: "vex",
          mark: "V",
          name: "Vex",
          x: 0,
          y: 0,
          side: "heroes",
          mine: true,
          acting: false,
          dead: false,
        },
        {
          id: "kor",
          mark: "K",
          name: "Kor",
          x: 1,
          y: 0,
          side: "heroes",
          mine: false,
          acting: false,
          dead: false,
        },
        {
          id: "goblin-warrior",
          mark: "w",
          name: "Goblin Warrior",
          x: 4,
          y: 2,
          side: "director",
          // Its picture is picked by its stat block, as every creature of it.
          figure: "goblin-warrior",
          mine: false,
          acting: false,
          dead: false,
        },
        {
          id: "goblin-runner-a",
          mark: "rA",
          name: "Goblin Runner A",
          x: 9,
          y: 4,
          side: "director",
          // Its picture is picked by its stat block, as every creature of it.
          figure: "goblin-runner",
          mine: false,
          acting: false,
          dead: false,
        },
      ],
      // Slowed to 2 from a1: through Kor to c1, round the wall's corner no further.
      reach: [
        { x: 2, y: 0 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
        { x: 0, y: 2 },
        { x: 1, y: 2 },
      ],
      reachLabel: "Vex can reach: speed 2",
    });
    expect(mapView(t.ds, GM)?.reach).toEqual([]);
    expect(mapView(t.ds, GM)?.reachLabel).toBeUndefined();
    expect(mapView(party().ds, GM)).toBeUndefined();
  });

  test("in combat the acting creature's reach shows to everyone; the dead stay as dead marks", () => {
    const t = cave();
    ok(t, GM, "/place vex a1");
    ok(t, GM, "/place goblin a5");
    t.run(GM, { type: "start" }, fixedDice(7));
    t.run(GM, { type: "first", side: "director" });
    t.run(GM, { type: "turn", who: "goblin" });
    t.run(GM, { type: "cond", who: "goblin", condition: "slowed" });
    const view = mapView(t.ds, ALICE);
    expect(view?.reachLabel).toBe("Goblin Warrior can reach: speed 2");
    // From a5, walls below at a6:c6.
    expect(view?.reach).toEqual([
      { x: 0, y: 2 },
      { x: 1, y: 2 },
      { x: 0, y: 3 },
      { x: 1, y: 3 },
      { x: 1, y: 4 },
      { x: 2, y: 4 },
    ]);
    expect(view?.tokens.find((k) => k.id === "goblin-warrior")?.acting).toBe(true);
    t.run(GM, { type: "dmg", who: "goblin", amount: 15 });
    const dead = mapView(t.ds, ALICE);
    // Dead tokens come first, so the living draw over them.
    expect(dead?.tokens.map((k) => [k.id, k.dead])).toEqual([
      ["goblin-warrior", true],
      ["vex", false],
    ]);
    expect(dead?.reachLabel).toBe("Vex can reach: speed 5");
    // A dead creature doesn't block: Vex may end on its square.
    ok(t, GM, "/move vex a5");
    t.run(GM, { type: "end" });
    expect(t.ds.map?.tokens).toEqual({ vex: { x: 0, y: 4 } });
  });

  test("marks: unique hero initials, else two letters; numbered creatures; squads by letter", () => {
    const t = cave();
    t.run(GM, { type: "hero", hero: "kira", sheet: { ...VEX, id: "kira", name: "Kira" } });
    t.run(GM, { type: "add", monster: "goblin-warrior", count: 2, sheet: GOBLIN });
    t.run(GM, { type: "add", monster: "goblin-archer", count: 1, sheet: ARCHER });
    t.run(GM, { type: "add", monster: "goblin-runner", count: 12, sheet: RUNNER });
    const ids = ["vex", "kor", "kira", "goblin-warrior", "goblin-warrior-1", "goblin-warrior-2"];
    const squares = ["a1", "b1", "d1", "e1", "f1", "g1", "h1", "i1", "j1", "a2"];
    const all = [...ids, "goblin-archer", "goblin-runner-a", "goblin-runner-b"];
    all.forEach((id, i) => ok(t, GM, `/place ${id} ${squares[i]}`));
    expect(mapView(t.ds, GM)?.tokens.map((k) => [k.id, k.mark])).toEqual([
      ["vex", "V"],
      ["kor", "K"],
      ["kira", "Ki"],
      ["goblin-warrior", "w"],
      ["goblin-warrior-1", "w1"],
      ["goblin-warrior-2", "w2"],
      ["goblin-archer", "a"],
      ["goblin-runner-a", "rA"],
      ["goblin-runner-b", "rB"],
    ]);
  });

  test("a block's mark comes from its last word, so it's the same whichever came first", () => {
    const marksWith = (first: StatBlock, second: StatBlock) => {
      const t = cave();
      t.run(GM, { type: "add", monster: first.id, count: 4, sheet: first });
      t.run(GM, { type: "add", monster: second.id, count: 4, sheet: second });
      ok(t, GM, "/place cutpurse-a a1");
      ok(t, GM, "/place slinger-a b1");
      return Object.fromEntries((mapView(t.ds, GM)?.tokens ?? []).map((k) => [k.id, k.mark]));
    };
    const cutpurse = { ...RUNNER, id: "bandit-cutpurse", name: "Bandit Cutpurse" };
    const slinger = { ...RUNNER, id: "bandit-slinger", name: "Bandit Slinger" };
    const marks = { "bandit-cutpurse-a": "cA", "bandit-slinger-a": "sA" };
    expect(marksWith(cutpurse, slinger)).toEqual(marks);
    expect(marksWith(slinger, cutpurse)).toEqual(marks);
  });
});

describe("movement over a turn (Combat, 'Advance', 'Can't Exceed Speed')", () => {
  /** Vex (Alice, speed 5) at a5 and the goblin at j1, with Vex's turn begun. */
  function vexTurn(): Table {
    const t = cave();
    ok(t, GM, "/place vex a5");
    ok(t, GM, "/place goblin j1");
    t.run(GM, { type: "start" }, fixedDice(7));
    t.run(GM, { type: "first", side: "heroes" });
    t.run(ALICE, { type: "turn" });
    return t;
  }

  test("a turn's moves add up to the speed, and the reach shows what is left", () => {
    const t = vexTurn();
    ok(t, ALICE, "/move vex c5");
    expect(t.envelopes.at(-1)).toMatchObject({
      type: "ds.moved",
      payload: { id: "vex", cost: 2, speed: 5, spent: 2, allowance: 5 },
    });
    expect(t.lastFeed()).toEqual(["Vex moves to c5 (2 squares of movement)."]);
    const view = mapView(t.ds, BOB);
    expect(view?.reachLabel).toBe("Vex can reach: 3 of speed 5 left");
    expect(view?.reach.some((r) => formatSquare(r) === "f5")).toBe(true);
    expect(view?.reach.some((r) => formatSquare(r) === "g5")).toBe(false);
    ok(t, ALICE, "/move vex f5");
    expect(t.lastFeed()).toEqual(["Vex moves to f5 (3 squares of movement, 5 of 5 this turn)."]);
    expect(type(t, ALICE, "/move vex g5")).toBe(
      "Vex can't move that far: g5 takes 1 square of movement, and Vex has 0 of speed 5 left this turn; add main to move again with the main action.",
    );
    expect(mapView(t.ds, BOB)?.reachLabel).toBe("Vex can reach: 0 of speed 5 left");
  });

  test("the main action spent as a move gives a second speed's worth (Combat, 'Main Actions')", () => {
    const t = vexTurn();
    ok(t, ALICE, "/move vex e5");
    ok(t, ALICE, "/move vex j5 main");
    expect(t.envelopes.at(-1)).toMatchObject({
      payload: { cost: 5, spent: 9, allowance: 10, main: true },
    });
    expect(t.lastFeed()).toEqual([
      "Vex moves to j5 (5 squares of movement, 9 of 10 this turn with the main action).",
    ]);
    expect(mapView(t.ds, BOB)?.reachLabel).toBe(
      "Vex can reach: 1 of speed 5 left, main action spent",
    );
    expect(type(t, ALICE, "/move vex h4")).toBe(
      "Vex can't move that far: h4 takes 2 squares of movement, and Vex has 1 of speed 5 left this turn.",
    );
  });

  test("a bleeding hero's main action spent as a move bleeds, once, like any main action (Classes, 'Bleeding')", () => {
    const t = vexTurn();
    t.run(GM, { type: "cond", who: "vex", condition: "bleeding", duration: "save" });
    const level = t.hero("vex").sheet.level;
    const before = t.hero("vex").stamina;
    // A move within the speed is no main action: no bleeding.
    ok(t, ALICE, "/move vex e5", fixedDice(6));
    expect(t.envelopes.at(-1)).toMatchObject({ type: "ds.moved" });
    ok(t, ALICE, "/move vex j5 main", fixedDice(3));
    expect(t.envelopes.slice(-2)).toMatchObject([
      { type: "ds.moved", payload: { main: true } },
      { type: "ds.bled", payload: { id: "vex", roll: 3, level } },
    ]);
    expect(t.hero("vex").stamina).toBe(before - 3 - level);
    // The main action is spent already: moving on with it bleeds no more.
    ok(t, ALICE, "/move vex j4 main", fixedDice(5));
    expect(t.envelopes.at(-1)).toMatchObject({ type: "ds.moved" });
    expect(t.hero("vex").stamina).toBe(before - 3 - level);
  });

  test("a move that spends no main action bleeds nothing, even with main typed (Classes, 'Bleeding')", () => {
    const t = vexTurn();
    t.run(GM, { type: "cond", who: "vex", condition: "bleeding", duration: "save" });
    const before = t.hero("vex").stamina;
    // Ending the turn rolls the save for bleeding: a 1 fails it, so Vex is still bleeding.
    t.run(ALICE, { type: "done" }, fixedDice(1));
    // Between Vex's turns the GM moves Vex: no turn of Vex's, so no main action to spend.
    ok(t, GM, "/move vex e5 main", fixedDice(4));
    ok(t, GM, "/move vex f5 main", fixedDice(4));
    expect(t.envelopes.at(-1)).toMatchObject({ type: "ds.moved" });
    expect(t.envelopes.some((e) => e.type === "ds.bled")).toBe(false);
    expect(t.hero("vex").stamina).toBe(before);
  });

  test("a new turn starts afresh; a player moves only on their hero's turn", () => {
    const t = vexTurn();
    ok(t, ALICE, "/move vex f5");
    t.run(ALICE, { type: "done" });
    expect(type(t, ALICE, "/move vex f4")).toBe(
      "It isn't Vex's turn; the GM moves heroes between turns.",
    );
    t.run(GM, { type: "turn", who: "goblin" });
    expect(t.ds.combat.moved).toBeUndefined();
    // The GM's moves count toward the acting creature's turn, though the GM may go over.
    ok(t, GM, "/move goblin j3");
    expect(t.ds.combat.moved).toEqual({ id: "goblin-warrior", spent: 2, main: false });
    ok(t, GM, "/move goblin a1");
    expect(t.lastFeed()).toEqual([
      "Goblin Warrior moves to a1 (9 squares of movement, 11 of 6 this turn, over speed 6).",
    ]);
  });

  test("an undone move gives its squares back", () => {
    const t = vexTurn();
    ok(t, ALICE, "/move vex e5");
    t.run(ALICE, { type: "undo", now: t.now });
    expect(t.ds.combat.moved).toBeUndefined();
    expect(mapView(t.ds, BOB)?.reachLabel).toBe("Vex can reach: speed 5");
  });
});

describe("forced movement, the finer points", () => {
  test("nobody force moves themselves: a slide of your own hero is a move", () => {
    const t = cave();
    ok(t, GM, "/place vex a1");
    expect(type(t, ALICE, "/slide vex 3 to c1")).toBe("Vex can't slide themselves; /move instead.");
    expect(type(t, GM, "/slide vex 3 to c1 from vex")).toBe(
      "Vex can't slide themselves; /move instead.",
    );
  });

  test("a pull to the source's own square slams the target into it ('Slamming into Creatures')", () => {
    const t = cave();
    ok(t, GM, "/place kor a1");
    ok(t, GM, "/place goblin c1");
    ok(t, GM, "/pull goblin 4 from kor to a1");
    expect(where(t, "goblin-warrior")).toBe("b1");
    expect(t.lastFeed(3)).toEqual([
      "Goblin Warrior is pulled 1 square to b1 and slams into Kor with 3 squares to go (Kor is 2 squares away).",
      "Goblin Warrior takes 3 damage → 12/15",
      "Kor takes 3 damage → 21/24",
    ]);
  });

  test("a pull with no square takes the straight line that brings the target closest", () => {
    const t = cave();
    ok(t, GM, "/place kor e5");
    ok(t, GM, "/place goblin j4");
    // The diagonal toward e5 runs off the map after two squares; along row 4 it goes all four.
    ok(t, GM, "/pull goblin 4 from kor");
    expect(where(t, "goblin-warrior")).toBe("f4");
    expect(t.lastFeed()).toEqual([
      "Goblin Warrior is pulled 4 squares to f4 (Kor is 5 squares away).",
    ]);
  });

  test("a push to a wall's square slams with everything left, as a slide does", () => {
    const t = cave();
    ok(t, GM, "/place kor e2");
    ok(t, GM, "/place goblin d2");
    ok(t, GM, "/push goblin 5 from kor to c2");
    expect(t.envelopes.slice(-2)).toMatchObject([
      { payload: { path: [], slam: { into: "wall", remaining: 5 } } },
      { payload: { amount: 7 } },
    ]);
    // A square short of the wall is a choice to move fewer: the slam has what's left of that.
    const u = cave();
    ok(u, GM, "/place kor e2");
    ok(u, GM, "/place goblin d2");
    expect(type(u, GM, "/push goblin 5 from kor to b2")).toBeUndefined();
    expect(u.envelopes.at(-2)).toMatchObject({ payload: { slam: { remaining: 2 } } });
  });

  test("the map's edge stops a push, and the feed says so", () => {
    const t = cave();
    ok(t, GM, "/place kor h5");
    ok(t, GM, "/place goblin i5");
    ok(t, GM, "/push goblin 5 from kor");
    expect(t.envelopes.at(-1)).toMatchObject({ payload: { edge: true } });
    expect(t.lastFeed()).toEqual([
      "Goblin Warrior is pushed 1 square to j5, stopped by the map's edge.",
    ]);
  });

  test("a source out of reach is allowed, since abilities reach far, but the feed says how far", () => {
    const t = cave();
    ok(t, GM, "/place vex a1");
    ok(t, GM, "/place kor e1");
    ok(t, GM, "/place goblin j1");
    // A player's hero can force move another player's hero, as an ability may.
    ok(t, ALICE, "/push kor 1");
    expect(t.envelopes.at(-1)).toMatchObject({ payload: { source: "vex", apart: 4 } });
    expect(t.lastFeed()).toEqual(["Kor is pushed 1 square to f1 (Vex is 4 squares away)."]);
    ok(t, GM, "/fs goblin vex");
    expect(t.envelopes.at(-1)).toMatchObject({ payload: { source: "goblin-warrior", apart: 9 } });
    expect(t.lastFeed()).toEqual([
      "Goblin Warrior free strikes from 9 squares away: Vex takes 2 damage → 19/21",
    ]);
    ok(t, GM, "/move goblin b1");
    ok(t, GM, "/fs goblin vex");
    expect(t.lastFeed()).toEqual(["Goblin Warrior free strikes: Vex takes 2 damage → 17/21"]);
  });
});

describe("corners (Combat, 'Can't Cut Corners')", () => {
  test("the map's edge fills no corner: only walls and objects do", () => {
    const t = cave();
    ok(t, GM, "/place kor h6");
    // i6 is outside the map, h5 is floor: the diagonal to i5 costs 1.
    ok(t, GM, "/move kor i5");
    expect(t.envelopes.at(-1)).toMatchObject({ payload: { path: [{ x: 8, y: 4 }], cost: 1 } });
  });
});

describe("marks are names", () => {
  test("a token's mark names it in any command, case and all, and wins over a square", () => {
    const t = cave();
    t.run(GM, { type: "add", monster: "goblin-warrior", count: 2, sheet: GOBLIN });
    ok(t, GM, "/place vex a1");
    ok(t, GM, "/place goblin-warrior-1 e3");
    ok(t, GM, "/dmg w1 3");
    expect(t.creature("goblin-warrior-1").stamina).toBe(12);
    ok(t, ALICE, "/dist vex w1");
    expect(t.lastFeed()).toEqual([
      "abcdefgh (Vex) measures Vex (a1) to Goblin Warrior 1 (e3): 4 squares.",
    ]);
    // No token is g2, so g2 is the square.
    ok(t, ALICE, "/dist V g2");
    expect(t.lastFeed()[0]).toEndWith("Vex (a1) to g2: 6 squares.");
    ok(t, GM, "/dmg K 1");
    expect(t.hero("kor").stamina).toBe(23);
  });

  test("past 9, a numbered creature's mark is its initial and a free digit, never the bare initial", () => {
    const t = cave();
    t.run(GM, { type: "add", monster: "goblin-warrior", count: 12, sheet: GOBLIN });
    const marks = new Map(
      t.ds.creatures.map((c, i) => {
        ok(t, GM, `/place ${c.id} ${formatSquare({ x: i % 10, y: i < 10 ? 0 : 4 })}`);
        return [c.id, ""];
      }),
    );
    for (const token of mapView(t.ds, GM)?.tokens ?? []) marks.set(token.id, token.mark);
    expect(marks.get("goblin-warrior-9")).toBe("w9");
    expect(marks.get("goblin-warrior-10")).toBe("w0");
    const eleven = marks.get("goblin-warrior-11")!;
    expect(eleven).toHaveLength(2);
    expect(eleven.startsWith("w")).toBe(true);
    // And the lone Goblin Warrior from the cave is "w": thirteen marks, all different.
    expect(marks.get("goblin-warrior")).toBe("w");
    expect(new Set(marks.values()).size).toBe(13);
  });
});

describe("what replay trusts", () => {
  test("a map grid wider than today's limit still replays: only its shape is checked", () => {
    const t = party();
    t.envelopes.push({
      actor: GM,
      seq: t.envelopes.length + 1,
      timestamp: t.now,
      type: "ds.map-loaded",
      payload: { id: "wide", name: "Wide", terrain: [".".repeat(70)] },
    });
    expect(t.ds.map?.terrain[0]).toHaveLength(70);
  });

  test("the end of combat takes off exactly the tokens it lists, and halts if a creature's is missing", () => {
    const t = cave();
    ok(t, GM, "/place goblin a1");
    t.run(GM, { type: "start" }, fixedDice(7));
    t.envelopes.push({
      actor: GM,
      seq: t.envelopes.length + 1,
      timestamp: t.now,
      type: "ds.combat-ended",
      payload: {},
    });
    expect(() => t.ds).toThrow(
      "replay halted: ds.combat-ended at seq 8 leaves 'goblin-warrior' on the map",
    );
  });

  test("a save says whether it ended the condition", () => {
    const t = cave();
    ok(t, GM, "/place vex a1");
    t.run(GM, { type: "start" }, fixedDice(7));
    t.run(GM, { type: "first", side: "heroes" });
    t.run(ALICE, { type: "turn" });
    t.run(GM, { type: "cond", who: "vex", condition: "dazed", duration: "save" });
    t.run(ALICE, { type: "done" }, fixedDice(6));
    expect(t.envelopes.at(-1)).toMatchObject({
      type: "ds.turn-ended",
      payload: { saves: [{ condition: "dazed", roll: 6, ends: true }] },
    });
    t.run(GM, { type: "cond", who: "vex", condition: "dazed", duration: "save" });
    t.run(ALICE, { type: "save", who: "vex" }, fixedDice(5));
    expect(t.envelopes.at(-1)).toMatchObject({ payload: { roll: 5, ends: false } });
  });
});

describe("undo at the map", () => {
  test("a measurement is not a change: it never takes an undo, nor blocks a player's", () => {
    const t = cave();
    ok(t, GM, "/place vex a1");
    ok(t, GM, "/dmg vex 5");
    ok(t, BOB, "/dist vex c3");
    t.run(GM, { type: "undo" });
    expect(t.hero("vex").stamina).toBe(21);
    ok(t, ALICE, "/move vex c1");
    ok(t, BOB, "/dist vex a1");
    t.run(ALICE, { type: "undo", now: t.now });
    expect(where(t, "vex")).toBe("a1");
  });

  test("a roll is the GM's to take back: a power roll, a save, a turn's dice", () => {
    const t = cave();
    ok(t, GM, "/place vex a1");
    t.run(GM, { type: "start" }, fixedDice(7));
    t.run(GM, { type: "first", side: "heroes" });
    t.run(ALICE, { type: "turn" });
    const refusal = "That change rolled dice, so only the GM can take it back.";
    ok(t, ALICE, "/pr vex +2", fixedDice(1, 2));
    expect(t.submit(ALICE, { type: "undo", now: t.now })).toBe(refusal);
    t.run(GM, { type: "cond", who: "vex", condition: "dazed", duration: "save" });
    t.run(ALICE, { type: "done" }, fixedDice(2));
    expect(t.submit(ALICE, { type: "undo", now: t.now })).toBe(refusal);
    // Vex's turn start has no dice (Wrath +2), so Alice may take back a later one.
    t.run(GM, { type: "round" });
    t.run(ALICE, { type: "turn" });
    t.run(ALICE, { type: "undo", now: t.now });
  });

  test("a move a later slam stood on can't be undone first, though the slam went nowhere", () => {
    const t = cave();
    ok(t, GM, "/place kor e2");
    ok(t, GM, "/place vex f1");
    ok(t, ALICE, "/move vex d2");
    // From d2, a push away from Kor at e2 meets the wall at c2 at once.
    ok(t, GM, "/push vex 3 from kor");
    expect(t.envelopes.at(-2)).toMatchObject({
      type: "ds.force-moved",
      payload: { path: [], from: { x: 3, y: 1 }, slam: { into: "wall", remaining: 2 } },
    });
    expect(t.hero("vex").stamina).toBe(17);
    expect(t.submit(ALICE, { type: "undo", now: t.now })).toStartWith(
      "A later change depends on it",
    );
    expect(t.submit(GM, { type: "undo", who: "alice", whose: ALICE })).toStartWith(
      "A later change depends on it",
    );
    t.run(GM, { type: "undo" });
    t.run(ALICE, { type: "undo", now: t.now });
    expect(where(t, "vex")).toBe("f1");
    expect(t.hero("vex").stamina).toBe(21);
  });
});
