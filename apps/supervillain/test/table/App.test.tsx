import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { App } from "../../src/table/App.tsx";
import { brakka, fight, goblins, ogre, sera, sniper, spearmen, vex } from "./combat.ts";
import { alice, bob, fakeView, gm, line } from "./fakeView.ts";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

/** Mounts the App on a headless renderer. Ctrl-C belongs to the App, not the renderer. */
async function mount(fake: ReturnType<typeof fakeView>, width = 100, height = 30) {
  setup = await testRender(() => <App view={fake.view} />, { width, height, exitOnCtrlC: false });
  await setup.renderOnce();
  return setup;
}

/** The frame's rows without trailing blanks; the last one is the input line. */
const rowsOf = (frame: string) => {
  const rows = frame.split("\n").map((r) => r.trimEnd());
  while (rows.length > 0 && rows.at(-1) === "") rows.pop();
  return rows;
};

const table = () =>
  fakeView({
    room: "den",
    myName: "Alice",
    present: [gm, alice, bob],
    feed: [line(1, "Oscar", "welcome to the den"), line(2, "Alice", "hi all")],
  });

describe("layout", () => {
  for (const [width, height] of [
    [100, 30],
    [80, 24],
  ] as const) {
    test(`at ${width}x${height}: header, band, feed, hint and input are all on screen`, async () => {
      const t = await mount(table(), width, height);
      const frame = t.captureCharFrame();
      const rows = rowsOf(frame);
      expect(rows[0]).toContain("den");
      expect(rows[0]).toContain("Oscar (GM)");
      expect(rows[0]).toContain("Alice (you)");
      expect(rows[0]).toContain("Bob");
      expect(frame).toContain("Oscar: welcome to the den");
      expect(frame).toContain("Alice: hi all");
      expect(rows.at(-2)).toBe(
        " Tab completes · ↑↓ history · PgUp/PgDn scroll · /help · Ctrl-C leaves",
      );
      expect(rows).toHaveLength(height);
      expect(rows.at(-1)).toStartWith(" >");
    });
  }
});

describe("the header at 80 columns", () => {
  const seated = [
    { actor: "gm", label: "GM", gm: true },
    { actor: "key:a", label: "Alice (Brann)", gm: false },
    { actor: "key:d", label: "Dan (Ilsa)", gm: false },
    { actor: "key:b", label: "Bob (Kesh)", gm: false },
    { actor: "key:c", label: "Cara (Wren)", gm: false },
  ];

  test("whole labels only: those that don't fit are counted, never cut in the middle", async () => {
    const t = await mount(fakeView({ me: "gm", room: "ford", present: seated }), 80, 24);
    const top = rowsOf(t.captureCharFrame())[0]!;
    expect(top).toEndWith("here: GM (you), Alice (Brann), Dan (Ilsa), +2");
    expect(top).not.toContain("…");
  });

  test("your own label stays, wherever you sit", async () => {
    const t = await mount(
      fakeView({
        me: "key:c",
        myName: "Cara",
        room: "ford",
        present: [...seated, { actor: "key:e", label: "Eve (Sel)", gm: false }],
      }),
      80,
      24,
    );
    const top = rowsOf(t.captureCharFrame())[0]!;
    expect(top).toContain("Cara (Wren) (you)");
    expect(top).toMatch(/, \+\d$/);
    expect(top).not.toContain("…");
  });
});

/** Lets pending submits resolve, then draws a frame. */
async function settle(t: Setup) {
  await Bun.sleep(1);
  await t.renderOnce();
  return t.captureCharFrame();
}

/** Types a line and presses Enter. */
async function enter(t: Setup, text: string) {
  await t.mockInput.typeText(text);
  t.mockInput.pressEnter();
  return settle(t);
}

const inputRow = (t: Setup) => rowsOf(t.captureCharFrame()).at(-1) ?? "";

