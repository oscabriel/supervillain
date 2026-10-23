import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { bandOf, mapOf } from "../../src/game/index.ts";
import { App } from "../../src/table/App.tsx";
import { MapPane } from "../../src/table/MapPane.tsx";
import {
  ALL_SHOWN,
  allHiddenLine,
  fittedTitle,
  marked,
  panelMark,
  panelOf,
  PANELS,
  type Panels,
  togglePanel,
  viewPreset,
} from "../../src/table/panels.ts";
import { ALICE, GM, Table } from "../game/table.ts";
import { recorded } from "../setWorld/harness.ts";
import { fight, sampleFord } from "./combat.ts";
import { alice, fakeView, gm, line } from "./fakeView.ts";
import { fordRoad, hall } from "./maps.ts";

describe("the panels, as data", () => {
  test("numbered in screen order, each title led by its key as a superscript", () => {
    expect(PANELS).toEqual(["band", "map", "feed", "reply"]);
    expect([1, 2, 3, 4, 5].map(panelOf)).toEqual(["band", "map", "feed", "reply", undefined]);
    expect(PANELS.map(panelMark)).toEqual(["¹", "²", "³", "⁴"]);
    expect(marked(" feed ", panelMark("feed"))).toBe(" ³ feed ");
    expect(marked(" round 2 · Malice 5 ", "¹")).toBe(" ¹ round 2 · Malice 5 ");
    expect(marked(" feed ", undefined)).toBe(" feed ");
  });

  test("a marked title gives up its later parts before the border would drop it whole", () => {
    // OpenTUI draws a title only when it is four columns narrower than its box.
    const titles = [
      " map · Hall · rows 1-9 of 30 · /view pictures ",
      " map · Hall · rows 1-9 of 30 ",
      " map · Hall ",
    ];
    expect(fittedTitle(titles, "²", 80)).toBe(" ² map · Hall · rows 1-9 of 30 · /view pictures ");
    // 48 columns with its mark, so it needs a box 52 wide.
    expect(fittedTitle(titles, "²", 52)).toBe(" ² map · Hall · rows 1-9 of 30 · /view pictures ");
    expect(fittedTitle(titles, "²", 51)).toBe(" ² map · Hall · rows 1-9 of 30 ");
    expect(fittedTitle(titles, "²", 34)).toBe(" ² map · Hall ");
    expect(fittedTitle(titles, undefined, 51)).toBe(
      " map · Hall · rows 1-9 of 30 · /view pictures ",
    );
  });

  test("a key flips its panel; the map and an open reply take turns", () => {
    expect(togglePanel(ALL_SHOWN, "band", false)).toEqual({ ...ALL_SHOWN, band: false });
    expect(togglePanel(ALL_SHOWN, "feed", false)).toEqual({ ...ALL_SHOWN, feed: false });
    expect(togglePanel(togglePanel(ALL_SHOWN, "feed", false), "feed", false)).toEqual(ALL_SHOWN);
    expect(togglePanel(ALL_SHOWN, "map", false)).toEqual({ ...ALL_SHOWN, map: false });
    // A reply is open, so the map is out of sight: Alt+2 brings it back and puts the reply away.
    expect(togglePanel(ALL_SHOWN, "map", true)).toEqual({ ...ALL_SHOWN, reply: false });
    const hidden = { ...ALL_SHOWN, map: false };
    expect(togglePanel(hidden, "map", true)).toEqual({ ...ALL_SHOWN, reply: false });
    expect(togglePanel(ALL_SHOWN, "reply", true)).toEqual({ ...ALL_SHOWN, reply: false });
    expect(togglePanel({ ...ALL_SHOWN, reply: false }, "reply", true)).toEqual(ALL_SHOWN);
  });

  test("/view words are presets that set every panel; plain /view shows or hides the map", () => {
    const some: Panels = { band: false, map: false, feed: false, reply: false, mapFirst: false };
    expect(viewPreset(some, "both")).toEqual(ALL_SHOWN);
    expect(viewPreset(some, "map")).toEqual({ ...ALL_SHOWN, mapFirst: true });
    expect(viewPreset(some, "feed")).toEqual({ ...ALL_SHOWN, map: false });
    expect(viewPreset(ALL_SHOWN, "toggle")).toEqual({ ...ALL_SHOWN, map: false });
    expect(viewPreset({ ...ALL_SHOWN, map: false }, "toggle")).toEqual(ALL_SHOWN);
    // From /view map, hiding the map and showing it again shares the rows, as /view both would.
    const first = viewPreset(ALL_SHOWN, "map");
    expect(viewPreset(viewPreset(first, "toggle"), "toggle")).toEqual(ALL_SHOWN);
    // Plain /view leaves the other panels as they are.
    expect(viewPreset(some, "toggle")).toEqual({ ...some, map: true });
  });

  test("with every panel hidden, one line names the keys that bring something back", () => {
    expect(allHiddenLine(["band", "map", "feed"], 118)).toBe(
      "every panel is hidden · Alt+1 band · Alt+2 map · Alt+3 feed · /view both shows them all",
    );
    expect(allHiddenLine(["band", "map", "feed"], 78)).toBe(
      "every panel is hidden · Alt+1 band · Alt+2 map · Alt+3 feed",
    );
    expect(allHiddenLine(["band", "feed"], 78)).toBe(
      "every panel is hidden · Alt+1 band · Alt+3 feed · /view both shows them all",
    );
    for (const width of [78, 60, 40])
      expect(Bun.stringWidth(allHiddenLine(PANELS, width))).toBeLessThanOrEqual(width);
  });
});

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

