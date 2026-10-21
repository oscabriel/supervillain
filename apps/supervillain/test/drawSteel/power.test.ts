import { describe, expect, test } from "bun:test";
import { ALICE, fixedDice, GM, GOBLIN, party, Table } from "./harness.ts";

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
