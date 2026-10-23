import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import {
  actionsOf,
  bandOf,
  helpText,
  mapOf,
  type PrepCatalog,
  prepOf,
  type PrepView,
} from "../../src/game/index.ts";
import { App } from "../../src/table/App.tsx";
import { emptyLine, fillLine, historyUp, insert, PREP_IS_GMS } from "../../src/table/input.ts";
import { countLine, itemCommand, prepClick, prepRows } from "../../src/table/prep.ts";
import { GOBLIN, KOR, VEX } from "../drawSteel/harness.ts";
import { ALICE, fixedDice, GM, Table } from "../game/table.ts";
import { character } from "../setWorld/harness.ts";
import { fakeView, line } from "./fakeView.ts";

/** The campaign's files as the host would list them. */
const CATALOG: PrepCatalog = {
  heroes: [
    { id: "kor", name: "Kor" },
    { id: "vex", name: "Vex" },
  ],
  monsters: [{ id: "goblin-warrior", name: "Goblin Warrior" }],
  maps: [
    { id: "cave", name: "Test Cave" },
    { id: "yard", name: "Yard" },
  ],
};

const YARD = {
  name: "Yard",
  terrain: ["..........", "..........", "....##....", "..........", ".........."],
};

/** Vex (Alice's) in the party, two goblins added, the yard loaded and only Vex on it. */
function drawSteelTable() {
  const t = new Table();
  t.run(ALICE, { type: "name", name: "Alice" });
  t.run(GM, { type: "hero", hero: "vex", sheet: VEX });
  t.run(ALICE, { type: "play", hero: "vex" });
  t.run(GM, { type: "add", monster: "goblin-warrior", count: 2, sheet: GOBLIN });
  t.run(GM, { type: "map", id: "yard", grid: YARD });
  t.run(GM, { type: "place", who: "vex", at: { x: 1, y: 1 } });
  return t;
}

/** Ada recruited and Grub rolled as a foe, the field loaded and only Ada on it. */
function setWorldTable() {
  const t = new Table();
  t.run(GM, { type: "set-recruit", name: "Ada", character: character() });
  t.run(GM, { type: "set-foe", name: "Grub", character: character({}, "sword", 2) });
  t.run(GM, { type: "set-map", id: "yard", grid: YARD });
  t.run(GM, { type: "set-place", who: "ada", at: { x: 0, y: 0 } });
  return t;
}

/** Each section as its title and its items' labels, lines and notes, for reading at a glance. */
const outline = (view: PrepView) =>
  view.sections.map((s) => ({
    title: s.title,
    items: s.items.map((i) => `${i.label} → ${i.line}${i.note ? ` (${i.note})` : ""}`),
    ...(s.note !== undefined && { note: s.note }),
  }));

