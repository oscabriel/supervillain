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

  test("an id that is only too long is refused for its length, not its letters", () => {
    const t = new Table();
    const long = "a-very-long-hero-id-that-runs-past-forty-c";
    expect(long.length).toBe(42);
    expect(t.submit(GM, { type: "hero", hero: long, sheet: { ...VEX, id: long } })).toEndWith(
      "' can't be used: id must be at most 40 characters.",
    );
    expect(t.submit(GM, { type: "hero", hero: "Vex", sheet: { ...VEX, id: "Vex" } })).toBe(
      "'Vex' can't be used: id must be lowercase letters, digits and dashes.",
    );
    const forty = "x".repeat(40);
    t.run(GM, { type: "hero", hero: forty, sheet: { ...VEX, id: forty } });
    expect(t.hero(forty).sheet.id).toBe(forty);
  });

  test("a sheet's level, Victories, Recovery value and free strike can't be below 0", () => {
    const t = new Table();
    const hero = { ...VEX, level: -1, victories: -2, recoveryValue: -3 };
    expect(t.submit(GM, { type: "hero", hero: "vex", sheet: hero })).toBe(
      "'vex' can't be used: level must be 0 or more; recoveryValue must be 0 or more; victories must be 0 or more.",
    );
    const block = { ...GOBLIN, freeStrike: -1 };
    expect(t.submit(GM, { type: "add", monster: "goblin-warrior", count: 1, sheet: block })).toBe(
      "'goblin-warrior' can't be used: freeStrike must be 0 or more.",
    );
    t.run(GM, { type: "hero", hero: "vex", sheet: { ...VEX, level: 0, victories: 0 } });
    t.run(GM, {
      type: "add",
      monster: "goblin-warrior",
      count: 1,
      sheet: { ...GOBLIN, freeStrike: 0 },
    });
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

  test("a reloaded sheet can't raise the dead or kill the dying with its Stamina", () => {
    const t = party();
    // Vex: 21 Stamina, dead at -10; with 30 she would be dying at -10.
    t.run(GM, { type: "dmg", who: "vex", amount: 31 });
    expect(t.submit(GM, { type: "hero", hero: "vex", sheet: { ...VEX, stamina: 30 } })).toBe(
      "Vex is dead, and that sheet's 30 Stamina would raise them; /heal them first.",
    );
    t.run(GM, { type: "hero", hero: "vex", sheet: { ...VEX, level: 2 } });
    // Kor: 24 Stamina, dying at -6; with 10 he would be dead at -5.
    t.run(GM, { type: "dmg", who: "kor", amount: 30 });
    expect(t.submit(GM, { type: "hero", hero: "kor", sheet: { ...KOR, stamina: 10 } })).toBe(
      "That sheet's 10 Stamina would kill Kor at -6; /heal them first.",
    );
    t.run(GM, { type: "heal", who: "kor", amount: 2 });
    t.run(GM, { type: "hero", hero: "kor", sheet: { ...KOR, stamina: 10 } });
    expect(t.hero("kor")).toMatchObject({ stamina: -4 });
  });
});

describe("claiming heroes", () => {
  test("a player plays one hero; the feed says so by their name", () => {
    const t = party();
    expect(t.hero("vex").player).toBe(ALICE);
    expect(t.lastFeed()).toEqual(["abcdefgh takes Vex."]);
    expect(t.submit(BOB, { type: "play", hero: "vex" })).toBe("Vex is played by abcdefgh.");
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

describe("claiming heroes after a drop", () => {
  const GUEST = "guest:7f3a0000-0000-4000-8000-000000000000";
  const GUEST_AGAIN = "guest:9b1c0000-0000-4000-8000-000000000000";

  test("a hero whose guest has left goes to whoever asks for it, player or GM", () => {
    const t = party();
    t.run(GUEST, { type: "play", hero: "kor" });
    // Seated, the guest keeps their hero.
    expect(t.submit(GUEST_AGAIN, { type: "play", hero: "kor", seated: [GUEST, GUEST_AGAIN] })).toBe(
      "Kor is played by guest-7f3a.",
    );
    // Gone, the guest can never come back as themselves: their hero is free to take.
    t.run(GUEST_AGAIN, { type: "play", hero: "kor", seated: [GUEST_AGAIN] });
    expect(t.hero("kor").player).toBe(GUEST_AGAIN);
    expect(t.lastFeed()).toEqual(["guest-9b1c takes Kor."]);
    t.run(GM, {
      type: "play",
      hero: "kor",
      player: "Bob",
      playerActor: BOB,
      seated: [BOB],
    });
    expect(t.hero("kor").player).toBe(BOB);
  });

  test("a player with a key keeps their hero while away, and the refusal says what to do", () => {
    const t = party();
    expect(t.submit(BOB, { type: "play", hero: "vex", seated: [BOB] })).toBe(
      "Vex is played by abcdefgh, who isn't here; ask the GM to /unplay vex if they aren't coming back.",
    );
    expect(
      t.submit(GM, { type: "play", hero: "vex", player: "Bob", playerActor: BOB, seated: [BOB] }),
    ).toBe("Vex is played by abcdefgh, who isn't here; /unplay vex first.");
  });

  test("a hero not in the party yet, and /play alone, say what there is", () => {
    const t = party();
    expect(t.submit(BOB, { type: "play", hero: "wren" })).toBe(
      "Nobody in the party is called 'wren'; the GM brings heroes in with /hero.",
    );
    expect(t.submit(BOB, { type: "play" })).toBe("Usage: /play <hero>. Free to play: Kor.");
    t.run(BOB, { type: "play", hero: "kor" });
    expect(t.submit(GUEST, { type: "play" })).toBe(
      "Usage: /play <hero>. Every hero is taken; the GM brings more in with /hero.",
    );
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

  test("one at a time, the second of a kind is 2 and the third 3; the first keeps its name", () => {
    const t = new Table();
    for (let i = 0; i < 3; i++)
      t.run(GM, { type: "add", monster: "goblin-warrior", count: 1, sheet: GOBLIN });
    expect(t.ds.creatures.map((c) => [c.id, c.name])).toEqual([
      ["goblin-warrior", "Goblin Warrior"],
      ["goblin-warrior-2", "Goblin Warrior 2"],
      ["goblin-warrior-3", "Goblin Warrior 3"],
    ]);
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