describe("chat", () => {
  test("typing and Enter submits the line and clears the input", async () => {
    const fake = table();
    const t = await mount(fake);
    await t.mockInput.typeText("hello there");
    await t.renderOnce();
    expect(inputRow(t)).toContain("> hello there");
    t.mockInput.pressEnter();
    await settle(t);
    expect(fake.submitted).toEqual(["hello there"]);
    expect(inputRow(t)).not.toContain("hello there");
  });

  test("a reply from submit shows to this seat, and Esc dismisses it", async () => {
    const fake = fakeView({ myName: "Alice", reply: () => "no creature called gob" });
    const t = await mount(fake);
    expect(await enter(t, "/dmg gob 3")).toContain("› no creature called gob");
    t.mockInput.pressEscape();
    await new Promise((r) => setTimeout(r, 40));
    expect(await settle(t)).not.toContain("no creature called gob");
  });

  test("multi-line help shows every line in a pane", async () => {
    const help = [
      "Plain text is chat.",
      "/roll <dice>   roll some dice",
      "/name <name>   what the table calls you",
    ];
    const fake = fakeView({
      myName: "Alice",
      reply: (l) => (l === "/help" ? help.join("\n") : undefined),
    });
    const t = await mount(fake, 80, 24);
    const frame = await enter(t, "/help");
    for (const row of help) expect(frame).toContain(row);
    expect(fake.submitted).toEqual(["/help"]);
  });

  test("a refused line comes back to the input to be fixed; a help reply does not", async () => {
    const fake = fakeView({
      myName: "Alice",
      reply: (l) =>
        l === "/roll fireball"
          ? "not dice"
          : l === "/help roll"
            ? "/roll <dice>  Roll dice."
            : undefined,
    });
    const t = await mount(fake);
    expect(await enter(t, "/roll fireball")).toContain("› not dice");
    expect(inputRow(t)).toContain("> /roll fireball");
    t.mockInput.pressKey("u", { ctrl: true });
    expect(await enter(t, "/help roll")).toContain("/roll <dice>  Roll dice.");
    expect(inputRow(t)).not.toContain("/help roll");
  });

  test("the next line clears an old reply", async () => {
    const fake = fakeView({
      myName: "Alice",
      reply: (l) => (l === "/bad" ? "unknown command" : undefined),
    });
    const t = await mount(fake);
    expect(await enter(t, "/bad")).toContain("unknown command");
    expect(await enter(t, "fine")).not.toContain("unknown command");
  });

  test("no single letter is a hotkey: q, s and h just type", async () => {
    const fake = table();
    const t = await mount(fake);
    await enter(t, "qsh");
    expect(fake.submitted).toEqual(["qsh"]);
    expect(fake.left()).toBe(0);
  });
});

describe("Tab completion", () => {
  const completer = (l: string): ReadonlyArray<string> =>
    l === "/r" ? ["/roll "] : l === "/h" ? ["/help ", "/heal ", "/hide "] : [];

  test("a single candidate replaces the line", async () => {
    const fake = fakeView({ myName: "Alice", complete: completer });
    const t = await mount(fake);
    await t.mockInput.typeText("/r");
    t.mockInput.pressTab();
    await t.renderOnce();
    expect(inputRow(t)).toContain("> /roll");
    await enter(t, "2d10");
    expect(fake.completed).toEqual(["/r"]);
    expect(fake.submitted).toEqual(["/roll 2d10"]);
  });

  test("repeated Tab cycles the candidates, listed in the hint row", async () => {
    const fake = fakeView({ myName: "Alice", complete: completer });
    const t = await mount(fake);
    await t.mockInput.typeText("/h");
    t.mockInput.pressTab();
    await t.renderOnce();
    expect(inputRow(t)).toContain("> /help");
    expect(rowsOf(t.captureCharFrame()).at(-2)).toContain("Tab:  /help  /heal  /hide");
    t.mockInput.pressTab();
    await t.renderOnce();
    expect(inputRow(t)).toContain("> /heal");
    t.mockInput.pressTab({ shift: true });
    await t.renderOnce();
    expect(inputRow(t)).toContain("> /help");
  });
});