describe("what the prep panel lists, by ruleset", () => {
  test("Draw Steel: heroes, monsters, maps, who to place, and Start, each with its command", () => {
    const t = drawSteelTable();
    expect(outline(prepOf(t.state, CATALOG, "draw-steel"))).toEqual([
      { title: "Heroes", items: ["Kor → /hero kor", "Vex → /hero vex (in play)"] },
      { title: "Monsters", items: ["Goblin Warrior → /add goblin-warrior (2 in play)"] },
      {
        title: "Maps",
        items: [
          "Test Cave → /map cave",
          "Yard → /map yard (loaded)",
          "Put away → /map off",
          "New crossing → /map new crossing",
          "New keep → /map new keep",
          "New, by seed → /map new ",
        ],
      },
      {
        title: "Place",
        items: [
          "Goblin Warrior 1 → /place goblin-warrior-1",
          "Goblin Warrior 2 → /place goblin-warrior-2",
        ],
      },
      { title: "Start", items: ["Start combat → /start"] },
    ]);
    const kinds = prepOf(t.state, CATALOG, "draw-steel").sections.map((s) =>
      s.items.map((i) => i.kind),
    );
    expect(kinds).toEqual([
      ["send", "send"],
      ["count"],
      ["send", "send", "send", "send", "send", "fill"],
      ["place", "place"],
      ["send"],
    ]);
  });

  test("Draw Steel: before a map there is nothing to place, and in combat no Start", () => {
    const t = new Table();
    const empty = { heroes: [], monsters: [], maps: [] };
    expect(outline(prepOf(t.state, empty, "draw-steel"))).toEqual([
      { title: "Heroes", items: [], note: "no sheets in heroes/" },
      { title: "Monsters", items: [], note: "no stat blocks in monsters/" },
      {
        title: "Maps",
        items: [
          "New crossing → /map new crossing",
          "New keep → /map new keep",
          "New, by seed → /map new ",
        ],
      },
      { title: "Place", items: [], note: "load a map first" },
      { title: "Start", items: ["Start combat → /start"] },
    ]);
    const fight = drawSteelTable();
    fight.run(GM, { type: "place", who: "goblin-warrior-1", at: { x: 7, y: 1 } });
    fight.run(GM, { type: "place", who: "goblin-warrior-2", at: { x: 7, y: 2 } });
    fight.run(GM, { type: "start" }, fixedDice(8));
    const sections = outline(prepOf(fight.state, CATALOG, "draw-steel"));
    expect(sections.at(-2)).toEqual({ title: "Place", items: [], note: "everyone is on the map" });
    expect(sections.at(-1)).toEqual({ title: "Start", items: [], note: "combat is on, round 1" });
  });

  test("set.world: Recruit and Foe fill the line for a name, then maps, who to place, Start", () => {
    const t = setWorldTable();
    expect(outline(prepOf(t.state, CATALOG, "set-world"))).toEqual([
      {
        title: "Fighters",
        items: ["Recruit → /recruit ", "Foe → /foe "],
        note: "1 in the party, 1 foe",
      },
      {
        title: "Maps",
        items: [
          "Test Cave → /map cave",
          "Yard → /map yard (loaded)",
          "Put away → /map off",
          "New crossing → /map new crossing",
          "New keep → /map new keep",
          "New, by seed → /map new ",
        ],
      },
      { title: "Place", items: ["Grub → /place grub"] },
      { title: "Start", items: ["Start the fight → /start"] },
    ]);
    expect(prepOf(t.state, CATALOG, "set-world").sections[0]!.items.map((i) => i.kind)).toEqual([
      "fill",
      "fill",
    ]);
  });
});

describe("Place, and /prep in /help", () => {
  test("a token off the loaded map offers Place where it would offer Move, to its player too", () => {
    const t = drawSteelTable();
    expect(actionsOf(t.state, GM, "draw-steel", "goblin-warrior-1")?.[0]).toEqual({
      label: "Place",
      pick: "square",
      line: "/place goblin-warrior-1",
    });
    expect(actionsOf(t.state, ALICE, "draw-steel", "vex")?.[0]?.label).toBe("Move");
    t.run(GM, { type: "hero", hero: "kor", sheet: KOR });
    t.run(ALICE, { type: "unplay", hero: "vex" });
    t.run(ALICE, { type: "play", hero: "kor" });
    expect(actionsOf(t.state, ALICE, "draw-steel", "kor")?.[0]?.label).toBe("Place");
    const sw = setWorldTable();
    expect(actionsOf(sw.state, GM, "set-world", "grub")?.[0]).toEqual({
      label: "Place",
      pick: "square",
      line: "/place grub",
    });
  });

  test("/help lists /prep for the GM alone, and only a seat has it", () => {
    expect(helpText(GM, undefined, "seat")).toContain("/prep");
    expect(helpText(ALICE, undefined, "seat")).not.toContain("/prep");
    expect(helpText(GM, undefined, "exec")).not.toContain("/prep");
    expect(helpText(GM, "prep", "seat")).toStartWith("/prep  Open the prep panel");
    expect(helpText(GM, undefined, "seat")).toContain("/map <map id>|off|new crossing|keep [seed]");
  });
});