const feed = Array.from({ length: 40 }, (_, i) => line(i + 1, "Bob", `message ${i + 1}`));
const sheet = Array.from({ length: 12 }, (_, i) => `sheet line ${i + 1}`).join("\n");

/** The sample fight beside The Ford Road, Alice seated; `/sheet` answers with twelve lines. */
const seated = (more: Parameters<typeof fakeView>[0] = {}) =>
  fakeView({
    myName: "Alice",
    present: [gm, alice],
    feed,
    combat: fight(sampleFord),
    map: fordRoad,
    reply: (l) => (l.startsWith("/sheet") ? sheet : undefined),
    ...more,
  });

async function mount(
  fake: ReturnType<typeof fakeView>,
  width: number,
  height: number,
  kittyKeyboard = false,
) {
  setup = await testRender(() => <App view={fake.view} />, {
    width,
    height,
    exitOnCtrlC: false,
    kittyKeyboard,
  });
  await setup.renderOnce();
  return setup;
}

/** Lets pending submits resolve, then draws a frame. */
async function settle(t: Setup) {
  await Bun.sleep(1);
  await t.renderOnce();
  return t.captureCharFrame();
}

/**
 * A frame without the scroll bars' thumbs: OpenTUI 0.6.6 keeps a feed's thumb at the size it had
 * while the feed was taller, though the same lines show, as after `/view feed` and `/view both`.
 */
const steady = (frame: string) =>
  frame
    .split("\n")
    .map((r) => r.replace(/[▀▄█](│\s*)$/, " $1"))
    .join("\n");

/** Alt and a digit, as OpenTUI's mock sends it: ESC 1, or CSI 49;3u under kitty's protocol. */
const alt = (t: Setup, digit: number) => {
  t.mockInput.pressKey(String(digit), { meta: true });
  return settle(t);
};

async function enter(t: Setup, text: string) {
  await t.mockInput.typeText(text);
  t.mockInput.pressEnter();
  return settle(t);
}

const rowsOf = (frame: string) => {
  const rows = frame.split("\n").map((r) => r.trimEnd());
  while (rows.length > 0 && rows.at(-1) === "") rows.pop();
  return rows;
};

/** A bordered box's height, from the top border row whose title has `title` to its bottom border. */
const boxHeight = (rows: ReadonlyArray<string>, title: string) => {
  const top = rows.findIndex((r) => r.startsWith("┌") && r.includes(title));
  if (top < 0) return 0;
  return rows.findIndex((r, i) => i > top && r.startsWith("└")) - top + 1;
};

const BAND = "¹ round 2";
const MAP = "² map · The Ford Road";
const FEED = "³ feed";
const REPLY = "⁴ just for you";

/** The header on top, the hint and the input at the bottom, the screen's height exactly. */
const framed = (rows: ReadonlyArray<string>, height: number) => {
  expect(rows).toHaveLength(height);
  expect(rows[0]).toContain("supervillain · den");
  expect(rows.at(-2)).toContain("/help");
  expect(rows.at(-1)).toStartWith(" >");
};

