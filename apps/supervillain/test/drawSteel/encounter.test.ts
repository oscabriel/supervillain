import { describe, expect, test } from "bun:test";
import { fold } from "@supervillain/engine";
import type { HeroSheet, StatBlock } from "../../src/game/drawSteel/sheets.ts";
import { sheetText } from "../../src/game/drawSteel/view.ts";
import {
  ALICE,
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

/** Vex (Alice) and Kor against a goblin warrior, round 1, the heroes first. */
function fight(t = party()): Table {
  t.run(GM, { type: "add", monster: "goblin-warrior", count: 1, sheet: GOBLIN });
  t.run(GM, { type: "start" }, fixedDice(7));
  t.run(GM, { type: "first", side: "heroes" });
  return t;
}

describe("what /end and /rest reset (Combat, 'End of Combat'; Monster Basics, 'Earning Malice')", () => {
  test("two combats in a row: the second starts from nothing the first left behind", () => {
    const t = fight();
    // Start: Malice 2 (Victories) + 2 heroes + round 1; Vex gains her 2 Victories as Wrath.
    expect(t.ds.malice).toBe(5);
    t.run(ALICE, { type: "turn" });
    expect(t.hero("vex").resource).toBe(4);
    t.run(GM, { type: "temp", who: "vex", amount: 5 });
    t.run(GM, { type: "cond", who: "vex", condition: "restrained", duration: "save" });
    t.run(GM, { type: "cond", who: "kor", condition: "slowed" });
    t.run(ALICE, { type: "surge", who: "vex", by: 1 });
    t.run(GM, { type: "end" });
    expect(t.ds.malice).toBe(0);
    expect(t.hero("vex")).toMatchObject({ resource: 0, temp: 0, surges: 0, conditions: [] });
    expect(t.hero("kor")).toMatchObject({ resource: 0, conditions: [] });
    expect(t.lastFeed()).toEqual([
      "Combat ends. Heroic resources, surges and Malice are lost; temporary Stamina and conditions end.",
    ]);

    t.run(GM, { type: "rest" });
    // A respite turns Victories into XP and resets them to 0.
    expect([t.hero("vex").victories, t.hero("kor").victories]).toEqual([0, 0]);
    expect(t.lastFeed()).toEqual([
      "The party rests: Stamina and Recoveries are back to full. Victories become XP: Vex 2, Kor 2.",
    ]);

    t.run(GM, { type: "start" }, fixedDice(3));
    // 0 for Victories + 2 heroes + round 1, from 0.
    expect(t.ds.malice).toBe(3);
    expect(t.hero("vex").resource).toBe(0);
    expect(t.lastFeed()[0]).toContain("Malice +3 (0 for Victories, 2 heroes, round 1) → 3.");
  });

  test("a dead hero doesn't recover at a respite, and the feed says so", () => {
    const t = party();
    // Vex: 21 Stamina, dead at -10.
    t.run(GM, { type: "dmg", who: "vex", amount: 31 });
    t.run(GM, { type: "dmg", who: "kor", amount: 5 });
    t.run(GM, { type: "rest" });
    expect(t.hero("vex").stamina).toBe(-10);
    expect(t.hero("kor").stamina).toBe(24);
    expect(t.envelopes.at(-1)).toMatchObject({ type: "ds.rested", payload: { dead: ["vex"] } });
    expect(t.lastFeed()).toEqual([
      "The party rests: Stamina and Recoveries are back to full. Victories become XP: Kor 2. Vex is dead and doesn't recover.",
    ]);
  });
});

describe("XP and the dead", () => {
  test("a respite adds each hero's Victories to their XP, which the sheet shows", () => {
    const t = party();
    t.run(GM, { type: "rest" });
    t.run(GM, { type: "victory", who: "vex", by: 3 });
    t.run(GM, { type: "rest" });
    expect([t.hero("vex").xp, t.hero("kor").xp]).toEqual([5, 2]);
    const sheet = sheetText(t.ds, "vex");
    expect(typeof sheet === "string" && sheet.split("\n")[2]).toContain("Victories 0 · XP 5");
  });

  test("a hero who dies loses their conditions, and Victories go to the living", () => {
    const t = party();
    t.run(GM, { type: "cond", who: "vex", condition: "slowed", duration: "eot" });
    t.run(GM, { type: "dmg", who: "vex", amount: 31 });
    expect(t.hero("vex").conditions).toEqual([]);
    t.run(GM, { type: "victory", by: 1 });
    expect(t.lastFeed()).toEqual(["Victories +1: Kor 3."]);
    expect(t.submit(GM, { type: "victory", who: "vex", by: 1 })).toBe(
      "Vex is dead and earns no Victories.",
    );
  });

  test("the dead don't act: no rolls, resource, surges or Recoveries, and they force move nobody", () => {
    const t = party();
    t.run(GM, { type: "add", monster: "goblin-warrior", count: 1, sheet: GOBLIN });
    t.run(GM, { type: "dmg", who: "vex", amount: 31 });
    const dead = "Vex is dead.";
    const pr = { type: "pr", who: "vex", edges: 0, banes: 0 } as const;
    expect(t.submit(ALICE, { ...pr, ability: "spinning", targets: ["goblin"] })).toBe(dead);
    expect(t.submit(ALICE, { ...pr, bonus: 2 })).toBe(dead);
    expect(t.submit(ALICE, { type: "res", who: "vex", by: 5 })).toBe(dead);
    expect(t.submit(GM, { type: "surge", who: "vex", by: 5 })).toBe(dead);
    expect(t.submit(ALICE, { type: "recover", who: "vex", ally: false })).toBe(dead);
    t.run(GM, { type: "map", id: "field", grid: { name: "Field", terrain: [".........."] } });
    t.run(GM, { type: "place", who: "vex", at: { x: 0, y: 0 } });
    t.run(GM, { type: "place", who: "goblin", at: { x: 1, y: 0 } });
    expect(t.submit(GM, { type: "push", who: "goblin", distance: 2, from: "vex" })).toBe(dead);
  });
});

describe("Recoveries while dying (Combat, 'Dying and Death')", () => {
  test("a dying hero spends Recoveries out of combat as usual, but can't Catch Breath in one", () => {
    const t = party();
    t.run(GM, { type: "dmg", who: "vex", amount: 24 });
    expect(t.hero("vex").stamina).toBe(-3);
    t.run(ALICE, { type: "recover", who: "vex", ally: false });
    // A third of 21 is 7.
    expect(t.hero("vex").stamina).toBe(4);
    const f = fight();
    f.run(GM, { type: "dmg", who: "vex", amount: 24 });
    expect(f.submit(ALICE, { type: "recover", who: "vex", ally: false })).toBe(
      "Vex is dying and can't Catch Breath; /recover vex ally if an ally's ability lets them spend one.",
    );
  });
});

describe("heroic resources", () => {
  test("a resource can't be spent below 0 unless the sheet gives it a floor (Classes, 'Clarity and Strain')", () => {
    const t = party();
    expect(t.submit(ALICE, { type: "res", who: "vex", by: -1 })).toBe("Vex has only 0 Wrath.");
    const TALENT: HeroSheet = {
      ...KOR,
      id: "ilo",
      name: "Ilo",
      class: "Talent",
      resource: { name: "Clarity", perTurn: "1d3", min: -2 },
    };
    t.run(GM, { type: "hero", hero: "ilo", sheet: TALENT });
    t.run(GM, { type: "res", who: "ilo", by: -2 });
    expect(t.hero("ilo").resource).toBe(-2);
    expect(t.submit(GM, { type: "res", who: "ilo", by: -1 })).toBe(
      "Ilo can't go below -2 Clarity.",
    );
  });

  test("an ability with a cost spends it in the same roll, and is refused when it's short", () => {
    const JUDGE: HeroSheet = {
      ...VEX,
      abilities: [
        ...VEX.abilities,
        {
          name: "Judgment",
          characteristics: ["presence"],
          cost: 3,
          tier1: "3 + P holy damage",
          tier2: "5 + P holy damage",
          tier3: "8 + P holy damage",
        },
      ],
    };
    const t = new Table();
    t.run(GM, { type: "hero", hero: "vex", sheet: JUDGE });
    t.run(ALICE, { type: "play", hero: "vex" });
    fight(t);
    expect(t.hero("vex").resource).toBe(2);
    const judge = { type: "pr", who: "vex", ability: "judg", edges: 0, banes: 0 } as const;
    expect(t.submit(ALICE, judge)).toBe("Vex has 2 Wrath; Judgment costs 3.");
    t.run(ALICE, { type: "turn" });
    t.run(ALICE, judge, fixedDice(6, 5));
    expect(t.envelopes.at(-1)).toMatchObject({
      type: "ds.power-rolled",
      payload: { ability: "Judgment", cost: 3, total: 13, tier: 2 },
    });
    expect(t.hero("vex").resource).toBe(1);
    // Presence 2: the feed does the sum.
    expect(t.lastFeed()).toEqual([
      "Vex uses Judgment (3 Wrath → 1): [6, 5] +2 = 13 · tier 2 — 5 + P (2) = 7 holy damage",
    ]);
  });

  test("a creature's ability with a cost spends Malice", () => {
    const BOSS: StatBlock = {
      ...GOBLIN,
      id: "goblin-boss",
      name: "Goblin Boss",
      organization: "leader",
      abilities: [{ name: "Rally", bonus: 2, cost: 2, tier1: "a", tier2: "b", tier3: "c" }],
    };
    const t = party();
    t.run(GM, { type: "add", monster: "goblin-boss", count: 1, sheet: BOSS });
    t.run(GM, { type: "start" }, fixedDice(7));
    t.run(
      GM,
      { type: "pr", who: "goblin-boss", ability: "rally", edges: 0, banes: 0 },
      fixedDice(1, 1),
    );
    expect(t.ds.malice).toBe(3);
    expect(t.lastFeed()).toEqual([
      "Goblin Boss uses Rally (2 Malice → 3): [1, 1] +2 = 4 · tier 1 — a",
    ]);
    t.run(GM, { type: "malice", by: -3, reason: "Get Them!" });
    expect(t.lastFeed()).toEqual(["Malice -3 (Get Them!) → 0."]);
    expect(
      t.submit(GM, { type: "pr", who: "goblin-boss", ability: "rally", edges: 0, banes: 0 }),
    ).toBe("The Director has only 0 Malice; Rally costs 2.");
  });

  test("tier text shows the hero's score where it says M, A, R, I or P", () => {
    const t = party();
    t.run(
      ALICE,
      { type: "pr", who: "vex", ability: "spinning", edges: 0, banes: 0 },
      fixedDice(3, 2),
    );
    expect(t.lastFeed()).toEqual(["Vex uses Spinning Strike: [3, 2] +2 = 7 · tier 1 — 3 damage"]);
    const SLAM: HeroSheet = {
      ...KOR,
      abilities: [
        { name: "Slam", characteristics: ["might"], tier1: "2 + M damage; A < 1 slowed" },
      ],
    };
    t.run(GM, { type: "hero", hero: "kor", sheet: SLAM });
    t.run(GM, { type: "pr", who: "kor", ability: "slam", edges: 0, banes: 0 }, fixedDice(1, 1));
    expect(t.lastFeed()).toEqual([
      "Kor uses Slam: [1, 1] +2 = 4 · tier 1 — 2 + M (2) = 4 damage; A < 1 slowed",
    ]);
  });
});

describe("who may do what", () => {
  test("only a player with a hero spends the party's hero tokens", () => {
    const t = party();
    t.run(GM, { type: "token", change: "reset" });
    expect(t.submit(BOB, { type: "token", change: -1 })).toBe(
      "Only a player with a hero spends hero tokens; /play one.",
    );
    t.run(ALICE, { type: "token", change: -1 });
    expect(t.ds.tokens).toBe(1);
  });

  test("the GM can't give away a hero someone plays without freeing it first", () => {
    const t = party();
    expect(t.submit(GM, { type: "play", hero: "vex", player: "Bob", playerActor: BOB })).toBe(
      "Vex is played by abcdefgh; /unplay vex first.",
    );
    expect(t.hero("vex").player).toBe(ALICE);
  });

  test("a claim reads the same whoever made it: the player's name, without their hero", () => {
    const t = party();
    expect(t.lastFeed()).toEqual(["abcdefgh takes Vex."]);
    t.run(GM, { type: "play", hero: "kor", player: "Bob", playerActor: BOB });
    expect(t.lastFeed()).toEqual(["Zyxwvuts takes Kor."]);
  });
});

describe("naming targets by any word", () => {
  test("a unique start of any word of a name or id is enough; exact and plain starts come first", () => {
    const t = party();
    t.run(GM, { type: "add", monster: "goblin-warrior", count: 2, sheet: GOBLIN });
    t.run(GM, { type: "add", monster: "goblin-runner", count: 4, sheet: RUNNER });
    t.run(GM, { type: "dmg", who: "runner", amount: 5 });
    t.run(GM, { type: "dmg", who: "warrior-2", amount: 1 });
    t.run(GM, { type: "dmg", who: "WARRIOR 1", amount: 2 });
    expect(t.ds.creatures.map((c) => c.stamina)).toEqual([13, 14, 15]);
    expect(t.submit(GM, { type: "dmg", who: "war", amount: 1 })).toBe(
      "'war' could be Goblin Warrior 1 or Goblin Warrior 2.",
    );
    // "k" begins Kor's name before it begins a word of anyone else's.
    t.run(GM, { type: "dmg", who: "k", amount: 1 });
    expect(t.hero("kor").stamina).toBe(23);
    t.run(ALICE, { type: "pr", who: "vex", ability: "lash", edges: 0, banes: 0 }, fixedDice(1, 1));
    expect(t.lastFeed()[0]).toStartWith("Vex uses Spirit Lash:");
  });

  test("Tab offers the ids a word start matches", () => {
    const t = party();
    t.run(GM, { type: "add", monster: "goblin-warrior", count: 2, sheet: GOBLIN });
    const pr = table.commands.find((c) => c.name === "pr")!;
    expect(pr.complete?.(t.state, "warr", GM)).toEqual(["goblin-warrior-1", "goblin-warrior-2"]);
    expect(pr.complete?.(t.state, "vex lash", GM)).toEqual(["vex Spirit Lash"]);
  });
});

describe("free strikes (Monster Basics, 'Creature Free Strikes', 'Free Strike Together')", () => {
  test("a free strike may name its damage type, and a squad's minions strike together", () => {
    const t = party();
    t.run(GM, { type: "add", monster: "goblin-warrior", count: 1, sheet: GOBLIN });
    t.run(GM, { type: "add", monster: "goblin-runner", count: 4, sheet: RUNNER });
    // Kor has holy weakness 3.
    t.run(GM, { type: "fs", who: "goblin-warrior", target: "kor", damageType: "holy" });
    expect(t.lastFeed()).toEqual([
      "Goblin Warrior free strikes: Kor takes 5 holy damage (2 +3 weakness) → 19/24",
    ]);
    t.run(GM, { type: "fs", who: "goblin-runner-a", target: "vex", minions: 3 });
    expect(t.hero("vex").stamina).toBe(18);
    expect(t.lastFeed()).toEqual([
      "Goblin Runner A free strikes (3 minions): Vex takes 3 damage → 18/21",
    ]);
    expect(t.submit(GM, { type: "fs", who: "goblin-runner-a", target: "vex", minions: 5 })).toBe(
      "Goblin Runner A has only 4 minions.",
    );
    expect(t.submit(GM, { type: "fs", who: "goblin-warrior", target: "vex", minions: 2 })).toBe(
      "Only a minion squad strikes together; Goblin Warrior is one creature.",
    );
  });
});

describe("minion squads keep the Stamina they were added with", () => {
  test("a later /add of a changed stat block doesn't change how an existing squad loses minions", () => {
    const t = new Table();
    t.run(GM, { type: "add", monster: "goblin-runner", count: 4, sheet: RUNNER });
    t.run(GM, {
      type: "add",
      monster: "goblin-runner",
      count: 1,
      sheet: { ...RUNNER, stamina: 6 },
    });
    t.run(GM, { type: "dmg", who: "goblin-runner-a", amount: 15 });
    // 15 of a 5-Stamina-each pool is three minions.
    expect(t.lastFeed()).toEqual([
      "Goblin Runner A takes 15 damage → 5/20 · 3 minions die, 1 left",
    ]);
  });
});

describe("a turn's end that a new round stood on", () => {
  const refusal = "A later change depends on it";

  test("can't be undone from under the GM's /round", () => {
    const t = fight();
    t.run(ALICE, { type: "turn" });
    t.run(ALICE, { type: "done" });
    t.run(GM, { type: "round" });
    expect(t.submit(ALICE, { type: "undo", now: t.now })).toStartWith(refusal);
    t.run(GM, { type: "undo" });
    t.run(ALICE, { type: "undo", now: t.now });
    expect(t.ds.combat).toMatchObject({ round: 1, acting: "vex" });
  });

  test("nor from under a /turn that started the round, once everyone had acted", () => {
    const t = fight();
    t.run(GM, { type: "dmg", who: "goblin-warrior", amount: 15 });
    t.run(GM, { type: "turn", who: "kor" }, fixedDice(2));
    t.run(GM, { type: "done" });
    t.run(GM, { type: "cond", who: "vex", condition: "slowed", duration: "eot" });
    t.run(ALICE, { type: "turn" });
    t.run(ALICE, { type: "done" });
    t.run(GM, { type: "turn", who: "kor" }, fixedDice(2));
    expect(t.ds.combat).toMatchObject({ round: 2, acting: "kor" });
    expect(t.submit(ALICE, { type: "undo", now: t.now })).toStartWith(refusal);
    expect(t.submit(GM, { type: "undo", who: "alice", whose: ALICE })).toStartWith(refusal);
    expect(t.hero("vex").conditions).toEqual([]);
  });

  test("replay halts a round that starts during a turn", () => {
    const t = fight();
    t.run(ALICE, { type: "turn" });
    t.envelopes.push({
      actor: GM,
      seq: t.envelopes.length + 1,
      timestamp: t.now,
      type: "ds.round-started",
      payload: { round: 2, heroes: 2, malice: 4 },
    });
    expect(() => t.ds).toThrow("ds.round-started at seq 8 starts a round during a turn");
  });
});

describe("replay trusts what decide stored", () => {
  const at = (seq: number, type: string, payload: unknown) => ({
    actor: GM,
    seq,
    timestamp: "2026-10-21T19:00:00.000Z",
    type,
    payload,
  });

  test("a power roll scored by older rules still replays, with its stored total and tier", () => {
    const live = party();
    const log = [
      ...live.envelopes,
      at(live.envelopes.length + 1, "ds.power-rolled", {
        id: "kor",
        dice: [5, 6],
        bonus: 0,
        edges: 0,
        banes: 0,
        total: 11,
        tier: 2,
      }),
    ];
    const folded = fold(table.rules, log, { strict: true });
    expect(folded.error).toBeUndefined();
    expect(folded.state.feed.at(-1)?.text).toBe("Kor rolls: [5, 6] = 11 · tier 2");
  });

  test("a round's Malice counted by older rules still replays", () => {
    const live = fight();
    const log = [
      ...live.envelopes,
      at(live.envelopes.length + 1, "ds.round-started", { round: 2, heroes: 2, malice: 5 }),
    ];
    const folded = fold(table.rules, log, { strict: true });
    expect(folded.error).toBeUndefined();
    expect(folded.state.ds.malice).toBe(10);
  });
});