describe("the prep panel, as data", () => {
  const view = prepOf(drawSteelTable().state, CATALOG, "draw-steel");
  const goblins = view.sections[1]!.items[0]!;

  test("each item shows the command it sends, the part to fill in named", () => {
    expect(view.sections.flatMap((s) => s.items.map(itemCommand))).toEqual([
      "/hero kor",
      "/hero vex",
      "/add goblin-warrior xN",
      "/map cave",
      "/map yard",
      "/map off",
      "/map new crossing",
      "/map new keep",
      "/map new …",
      "/place goblin-warrior-1 <square>",
      "/place goblin-warrior-2 <square>",
      "/start",
    ]);
    expect([1, 3].map((n) => countLine(goblins, n))).toEqual([
      "/add goblin-warrior",
      "/add goblin-warrior x3",
    ]);
  });

  test("rows: titles in a column, items wrapping under the first, a count's row under its section", () => {
    const text = (rows: ReturnType<typeof prepRows>) =>
      rows.map((r) =>
        r
          .map((p) => `${p.text}${p.command ? ` ${p.command}` : ""}${p.note ? ` · ${p.note}` : ""}`)
          .join("")
          .trimEnd(),
      );
    expect(text(prepRows(view, 76))).toEqual([
      "Heroes    Kor  /hero kor   Vex  /hero vex · in play",
      "Monsters  Goblin Warrior  /add goblin-warrior xN · 2 in play",
      "Maps      Test Cave  /map cave   Yard  /map yard · loaded",
      "          Put away  /map off   New crossing  /map new crossing",
      "          New keep  /map new keep   New, by seed  /map new …",
      "Place     Goblin Warrior 1  /place goblin-warrior-1 <square>",
      "          Goblin Warrior 2  /place goblin-warrior-2 <square>",
      "Start     Start combat  /start",
    ]);
    const counting = prepRows(view, 76, { section: 1, index: 0, n: 3 });
    expect(text(counting)[2]).toBe(
      "          Goblin Warrior:  −  3  +    Add  /add goblin-warrior x3   Cancel",
    );
    expect(counting[1]!.find((p) => p.action?.kind === "item")?.tone).toBe("active");
    const placing = prepRows(view, 76, undefined, "goblin-warrior-2");
    expect(placing[6]!.find((p) => p.action?.kind === "item")?.tone).toBe("active");
  });

  test("a click sends, fills, counts or waits for a square; the count stays between 1 and the most", () => {
    const at = (section: number, index: number) => ({ kind: "item" as const, section, index });
    expect(prepClick(view, at(0, 0), undefined)).toEqual({ kind: "send", line: "/hero kor" });
    expect(prepClick(view, at(2, 5), undefined)).toEqual({ kind: "fill", line: "/map new " });
    expect(prepClick(view, at(3, 1), undefined)).toEqual({
      kind: "place",
      id: "goblin-warrior-2",
      line: "/place goblin-warrior-2",
    });
    const opened = prepClick(view, at(1, 0), undefined);
    expect(opened).toEqual({ kind: "count", count: { section: 1, index: 0, n: 1 } });
    const one = { section: 1, index: 0, n: 1 };
    expect(prepClick(view, at(1, 0), one)).toEqual({ kind: "count", count: undefined });
    expect(prepClick(view, { kind: "less" }, one)).toEqual({ kind: "count", count: one });
    expect(prepClick(view, { kind: "more" }, one)).toEqual({
      kind: "count",
      count: { ...one, n: 2 },
    });
    expect(prepClick(view, { kind: "more" }, { ...one, n: 40 })).toEqual({
      kind: "count",
      count: { ...one, n: 40 },
    });
    expect(prepClick(view, { kind: "add" }, { ...one, n: 4 })).toEqual({
      kind: "send",
      line: "/add goblin-warrior x4",
    });
    expect(prepClick(view, { kind: "cancel" }, one)).toEqual({ kind: "count", count: undefined });
  });

  test("a filled line replaces what was typed, which Up brings back", () => {
    const typed = insert(emptyLine, "hello");
    const filled = fillLine(typed, "/recruit ");
    expect(filled).toMatchObject({ text: "/recruit ", cursor: 9 });
    expect(historyUp(filled).text).toBe("hello");
    expect(fillLine(emptyLine, "/foe ").history).toEqual([]);
  });
});

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

