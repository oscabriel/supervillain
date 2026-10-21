import { describe, expect, test } from "bun:test";
import { ALICE, BOB, fixedDice, GM, GOBLIN, party, RUNNER, Table } from "./harness.ts";

/** Vex (Alice) and Kor against a goblin warrior and a squad of four runners, the heroes first. */
function fight(): Table {
  const t = party();
  t.run(GM, { type: "add", monster: "goblin-warrior", count: 1, sheet: GOBLIN });
  t.run(GM, { type: "add", monster: "goblin-runner", count: 4, sheet: RUNNER });
  t.run(GM, { type: "start" }, fixedDice(8));
  t.run(GM, { type: "first", side: "heroes" });
  return t;
}

describe("starting a combat", () => {
  test("a d10 of 6+ lets the players pick; heroes gain resource from Victories; Malice from Victories and round 1", () => {
    const t = party();
    t.run(GM, { type: "start" }, fixedDice(7));
    expect(t.envelopes.at(-1)).toMatchObject({
      type: "ds.combat-started",
      payload: {
        roll: 7,
        gains: { vex: 2, kor: 2 },
        malice: { victories: 2, heroes: 2, round: 1 },
      },
    });
    expect(t.ds.malice).toBe(5);
    expect(t.hero("vex").resource).toBe(2);
    expect(t.hero("kor").resource).toBe(2);
    expect(t.ds.combat).toMatchObject({ active: true, round: 1, roll: 7 });
    expect(t.lastFeed()).toEqual([
      "Combat begins, round 1. d10: 7, so the players pick who goes first, and the GM types /first heroes or /first director. Malice +5 (2 for Victories, 2 heroes, round 1) → 5. Vex +2 Wrath, Kor +2 Ferocity. The party has no hero tokens; /token reset gives one per hero.",
    ]);
    expect(t.submit(GM, { type: "start" })).toBe("A combat is already running; /end it first.");
    // With tokens to spend, nothing more is said.
    t.run(GM, { type: "end" });
    t.run(GM, { type: "token", change: "reset" });
    t.run(GM, { type: "start" }, fixedDice(7));
    expect(t.lastFeed()[0]).not.toContain("hero tokens");
  });

  test("below 6 the Director picks; Malice from average Victories rounds down", () => {
    const t = party();
    t.run(GM, { type: "victory", who: "kor", by: 1 });
    t.run(GM, { type: "start" }, fixedDice(5));
    // Victories 2 and 3: average 2.5, rounded down to 2.
    expect(t.ds.malice).toBe(5);
    expect(t.hero("kor").resource).toBe(3);
    expect(t.lastFeed()[0]).toStartWith("Combat begins, round 1. d10: 5, so the Director picks");
  });

  test("only the GM starts, sets who goes first, and ends a combat", () => {
    const t = party();
    expect(t.submit(ALICE, { type: "start" })).toBe("Only the GM can use /start.");
    expect(t.submit(GM, { type: "first", side: "heroes" })).toBe(
      "No combat is running; /start one.",
    );
    // A player can't /start, so they're told who can.
    expect(t.submit(ALICE, { type: "turn" })).toBe(
      "No combat is running; the GM starts one with /start.",
    );
    expect(t.submit(ALICE, { type: "done" })).toBe(
      "No combat is running; the GM starts one with /start.",
    );
  });
});

