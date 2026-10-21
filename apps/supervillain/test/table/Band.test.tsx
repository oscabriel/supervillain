import { afterEach, describe, expect, test } from "bun:test";
import { TextAttributes } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { Band } from "../../src/table/Band.tsx";
import type { CombatView } from "../../src/table/view.ts";
import { brakka, combatant, fight, goblins, ogre, sera, sniper, spearmen, vex } from "./combat.ts";
import { alice, gm } from "./fakeView.ts";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

/** Mounts the band alone at the top of a screen, given at most `maxHeight` rows as the App does. */
async function mount(
  combat: CombatView | undefined,
  width: number,
  height: number,
  maxHeight = Math.floor(height / 2),
) {
  setup = await testRender(
    () => <Band me={alice.actor} present={[gm, alice]} combat={combat} maxHeight={maxHeight} />,
    { width, height },
  );
  await setup.renderOnce();
  return setup;
}

/** The band's rows: from its top border down to its bottom border. */
function bandRows(t: Setup): ReadonlyArray<string> {
  const rows = t
    .captureCharFrame()
    .split("\n")
    .map((r) => r.trimEnd());
  const bottom = rows.findIndex((r, i) => i > 0 && r.startsWith("└"));
  return rows.slice(0, bottom + 1);
}

const rowWith = (rows: ReadonlyArray<string>, text: string) =>
  rows.find((r) => r.includes(text)) ?? "";

const party = [vex, spearmen, brakka, ogre, sera, sniper];

