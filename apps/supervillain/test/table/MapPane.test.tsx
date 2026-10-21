import { afterEach, describe, expect, test } from "bun:test";
import { RGBA, TextAttributes } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { columnLabel } from "../../src/game/drawSteel/index.ts";
import { type Focus, focusOf } from "../../src/table/map.ts";
import { MapPane } from "../../src/table/MapPane.tsx";
import { color } from "../../src/table/theme.ts";
import type { MapView } from "../../src/table/view.ts";
import { ford, hall, token } from "./maps.ts";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

/** Mounts the pane alone at the top of a screen `width` wide, `height` rows tall, border to border. */
async function mount(map: () => MapView, width: number, height: number, focus?: Focus) {
  setup = await testRender(() => <MapPane map={map()} height={height} focus={focus} />, {
    width,
    height: height + 2,
  });
  await setup.renderOnce();
  return setup;
}

/** The pane's rows, border to border. */
const paneRows = (t: Setup, height: number) => t.captureCharFrame().split("\n").slice(0, height);

/** What is inside the border and its padding, trailing blanks dropped. */
const inside = (row: string) => [...row].slice(2, -2).join("").trimEnd();

const spansOf = (t: Setup) => t.captureSpans().lines.flatMap((l) => l.spans);
const hex = (c: string) => RGBA.fromHex(c);

describe("column names, as in c5", () => {
  test("a to z, then aa, ab and on, like a spreadsheet", () => {
    expect([0, 1, 2, 25, 26, 27, 51, 52, 701, 702].map(columnLabel)).toEqual([
      "a",
      "b",
      "c",
      "z",
      "aa",
      "ab",
      "az",
      "ba",
      "zz",
      "aaa",
    ]);
  });
});

describe("a small map", () => {
  test("fits and is centred: two columns a square, column letters on top, row numbers left", async () => {
    const t = await mount(() => ford, 40, 7);
    const rows = paneRows(t, 7);
    expect(rows[0]).toContain("map · Ford crossing");
    // 36 columns inside; the map with its row numbers is 14 wide, so 11 blank columns lead.
    const pad = " ".repeat(11);
    expect(rows.slice(1, 6).map(inside)).toEqual([
      `${pad}  a b c d e f`,
      `${pad}1 • • • · · ·`,
      `${pad}2 • V ████· ·`,
      `${pad}3 • • ~ ~ g1·`,
      `${pad}4 · · · · · x`,
    ]);
    expect(rows[6]).toStartWith("└");
  });

  test("a dead token is an x, and the creature's letter is gone", async () => {
    const t = await mount(() => ford, 40, 7);
    const frame = t.captureCharFrame();
    expect(frame).not.toContain("O");
    expect(inside(paneRows(t, 7)[5]!)).toEndWith("x");
  });

  test("tokens in role colours, the seat's own in its own; terrain never shares them", async () => {
    const t = await mount(() => ford, 40, 7);
    const spans = spansOf(t);
    const vex = spans.find((s) => s.text.trim() === "V");
    const goblin = spans.find((s) => s.text.trim() === "g1");
    expect(vex?.fg.equals(hex(color.you))).toBe(true);
    expect(goblin?.fg.equals(hex(color.director))).toBe(true);
    const tokenColours = [color.heroes, color.director, color.you, color.gm].map(hex);
    const terrain = spans.filter((s) => /^[·•█~]/.test(s.text.trim()));
    expect(terrain.length).toBeGreaterThan(0);
    for (const s of terrain) for (const c of tokenColours) expect(s.fg.equals(c)).toBe(false);
  });

  test("another hero is in the heroes' colour", async () => {
    const map: MapView = {
      ...ford,
      tokens: [...ford.tokens, token({ id: "brakka", mark: "B", x: 0, y: 3, side: "heroes" })],
    };
    const t = await mount(() => map, 40, 7);
    const brakka = spansOf(t).find((s) => s.text.trim() === "B");
    expect(brakka?.fg.equals(hex(color.heroes))).toBe(true);
  });

  test("the acting token is underlined and bold, so colour isn't the only sign", async () => {
    const t = await mount(() => ford, 40, 7);
    const spans = spansOf(t);
    const vex = spans.find((s) => s.text.trim() === "V");
    const goblin = spans.find((s) => s.text.trim() === "g1");
    expect((vex?.attributes ?? 0) & TextAttributes.UNDERLINE).toBeTruthy();
    expect((vex?.attributes ?? 0) & TextAttributes.BOLD).toBeTruthy();
    expect((goblin?.attributes ?? 0) & TextAttributes.UNDERLINE).toBeFalsy();
  });

  test("reachable squares are tinted, and their dot is a bigger one", async () => {
    const t = await mount(() => ford, 40, 7);
    const spans = spansOf(t);
    const reach = spans.filter((s) => s.text.includes("•"));
    const floor = spans.filter((s) => s.text.includes("·"));
    expect(reach.length).toBeGreaterThan(0);
    for (const s of reach) expect(s.bg.equals(hex(color.reach))).toBe(true);
    for (const s of floor) expect(s.bg.equals(hex(color.reach))).toBe(false);
  });

  test("with room to spare it is centred up and down too", async () => {
    const t = await mount(() => ford, 40, 11);
    const rows = paneRows(t, 11).map(inside);
    // Nine rows inside, five of them the map: two blank rows above it.
    expect(rows[1]).toBe("");
    expect(rows[2]).toBe("");
    expect(rows[3]?.trim()).toBe("a b c d e f");
    expect(rows[7]?.trim()).toBe("4 · · · · · x");
  });
});