describe("turns", () => {
  test("sides alternate; a player starts only their own hero's turn, on the heroes' side", () => {
    const t = fight();
    expect(t.submit(ALICE, { type: "turn", who: "kor" })).toBe(
      "You can only start your own hero's turn.",
    );
    t.run(ALICE, { type: "turn" });
    expect(t.ds.combat).toMatchObject({ acting: "vex", acted: ["vex"] });
    // Censor: 2 Wrath a turn, on top of 2 from Victories.
    expect(t.hero("vex").resource).toBe(4);
    expect(t.lastFeed()).toEqual(["Vex's turn. Wrath +2 → 4."]);
    t.run(ALICE, { type: "done" });
    expect(t.lastFeed()).toEqual(["Vex's turn ends."]);
    expect(t.ds.combat.acting).toBeUndefined();
    expect(t.submit(BOB, { type: "turn", who: "kor" })).toBe(
      "You can only start your own hero's turn.",
    );
    t.run(GM, { type: "turn", who: "goblin-warrior" });
    // The GM moves on: the warrior's turn ends when the next begins.
    t.run(GM, { type: "turn", who: "kor" }, fixedDice(3));
    expect(t.hero("kor").resource).toBe(5);
    expect(t.lastFeed(2)).toEqual([
      "Goblin Warrior's turn ends.",
      "Kor's turn. Ferocity +3 (1d3: 3) → 5.",
    ]);
    expect(t.submit(GM, { type: "turn", who: "vex" })).toBe("Vex has already acted this round.");
  });

  test("a player waits for the Director's side, and for whoever is acting", () => {
    const t = fight();
    t.run(GM, { type: "turn", who: "kor" }, fixedDice(1));
    expect(t.submit(ALICE, { type: "turn", who: "vex" })).toBe("Kor is still acting.");
    t.run(GM, { type: "done" });
    expect(t.submit(ALICE, { type: "turn", who: "vex" })).toBe(
      "It's the Director's turn to pick a creature.",
    );
  });

  test("when one side has nobody left to act, the other side acts back to back", () => {
    const t = fight();
    t.run(GM, { type: "dmg", who: "goblin-runner-a", amount: 20 });
    t.run(GM, { type: "turn", who: "goblin-warrior" });
    t.run(GM, { type: "done" });
    t.run(ALICE, { type: "turn", who: "vex" });
    t.run(ALICE, { type: "done" });
    expect(t.submit(GM, { type: "turn", who: "goblin-runner-a" })).toBe("Goblin Runner A is dead.");
    // The Director has nobody left, so it's the heroes' side again.
    t.run(BOB, { type: "play", hero: "kor" });
    expect(t.submit(BOB, { type: "turn" }, fixedDice(1))).toBeUndefined();
  });

  test("round start: Malice gains the living heroes plus the round number", () => {
    const t = fight();
    expect(t.ds.malice).toBe(5);
    for (const who of ["vex", "goblin-warrior", "kor", "goblin-runner-a"]) {
      t.run(GM, { type: "turn", who }, who === "kor" ? fixedDice(2) : undefined);
    }
    t.run(GM, { type: "dmg", who: "kor", amount: 36 });
    expect(t.hero("kor").stamina).toBe(-12);
    // Everyone has acted, so the next turn starts round 2: 1 living hero + 2.
    t.run(GM, { type: "turn", who: "goblin-warrior" });
    expect(t.ds.malice).toBe(8);
    expect(t.ds.combat).toMatchObject({
      round: 2,
      acting: "goblin-warrior",
      acted: ["goblin-warrior"],
    });
    expect(t.lastFeed(3)).toEqual([
      "Goblin Runner A's turn ends.",
      "Round 2. Malice +3 (1 hero, round 2) → 8.",
      "Goblin Warrior's turn.",
    ]);
  });

  test("/round starts the next round straight away", () => {
    const t = fight();
    t.run(ALICE, { type: "turn" });
    t.run(GM, { type: "round" });
    expect(t.ds.combat).toMatchObject({ round: 2, acted: [] });
    expect(t.ds.malice).toBe(9);
    expect(t.lastFeed(2)).toEqual([
      "Vex's turn ends.",
      "Round 2. Malice +4 (2 heroes, round 2) → 9.",
    ]);
  });
});

describe("conditions", () => {
  test("EoT lasts to the end of the target's next turn; save ends rolls a d10 there, 6+ ends it", () => {
    const t = fight();
    t.run(GM, { type: "cond", who: "goblin-warrior", condition: "slowed", duration: "eot" });
    t.run(GM, { type: "cond", who: "goblin-warrior", condition: "bleeding", duration: "save" });
    t.run(GM, { type: "cond", who: "goblin-warrior", condition: "prone" });
    expect(t.lastFeed(3)).toEqual([
      "Goblin Warrior is slowed (EoT).",
      "Goblin Warrior is bleeding (save ends).",
      "Goblin Warrior is prone until the end of the encounter.",
    ]);
    // Another creature's turn ending touches nothing.
    t.run(ALICE, { type: "turn" });
    t.run(ALICE, { type: "done" });
    expect(t.creature("goblin-warrior").conditions).toHaveLength(3);
    t.run(GM, { type: "turn", who: "goblin-warrior" });
    t.run(GM, { type: "done" }, fixedDice(5));
    expect(t.envelopes.at(-1)).toMatchObject({
      type: "ds.turn-ended",
      payload: {
        id: "goblin-warrior",
        ended: ["slowed"],
        saves: [{ condition: "bleeding", roll: 5 }],
      },
    });
    expect(t.lastFeed()).toEqual([
      "Goblin Warrior's turn ends. Slowed ends. Save against bleeding: 5, it goes on.",
    ]);
    expect(t.creature("goblin-warrior").conditions).toEqual([
      { name: "bleeding", duration: "save" },
      { name: "prone", duration: "end" },
    ]);
  });

  test("a save of 6 ends it, at turn end or with /save", () => {
    const t = fight();
    t.run(GM, { type: "cond", who: "vex", condition: "bleeding", duration: "save" });
    t.run(GM, { type: "cond", who: "vex", condition: "dazed", duration: "save" });
    t.run(ALICE, { type: "save", who: "vex", condition: "dazed" }, fixedDice(6));
    expect(t.lastFeed()).toEqual(["Vex saves against dazed: 6, it ends."]);
    t.run(ALICE, { type: "turn" });
    t.run(ALICE, { type: "done" }, fixedDice(6));
    expect(t.lastFeed()).toEqual(["Vex's turn ends. Save against bleeding: 6, it ends."]);
    expect(t.hero("vex").conditions).toEqual([]);
    expect(t.submit(ALICE, { type: "save", who: "vex" })).toBe("Vex has nothing a save ends.");
  });

  test("an EoT condition imposed during the target's own turn ends with that turn", () => {
    const t = fight();
    t.run(ALICE, { type: "turn" });
    t.run(GM, { type: "cond", who: "vex", condition: "weakened", duration: "eot" });
    t.run(ALICE, { type: "done" });
    expect(t.hero("vex").conditions).toEqual([]);
    expect(t.lastFeed()).toEqual(["Vex's turn ends. Weakened ends."]);
  });

  test("removing a condition, and setting one again changes its duration", () => {
    const t = party();
    t.run(ALICE, { type: "cond", who: "vex", condition: "prone", duration: "eot" });
    t.run(ALICE, { type: "cond", who: "vex", condition: "prone", duration: "save" });
    expect(t.hero("vex").conditions).toEqual([{ name: "prone", duration: "save" }]);
    t.run(ALICE, { type: "cond", who: "vex", condition: "prone", remove: true });
    expect(t.lastFeed()).toEqual(["Vex is no longer prone."]);
    expect(t.submit(ALICE, { type: "cond", who: "vex", condition: "prone", remove: true })).toBe(
      "Vex isn't prone.",
    );
  });
});