describe("in combat", () => {
  test("at 100x30 the title has the round, the side next, Malice and hero tokens", async () => {
    const t = await mount(fight(party), 100, 30);
    const top = bandRows(t)[0];
    expect(top).toContain("round 2");
    expect(top).toContain("director next");
    expect(top).toContain("Malice 5");
    expect(top).toContain("hero tokens 2");
  });

  test("at 100x30 each combatant has one row, in turn order, with its meter and numbers", async () => {
    const t = await mount(fight(party), 100, 30);
    const rows = bandRows(t);
    const mine = rowWith(rows, "Vex");
    // 14 of 21 is two thirds: four of the six cells.
    expect(mine).toContain("▶");
    expect(mine).toContain("▐████░░▌ 14/21 +5");
    for (const part of ["slowed (EoT)", "Wrath 3", "recoveries 6/8", "2 surges"])
      expect(mine).toContain(part);

    const winded = rowWith(rows, "Brakka");
    expect(winded).toContain("✓");
    expect(winded).toContain("▐██░░░░▌  8/24");
    expect(winded).toContain("winded");
    expect(winded).toContain("recoveries 4/10");

    const dying = rowWith(rows, "Sera");
    expect(dying).toContain("▐░░░░░░▌ -3/18");
    expect(dying).toContain("dying");
    expect(dying).toContain("bleeding (save)");

    const squad = rowWith(rows, "Goblin Spearmen x3");
    expect(squad).toContain("✓");
    expect(squad).toContain("▐█████░▌ 12/15");

    expect(rowWith(rows, "Ogre")).toContain("▐███░░░▌ 40/76");
    expect(rowWith(rows, "Goblin Sniper")).toContain("dead");

    const order = ["Vex", "Spearmen", "Brakka", "Ogre", "Sera", "Sniper"].map((n) =>
      rows.findIndex((r) => r.includes(n)),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(order.length);
  });

  test("any Stamina above 0 shows at least one cell of the meter", async () => {
    const t = await mount(
      fight([combatant({ id: "rat", name: "Rat", stamina: 1, max: 21 })]),
      100,
      30,
    );
    expect(rowWith(bandRows(t), "Rat")).toContain("▐█░░░░░▌ 1/21");
  });

  test("at 80x24 every combatant's whole state is still on screen", async () => {
    const t = await mount(fight(party), 80, 24);
    const band = bandRows(t).join("\n");
    expect(bandRows(t).length).toBeLessThanOrEqual(12);
    for (const part of [
      "round 2",
      "Malice 5",
      "▐████░░▌ 14/21 +5",
      "slowed (EoT)",
      "Wrath 3",
      "recoveries 6/8",
      "2 surges",
      "winded",
      "dying",
      "bleeding (save)",
      "Goblin Spearmen x3",
      "dead",
    ])
      expect(band).toContain(part);
    expect(band).not.toContain("more");
  });

  test("at 80x24 ten combatants fit with nothing cut: short rows pair up, long ones take the width", async () => {
    const t = await mount(fight([...party, ...goblins(4)]), 80, 24);
    const rows = bandRows(t);
    const band = rows.join("\n");
    expect(rows.length).toBeLessThanOrEqual(12);
    for (const part of [
      "slowed (EoT)",
      "2 surges",
      "recoveries 4/10",
      "bleeding (save)",
      "Goblin 4",
    ])
      expect(band).toContain(part);
    expect(band).not.toContain("…");
    expect(band).not.toContain("more");
    expect(rowWith(rows, "Goblin 1 ")).toMatch(/Goblin \d+ .*Goblin \d+ /);
  });

  test("the seat's own hero is highlighted: bold, on its own background", async () => {
    const t = await mount(fight(party), 100, 30);
    const spans = t.captureSpans().lines.flatMap((l) => l.spans);
    const mine = spans.find((s) => s.text.includes("Vex"));
    const other = spans.find((s) => s.text.includes("Brakka"));
    expect(mine).toBeDefined();
    expect(other).toBeDefined();
    expect((mine?.attributes ?? 0) & TextAttributes.BOLD).toBeTruthy();
    expect(mine?.bg.equals(other!.bg)).toBe(false);
  });

  test("short rows go two to a row when the band is wide enough", async () => {
    const t = await mount(fight(goblins(6)), 100, 30);
    const rows = bandRows(t);
    expect(rowWith(rows, "Goblin 1")).toContain("Goblin 2");
    expect(rowWith(rows, "Goblin 5")).toContain("Goblin 6");
  });

  test("fourteen at 80x24: everyone still shows, long rows cut with … rather than hidden", async () => {
    const t = await mount(fight([...party, ...goblins(8)]), 80, 24);
    const rows = bandRows(t);
    const band = rows.join("\n");
    expect(rows.length).toBeLessThanOrEqual(12);
    for (const name of ["Vex", "Spearmen", "Brakka", "Ogre", "Sera", "Sniper", "Goblin 8"])
      expect(band).toContain(name);
    expect(rowWith(rows, "Vex")).toContain("slowed (EoT)");
    expect(rowWith(rows, "Vex")).toMatch(/ …\s*│$/);
    expect(band).not.toContain("more");
  });

  test("however tight the band, winded, dying and dead are spelled out, never colour alone", async () => {
    const t = await mount(fight([...party, ...goblins(30)]), 80, 24, 8);
    const rows = bandRows(t);
    expect(rows.join("\n")).toMatch(/\+\d+ more/);
    expect(rowWith(rows, "Brakka")).toContain("winded");
    expect(rowWith(rows, "Sera")).toContain("dying");
  });

  test("rows too long for half the width keep one combatant each", async () => {
    const t = await mount(fight(party), 80, 24);
    expect(rowWith(bandRows(t), "Vex")).not.toContain("Brakka");
  });

  test("too many to fit: the band keeps its height and says how many more, never clipping silently", async () => {
    const many = [...goblins(15), vex, ...goblins(25).slice(15)];
    const t = await mount(fight(many), 80, 24, 8);
    const rows = bandRows(t);
    expect(rows.length).toBeLessThanOrEqual(8);
    const more = /\+(\d+) more/.exec(rows.join("\n"));
    expect(more).not.toBeNull();
    const shown = (rows.join("\n").match(/Goblin \d+/g) ?? []).length + 1;
    expect(shown + Number(more?.[1])).toBe(many.length);
    // The one acting is never the one left out.
    expect(rowWith(rows, "Vex")).toContain("▶");
  });
});

/** The fight at the ford as the GM saw it at round 3: four heroes, two dead squads, the chief and five bruisers. */
const ford = [
  combatant({
    id: "brann",
    name: "Brann (Alice)",
    side: "heroes",
    stamina: 8,
    max: 24,
    health: "winded",
    resource: "wrath 3",
    recoveries: { left: 12, max: 12 },
    acted: true,
  }),
  combatant({
    id: "kesh",
    name: "Kesh (Bob)",
    side: "heroes",
    stamina: 16,
    max: 24,
    resource: "ferocity 4",
    recoveries: { left: 10, max: 10 },
    surges: 1,
    acted: true,
  }),
  combatant({
    id: "ilsa",
    name: "Ilsa (Dan)",
    side: "heroes",
    stamina: 7,
    max: 24,
    health: "winded",
    conditions: ["weakened (save)"],
    resource: "focus 1",
    recoveries: { left: 9, max: 10 },
  }),
  combatant({
    id: "wren",
    name: "Wren (Cara)",
    side: "heroes",
    stamina: -7,
    max: 21,
    health: "dying",
    deadAt: -10,
    conditions: ["bleeding", "dazed (save)"],
    resource: "insight 0",
    recoveries: { left: 8, max: 8 },
  }),
  combatant({
    id: "bandit-cutpurse-a",
    name: "Bandit Cutpurse A",
    stamina: 0,
    max: 20,
    count: 0,
    health: "dead",
  }),
  combatant({
    id: "bandit-slinger-a",
    name: "Bandit Slinger A",
    stamina: 0,
    max: 20,
    count: 0,
    health: "dead",
  }),
  combatant({ id: "bandit-chief", name: "Bandit Chief", stamina: 60, max: 80, acting: true }),
  ...[1, 2, 3, 4, 5].map((n) =>
    combatant({
      id: `bandit-bruiser-${n}`,
      name: `Bandit Bruiser ${n}`,
      stamina: 7 + n,
      max: 20,
      health: "winded",
    }),
  ),
];

describe("a full fight in a small band", () => {
  test("at 80x24 every hero keeps its numbers, every creature its own name, and the dead fold into one line", async () => {
    const t = await mount(fight(ford), 80, 24);
    const rows = bandRows(t);
    const band = rows.join("\n");
    expect(rows.length).toBeLessThanOrEqual(12);
    for (const part of [
      "wrath 3",
      "recoveries 12/12",
      "ferocity 4",
      "1 surge",
      "weakened (save)",
      "focus 1",
      "recoveries 9/10",
      "dying (dead at -10)",
      "bleeding",
      "dazed (save)",
      "insight 0",
      "recoveries 8/8",
    ])
      expect(band).toContain(part);
    for (const n of [1, 2, 3, 4, 5]) expect(band).toContain(`Bruiser ${n} `);
    expect(band).toContain("Chief");
    expect(rowWith(rows, "dead:")).toContain("Bandit Cutpurse A");
    expect(rowWith(rows, "dead:")).toContain("Bandit Slinger A");
    expect(band).not.toContain("x0");
    expect(band).not.toContain("more");
  });

  test("narrowed names share one width, so every meter on a row starts in the same column", async () => {
    const t = await mount(fight(ford), 80, 24);
    const meters = bandRows(t)
      .filter((r) => r.includes("▐"))
      .flatMap((r) => [...r.matchAll(/▐/g)].map((m) => m.index));
    expect(new Set(meters.filter((i) => i < 40)).size).toBe(1);
  });

  test("squads keep their letter when their names are cut", async () => {
    const squads = ["A", "B", "C", "D", "E", "F"].map((l) =>
      combatant({
        id: `bandit-cutpurse-${l}`,
        name: `Bandit Cutpurse ${l}`,
        stamina: 20,
        max: 20,
        count: 4,
      }),
    );
    const t = await mount(fight([...ford.slice(0, 4), ...squads]), 80, 24, 9);
    const band = bandRows(t).join("\n");
    for (const l of ["A", "B", "C", "D", "E", "F"]) expect(band).toContain(`${l} x4`);
  });

  test("at 100x30 a squad's whole name fits", async () => {
    const t = await mount(
      fight([combatant({ id: "c", name: "Bandit Cutpurse A", stamina: 20, max: 20, count: 4 })]),
      100,
      30,
    );
    expect(bandRows(t).join("\n")).toContain("Bandit Cutpurse A x4");
  });

  test("in a band 44 columns wide, a long name gives way before the numbers and the health word", async () => {
    const dying = [1, 2, 3, 4].map((n) =>
      combatant({
        id: `brann-${n}`,
        name: n % 2 === 0 ? "Goblin Spinecleaver Captain" : "Brann (Alice the Magnificent)",
        side: n % 2 === 0 ? "director" : "heroes",
        stamina: -5,
        max: 120,
        temp: 15,
        count: n % 2 === 0 ? 3 : undefined,
        health: "dying",
      }),
    );
    const t = await mount(fight(dying), 44, 24, 7);
    const rows = bandRows(t).filter((r) => r.includes("▐"));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r).toContain("-5/120");
      expect(r).toContain("dying");
    }
  });
});

describe("outside combat", () => {
  test("the band shows the party, compactly: heroes only, no round, no Malice, no turn markers", async () => {
    const t = await mount(fight([vex, ogre, brakka], { active: false, next: undefined }), 100, 30);
    const rows = bandRows(t);
    const band = rows.join("\n");
    expect(rows[0]).toContain("party");
    expect(rows[0]).toContain("hero tokens 2");
    expect(band).toContain("Vex");
    expect(band).toContain("Brakka");
    expect(band).not.toContain("Ogre");
    expect(band).not.toContain("round");
    expect(band).not.toContain("Malice");
    expect(band).not.toContain("▶");
    expect(rows.length).toBeLessThanOrEqual(4);
  });

  test("a party with no heroes yet says so", async () => {
    const t = await mount(fight([], { active: false }), 100, 30);
    expect(bandRows(t).join("\n")).toContain("no heroes yet");
  });

  test("without a combat view the band shows who is at the table", async () => {
    const t = await mount(undefined, 100, 30);
    const band = bandRows(t).join("\n");
    expect(band).toContain("at the table");
    expect(band).toContain("Alice (you)");
  });
});