describe("a map bigger than the pane", () => {
  // 50 wide: 46 inside, 3 for row numbers, 21 squares across, one of them an edge marker
  // column when a token is past that edge. 12 tall: 10 inside, the letters (two rows once
  // two-letter columns show), then the rows, one more for each edge with a token past it.
  const floor = (n: number) => Array.from({ length: n }, () => "·").join(" ");
  /** A row of squares, `n` across, with marks at some of them, as drawn: two columns a square. */
  const squares = (n: number, marks: Readonly<Record<number, string>> = {}) =>
    Array.from({ length: n }, (_, i) => (marks[i] ?? "·").padEnd(2))
      .join("")
      .trimEnd();

  test("follows the acting token, with arrows at the edges toward the tokens out of view", async () => {
    const t = await mount(() => hall(), 50, 12);
    const rows = paneRows(t, 12).map(inside);
    // Columns u to an, rows 23 to 29; aj26 (Vex) is in view. Two-letter columns show, so the
    // letters take two rows, the first letter over the second.
    expect(rows[1]).toBe(`${" ".repeat(17)}a a a a a a a a a a a a a a`);
    expect(rows[2]).toBe("     u v w x y z a b c d e f g h i j k l m n");
    // Brakka (c4) is up and left: the corner. The goblin (ae6) is straight up: over column ae.
    expect(rows[3]).toBe(`   ↖ ${" ".repeat(20)}▴`);
    expect(rows[4]).toBe(`23   ${floor(20)}`);
    // The ogre (k26) is straight left, on its row; Vex is at aj.
    expect(rows[7]).toBe(`26 ◂ ${floor(15)} V ${floor(4)}`);
    // Nothing is past the bottom or the right, so those edges are squares too.
    expect(rows[10]).toBe(`29   ${floor(20)}`);
  });

  test("the bottom border names the tokens out of view, arrow first; the dead get none", async () => {
    const t = await mount(() => hall(), 50, 12);
    const bottom = paneRows(t, 12)[11]!;
    expect(bottom).toContain(" ↖B ▴g ◂O ");
    expect(bottom).not.toContain("s");
  });

  test("pans when the turn passes to another token", async () => {
    const [map, setMap] = createSignal(hall());
    const t = await mount(map, 50, 12);
    setMap(hall({ acting: "brakka" }));
    await t.renderOnce();
    const rows = paneRows(t, 12).map(inside);
    // Brakka at c4: the view starts at a1, so there is no top or left edge row, and the columns
    // a to t need one row of letters.
    expect(rows[1]).toBe("   a b c d e f g h i j k l m n o p q r s t");
    expect(rows[2]).toBe(` 1 x ${floor(19)}`);
    expect(rows[5]).toBe(` 4 · · B ${floor(17)}`);
    // The goblin (ae6) is straight right; the ogre (k26) straight down; Vex (aj26) down and right.
    expect(rows[7]).toBe(` 6 ${floor(20)} ▸`);
    expect(rows[9]).toBe(` 8 ${floor(20)}`);
    expect(rows[10]).toBe(`${" ".repeat(23)}▾${" ".repeat(19)}↘`);
    expect(paneRows(t, 12)[11]).toContain(" ↘V ▸g ▾O ");
  });

  test("in the fewest rows the App gives it, the edge rows give way and nothing spills", async () => {
    const t = await mount(() => hall(), 50, 5);
    const rows = paneRows(t, 5);
    expect(rows[4]).toStartWith("└");
    // One row of letters, past z only every other column named; then two rows of squares.
    expect(inside(rows[1]!)).toBe("     u v w x y z aa  ac  ae  ag  ai  ak  am");
    expect(inside(rows[2]!)).toStartWith("25 ");
    expect(inside(rows[3]!)).toStartWith("26 ◂");
    expect(inside(rows[3]!)).toContain("V");
    expect(rows[4]).toContain(" ↖B ▴g ◂O ");
  });

  test("with nobody acting, it follows the seat's own hero", async () => {
    const t = await mount(() => hall({ acting: "nobody", mine: "brakka" }), 50, 12);
    const rows = paneRows(t, 12).map(inside);
    expect(rows[5]).toBe(` 4 · · B ${floor(17)}`);
  });

  test("with nobody to follow, as on the GM's seat between turns, it shows the most tokens it can", async () => {
    const base = hall({ acting: "nobody", mine: "nobody" });
    const map: MapView = {
      ...base,
      tokens: [
        ...base.tokens,
        token({ id: "goblin-2", mark: "g2", x: 32, y: 6 }),
        token({ id: "goblin-3", mark: "g3", x: 28, y: 4 }),
      ],
    };
    const t = await mount(() => map, 50, 12);
    const rows = paneRows(t, 12).map(inside);
    // The three goblins round ae6, never the empty middle: columns u to an, rows 3 to 9.
    expect(rows[2]).toBe("     u v w x y z a b c d e f g h i j k l m n");
    expect(rows[3]).toBe(` 3   ${floor(20)}`);
    // Brakka (c4) is straight left, on row 4; Vex (aj26) straight down; the ogre down and left.
    expect(rows[4]).toBe(` 4 ◂ ${floor(20)}`);
    expect(rows[5]).toBe(` 5   ${squares(20, { 8: "g3" })}`);
    expect(rows[6]).toBe(` 6   ${squares(20, { 10: "g" })}`);
    expect(rows[7]).toBe(` 7   ${squares(20, { 12: "g2" })}`);
    expect(paneRows(t, 12)[11]).toContain(" ▾V ◂B ↙O ");
  });

  test("a seat can centre it anywhere: /view gives it a square to centre on", async () => {
    const t = await mount(() => hall(), 50, 12, { x: 10, y: 25 });
    const rows = paneRows(t, 12).map(inside);
    // The ogre at k26 in the middle of a1:t…, Vex out to the right.
    expect(rows[1]).toBe("   a b c d e f g h i j k l m n o p q r s t");
    expect(rows.find((r) => r.startsWith("26"))).toBe(`26 ${squares(20, { 10: "O" })} ▸`);
  });

  test("an arrow is in its token's colour: the seat's own hero's, out of view, in its own", async () => {
    const [map, setMap] = createSignal(hall());
    const t = await mount(map, 50, 12);
    setMap(hall({ acting: "brakka" }));
    await t.renderOnce();
    const spans = spansOf(t);
    expect(spans.find((s) => s.text.trim() === "↘")?.fg.equals(hex(color.you))).toBe(true);
    expect(spans.find((s) => s.text.trim() === "▸")?.fg.equals(hex(color.director))).toBe(true);
  });
});