describe("history", () => {
  test("Up recalls sent lines and Down past the newest restores the draft", async () => {
    const fake = table();
    const t = await mount(fake);
    await enter(t, "first");
    await enter(t, "second");
    await t.mockInput.typeText("half typed");
    t.mockInput.pressArrow("up");
    await t.renderOnce();
    expect(inputRow(t)).toContain("> second");
    t.mockInput.pressArrow("up");
    await t.renderOnce();
    expect(inputRow(t)).toContain("> first");
    t.mockInput.pressArrow("down");
    t.mockInput.pressArrow("down");
    await t.renderOnce();
    expect(inputRow(t)).toContain("> half typed");
  });
});

describe("paste and control keys", () => {
  test("pasted newlines become spaces and escape sequences never reach the line", async () => {
    const fake = table();
    const t = await mount(fake);
    await t.mockInput.pasteBracketedText("roll\nfor \x1b[31minitiative\x1b[0m\r\nnow");
    await enter(t, "");
    expect(fake.submitted).toEqual(["roll for initiative now"]);
  });

  test("control keys without a meaning type nothing", async () => {
    const fake = table();
    const t = await mount(fake);
    await t.mockInput.typeText("ok");
    t.mockInput.pressKey("x", { ctrl: true });
    t.mockInput.pressKey("F1");
    await enter(t, "");
    expect(fake.submitted).toEqual(["ok"]);
  });
});

describe("first ten seconds", () => {
  test("the GM sees how players join until someone else sits down", async () => {
    const hint = "ssh -p 2222 den@127.0.0.1";
    const fake = fakeView({ me: "gm", present: [gm], joinHint: hint });
    const t = await mount(fake);
    expect(t.captureCharFrame()).toContain(`players join with: ${hint}`);
    fake.setPresent([gm, alice]);
    expect(await settle(t)).not.toContain(hint);
  });

  test("a player's /state goes to the host like any other line", async () => {
    const fake = fakeView({ myName: "Alice", reply: () => "Only the GM can use /state." });
    const t = await mount(fake);
    expect(await enter(t, "/state")).toContain("Only the GM can use /state.");
    expect(fake.submitted).toEqual(["/state"]);
  });

  test("a seat without a name is asked for one, and the line is sent as /name", async () => {
    const fake = fakeView({ myName: undefined, present: [alice] });
    const t = await mount(fake);
    expect(inputRow(t)).toStartWith(" what should the table call you?");
    await enter(t, "Vex");
    expect(fake.submitted).toEqual(["/name Vex"]);
  });

  test("a refusal shows and the table keeps asking; once named, lines are chat", async () => {
    const fake = fakeView({
      myName: undefined,
      reply: (l) => (l === "/name Oscar" ? "Oscar is taken; pick another name" : undefined),
    });
    const t = await mount(fake);
    expect(await enter(t, "Oscar")).toContain("Oscar is taken; pick another name");
    expect(inputRow(t)).toStartWith(" what should the table call you? Oscar");
    t.mockInput.pressKey("u", { ctrl: true });
    await enter(t, "Vex");
    fake.setMyName("Vex");
    await settle(t);
    expect(inputRow(t)).toStartWith(" >");
    await enter(t, "hello");
    expect(fake.submitted).toEqual(["/name Oscar", "/name Vex", "hello"]);
  });

  test("the GM's seat is never asked for a name", async () => {
    const fake = fakeView({ me: "gm", myName: undefined });
    const t = await mount(fake);
    expect(inputRow(t)).toStartWith(" >");
    await enter(t, "welcome");
    expect(fake.submitted).toEqual(["welcome"]);
  });
});

