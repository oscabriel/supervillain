import { describe, expect, test } from "bun:test";
import type { HeroSheet, StatBlock } from "../../src/game/drawSteel/sheets.ts";
import {
  ALICE,
  type Command,
  fixedDice,
  GM,
  GOBLIN,
  KOR,
  party,
  table,
  Table,
  VEX,
} from "./harness.ts";

/** Rolls a flat power roll for Vex with the given dice and edges/banes; returns the payload. */
function flat(bonus: number, dice: [number, number], edges = 0, banes = 0) {
  const t = party();
  t.run(ALICE, { type: "pr", who: "vex", bonus, edges, banes }, fixedDice(...dice));
  return { payload: t.envelopes.at(-1)?.payload, feed: t.lastFeed()[0] };
}

describe("power roll tiers", () => {
  test("11 or less is tier 1, 12 to 16 tier 2, 17 or more tier 3", () => {
    expect(flat(0, [5, 6]).payload).toMatchObject({ total: 11, tier: 1 });
    expect(flat(0, [6, 6]).payload).toMatchObject({ total: 12, tier: 2 });
    expect(flat(0, [8, 8]).payload).toMatchObject({ total: 16, tier: 2 });
    expect(flat(0, [8, 9]).payload).toMatchObject({ total: 17, tier: 3 });
  });

  test("a natural 19 is tier 3 whatever the total, even with a double bane", () => {
    expect(flat(-4, [9, 10])).toEqual({
      payload: { id: "vex", dice: [9, 10], bonus: -4, edges: 0, banes: 0, total: 15, tier: 3 },
      feed: "Vex rolls: [9, 10] -4 = 15, natural 19 · tier 3",
    });
    expect(flat(-4, [10, 10], 0, 2).payload).toMatchObject({ total: 16, tier: 3 });
  });

  test("an edge is +2 and a bane -2", () => {
    expect(flat(0, [5, 5], 1).payload).toMatchObject({ total: 12, tier: 2 });
    expect(flat(0, [5, 5], 1).feed).toBe("Vex rolls: [5, 5] +2 edge = 12 · tier 2");
    expect(flat(0, [6, 6], 0, 1).payload).toMatchObject({ total: 10, tier: 1 });
  });

  test("a double edge raises the tier instead, and a double bane lowers it", () => {
    expect(flat(0, [6, 6], 2).payload).toMatchObject({ total: 12, tier: 3 });
    expect(flat(0, [6, 6], 2).feed).toBe("Vex rolls: [6, 6] = 12, double edge · tier 3");
    expect(flat(0, [8, 9], 0, 2).payload).toMatchObject({ total: 17, tier: 2 });
    expect(flat(0, [8, 9], 2).payload).toMatchObject({ total: 17, tier: 3 });
    expect(flat(0, [2, 3], 0, 2).payload).toMatchObject({ total: 5, tier: 1 });
  });

  test("an edge and a bane cancel; a double and a single leave a single", () => {
    expect(flat(0, [5, 5], 1, 1).payload).toMatchObject({ total: 10, tier: 1 });
    expect(flat(0, [5, 5], 2, 1).payload).toMatchObject({ total: 12, tier: 2 });
    expect(flat(0, [6, 6], 1, 2).payload).toMatchObject({ total: 10, tier: 1 });
    expect(flat(0, [6, 6], 2, 2).payload).toMatchObject({ total: 12, tier: 2 });
  });
});