const rowsOf = (frame: string) => {
  const rows = frame.split("\n").map((r) => r.trimEnd());
  while (rows.length > 0 && rows.at(-1) === "") rows.pop();
  return rows;
};

const where = (t: Setup, text: string, from = 0) => {
  const rows = t.captureCharFrame().split("\n");
  for (let row = from; row < rows.length; row++) {
    const col = rows[row]!.indexOf(text);
    if (col >= 0) return { col, row };
  }
  throw new Error(`'${text}' isn't on screen:\n${t.captureCharFrame()}`);
};

async function settle(t: Setup) {
  await Bun.sleep(1);
  await t.renderOnce();
  return t.captureCharFrame();
}

async function click(t: Setup, col: number, row: number) {
  await t.mockMouse.click(col, row, undefined, { delayMs: 0 });
  return settle(t);
}

/** Clicks the first place `text` shows at or below the prep panel's title. */
async function clickInPrep(t: Setup, text: string) {
  const at = where(t, text, where(t, "⁵ prep").row);
  return click(t, at.col, at.row);
}

/**
 * The App on an 80x24 seat for `actor`, its views projected from a table playing `ruleset` (the
 * prep panel on the GM's seat only), kept up with `run` as the host would.
 */
async function seat(
  t: Table,
  actor: string,
  ruleset: "draw-steel" | "set-world",
  height = 24,
  reply?: (line: string) => string | undefined,
) {
  const [version, setVersion] = createSignal(0);
  const fake = fakeView({
    ...(reply === undefined ? {} : { reply }),
    me: actor,
    myName: actor === GM ? undefined : "Alice",
    feed: [line(1, "Oscar", "welcome to the yard")],
    combat: bandOf(t.state, actor, ruleset) ?? null,
    map: mapOf(t.state, actor, ruleset) ?? null,
    actions: (id) => (version(), actionsOf(t.state, actor, ruleset, id)),
    ...(actor === GM ? { prep: prepOf(t.state, CATALOG, ruleset) } : {}),
  });
  setup = await testRender(() => <App view={fake.view} />, {
    width: 80,
    height,
    exitOnCtrlC: false,
    autoFocus: false,
  });
  await setup.renderOnce();
  const shown = setup;
  const run = async (...args: Parameters<Table["run"]>) => {
    t.run(...args);
    fake.setCombat(bandOf(t.state, actor, ruleset));
    fake.setMap(mapOf(t.state, actor, ruleset));
    fake.setPrep(prepOf(t.state, CATALOG, ruleset));
    setVersion(version() + 1);
    return settle(shown);
  };
  return { fake, t: shown, run };
}

/** Presses Esc, and waits out the terminal's wait for a key that might follow it. */
async function escape(t: Setup) {
  t.mockInput.pressEscape();
  await Bun.sleep(40);
  return settle(t);
}

/** Turns the wheel down over the prep panel, three lines a notch. */
async function scrollPrep(t: Setup, notches: number) {
  const at = where(t, "⁵ prep");
  for (let i = 0; i < notches; i++) await t.mockMouse.scroll(at.col, at.row + 1, "down");
  return settle(t);
}

/** Types a line and presses Enter. */
async function typeLine(t: Setup, text: string) {
  await t.mockInput.typeText(text);
  t.mockInput.pressEnter();
  return settle(t);
}

