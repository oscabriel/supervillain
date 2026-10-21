import { describe, expect, test } from "bun:test";
import { fold } from "@supervillain/engine";
import { hostNeeds } from "../../src/game/drawSteel/index.ts";
import {
  ALICE,
  ARCHER,
  BOB,
  fixedDice,
  GM,
  GOBLIN,
  KOR,
  party,
  RUNNER,
  table,
  Table,
  VEX,
} from "./harness.ts";

describe("heroes join from their sheets", () => {
  test("/hero puts the whole sheet in the payload and starts the hero full", () => {
    const t = new Table();
    t.run(GM, { type: "hero", hero: "vex", sheet: VEX });
    expect(t.envelopes[0]).toMatchObject({ type: "ds.hero-joined", payload: { sheet: VEX } });
    expect(t.hero("vex")).toMatchObject({
      stamina: 21,
      temp: 0,
      recoveries: 8,
      resource: 0,
      surges: 0,
      victories: 2,
      conditions: [],
    });
    expect(t.lastFeed()).toEqual(["Vex joins the party: Censor 1, 21 Stamina."]);
  });

  test("/hero and /add are refused until the host has put a sheet in the command", () => {
    const t = new Table();
    expect(t.submit(GM, { type: "hero", hero: "vex" })).toBe("No hero sheet for 'vex' was loaded.");
    expect(t.submit(GM, { type: "add", monster: "goblin", count: 1 })).toBe(
      "No stat block for 'goblin' was loaded.",
    );
    expect(t.submit(GM, { type: "hero", hero: "goblin", sheet: GOBLIN as never })).toBe(
      "'goblin-warrior' isn't a hero sheet: class is missing.",
    );
  });

  test("the host learns which commands need a sheet or a player looked up", () => {
    expect(hostNeeds({ type: "hero", hero: "vex" })).toEqual({ kind: "hero", id: "vex" });
    expect(hostNeeds({ type: "add", monster: "goblin-warrior", count: 2 })).toEqual({
      kind: "monster",
      id: "goblin-warrior",
    });
    expect(hostNeeds({ type: "play", hero: "vex", player: "Alice" })).toEqual({
      kind: "player",
      label: "Alice",
    });
    expect(hostNeeds({ type: "play", hero: "vex" })).toBeUndefined();
    expect(hostNeeds({ type: "say", text: "hi" })).toBeUndefined();
  });

  test("/hero again reloads the sheet and keeps what happened", () => {
    const t = party();
    t.run(GM, { type: "dmg", who: "vex", amount: 5 });
    t.run(GM, { type: "hero", hero: "vex", sheet: { ...VEX, level: 2, stamina: 30 } });
    expect(t.hero("vex")).toMatchObject({ stamina: 16, player: ALICE });
    expect(t.hero("vex").sheet.stamina).toBe(30);
    expect(t.lastFeed()).toEqual(["Vex's sheet is reloaded: Censor 2, 30 Stamina."]);
  });
});

describe("claiming heroes", () => {
  test("a player plays one hero; the feed says so by their name", () => {
    const t = party();
    expect(t.hero("vex").player).toBe(ALICE);
    expect(t.lastFeed()).toEqual(["abcdefgh takes Vex."]);
    expect(t.submit(BOB, { type: "play", hero: "vex" })).toBe("Vex is taken.");
    expect(t.submit(ALICE, { type: "play", hero: "kor" })).toBe("You already play Vex.");
    expect(t.submit(BOB, { type: "play", hero: "kor", player: "Alice", playerActor: ALICE })).toBe(
      "Only the GM can give a hero to someone else.",
    );
    t.run(ALICE, { type: "unplay" });
    expect(t.hero("vex").player).toBeUndefined();
    t.run(BOB, { type: "play", hero: "vex" });
    expect(t.hero("vex").player).toBe(BOB);
  });

  test("the GM gives a hero to a player the host has looked up", () => {
    const t = party();
    expect(t.submit(GM, { type: "play", hero: "kor" })).toBe(
      "The GM plays every creature; /play <hero> <player> gives a hero to a player.",
    );
    expect(t.submit(GM, { type: "play", hero: "kor", player: "Zed" })).toBe(
      "Nobody at the table is called 'Zed'.",
    );
    expect(t.submit(GM, { type: "play", hero: "kor", player: "Alice", playerActor: ALICE })).toBe(
      "Alice already plays Vex.",
    );
    t.run(GM, { type: "play", hero: "kor", player: "Bob", playerActor: BOB });
    expect(t.hero("kor").player).toBe(BOB);
    expect(t.lastFeed()).toEqual(["Zyxwvuts takes Kor."]);
    t.run(GM, { type: "unplay", hero: "kor" });
    expect(t.lastFeed()).toEqual(["Nobody plays Kor now."]);
  });
});