describe("power rolls with abilities", () => {
  test("a hero adds the best listed characteristic and prints the tier's text", () => {
    const t = party();
    t.run(
      ALICE,
      { type: "pr", who: "vex", ability: "spinning strike", edges: 0, banes: 0 },
      fixedDice(7, 5),
    );
    expect(t.envelopes.at(-1)?.payload).toEqual({
      id: "vex",
      ability: "Spinning Strike",
      dice: [7, 5],
      bonus: 2,
      edges: 0,
      banes: 0,
      total: 14,
      tier: 2,
    });
    expect(t.lastFeed()).toEqual([
      "Vex uses Spinning Strike: [7, 5] +2 = 14 · tier 2 — 5 damage; push 1",
    ]);
  });

  test("abilities resolve by a unique prefix; an ambiguous one is refused with the candidates", () => {
    const t = party();
    expect(t.submit(ALICE, { type: "pr", who: "vex", ability: "sp", edges: 0, banes: 0 })).toBe(
      "'sp' could be Spinning Strike or Spirit Lash.",
    );
    expect(t.submit(ALICE, { type: "pr", who: "vex", ability: "fly", edges: 0, banes: 0 })).toBe(
      "Vex has no ability or characteristic called 'fly'.",
    );
    t.run(ALICE, { type: "pr", who: "vex", ability: "spir", edges: 0, banes: 0 }, fixedDice(9, 9));
    expect(t.lastFeed()).toEqual([
      "Vex uses Spirit Lash: [9, 9] +2 = 20 · tier 3 — 6 holy damage; taunted (EoT)",
    ]);
  });

  test("a characteristic can be rolled by name", () => {
    const t = party();
    t.run(
      ALICE,
      { type: "pr", who: "vex", ability: "reason", edges: 0, banes: 0 },
      fixedDice(6, 6),
    );
    expect(t.lastFeed()).toEqual(["Vex rolls Reason: [6, 6] -1 = 11 · tier 1"]);
  });

  test("a monster adds its printed bonus; only the GM rolls for it", () => {
    const t = party();
    t.run(GM, { type: "add", monster: "goblin-warrior", count: 1, sheet: GOBLIN });
    expect(
      t.submit(ALICE, { type: "pr", who: "goblin-warrior", ability: "spear", edges: 0, banes: 0 }),
    ).toBe("You can only roll for your own hero.");
    t.run(GM, { type: "pr", who: "goblin", ability: "spear", edges: 1, banes: 0 }, fixedDice(4, 4));
    expect(t.lastFeed()).toEqual([
      "Goblin Warrior uses Spear Charge: [4, 4] +2 +2 edge = 12 · tier 2 — 4 damage",
    ]);
  });

  test("a roll's payload holds the dice, so replay prints the same line without rolling", () => {
    const t = new Table();
    t.run(GM, { type: "add", monster: "goblin-warrior", count: 1, sheet: GOBLIN });
    t.run(GM, { type: "pr", who: "goblin-warrior", bonus: 3, edges: 0, banes: 0 }, fixedDice(1, 2));
    expect(t.lastFeed()).toEqual(["Goblin Warrior rolls: [1, 2] +3 = 6 · tier 1"]);
  });
});

/** Vex with abilities that print an effect, cost something without rolling, or are traits. */
const ROOK: HeroSheet = {
  ...VEX,
  id: "rook",
  name: "Rook",
  abilities: [
    ...VEX.abilities,
    {
      name: "Reckless Swing",
      kind: "main action",
      characteristics: ["might"],
      distance: "Melee 1",
      tier1: "3 + M damage",
      tier2: "6 + M damage",
      tier3: "9 + M damage",
      effect: "Strikes against Rook have an edge.",
    },
    { name: "Form Up", kind: "maneuver", cost: 3, effect: "Each ally shifts up to 2 squares." },
    { name: "Steady", kind: "trait", effect: "Rook can't be knocked prone." },
  ],
};

const CHIEF: StatBlock = {
  ...GOBLIN,
  id: "goblin-chief",
  name: "Goblin Chief",
  level: 2,
  organization: "leader",
  stamina: 40,
  abilities: [
    { name: "Get Them!", kind: "maneuver", cost: 2, effect: "Each ally shifts up to 2 squares." },
    { name: "Shout", kind: "main action" },
    {
      name: "Not Like This",
      kind: "trait",
      effect: "When the chief drops to half Stamina or below, they move up to their speed.",
    },
  ],
};

/** Rook (Alice) and Kor with a goblin warrior and a goblin chief. */
function rookTable(): Table {
  const t = new Table();
  t.run(GM, { type: "hero", hero: "rook", sheet: ROOK });
  t.run(GM, { type: "hero", hero: "kor", sheet: KOR });
  t.run(ALICE, { type: "play", hero: "rook" });
  t.run(GM, { type: "add", monster: "goblin-warrior", count: 1, sheet: GOBLIN });
  t.run(GM, { type: "add", monster: "goblin-chief", count: 1, sheet: CHIEF });
  return t;
}

const pr = (who: string, ability: string, more: Partial<Command> = {}): Command =>
  ({ type: "pr", who, ability, edges: 0, banes: 0, ...more }) as Command;