describe("the prep panel at the GM's seat", () => {
  test("Alt+5 and /prep open it, reading the campaign's files each time; it starts hidden", async () => {
    const { fake, t } = await seat(drawSteelTable(), GM, "draw-steel");
    expect(t.captureCharFrame()).not.toContain("─ ⁵ prep");
    // Hidden, the hint row offers it, as it does any panel the seat has put away.
    expect(rowsOf(t.captureCharFrame()).at(-2)).toEndWith("show ⁵ prep");
    t.mockInput.pressKey("5", { meta: true });
    const frame = await settle(t);
    expect(frame).toContain("─ ⁵ prep");
    expect(fake.reloads()).toBe(1);
    t.mockInput.pressKey("5", { meta: true });
    expect(await settle(t)).not.toContain("─ ⁵ prep");
    expect(fake.reloads()).toBe(1);
    expect(await typeLine(t, "/prep")).toContain("─ ⁵ prep");
    expect(fake.reloads()).toBe(2);
    // /prep again keeps it open, and reads the files again.
    expect(await typeLine(t, "/prep")).toContain("─ ⁵ prep");
    expect(fake.reloads()).toBe(3);
    expect(fake.submitted).toEqual([]);
  });

  test("a player's seat has none: Alt+5 and /prep are answered politely, and nothing is sent", async () => {
    const { fake, t } = await seat(drawSteelTable(), ALICE, "draw-steel");
    expect(fake.view.prep).toBeUndefined();
    expect(rowsOf(t.captureCharFrame()).at(-2)).not.toContain("prep");
    t.mockInput.pressKey("5", { meta: true });
    expect(await settle(t)).toContain(PREP_IS_GMS);
    expect(await escape(t)).not.toContain(PREP_IS_GMS);
    expect(await typeLine(t, "/prep")).toContain(PREP_IS_GMS);
    expect(t.captureCharFrame()).not.toContain("⁵ prep");
    expect(fake.submitted).toEqual([]);
  });

  test("a folder that can't be read says why", async () => {
    const fake = fakeView({ me: GM, prep: null, prepProblem: "can't list heroes/: EACCES" });
    setup = await testRender(() => <App view={fake.view} />, {
      width: 80,
      height: 24,
      exitOnCtrlC: false,
      autoFocus: false,
    });
    expect(await typeLine(setup, "/prep")).toContain("can't list heroes/: EACCES");
  });

  test("Draw Steel: each click sends the line typing would, and Up shows it", async () => {
    const table = drawSteelTable();
    const { fake, t } = await seat(table, GM, "draw-steel", 40);
    await typeLine(t, "/prep");
    await clickInPrep(t, " Kor ");
    await clickInPrep(t, "New keep");
    await clickInPrep(t, "Test Cave");
    await clickInPrep(t, "Put away");
    await clickInPrep(t, "Start combat");
    expect(fake.submitted).toEqual([
      "/hero kor",
      "/map new keep",
      "/map cave",
      "/map off",
      "/start",
    ]);
    t.mockInput.pressArrow("up");
    expect(rowsOf(await settle(t)).at(-1)).toContain("/start");
  });

  test("Draw Steel: a monster opens a count; − and + step it, Add sends /add … xN", async () => {
    const { fake, t } = await seat(drawSteelTable(), GM, "draw-steel", 40);
    await typeLine(t, "/prep");
    await clickInPrep(t, "Goblin Warrior ");
    expect(t.captureCharFrame()).toContain("Goblin Warrior:  −  1  +    Add  /add goblin-warrior ");
    await clickInPrep(t, " + ");
    await clickInPrep(t, " + ");
    await clickInPrep(t, " − ");
    await clickInPrep(t, " + ");
    expect(t.captureCharFrame()).toContain("Add  /add goblin-warrior x3");
    await clickInPrep(t, " Add ");
    expect(fake.submitted).toEqual(["/add goblin-warrior x3"]);
    expect(t.captureCharFrame()).not.toContain(" Add ");
    // Cancel, or Esc, closes a count and sends nothing.
    await clickInPrep(t, "Goblin Warrior ");
    await clickInPrep(t, " Cancel ");
    expect(t.captureCharFrame()).not.toContain(" Cancel ");
    await clickInPrep(t, "Goblin Warrior ");
    expect(await escape(t)).not.toContain(" Cancel ");
    expect(fake.submitted).toEqual(["/add goblin-warrior x3"]);
  });

  test("Draw Steel: Place waits for a square on the map, as a token's Place in its menu would", async () => {
    const { fake, t, run } = await seat(drawSteelTable(), GM, "draw-steel");
    await typeLine(t, "/prep");
    // At 80x24 the panel shares the rows with the map, and the wheel brings Place into view.
    expect(t.captureCharFrame()).not.toContain("Goblin Warrior 2");
    await scrollPrep(t, 2);
    await clickInPrep(t, "Goblin Warrior 2");
    expect(rowsOf(t.captureCharFrame()).at(-3)).toBe(
      " Goblin Warrior 2 · Place: click a square  Cancel",
    );
    // g4, under the map's letters: a square being two columns, from column a.
    const letters = where(t, "a b c");
    await click(t, letters.col + 12, letters.row + 4);
    expect(fake.submitted).toEqual(["/place goblin-warrior-2 g4"]);
    expect(t.captureCharFrame()).not.toContain("Place: click a square");
    // Once it stands there, the panel stops offering it.
    await run(GM, { type: "place", who: "goblin-warrior-2", at: { x: 6, y: 3 } });
    expect(t.captureCharFrame()).not.toContain("/place goblin-warrior-2");
  });

  test("New, by seed puts /map new on the input line for the seed to be typed", async () => {
    const { fake, t } = await seat(drawSteelTable(), GM, "draw-steel", 40);
    await typeLine(t, "/prep");
    await clickInPrep(t, "New, by seed");
    expect(rowsOf(t.captureCharFrame()).at(-1)).toBe(" > /map new");
    await typeLine(t, "keep 42");
    expect(fake.submitted).toEqual(["/map new keep 42"]);
  });

  test("set.world: Recruit and Foe fill the line for a name; Place and Start send", async () => {
    const { fake, t } = await seat(setWorldTable(), GM, "set-world");
    await typeLine(t, "/prep");
    await clickInPrep(t, " Recruit ");
    expect(rowsOf(t.captureCharFrame()).at(-1)).toBe(" > /recruit");
    await typeLine(t, "Bea");
    await clickInPrep(t, " Foe ");
    expect(rowsOf(t.captureCharFrame()).at(-1)).toBe(" > /foe");
    await typeLine(t, "Old Grub 7");
    await scrollPrep(t, 2);
    await clickInPrep(t, " Grub ");
    const letters = where(t, "a b c");
    await click(t, letters.col + 4, letters.row + 2);
    await clickInPrep(t, "Start the fight");
    expect(fake.submitted).toEqual(["/recruit Bea", "/foe Old Grub 7", "/place grub c2", "/start"]);
  });
});