describe("leaving and the debug pane", () => {
  test("Ctrl-C calls leave", async () => {
    const fake = table();
    const t = await mount(fake);
    t.mockInput.pressCtrlC();
    await settle(t);
    expect(fake.left()).toBe(1);
  });

  test("/quit calls leave and is not sent to the host", async () => {
    const fake = table();
    const t = await mount(fake);
    await enter(t, "/quit");
    expect(fake.left()).toBe(1);
    expect(fake.submitted).toEqual([]);
  });

  test("the GM's Ctrl-C asks first while players are here; a second one leaves", async () => {
    const fake = fakeView({ me: "gm", present: [gm, alice] });
    const t = await mount(fake);
    t.mockInput.pressCtrlC();
    expect(await settle(t)).toContain("Ctrl-C again");
    expect(fake.left()).toBe(0);
    t.mockInput.pressCtrlC();
    await settle(t);
    expect(fake.left()).toBe(1);
  });

  test("typing after the GM's first Ctrl-C calls it off", async () => {
    const fake = fakeView({ me: "gm", present: [gm, alice] });
    const t = await mount(fake);
    t.mockInput.pressCtrlC();
    await settle(t);
    await t.mockInput.typeText("x");
    t.mockInput.pressCtrlC();
    expect(await settle(t)).toContain("Ctrl-C again");
    expect(fake.left()).toBe(0);
  });

  test("a GM alone at the table leaves on the first Ctrl-C", async () => {
    const fake = fakeView({ me: "gm", present: [gm] });
    const t = await mount(fake);
    t.mockInput.pressCtrlC();
    await settle(t);
    expect(fake.left()).toBe(1);
  });

  test("/state on the GM's seat toggles a pane with view.debug(), without sending anything", async () => {
    const fake = fakeView({ me: "gm", debug: '{ "seq": 42, "names": {} }' });
    const t = await mount(fake);
    const open = await enter(t, "/state");
    expect(open).toContain("/state");
    expect(open).toContain('{ "seq": 42, "names": {} }');
    expect(await enter(t, "/state")).not.toContain('"seq": 42');
    expect(fake.submitted).toEqual([]);
  });
});

describe("scrolling", () => {
  test("the feed shows the newest lines, and PgUp/PgDn page through older ones", async () => {
    const lines = Array.from({ length: 60 }, (_, i) => line(i + 1, "Bob", `message ${i + 1}`));
    const fake = fakeView({ myName: "Alice", feed: lines });
    const t = await mount(fake, 80, 24);
    expect(t.captureCharFrame()).toContain("message 60");
    t.mockInput.pressKey("\x1b[5~");
    expect(await settle(t)).not.toContain("message 60");
    t.mockInput.pressKey("\x1b[6~");
    t.mockInput.pressKey("\x1b[6~");
    expect(await settle(t)).toContain("message 60");
  });

  test("the mouse wheel scrolls the feed too", async () => {
    const lines = Array.from({ length: 60 }, (_, i) => line(i + 1, "Bob", `message ${i + 1}`));
    const fake = fakeView({ myName: "Alice", feed: lines });
    const t = await mount(fake, 80, 24);
    for (let i = 0; i < 5; i++) await t.mockMouse.scroll(20, 10, "up");
    expect(await settle(t)).not.toContain("message 60");
  });

  test("new lines arrive at the bottom of the feed", async () => {
    const fake = fakeView({ myName: "Alice", feed: [line(1, "Bob", "old news")] });
    const t = await mount(fake, 80, 24);
    fake.setFeed([line(1, "Bob", "old news"), line(2, "Oscar", "fresh news")]);
    const frame = await settle(t);
    expect(frame.indexOf("fresh news")).toBeGreaterThan(frame.indexOf("old news"));
  });
});

