import { afterEach, describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { App } from "../../src/table/App.tsx";
import { color } from "../../src/table/theme.ts";
import {
  brakka,
  fight,
  ford,
  goblins,
  ogre,
  sampleFord,
  sampleFordMidFight,
  sera,
  showsStamina,
  sniper,
  spearmen,
  vex,
} from "./combat.ts";
import { alice, bob, fakeView, gm, line } from "./fakeView.ts";
import { courtyard, fordRoad, hall } from "./maps.ts";

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

  test("a long line in the pane wraps under where its text starts, not at the left edge", async () => {
    const help = [
      "Plain text is chat.",
      `/turn [who]      ${"Start a turn (your hero's, by default); the turn before ends. ".repeat(2).trim()}`,
      "  ≤11: a tier's text, indented, that runs long enough to need a second line at eighty",
    ];
    const fake = fakeView({ myName: "Alice", reply: () => help.join("\n") });
    const t = await mount(fake, 80, 24);
    const rows = rowsOf(await enter(t, "/help"));
    const turn = rows.findIndex((r) => r.includes("/turn [who]"));
    // The pane's border and padding take two columns: the summary starts at 17 inside it.
    const at = rows[turn]!.indexOf("Start");
    expect(rows[turn + 1]!.slice(0, at).trim()).toBe("│");
    expect(rows[turn + 1]![at]).not.toBe(" ");
    const tier = rows.findIndex((r) => r.includes("≤11"));
    const indent = rows[tier]!.indexOf("≤11");
    expect(rows[tier + 1]!.slice(0, indent).trim()).toBe("│");
    expect(rows[tier + 1]![indent]).not.toBe(" ");
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

  test("a refused line leaves the input empty, so the next line can't run into it; Up brings it back", async () => {
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
    expect(inputRow(t)).not.toContain("fireball");
    t.mockInput.pressArrow("up");
    await t.renderOnce();
    expect(inputRow(t)).toContain("> /roll fireball");
    t.mockInput.pressKey("u", { ctrl: true });
    await enter(t, "/roll 2d10");
    expect(fake.submitted).toEqual(["/roll fireball", "/roll 2d10"]);
    expect(await enter(t, "/help roll")).toContain("/roll <dice>  Roll dice.");
    expect(inputRow(t)).not.toContain("/help roll");
  });

  test("lines go to the host one at a time, in the order they were typed", async () => {
    let release: (() => void) | undefined;
    const fake = fakeView({
      myName: "Alice",
      reply: (l) =>
        l === "/hero brann" ? new Promise((done) => (release = () => done(undefined))) : undefined,
    });
    const t = await mount(fake);
    await enter(t, "/hero brann");
    await enter(t, "/play brann");
    expect(fake.submitted).toEqual(["/hero brann"]);
    release?.();
    await settle(t);
    expect(fake.submitted).toEqual(["/hero brann", "/play brann"]);
  });

  test("a bare help, exit or quit is a question first: Enter again says it to the table", async () => {
    const fake = fakeView({ myName: "Alice" });
    const t = await mount(fake);
    expect(await enter(t, "help")).toContain(
      '› Did you mean /help? Enter again to say "help" to the table.',
    );
    expect(fake.submitted).toEqual([]);
    expect(inputRow(t)).toContain("> help");
    t.mockInput.pressEnter();
    await settle(t);
    expect(fake.submitted).toEqual(["help"]);
    expect(await enter(t, "exit")).toContain(
      '› Did you mean /quit? Enter again to say "exit" to the table.',
    );
    expect(fake.left()).toBe(0);
  });

  test("Ctrl-D on an empty line leaves, as in a shell", async () => {
    const fake = fakeView({ myName: "Alice" });
    const t = await mount(fake);
    await t.mockInput.typeText("ab");
    t.mockInput.pressKey("a", { ctrl: true });
    t.mockInput.pressKey("d", { ctrl: true });
    await t.renderOnce();
    expect(inputRow(t)).toContain("> b");
    expect(fake.left()).toBe(0);
    t.mockInput.pressKey("u", { ctrl: true });
    t.mockInput.pressKey("e", { ctrl: true });
    t.mockInput.pressKey("u", { ctrl: true });
    t.mockInput.pressKey("d", { ctrl: true });
    await settle(t);
    expect(fake.left()).toBe(1);
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

  test("the GM sees the relay link's trouble in the header, party or fight on screen", async () => {
    const fake = fakeView({
      me: "gm",
      present: [gm, alice],
      combat: fight(ford),
      alert: "relay: down, redialing",
    });
    const t = await mount(fake, 80, 24);
    const top = () => rowsOf(t.captureCharFrame())[0]!;
    expect(top()).toContain("den · relay: down, redialing");
    expect(top()).toContain("here: Oscar (GM)");
    fake.setAlert(undefined);
    await settle(t);
    expect(top()).not.toContain("relay");
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
    // The line is empty again, so the next name isn't added to the refused one.
    expect(inputRow(t)).toBe(" what should the table call you?");
    await enter(t, "Vex");
    fake.setMyName("Vex");
    await settle(t);
    expect(inputRow(t)).toStartWith(" >");
    await enter(t, "hello");
    expect(fake.submitted).toEqual(["/name Oscar", "/name Vex", "hello"]);
  });

  test("at the name prompt, help and leaving words are answered, not taken as a name", async () => {
    const fake = fakeView({ myName: undefined, present: [alice] });
    const t = await mount(fake);
    expect(await enter(t, "help")).toContain(
      "› Type the name the table should call you, then Enter. /help lists the commands; Ctrl-C leaves.",
    );
    expect(await enter(t, "quit")).toContain(
      '› To leave, press Ctrl-C. To be called "quit", press Enter again.',
    );
    expect(fake.submitted).toEqual([]);
    t.mockInput.pressEnter();
    await settle(t);
    expect(fake.submitted).toEqual(["/name quit"]);
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

  test("at 80x24 a sheet beside the twelve-combatant fight gets a usable pane, paid for by creatures", async () => {
    const sheet = Array.from({ length: 15 }, (_, i) => `sheet line ${i + 1}`).join("\n");
    const fake = fakeView({
      myName: "Alice",
      present: [gm, alice],
      feed,
      combat: fight(ford),
      reply: () => sheet,
    });
    const t = await mount(fake, 80, 24);
    const frame = await enter(t, "/sheet brann");
    const rows = rowsOf(frame);
    expect(rows).toHaveLength(24);
    // The pane, border to border: at least 7 rows, since the four heroes' rows (five lines, one
    // wrapped, their Recoveries gone) and the one acting are what the band keeps.
    const top = rows.findIndex((r) => r.includes("just for you"));
    const bottom = rows.findIndex((r, i) => i > top && r.startsWith("└"));
    expect(bottom - top + 1).toBeGreaterThanOrEqual(7);
    expect(frame).toContain("sheet line 1");
    expect(frame).toContain("sheet line 5");
    // Every hero row stays whole but for its Recoveries, which the sheet has.
    for (const part of [
      "wrath 3",
      "ferocity 4",
      "1 surge",
      "weakened (save)",
      "focus 1",
      "dying (dead at -10)",
      "bleeding",
      "dazed (save)",
      "insight 0",
    ])
      expect(frame).toContain(part);
    // Creatures fold into "+N more", and only creatures: shown plus hidden is all eight of them.
    const band = rows.slice(0, top).join("\n");
    const more = /\+(\d+) more/.exec(band);
    expect(more).not.toBeNull();
    const creatures = ["Chief", "Bruiser 1", "Bruiser 2", "Bruiser 3", "Bruiser 4", "Bruiser 5"];
    const dead = ["Cutpurse A", "Slinger A"];
    const shown = [...creatures, ...dead].filter((name) => band.includes(name)).length;
    expect(shown + Number(more?.[1])).toBe(8);
    // The one acting stays.
    expect(band).toContain("▶");
    expect(frame).toContain("message 40");
    expect(rows.at(-1)).toStartWith(" >");
  });

  test("closing the pane gives the band back its creatures", async () => {
    const sheet = Array.from({ length: 15 }, (_, i) => `sheet line ${i + 1}`).join("\n");
    const fake = fakeView({
      myName: "Alice",
      present: [gm, alice],
      feed,
      combat: fight(ford),
      reply: () => sheet,
    });
    const t = await mount(fake, 80, 24);
    await enter(t, "/sheet brann");
    t.mockInput.pressEscape();
    await new Promise((r) => setTimeout(r, 40));
    const frame = await settle(t);
    expect(frame).not.toContain("sheet line 1");
    for (const n of [1, 2, 3, 4, 5]) expect(frame).toContain(`Bruiser ${n} `);
    expect(frame).not.toMatch(/\+\d+ more/);
  });

  test("a multi-line reply, like a sheet, opens the pane, and a refusal one line, neither giving the line back", async () => {
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
    expect(inputRow(t)).not.toContain("/sheet bob");
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

describe("below the smallest seat, 80x24", () => {
  for (const [width, height] of [
    [79, 24],
    [80, 23],
    [60, 16],
  ] as const) {
    test(`at ${width}x${height} one line asks to widen the terminal, and the input still works`, async () => {
      const fake = fakeView({
        myName: "Alice",
        present: [gm, alice],
        feed: [line(1, "Bob", "anyone there?")],
        combat: fight(ford),
      });
      const t = await mount(fake, width, height);
      const frame = t.captureCharFrame();
      const rows = rowsOf(frame);
      expect(rows.filter((r) => r.includes("widen your terminal to 80x24"))).toHaveLength(1);
      expect(frame).not.toContain("round 2");
      expect(frame).not.toContain("▐");
      expect(frame).toContain("Bob: anyone there?");
      expect(rows.at(-1)).toStartWith(" >");
      await enter(t, "hello");
      expect(fake.submitted).toEqual(["hello"]);
    });
  }

  test("at 80x24 there is no notice, and the band is back", async () => {
    const fake = fakeView({ myName: "Alice", present: [gm, alice], combat: fight(ford) });
    const t = await mount(fake, 80, 24);
    const frame = t.captureCharFrame();
    expect(frame).not.toContain("widen your terminal");
    expect(frame).toContain("round 2");
  });
});

describe("the map", () => {
  const feed = Array.from({ length: 40 }, (_, i) => line(i + 1, "Bob", `message ${i + 1}`));
  const seated = (more: Parameters<typeof fakeView>[0] = {}) =>
    fakeView({ myName: "Alice", present: [gm, alice], feed, combat: fight(ford), ...more });

  /** A bordered box's height, from the top border row whose title has `title` to its bottom border. */
  const boxHeight = (rows: ReadonlyArray<string>, title: string) => {
    const top = rows.findIndex((r) => r.startsWith("┌") && r.includes(title));
    if (top < 0) return 0;
    return rows.findIndex((r, i) => i > top && r.startsWith("└")) - top + 1;
  };

  for (const [width, height] of [
    [100, 30],
    [80, 24],
  ] as const) {
    test(`at ${width}x${height} band, map, feed and input are all on screen, the feed at least 5 rows`, async () => {
      const t = await mount(seated({ map: courtyard }), width, height);
      const rows = rowsOf(t.captureCharFrame());
      expect(rows).toHaveLength(height);
      expect(rows[1]).toContain("round 2");
      const band = rows.findIndex((r) => r.includes("round 2"));
      const map = rows.findIndex((r) => r.includes("map · Courtyard"));
      const feedTop = rows.findIndex((r) => r.startsWith("┌") && r.includes(" feed "));
      expect(band).toBeLessThan(map);
      expect(map).toBeLessThan(feedTop);
      // The map shows the acting token and its letters and numbers.
      const mapRows = rows.slice(map, feedTop).join("\n");
      expect(mapRows).toContain("V");
      expect(mapRows).toMatch(/ a b c /);
      expect(boxHeight(rows, " feed ")).toBeGreaterThanOrEqual(5);
      for (const n of [38, 39, 40]) expect(rows.join("\n")).toContain(`message ${n}`);
      expect(rows.at(-1)).toStartWith(" >");
    });
  }

  for (const [when, roster] of [
    ["healthy", sampleFord],
    ["mid-fight", sampleFordMidFight],
  ] as const) {
    test(`at 80x24 the sample fight ${when} beside The Ford Road: every living combatant's Stamina shows, the feed keeps 3 rows`, async () => {
      const t = await mount(seated({ map: fordRoad, combat: fight(roster) }), 80, 24);
      const rows = rowsOf(t.captureCharFrame());
      expect(rows).toHaveLength(24);
      const bandTop = rows.findIndex((r) => r.includes("round 2"));
      const bandEnd = rows.findIndex((r, i) => i > bandTop && r.startsWith("└"));
      const band = rows.slice(bandTop, bandEnd + 1).join("\n");
      const living = roster.filter((c) => c.health !== "dead");
      for (const c of living) expect(showsStamina(band, c)).toBe(true);
      // Only the dead may be counted in `+N more`.
      expect(Number(/\+(\d+) more/.exec(band)?.[1] ?? 0)).toBeLessThanOrEqual(
        roster.length - living.length,
      );
      // Each hero on one row: every line inside the band holds a meter or the dead.
      for (const r of rows.slice(bandTop + 1, bandEnd)) expect(r).toMatch(/▐|dead:/);
      expect(boxHeight(rows, " feed ")).toBeGreaterThanOrEqual(5);
      expect(rows.join("\n")).toContain("message 40");
      expect(rows.at(-1)).toStartWith(" >");
      // The map gave up rows, not the enemies: /view map shows it whole.
      expect(rows.join("\n")).toContain("map · The Ford Road");
      expect(rows.at(-2)).toContain("/help");
    });
  }

  test("at 100x30 the courtyard fits whole with the band beside it", async () => {
    const t = await mount(seated({ map: courtyard, combat: fight([]) }), 100, 30);
    const rows = rowsOf(t.captureCharFrame());
    // Twelve rows, the letters and the border: fifteen.
    expect(boxHeight(rows, "map · Courtyard")).toBe(15);
    expect(rows.join("\n")).toContain("12 ");
  });

  test("the reach label leads the hint row, on the reach tint, and the rest still fits 80 columns", async () => {
    for (const [width, height] of [
      [100, 30],
      [80, 24],
    ] as const) {
      const t = await mount(seated({ map: courtyard }), width, height);
      const hint = rowsOf(t.captureCharFrame()).at(-2) ?? "";
      expect(hint).toStartWith(" Vex can reach: speed 5 · ");
      expect(hint).toEndWith("/help · Ctrl-C leaves");
      expect(hint).not.toContain("...");
      const label = t
        .captureSpans()
        .lines.at(-2)
        ?.spans.find((s) => s.text.includes("Vex can reach"));
      expect(label?.bg.equals(RGBA.fromHex(color.reach))).toBe(true);
      setup?.renderer.destroy();
      setup = undefined;
    }
  });

  test("without a map, or before one is loaded, the layout is today's", async () => {
    for (const [width, height] of [
      [100, 30],
      [80, 24],
    ] as const) {
      const before = (await mount(seated(), width, height)).captureCharFrame();
      setup?.renderer.destroy();
      const empty = (await mount(seated({ map: null }), width, height)).captureCharFrame();
      expect(empty).toBe(before);
      expect(empty).not.toContain("map ·");
      expect(rowsOf(empty).at(-2)).toContain("Tab completes");
      setup?.renderer.destroy();
      setup = undefined;
    }
  });

  test("a map the host loads appears; one it clears goes", async () => {
    const fake = seated({ map: null });
    const t = await mount(fake, 100, 30);
    fake.setMap(courtyard);
    expect(await settle(t)).toContain("map · Courtyard");
    fake.setMap(undefined);
    expect(await settle(t)).not.toContain("map · Courtyard");
  });

  test("/view feed hides it, /view map gives it the room, /view both shares; none is sent", async () => {
    const fake = seated({ map: hall() });
    const t = await mount(fake, 100, 30);
    const shared = boxHeight(rowsOf(t.captureCharFrame()), "map · Great hall");
    expect(shared).toBeGreaterThan(0);

    let rows = rowsOf(await enter(t, "/view feed"));
    expect(boxHeight(rows, "map · Great hall")).toBe(0);
    expect(boxHeight(rows, " feed ")).toBeGreaterThan(5);

    rows = rowsOf(await enter(t, "/view map"));
    const big = boxHeight(rows, "map · Great hall");
    expect(big).toBeGreaterThan(shared);
    expect(boxHeight(rows, " feed ")).toBe(5);
    expect(rows[1]).toContain("round 2");
    expect(rows.at(-1)).toStartWith(" >");

    rows = rowsOf(await enter(t, "/view both"));
    expect(boxHeight(rows, "map · Great hall")).toBe(shared);
    expect(fake.submitted).toEqual([]);
  });

  test("/view alone shows or hides the map; anything else says how", async () => {
    const fake = seated({ map: courtyard });
    const t = await mount(fake);
    expect(await enter(t, "/view")).not.toContain("map · Courtyard");
    expect(await enter(t, "/view")).toContain("map · Courtyard");
    expect(await enter(t, "/view sideways")).toContain(
      "› No token on the map is called 'sideways'; /view <square|who>, or map, feed or both",
    );
    expect(fake.submitted).toEqual([]);
  });

  test("Tab completes /view beside the host's completions", async () => {
    const fake = seated({ map: courtyard, complete: () => [] });
    const t = await mount(fake);
    await t.mockInput.typeText("/view m");
    t.mockInput.pressTab();
    await t.renderOnce();
    expect(inputRow(t)).toContain("> /view map");
  });

  test("a long reply puts the map away while it is open, and Esc brings it back", async () => {
    const sheet = Array.from({ length: 30 }, (_, i) => `sheet line ${i + 1}`).join("\n");
    const fake = seated({ map: courtyard, reply: () => sheet });
    const t = await mount(fake, 80, 24);
    let frame = await enter(t, "/sheet vex");
    expect(frame).toContain("sheet line 1");
    expect(frame).not.toContain("map · Courtyard");
    expect(frame).toContain("message 40");
    expect(rowsOf(frame).at(-1)).toStartWith(" >");
    t.mockInput.pressEscape();
    await new Promise((r) => setTimeout(r, 40));
    frame = await settle(t);
    expect(frame).toContain("map · Courtyard");
  });

  test("/view <who> or <square> centres the map there until the turn passes; none is sent", async () => {
    const fake = seated({ map: hall() });
    const t = await mount(fake, 100, 30);
    // Vex acts at aj26, so the view starts round there, far from Brakka at c4.
    expect(rowsOf(t.captureCharFrame()).some((r) => / 4 [·x ]+B /.test(r))).toBe(false);
    let rows = rowsOf(await enter(t, "/view brakka"));
    expect(rows.some((r) => r.includes(" 4 · · B "))).toBe(true);
    rows = rowsOf(await enter(t, "/view a1"));
    expect(rows.some((r) => r.includes(" 1 x "))).toBe(true);
    expect(await enter(t, "/view nobody")).toContain(
      "› No token on the map is called 'nobody'; /view <square|who>, or map, feed or both",
    );
    rows = rowsOf(await enter(t, "/view B"));
    expect(rows.some((r) => r.includes(" 4 · · B "))).toBe(true);
    // The turn passes to the ogre at k26: the view follows it again.
    fake.setMap(hall({ acting: "ogre" }));
    rows = rowsOf(await settle(t));
    expect(rows.some((r) => r.startsWith("│") && r.includes("26 ") && r.includes(" O "))).toBe(
      true,
    );
    expect(fake.submitted).toEqual([]);
  });

  test("at 80x24, /view map folds the band to two lines so the map gets the rows", async () => {
    const fake = seated({ map: courtyard });
    const t = await mount(fake, 80, 24);
    const rows = rowsOf(await enter(t, "/view map"));
    // The courtyard wants 15 rows; 24 less header, hint, input, the feed's 5 and a band of 4.
    expect(boxHeight(rows, "map · Courtyard")).toBe(12);
    expect(rows[1]).toContain("round 2");
    expect(boxHeight(rows, " feed ")).toBe(5);
  });

  test("a long reach label keeps the hint row whole: the keys give way, never the label", async () => {
    const label = "Bandit Bruiser 2 can reach: 3 of speed 5 left, main action spent";
    const t = await mount(seated({ map: { ...courtyard, reachLabel: label } }), 80, 24);
    expect(rowsOf(t.captureCharFrame()).at(-2)).toBe(` ${label}`);
    setup?.renderer.destroy();
    const short = "Bandit Bruiser 2 can reach: speed 5";
    const u = await mount(seated({ map: { ...courtyard, reachLabel: short } }), 80, 24);
    expect(rowsOf(u.captureCharFrame()).at(-2)).toBe(` ${short} · /view · /help`);
  });

  test("at 80x24 beside a full band, a reach that doesn't fit points at /view map", async () => {
    const reach = Array.from({ length: 12 * 16 }, (_, i) => ({
      x: i % 16,
      y: Math.floor(i / 16),
    })).filter(({ x, y }) => Math.abs(x - 3) + Math.abs(y - 3) <= 5);
    const crowd = fight([vex, spearmen, brakka, ogre, sera, sniper, ...goblins(40)]);
    const fake = seated({ map: { ...courtyard, reach }, combat: crowd });
    const t = await mount(fake, 80, 24);
    expect(rowsOf(t.captureCharFrame()).at(-2)).toBe(
      " Vex can reach: speed 5 · /view map to see all your reach",
    );
    // With the map given the room, the reach shows whole and the keys come back.
    const rows = rowsOf(await enter(t, "/view map"));
    expect(rows.at(-2)).toBe(
      " Vex can reach: speed 5 · Tab completes · /view · /help · Ctrl-C leaves",
    );
    setup?.renderer.destroy();
    // Someone else's reach: the hint doesn't call it yours.
    const goblin = {
      ...courtyard,
      reach,
      tokens: courtyard.tokens.map((k) => ({ ...k, acting: false })),
      reachLabel: "Goblin can reach: speed 5",
    };
    goblin.tokens.push({
      ...courtyard.tokens[1]!,
      id: "goblin",
      mark: "g",
      x: 3,
      y: 3,
      acting: true,
    });
    goblin.tokens[0] = { ...goblin.tokens[0]!, x: 0, y: 11 };
    const u = await mount(seated({ map: goblin, combat: crowd }), 80, 24);
    expect(rowsOf(u.captureCharFrame()).at(-2)).toBe(
      " Goblin can reach: speed 5 · /view map to see all of it",
    );
  });

  test("below the smallest seat the map gives way like the band", async () => {
    const t = await mount(seated({ map: courtyard }), 79, 24);
    const frame = t.captureCharFrame();
    expect(frame).toContain("widen your terminal");
    expect(frame).not.toContain("map · Courtyard");
  });
});