describe("Alt+1-4 show and hide this seat's panels", () => {
  for (const [width, height] of [
    [80, 24],
    [120, 40],
  ] as const) {
    describe(`at ${width}x${height}`, () => {
      test("every title shows its key, in screen order", async () => {
        const t = await mount(seated(), width, height);
        const rows = rowsOf(t.captureCharFrame());
        framed(rows, height);
        const at = [BAND, MAP, FEED].map((title) => rows.findIndex((r) => r.includes(title)));
        expect(at.every((i) => i > 0)).toBe(true);
        expect(at).toEqual(at.toSorted((a, b) => a - b));
      });

      test("Alt+1 hides the band, the map and the feed take its rows; again brings it back", async () => {
        const t = await mount(seated(), width, height);
        const before = t.captureCharFrame();
        const rows = rowsOf(await alt(t, 1));
        framed(rows, height);
        expect(rows.join("\n")).not.toContain("round 2");
        expect(rows[1]).toStartWith(`┌─ ${MAP}`);
        const shown = rowsOf(before);
        expect(boxHeight(rows, MAP)).toBeGreaterThanOrEqual(boxHeight(shown, MAP));
        expect(boxHeight(rows, MAP) + boxHeight(rows, FEED)).toBe(height - 3);
        expect(steady(await alt(t, 1))).toBe(steady(before));
      });

      test("Alt+2 hides the map, the band shows whole and the feed grows", async () => {
        const t = await mount(seated(), width, height);
        const before = rowsOf(t.captureCharFrame());
        const rows = rowsOf(await alt(t, 2));
        framed(rows, height);
        expect(boxHeight(rows, MAP)).toBe(0);
        expect(rows[1]).toContain(BAND);
        expect(rows.join("\n")).toContain("Bandit Slinger A x4");
        expect(rows.join("\n")).not.toMatch(/\+\d+ more/);
        expect(boxHeight(rows, FEED)).toBeGreaterThan(boxHeight(before, FEED));
      });

      test("Alt+3 hides the feed, the band and the map take its rows", async () => {
        const t = await mount(seated(), width, height);
        const before = rowsOf(t.captureCharFrame());
        const rows = rowsOf(await alt(t, 3));
        framed(rows, height);
        expect(boxHeight(rows, FEED)).toBe(0);
        expect(rows.join("\n")).not.toContain("message 40");
        // At 80x24 both had given rows to the feed; at 120x40 both were whole already.
        const grew = boxHeight(rows, BAND) + boxHeight(rows, MAP);
        const was = boxHeight(before, BAND) + boxHeight(before, MAP);
        if (height === 24) expect(grew).toBeGreaterThan(was);
        else expect(grew).toBe(was);
        expect(rows.join("\n")).not.toMatch(/\+\d+ more/);
      });

      test("Alt+4 hides an open reply to one line, the map comes back; Alt+4 shows it again", async () => {
        const t = await mount(seated(), width, height);
        let rows = rowsOf(await enter(t, "/sheet brann"));
        expect(rows.some((r) => r.includes(REPLY))).toBe(true);
        expect(boxHeight(rows, MAP)).toBe(0);
        expect(rows.at(-2)).toContain("Alt+4 hides it");
        rows = rowsOf(await alt(t, 4));
        framed(rows, height);
        expect(rows.some((r) => r.includes(REPLY))).toBe(false);
        expect(rows.join("\n")).not.toContain("sheet line 1");
        expect(rows.at(-3)).toBe(" › your reply is hidden · Alt+4 shows it · Esc drops it");
        expect(boxHeight(rows, MAP)).toBeGreaterThan(0);
        rows = rowsOf(await alt(t, 4));
        expect(rows.join("\n")).toContain("sheet line 1");
        expect(boxHeight(rows, MAP)).toBe(0);
      });

      test("with every panel hidden, one line says how to get them back", async () => {
        const t = await mount(seated(), width, height);
        await alt(t, 1);
        await alt(t, 2);
        const rows = rowsOf(await alt(t, 3));
        framed(rows, height);
        expect(rows[1]).toStartWith(" every panel is hidden · Alt+1 band · Alt+2 map · Alt+3 feed");
        expect(rows.slice(2, -2).every((r) => r === "")).toBe(true);
        const back = rowsOf(await alt(t, 3));
        expect(back.join("\n")).not.toContain("every panel is hidden");
        expect(boxHeight(back, FEED)).toBeGreaterThan(5);
      });
    });
  }

  test("a bare digit types it; only Alt toggles", async () => {
    const fake = seated();
    const t = await mount(fake, 80, 24);
    const before = t.captureCharFrame();
    await t.mockInput.typeText("1234");
    const frame = await settle(t);
    expect(rowsOf(frame).at(-1)).toContain("> 1234");
    expect(rowsOf(frame).slice(0, -1)).toEqual(rowsOf(before).slice(0, -1));
  });

  test("under the kitty keyboard protocol too", async () => {
    const t = await mount(seated(), 80, 24, true);
    const rows = rowsOf(await alt(t, 2));
    expect(boxHeight(rows, MAP)).toBe(0);
    expect(rows.at(-1)).not.toContain("2");
  });

  test("the hint row names the keys where it has room, not at 80 or 100 columns", async () => {
    const wide = await mount(fakeView({ myName: "Alice", feed }), 120, 40);
    expect(rowsOf(wide.captureCharFrame()).at(-2)).toBe(
      " Tab completes · ↑↓ history · PgUp/PgDn scroll · Alt+1-4 show or hide panels · /help · Ctrl-C leaves",
    );
  });

  test("the map without one loaded, and the reply pane without a reply, say so", async () => {
    const t = await mount(seated({ map: null }), 80, 24);
    expect(await alt(t, 2)).toContain("› no map is loaded; the layout applies once one is");
    t.mockInput.pressEscape();
    await Bun.sleep(40);
    expect(await alt(t, 4)).toContain("› no reply is open; /sheet or /help opens one");
  });

  test("Alt+2 with no map loaded leaves an open reply as it is", async () => {
    const t = await mount(seated({ map: null }), 80, 24);
    await enter(t, "/sheet brann");
    let rows = rowsOf(await alt(t, 2));
    expect(rows.some((r) => r.includes(REPLY))).toBe(true);
    expect(rows.join("\n")).toContain("sheet line 1");
    expect(rows.join("\n")).not.toContain("no map is loaded");
    rows = rowsOf(await alt(t, 4));
    expect(rows.at(-3)).toBe(" › your reply is hidden · Alt+4 shows it · Esc drops it");
  });

  test("with the feed hidden, a reply sits under the panels and the spare rows fall below it", async () => {
    for (const [combat, title] of [
      [null, "¹ at the table"],
      [fight(sampleFord), BAND],
    ] as const) {
      setup?.renderer.destroy();
      const t = await mount(seated({ combat }), 80, 24);
      await alt(t, 3);
      const rows = rowsOf(await enter(t, "/sheet brann"));
      expect(rows).toHaveLength(24);
      expect(rows.at(-2)).toStartWith(" Esc closes");
      expect(rows.at(-1)).toStartWith(" >");
      const band = rows.findIndex((r) => r.startsWith("┌") && r.includes(title));
      const bottom = rows.findIndex((r, i) => i > band && r.startsWith("└"));
      expect(band).toBe(1);
      expect(rows[bottom + 1]).toStartWith(`┌─ ${REPLY}`);
      const end = bottom + 1 + boxHeight(rows, REPLY);
      expect(rows.slice(end, -2).every((r) => r === "")).toBe(true);
    }
  });

  test("a one-line notice with the feed hidden sits under the panels too", async () => {
    const t = await mount(seated(), 80, 24);
    await alt(t, 3);
    const rows = rowsOf(await alt(t, 4));
    framed(rows, 24);
    const bottom = rows.findLastIndex((r) => r.startsWith("└"));
    expect(rows[bottom + 1]).toBe(" › no reply is open; /sheet or /help opens one");
  });

  test("Alt+2 beside an open reply brings the map and puts the reply away", async () => {
    const t = await mount(seated(), 80, 24);
    await enter(t, "/sheet brann");
    const rows = rowsOf(await alt(t, 2));
    expect(boxHeight(rows, MAP)).toBeGreaterThan(0);
    expect(rows.some((r) => r.includes("your reply is hidden"))).toBe(true);
  });

  test("a new reply opens the pane though the last was hidden", async () => {
    const t = await mount(seated(), 80, 24);
    await enter(t, "/sheet brann");
    await alt(t, 4);
    const rows = rowsOf(await enter(t, "/sheet ilsa"));
    expect(rows.some((r) => r.includes(REPLY))).toBe(true);
  });

  test("set.world's band hides and shows the same way", async () => {
    const table = new Table();
    table.run(ALICE, { type: "name", name: "Alice" });
    table.run(GM, { type: "set-recruit", name: "Ada", character: recorded(101) });
    table.run(GM, { type: "set-foe", name: "Grub", character: recorded(501) });
    table.run(GM, {
      type: "set-map",
      id: "field",
      grid: { name: "Field", terrain: ["........", "........"] },
    });
    table.run(ALICE, { type: "set-play", who: "ada" });
    table.run(GM, { type: "set-place", who: "ada", at: { x: 0, y: 0 } });
    table.run(GM, { type: "set-place", who: "grub", at: { x: 7, y: 1 } });
    table.run(GM, { type: "set-start" });
    const fake = fakeView({
      me: ALICE,
      myName: "Alice",
      feed,
      combat: bandOf(table.state, ALICE, "set-world") ?? null,
      map: mapOf(table.state, ALICE, "set-world") ?? null,
    });
    const t = await mount(fake, 80, 24);
    const before = t.captureCharFrame();
    expect(rowsOf(before)[1]).toStartWith("┌─ ¹ set.world · 0.93 s · turn 1 ");
    expect(before).toContain("² map · Field");
    const rows = rowsOf(await alt(t, 1));
    expect(rows.join("\n")).not.toContain("set.world ·");
    expect(rows[1]).toContain("² map · Field");
    expect(steady(await alt(t, 1))).toBe(steady(before));
  });
});