describe("what an ability says beyond its tiers", () => {
  test("the roll line carries the ability's effect after the tier's text", () => {
    const t = rookTable();
    t.run(ALICE, pr("rook", "reckless"), fixedDice(7, 7));
    expect(t.lastFeed()).toEqual([
      "Rook uses Reckless Swing: [7, 7] +2 = 16 · tier 2 — 6 + M (2) = 8 damage. Effect: Strikes against Rook have an edge.",
    ]);
  });

  test("an ability with no power roll is used: its cost is spent and its effect printed", () => {
    const t = rookTable();
    expect(t.submit(ALICE, pr("rook", "form"))).toBe("Rook has 0 Wrath; Form Up costs 3.");
    t.run(GM, { type: "res", who: "rook", by: 4 });
    t.run(ALICE, pr("rook", "form"));
    expect(t.envelopes.at(-1)).toMatchObject({
      type: "ds.ability-used",
      payload: { id: "rook", ability: "Form Up", cost: 3 },
    });
    expect(t.hero("rook").resource).toBe(1);
    expect(t.lastFeed()).toEqual([
      "Rook uses Form Up (3 Wrath → 1): Each ally shifts up to 2 squares.",
    ]);
    // Nothing rolled, so the player can take it back.
    t.run(ALICE, { type: "undo", now: t.now });
    expect(t.hero("rook").resource).toBe(4);
  });

  test("a creature's costs come out of Malice, and a trait isn't used", () => {
    const t = rookTable();
    expect(t.submit(GM, pr("chief", "get"))).toBe(
      "The Director has only 0 Malice; Get Them! costs 2.",
    );
    t.run(GM, { type: "malice", by: 5 });
    t.run(GM, pr("chief", "get"));
    expect(t.ds.malice).toBe(3);
    expect(t.lastFeed()).toEqual([
      "Goblin Chief uses Get Them! (2 Malice → 3): Each ally shifts up to 2 squares.",
    ]);
    t.run(GM, pr("chief", "shout"));
    expect(t.lastFeed()).toEqual(["Goblin Chief uses Shout."]);
    expect(t.submit(GM, pr("chief", "not like"))).toBe(
      "Not Like This is a trait: it's always on, so there's nothing to use.",
    );
  });

  test("a creature's trait for half Stamina is called out when it gets there", () => {
    const t = rookTable();
    t.run(GM, { type: "dmg", who: "chief", amount: 19 });
    expect(t.lastFeed()).toEqual(["Goblin Chief takes 19 damage → 21/40"]);
    t.run(GM, { type: "dmg", who: "chief", amount: 1 });
    expect(t.lastFeed()).toEqual([
      "Goblin Chief takes 1 damage → 20/40 · winded · Not Like This: When the chief drops to half Stamina or below, they move up to their speed.",
    ]);
    t.run(GM, { type: "dmg", who: "chief", amount: 1 });
    expect(t.lastFeed()).toEqual(["Goblin Chief takes 1 damage → 19/40 · winded"]);
  });
});

describe("bleeding (Classes, 'Bleeding')", () => {
  test("a roll with Might or Agility costs 1d6 + level Stamina after it, which temporary Stamina doesn't take", () => {
    const t = rookTable();
    t.run(GM, { type: "cond", who: "rook", condition: "bleeding", duration: "save" });
    t.run(GM, { type: "temp", who: "rook", amount: 5 });
    t.run(ALICE, pr("rook", "might"), fixedDice(6, 6, 4));
    expect(t.envelopes.slice(-2)).toMatchObject([
      { type: "ds.power-rolled" },
      { type: "ds.bled", payload: { id: "rook", roll: 4, level: 1 } },
    ]);
    expect(t.hero("rook")).toMatchObject({ stamina: 16, temp: 5 });
    expect(t.lastFeed()).toEqual(["Rook bleeds and loses 5 Stamina (1d6: 4, + level 1) → 16/21"]);
    // It rolled, so it's the GM's to take back.
    expect(t.submit(ALICE, { type: "undo", now: t.now })).toBe(
      "That change rolled dice, so only the GM can take it back.",
    );
  });

  test("a main action bleeds whatever it rolls with; Reason or a flat bonus doesn't", () => {
    const t = rookTable();
    t.run(GM, { type: "cond", who: "rook", condition: "bleeding" });
    t.run(ALICE, pr("rook", "spirit"), fixedDice(5, 5, 2));
    expect(t.lastFeed()).toEqual(["Rook bleeds and loses 3 Stamina (1d6: 2, + level 1) → 18/21"]);
    t.run(ALICE, pr("rook", "reason"), fixedDice(5, 5));
    t.run(ALICE, { type: "pr", who: "rook", bonus: 2, edges: 0, banes: 0 }, fixedDice(5, 5));
    expect(t.hero("rook").stamina).toBe(18);
  });

  test("a dying hero is bleeding without the condition; a creature bleeds by its level", () => {
    const t = rookTable();
    t.run(GM, { type: "dmg", who: "rook", amount: 22 });
    t.run(ALICE, pr("rook", "agility"), fixedDice(5, 5, 6));
    expect(t.hero("rook").stamina).toBe(-8);
    t.run(GM, { type: "cond", who: "chief", condition: "bleeding" });
    t.run(GM, pr("chief", "shout"), fixedDice(1));
    expect(t.lastFeed(2)).toEqual([
      "Goblin Chief uses Shout.",
      "Goblin Chief bleeds and loses 3 Stamina (1d6: 1, + level 2) → 37/40",
    ]);
  });
});