describe("the prep panel at 80x24", () => {
  test("Draw Steel: the header, the band, the map, the feed, the panel, the hint and the input all show", async () => {
    const { t } = await seat(drawSteelTable(), GM, "draw-steel");
    const frame = await typeLine(t, "/prep");
    const rows = rowsOf(frame);
    expect(rows).toHaveLength(24);
    expect(rows[0]).toContain("supervillain · den");
    expect(frame).toContain("¹ party");
    expect(frame).toContain("² map · Yard");
    expect(frame).toContain("³ feed");
    expect(frame).toContain("⁵ prep · click to send · the dim words are how to type it");
    expect(frame).toContain("Heroes    Kor  /hero kor   Vex  /hero vex · in play");
    expect(rows.at(-1)).toStartWith(" > ");
    // Its rows scroll: what doesn't fit is a wheel away.
    expect(frame).not.toContain("Start combat");
  });

  test("set.world: the same, Place and Start a wheel away", async () => {
    const { t } = await seat(setWorldTable(), GM, "set-world");
    const frame = await typeLine(t, "/prep");
    expect(rowsOf(frame)).toHaveLength(24);
    expect(frame).toContain("² map · Yard");
    expect(frame).toContain("Fighters  Recruit  /recruit …   Foe  /foe …  1 in the party, 1 foe");
    expect(frame).not.toContain("Start the fight");
    expect(rowsOf(frame).at(-1)).toStartWith(" > ");
    expect(await scrollPrep(t, 2)).toContain("Start the fight  /start");
  });

  test("a reply opened beside it (/help), or it beside a reply, leaves every box whole", async () => {
    const help = helpText(GM, undefined, "seat");
    for (const order of [
      ["/prep", "/help"],
      ["/help", "alt+5"],
    ]) {
      const { t } = await seat(drawSteelTable(), GM, "draw-steel", 24, (l) =>
        l === "/help" ? help : undefined,
      );
      for (const step of order)
        if (step === "alt+5") {
          t.mockInput.pressKey("5", { meta: true });
          await settle(t);
        } else await typeLine(t, step);
      const rows = rowsOf(t.captureCharFrame());
      expect(rows).toHaveLength(24);
      expect(rows[0]).toContain("supervillain · den");
      // Each box, top to bottom: its title on its top border, its bottom border before the next.
      const tops = rows.flatMap((r, i) => (r.startsWith("┌") ? [i] : []));
      const bottoms = rows.flatMap((r, i) => (r.startsWith("└") ? [i] : []));
      expect(tops.map((i) => rows[i]!.slice(0, 6))).toEqual([
        "┌─ ¹ p",
        "┌─ ³ f",
        "┌─ ⁴ j",
        "┌─ ⁵ p",
      ]);
      expect(bottoms).toHaveLength(4);
      tops.forEach((top, k) => expect(bottoms[k]!).toBeGreaterThan(top));
      tops.slice(1).forEach((top, k) => expect(top).toBeGreaterThan(bottoms[k]!));
      expect(rows.at(-1)).toStartWith(" > ");
      setup?.renderer.destroy();
      setup = undefined;
    }
  });

  test("in a fight with a full band, the map keeps its rows for a Place's square", async () => {
    const t = drawSteelTable();
    t.run(GM, { type: "hero", hero: "kor", sheet: KOR });
    t.run(GM, { type: "add", monster: "goblin-warrior", count: 6, sheet: GOBLIN });
    t.run(GM, { type: "start" }, fixedDice(8));
    const { fake, t: shown } = await seat(t, GM, "draw-steel");
    expect(rowsOf(shown.captureCharFrame()).filter((r) => /^│ +\d+ [·█V]/.test(r)).length).toBe(5);
    const rows = rowsOf(await typeLine(shown, "/prep"));
    expect(rows).toHaveLength(24);
    expect(rows.join("\n")).toContain("² map · Yard · rows 1-2 of 5");
    expect(rows.join("\n")).toContain("─ ⁵ prep");
    // The band keeps every living row and the map its least (MAP_FLOOR): the panel scrolls a line.
    expect(rows.filter((r) => /^│ +\d+ [·█V]/.test(r)).length).toBe(2);
    expect(rows.filter((r) => r.includes("Goblin Warrior 7")).length).toBe(1);
    await scrollPrep(shown, 2);
    // The menu's line takes the panel's last: it steps aside while the square is waited for.
    expect(await clickInPrep(shown, "Goblin Warrior 1")).not.toContain("─ ⁵ prep");
    const letters = where(shown, "a b c");
    expect(await click(shown, letters.col + 12, letters.row + 2)).toContain("─ ⁵ prep");
    expect(fake.submitted).toEqual(["/place goblin-warrior-1 g2"]);
  });
});