describe("the map's title and hints with panels hidden", () => {
  /** A reach 24 squares tall, down Vex's column of the Great hall. */
  const tall = () => {
    const map = hall();
    return {
      ...map,
      reach: Array.from({ length: 24 }, (_, i) => ({ x: 35, y: 6 + i })),
      reachLabel: "Vex can reach: speed 24",
    };
  };

  test("a reach the map can't show points at /view map only while that gives the map more rows", async () => {
    const t = await mount(seated({ map: tall() }), 80, 24);
    expect(rowsOf(t.captureCharFrame()).at(-2)).toContain("/view map to see all your reach");
    // With the band hidden, /view map would bring it back folded, and the feed too.
    let rows = rowsOf(await alt(t, 1));
    expect(rows.at(-2)).toStartWith(" Vex can reach: speed 24");
    expect(rows.at(-2)).not.toContain("/view map");
    rows = rowsOf(await alt(t, 3));
    expect(rows.at(-2)).not.toContain("/view map");
  });

  test("the panel's mark never pushes a cropped map's title out of its border", async () => {
    for (const height of [5, 8, 12]) {
      setup?.renderer.destroy();
      setup = await testRender(
        () => <MapPane map={hall()} height={height} hint="/view pictures" mark="²" />,
        { width: 80, height: height + 2 },
      );
      await setup.renderOnce();
      const top = setup.captureCharFrame().split("\n")[0]!;
      expect(top).toStartWith("┌─ ² map · Great hall · rows ");
      expect(top).toContain("columns ");
    }
  });
});