describe("power rolls at targets", () => {
  test("the tier's damage goes to each target, after weakness and immunity", () => {
    const t = rookTable();
    t.run(ALICE, pr("rook", "spinning", { targets: ["warrior"] }), fixedDice(7, 5));
    expect(t.envelopes.slice(-2)).toMatchObject([
      { type: "ds.power-rolled", payload: { targets: [{ id: "goblin-warrior" }] } },
      { type: "ds.damaged", payload: { id: "goblin-warrior", amount: 5, dealt: 5 } },
    ]);
    expect(t.lastFeed(2)).toEqual([
      "Rook uses Spinning Strike on Goblin Warrior: [7, 5] +2 = 14 · tier 2 — 5 damage; push 1",
      "Goblin Warrior takes 5 damage → 10/15",
    ]);
    t.run(ALICE, pr("rook", "spirit", { targets: ["kor", "warrior"] }), fixedDice(9, 9));
    expect(t.lastFeed(3)).toEqual([
      "Rook uses Spirit Lash on Kor and Goblin Warrior: [9, 9] +2 = 20 · tier 3 — 6 holy damage; taunted (EoT)",
      "Kor takes 9 holy damage (6 +3 weakness) → 15/24",
      "Goblin Warrior takes 6 holy damage → 4/15 · winded",
    ]);
  });

  test("a characteristic in the damage counts, and a target out of reach is named", () => {
    const t = rookTable();
    t.run(GM, { type: "map", id: "field", grid: { name: "Field", terrain: [".........."] } });
    t.run(GM, { type: "place", who: "rook", at: { x: 0, y: 0 } });
    t.run(GM, { type: "place", who: "warrior", at: { x: 3, y: 0 } });
    t.run(ALICE, pr("rook", "reckless", { targets: ["warrior"] }), fixedDice(2, 2));
    expect(t.lastFeed(2)).toEqual([
      "Rook uses Reckless Swing on Goblin Warrior: [2, 2] +2 = 6 · tier 1 — 3 + M (2) = 5 damage. Effect: Strikes against Rook have an edge. (Goblin Warrior is 3 squares away; Melee 1)",
      "Goblin Warrior takes 5 damage → 10/15",
    ]);
  });

  test("a target must be at the table and alive", () => {
    const t = rookTable();
    expect(t.submit(ALICE, pr("rook", "spinning", { targets: ["nobody"] }))).toBe(
      "Nobody at the table is called 'nobody'.",
    );
    t.run(GM, { type: "dmg", who: "warrior", amount: 15 });
    expect(t.submit(ALICE, pr("rook", "spinning", { targets: ["warrior"] }))).toBe(
      "Goblin Warrior is dead.",
    );
  });

  test("the command line names targets after 'on', with edges and banes before or after", () => {
    const spec = table.commands.find((c) => c.name === "pr")!;
    expect(spec.parse("rook spinning strike edge on goblin b1")).toEqual({
      type: "pr",
      who: "rook",
      ability: "spinning strike",
      edges: 1,
      banes: 0,
      targets: ["goblin", "b1"],
    });
    expect(spec.parse("rook spin on goblin bane")).toMatchObject({
      ability: "spin",
      banes: 1,
      targets: ["goblin"],
    });
    expect(spec.parse("rook spin on")).toEqual({ refusal: `Usage: ${spec.usage}` });
  });
});