describe("ending a combat", () => {
  test("surges are lost, every condition ends, Stamina stays, the creatures leave", () => {
    const t = fight();
    t.run(ALICE, { type: "surge", who: "vex", by: 2 });
    t.run(GM, { type: "cond", who: "vex", condition: "frightened" });
    t.run(GM, { type: "cond", who: "vex", condition: "slowed", duration: "eot" });
    t.run(GM, { type: "cond", who: "kor", condition: "bleeding", duration: "save" });
    t.run(GM, { type: "dmg", who: "vex", amount: 4 });
    t.run(GM, { type: "end" });
    expect(t.lastFeed()).toEqual([
      "Combat ends. Heroic resources, surges and Malice are lost; temporary Stamina and conditions end.",
    ]);
    expect(t.hero("vex")).toMatchObject({ surges: 0, conditions: [], stamina: 17 });
    expect(t.hero("kor").conditions).toEqual([]);
    expect(t.ds.creatures).toEqual([]);
    expect(t.ds.combat).toEqual({ active: false, round: 0, acted: [] });
    expect(t.submit(GM, { type: "end" })).toBe("No combat is running; /start one.");
  });
});

describe("Malice, surges, hero tokens and Victories", () => {
  test("counters move by signed amounts and never below zero", () => {
    const t = party();
    t.run(GM, { type: "malice", by: 3 });
    t.run(GM, { type: "malice", by: -2 });
    expect(t.ds.malice).toBe(1);
    expect(t.submit(GM, { type: "malice", by: -2 })).toBe("The Director has only 1 Malice.");
    t.run(ALICE, { type: "surge", who: "vex", by: 2 });
    expect(t.submit(ALICE, { type: "surge", who: "vex", by: -3 })).toBe("Vex has only 2 surges.");
    t.run(ALICE, { type: "res", who: "vex", by: 2 });
    t.run(ALICE, { type: "res", who: "vex", by: -1 });
    expect(t.hero("vex").resource).toBe(1);
    expect(t.lastFeed(5)).toEqual([
      "Malice +3 → 3.",
      "Malice -2 → 1.",
      "Vex gains 2 surges → 2.",
      "Vex gains 2 Wrath → 2.",
      "Vex spends 1 Wrath → 1.",
    ]);
  });

  test("hero tokens reset to one per hero; players spend them, only the GM adds", () => {
    const t = party();
    t.run(GM, { type: "token", change: "reset" });
    expect(t.ds.tokens).toBe(2);
    expect(t.submit(ALICE, { type: "token", change: 1 })).toBe("Only the GM can add hero tokens.");
    t.run(ALICE, { type: "token", change: -1 });
    expect(t.ds.tokens).toBe(1);
    expect(t.lastFeed(2)).toEqual([
      "Hero tokens reset to 2, one per hero.",
      "abcdefgh (Vex) spends 1 hero token → 1.",
    ]);
    expect(t.submit(ALICE, { type: "token", change: -2 })).toBe("The party has only 1 hero token.");
  });

  test("Victories go to one hero or all, and feed the next /start", () => {
    const t = party();
    t.run(GM, { type: "victory", by: 1 });
    expect([t.hero("vex").victories, t.hero("kor").victories]).toEqual([3, 3]);
    expect(t.lastFeed()).toEqual(["Victories +1: Vex 3, Kor 3."]);
    t.run(GM, { type: "start" }, fixedDice(1));
    expect(t.ds.malice).toBe(6);
  });
});