describe("the Draw Steel band", () => {
  const crowd = fight([vex, spearmen, brakka, ogre, sera, sniper, ...goblins(40)]);
  const feed = Array.from({ length: 40 }, (_, i) => line(i + 1, "Bob", `message ${i + 1}`));

  /** The band's height: its top border (row 1, under the header) down to its bottom border. */
  const bandHeight = (rows: ReadonlyArray<string>) =>
    rows.findIndex((r, i) => i > 1 && r.startsWith("└"));

  for (const [width, height] of [
    [100, 30],
    [80, 24],
  ] as const) {
    test(`at ${width}x${height} a full band leaves the feed, the hint and the input on screen`, async () => {
      const fake = fakeView({ myName: "Alice", present: [gm, alice], feed, combat: crowd });
      const t = await mount(fake, width, height);
      const frame = t.captureCharFrame();
      const rows = rowsOf(frame);
      expect(rows).toHaveLength(height);
      expect(rows[1]).toContain("round 2");
      // In combat the band may take two thirds of the screen; the feed keeps its three lines.
      expect(bandHeight(rows)).toBeLessThanOrEqual(Math.floor((height * 2) / 3));
      expect(frame).toMatch(/\+\d+ more/);
      expect(frame).toContain("message 40");
      expect(frame).toContain("message 38");
      expect(rows.at(-2)).toContain("Tab completes");
      expect(rows.at(-1)).toStartWith(" >");
    });
  }

  test("with a long reply open too, the band gives way and the feed and input stay", async () => {
    const sheet = Array.from({ length: 30 }, (_, i) => `sheet line ${i + 1}`).join("\n");
    const fake = fakeView({
      myName: "Alice",
      present: [gm, alice],
      feed,
      combat: crowd,
      reply: () => sheet,
    });
    const t = await mount(fake, 80, 24);
    const frame = await enter(t, "/sheet vex");
    const rows = rowsOf(frame);
    expect(rows).toHaveLength(24);
    expect(frame).toContain("sheet line 1");
    expect(frame).toContain("message 40");
    expect(frame).toContain("▶ Vex");
    expect(rows.at(-1)).toStartWith(" >");
  });

  test("a sheet open beside a full fight gives way to the band: every hero's numbers stay", async () => {
    const sheet = Array.from({ length: 30 }, (_, i) => `sheet line ${i + 1}`).join("\n");
    const heroes = [vex, brakka, sera].map((c) => ({ ...c, acting: false }));
    const crowded = fight([...heroes, ogre, spearmen, ...goblins(5)], { active: true });
    const fake = fakeView({
      myName: "Alice",
      present: [gm, alice],
      feed,
      combat: crowded,
      reply: () => sheet,
    });
    const t = await mount(fake, 100, 30);
    const frame = await enter(t, "/sheet ogre");
    expect(frame).toContain("sheet line 1");
    for (const part of [
      "Wrath 3",
      "recoveries 6/8",
      "recoveries 4/10",
      "bleeding (save)",
      "Insight 1",
    ])
      expect(frame).toContain(part);
    expect(frame).not.toMatch(/\+\d+ more/);
    expect(frame).toContain("message 40");
    expect(rowsOf(frame).at(-1)).toStartWith(" >");
  });

  test("a multi-line reply, like a sheet, is not a refusal: the line is not given back", async () => {
    const fake = fakeView({
      myName: "Alice",
      reply: (l) =>
        l === "/sheet vex" ? "Vex, level 1 Fury\nStamina 14/21" : "no hero called bob",
    });
    const t = await mount(fake);
    const frame = await enter(t, "/sheet vex");
    expect(frame).toContain("Vex, level 1 Fury");
    expect(frame).toContain("Stamina 14/21");
    expect(inputRow(t)).not.toContain("/sheet vex");
    t.mockInput.pressEscape();
    await new Promise((r) => setTimeout(r, 40));
    expect(await settle(t)).not.toContain("Vex, level 1 Fury");
    expect(await enter(t, "/sheet bob")).toContain("› no hero called bob");
    expect(inputRow(t)).toContain("> /sheet bob");
  });

  test("while the view has no party or combat the band shows who is here, until one starts", async () => {
    const fake = fakeView({ myName: "Alice", present: [gm, alice], combat: null });
    const t = await mount(fake);
    expect(t.captureCharFrame()).toContain("at the table");
    fake.setCombat(fight([vex, brakka], { active: false }));
    const frame = await settle(t);
    expect(frame).not.toContain("at the table");
    expect(frame).toContain("party");
    expect(frame).toContain("Brakka");
  });
});