describe("reach on difficult terrain", () => {
  test("a reachable difficult square is a doubled wave, so the tint isn't the only sign", async () => {
    const map: MapView = { ...ford, reach: [...ford.reach, { x: 2, y: 2 }] };
    const t = await mount(() => map, 40, 7);
    const rows = paneRows(t, 7).map(inside);
    expect(rows[4]).toEndWith("3 • • ≈ ~ g1·");
  });
});

describe("where /view points", () => {
  test("a token by its mark (case and all), its id or name or a start of one, else a square", () => {
    const map = hall();
    expect(focusOf(map, "B")).toEqual({ token: "brakka" });
    expect(focusOf(map, "bra")).toEqual({ token: "brakka" });
    expect(focusOf(map, "Ogre")).toEqual({ token: "ogre" });
    expect(focusOf(map, "k26")).toEqual({ square: { x: 10, y: 25 } });
    // "g" is the goblin's mark, though it starts no other name either.
    expect(focusOf(map, "g")).toEqual({ token: "goblin" });
    expect(focusOf(map, "zz9")).toEqual({
      refusal: "No token on the map is called 'zz9'; /view <square|who>, or map, feed or both",
    });
    const two = {
      ...map,
      tokens: [...map.tokens, token({ id: "goblin-2", mark: "g2", x: 1, y: 1 })],
    };
    expect(focusOf(two, "gob")).toEqual({ refusal: "'gob' could be goblin or goblin-2." });
  });
});