describe("adding creatures", () => {
  test("xN numbers copies; a lone creature keeps the block's name; 'as' renames", () => {
    const t = new Table();
    t.run(GM, { type: "add", monster: "goblin-warrior", count: 2, sheet: GOBLIN });
    t.run(GM, { type: "add", monster: "goblin-warrior", count: 1, sheet: GOBLIN });
    t.run(GM, { type: "add", monster: "goblin-warrior", count: 1, as: "Snik", sheet: GOBLIN });
    expect(t.ds.creatures.map((c) => [c.id, c.name, c.max])).toEqual([
      ["goblin-warrior-1", "Goblin Warrior 1", 15],
      ["goblin-warrior-2", "Goblin Warrior 2", 15],
      ["goblin-warrior-3", "Goblin Warrior 3", 15],
      ["snik", "Snik", 15],
    ]);
    expect(t.envelopes[0]?.payload).toEqual({
      block: GOBLIN,
      creatures: [
        { id: "goblin-warrior-1", name: "Goblin Warrior 1" },
        { id: "goblin-warrior-2", name: "Goblin Warrior 2" },
      ],
    });
    expect(t.feed[0]).toBe("Goblin Warrior 1 and Goblin Warrior 2 join the fight.");
  });

  test("minions form squads of up to 8", () => {
    const t = new Table();
    t.run(GM, { type: "add", monster: "goblin-runner", count: 10, sheet: RUNNER });
    expect(t.ds.creatures.map((c) => [c.id, c.squad, c.stamina])).toEqual([
      ["goblin-runner-a", 8, 40],
      ["goblin-runner-b", 2, 10],
    ]);
    expect(t.lastFeed()).toEqual([
      "Goblin Runner A (8 minions) and Goblin Runner B (2 minions) join the fight.",
    ]);
  });
});

describe("naming targets", () => {
  test("exact id or name first, then a unique prefix; an ambiguous prefix lists the candidates", () => {
    const t = new Table();
    t.run(GM, { type: "add", monster: "goblin-warrior", count: 2, sheet: GOBLIN });
    t.run(GM, { type: "add", monster: "goblin-archer", count: 1, sheet: ARCHER });
    expect(t.submit(GM, { type: "dmg", who: "gob", amount: 1 })).toBe(
      "'gob' could be Goblin Warrior 1, Goblin Warrior 2 or Goblin Archer.",
    );
    expect(t.submit(GM, { type: "dmg", who: "orc", amount: 1 })).toBe(
      "Nobody at the table is called 'orc'.",
    );
    t.run(GM, { type: "dmg", who: "goblin-a", amount: 1 });
    t.run(GM, { type: "dmg", who: "GOBLIN-WARRIOR-2", amount: 2 });
    expect(t.ds.creatures.map((c) => c.stamina)).toEqual([15, 13, 14]);
  });
});

describe("replay", () => {
  test("a hand-written log folds to the same state with no dice and no files", () => {
    const live = party();
    live.run(GM, { type: "add", monster: "goblin-runner", count: 4, sheet: RUNNER });
    live.run(GM, { type: "start" }, fixedDice(9));
    live.run(GM, { type: "first", side: "heroes" });
    live.run(GM, { type: "turn", who: "kor" }, fixedDice(2));
    live.run(
      GM,
      { type: "pr", who: "kor", ability: "brutal", edges: 0, banes: 0 },
      fixedDice(8, 8),
    );
    live.run(GM, { type: "dmg", who: "goblin-runner-a", amount: 9 });
    const replayed = fold(table.rules, live.envelopes, { strict: true });
    expect(replayed.error).toBeUndefined();
    expect(replayed.state).toEqual(live.state);
    expect(JSON.parse(JSON.stringify(live.envelopes))).toEqual(live.envelopes);
    expect(live.hero("kor")).toMatchObject({ resource: 4 });
    expect(live.creature("goblin-runner-a")).toMatchObject({ stamina: 11 });
    expect(KOR.resource.perTurn).toBe("1d3");
  });

  test("an event that names nobody halts the writer", () => {
    const folded = fold(
      table.rules,
      [
        {
          actor: GM,
          seq: 1,
          timestamp: "2026-10-21T19:00:00.000Z",
          type: "ds.damaged",
          payload: { id: "ghost", amount: 3, dealt: 3 },
        },
      ],
      { strict: true },
    );
    expect(folded.error?.message).toBe("ds.damaged at seq 1 names 'ghost', who isn't at the table");
  });
});