describe("/view presets over the same panels", () => {
  test("/view both brings back every panel the keys hid", async () => {
    const fake = seated();
    const t = await mount(fake, 80, 24);
    const before = t.captureCharFrame();
    await alt(t, 1);
    await alt(t, 3);
    expect(steady(await enter(t, "/view both"))).toBe(steady(before));
    expect(fake.submitted).toEqual([]);
  });

  test("/view feed hides the map and shows the rest; Alt+2 brings the map back", async () => {
    const t = await mount(seated(), 80, 24);
    const before = t.captureCharFrame();
    await alt(t, 1);
    const rows = rowsOf(await enter(t, "/view feed"));
    expect(boxHeight(rows, MAP)).toBe(0);
    expect(rows[1]).toContain(BAND);
    expect(boxHeight(rows, FEED)).toBeGreaterThan(5);
    expect(steady(await alt(t, 2))).toBe(steady(before));
  });

  test("/view map folds the band for the map; Alt+1 then gives the map the band's rows too", async () => {
    const t = await mount(seated(), 80, 24);
    let rows = rowsOf(await enter(t, "/view map"));
    const first = boxHeight(rows, MAP);
    expect(rows[1]).toContain(BAND);
    expect(boxHeight(rows, FEED)).toBe(5);
    rows = rowsOf(await alt(t, 1));
    // The Ford Road wants thirteen rows: ten, its letters and its border.
    expect(boxHeight(rows, MAP)).toBeGreaterThan(first);
    expect(boxHeight(rows, MAP)).toBe(13);
    expect(boxHeight(rows, FEED)).toBeGreaterThan(5);
  });

  test("plain /view shows or hides the map and leaves the other panels as they are", async () => {
    const t = await mount(seated(), 80, 24);
    await alt(t, 1);
    let rows = rowsOf(await enter(t, "/view"));
    expect(boxHeight(rows, MAP)).toBe(0);
    expect(rows.join("\n")).not.toContain("round 2");
    rows = rowsOf(await enter(t, "/view"));
    expect(boxHeight(rows, MAP)).toBeGreaterThan(0);
    expect(rows.join("\n")).not.toContain("round 2");
  });

  test("/view <who> shows a hidden map, centred there", async () => {
    const t = await mount(seated(), 80, 24);
    await alt(t, 2);
    const rows = rowsOf(await enter(t, "/view wren"));
    expect(boxHeight(rows, MAP)).toBeGreaterThan(0);
    expect(rows.some((r) => r.includes(" 7 · W "))).toBe(true);
  });
});
