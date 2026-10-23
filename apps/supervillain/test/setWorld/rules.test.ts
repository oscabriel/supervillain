import { describe, expect, test } from "bun:test";
import type { MapGrid } from "../../src/game/drawSteel/map.ts";
import { feedLines, plainText, type SetCharacter, tableLabel } from "../../src/game/index.ts";
import { landedDamage, reachOf, speedOf } from "../../src/game/setWorld/index.ts";
import { ALICE, BOB, fixedDice, GM, noDice, Table } from "../game/table.ts";
import { character, recorded } from "./harness.ts";

/** Twelve squares by three, all floor but a wall at f2. */
const FIELD: MapGrid = {
  name: "Field",
  terrain: ["............", ".....#......", "............"],
};

/** Every die rolls high: no dodge, no critical. */
const plainHit = () => fixedDice(1000, 1000);

/** The feed as the table shows it, one plain string per line. */
const feed = (table: Table) => {
  const state = table.state;
  return feedLines(state, tableLabel(state, "set-world")).map(plainText);
};
const last = (table: Table, n = 1) => feed(table).slice(-n);
const fighter = (table: Table, id: string) => {
  const found = table.state.sw.fighters.find((f) => f.id === id);
  if (found === undefined) throw new Error(`no fighter ${id}`);
  return found;
};

/** A table with these fighters rolled, the party first, then the foes. */
function tableWith(
  party: ReadonlyArray<readonly [string, SetCharacter]>,
  foes: ReadonlyArray<readonly [string, SetCharacter]>,
): Table {
  const table = new Table();
  for (const [name, c] of party) table.run(GM, { type: "set-recruit", name, character: c });
  for (const [name, c] of foes) table.run(GM, { type: "set-foe", name, character: c });
  return table;
}

describe("rolling fighters", () => {
  test("a recorded roll joins under the GM's name, its numbers from set.world's", () => {
    const table = tableWith([["Ada", recorded(101)]], [["Sky", recorded(611)]]);
    expect(feed(table)).toEqual([
      "Ada the Wayguard joins the party: 191 health, 102 stamina, a targe (melee, reach 1), speed 5, set.world seed 101.",
      "Sky the Skirmisher comes as a foe: 193 health, 98 stamina, a sling (projectile, reach 10), speed 6, set.world seed 611.",
    ]);
    const ada = fighter(table, "ada");
    expect(ada).toMatchObject({ health: 191, stamina: 102, side: "party" });
    // The event carries the kept part of the roll; replay (every read here) never fetches.
    expect(table.envelopes[0]!.payload).toMatchObject({
      id: "ada",
      character: { seed: 101, contentVersion: "7.1bmmTgz1B0Y9UKhiu84STg", className: "Wayguard" },
    });
  });

  test("a roll must have come, a name must be new and short, and only the GM rolls", () => {
    const table = tableWith([["Ada", character()]], []);
    expect(table.submit(GM, { type: "set-recruit", name: "Bo" })).toBe(
      "No roll came from set.world for that; try again.",
    );
    expect(table.submit(GM, { type: "set-foe", name: "ADA", character: character() })).toBe(
      "ADA is at the table already.",
    );
    expect(
      table.submit(GM, { type: "set-foe", name: "x".repeat(25), character: character() }),
    ).toBe("Keep a fighter's name to 24 characters.");
    expect(table.submit(ALICE, { type: "set-recruit", name: "Bo", character: character() })).toBe(
      "Only the GM can use /recruit.",
    );
    const broken = { ...character(), attributes: { ...character().attributes, initiative: 0 } };
    expect(table.submit(GM, { type: "set-recruit", name: "Bo", character: broken })).toBe(
      "set.world's roll doesn't fit the table.",
    );
  });

  test("speed and reach come from the walk speed and the weapon's delivery", () => {
    expect(speedOf(recorded(101))).toBe(5);
    expect(speedOf(recorded(611))).toBe(6);
    expect(reachOf("sword")).toEqual({ delivery: "melee", squares: 1, magic: false });
    expect(reachOf("pike")).toEqual({ delivery: "melee", squares: 2, magic: false });
    expect(reachOf("sling")).toEqual({ delivery: "projectile", squares: 10, magic: false });
    expect(reachOf("wand")).toEqual({ delivery: "wave", squares: 5, magic: true });
    expect(reachOf("tome")).toEqual({ delivery: "aura", squares: 3, magic: true });
  });
});

describe("turn order", () => {
  test("each fighter acts every 1000 / initiative ms of logical time, starting one interval in", () => {
    const table = tableWith(
      [["Ada", character({ initiative: 1.25 })]],
      [["Grub", character({ initiative: 1 })]],
    );
    table.run(GM, { type: "set-start" });
    expect(last(table, 2)).toEqual([
      "The fight begins. Turns follow initiative, on set.world's clock.",
      "0.80 s · Ada's turn: stamina 100, speed 5.",
    ]);
    const order: string[] = [];
    for (let i = 0; i < 5; i++) {
      table.run(GM, { type: "set-done" });
      order.push(last(table)[0]!.split(":")[0]!);
    }
    expect(order).toEqual([
      "1.00 s · Grub's turn",
      "1.60 s · Ada's turn",
      "2.00 s · Grub's turn",
      "2.40 s · Ada's turn",
      "3.00 s · Grub's turn",
    ]);
  });

  test("an exact tie goes to the party, then the foes, each in the order they came", () => {
    const table = new Table();
    table.run(GM, { type: "set-foe", name: "Grub", character: character() });
    table.run(GM, { type: "set-recruit", name: "Ada", character: character() });
    table.run(GM, { type: "set-recruit", name: "Bo", character: character() });
    table.run(GM, { type: "set-start" });
    expect(last(table)).toEqual(["1.00 s · Ada's turn: stamina 100, speed 5."]);
    table.run(GM, { type: "set-done" });
    expect(last(table, 2)).toEqual(["Ada rests.", "1.00 s · Bo's turn: stamina 100, speed 5."]);
    table.run(GM, { type: "set-done" });
    expect(last(table, 2)).toEqual(["Bo rests.", "1.00 s · Grub's turn: stamina 100, speed 5."]);
  });

  test("Set's worked encounter: its times, its stamina before each turn, its 21 and 19", () => {
    // The hero of Rolling a character (initiative 1.108) against an all-16 enemy (1.144), every
    // draw fixed to no dodge, no critical, as https://set.world/skills/anima-derived-combat has it.
    const table = tableWith(
      [["Hero", character({ initiative: 1.108, stamina: 98, maxHealth: 187, physicalDamage: 27 })]],
      [
        [
          "Enemy",
          character({
            initiative: 1.144,
            stamina: 88,
            maxHealth: 168,
            physicalDamage: 19,
            physicalDamageReduction: 0.128,
            globalResistance: 0.088,
          }),
        ],
      ],
    );
    table.run(GM, { type: "set-start" });
    const turns: Array<[number, string, number, number]> = [];
    for (let i = 0; i < 10; i++) {
      const fight = table.state.sw.fight!;
      const who = fighter(table, fight.turn!.id);
      const before = Math.floor(who.stamina);
      const target = who.id === "hero" ? "enemy" : "hero";
      table.run(GM, { type: "set-attack", who: who.id, target }, plainHit());
      turns.push([Math.round(fight.clock), who.id, before, fighter(table, target).health]);
      table.run(GM, { type: "set-done" });
    }
    expect(turns).toEqual([
      [874, "enemy", 88, 168],
      [903, "hero", 98, 147],
      [1748, "enemy", 76, 149],
      [1805, "hero", 87, 126],
      [2622, "enemy", 65, 130],
      [2708, "hero", 76, 105],
      [3497, "enemy", 54, 111],
      [3610, "hero", 65, 84],
      [4371, "enemy", 42, 92],
      [4513, "hero", 54, 63],
    ]);
    // Attacks give way to rests: the enemy first rests on its turn at 6,993 ms, with 9 stamina.
    for (;;) {
      const fight = table.state.sw.fight!;
      const who = fighter(table, fight.turn!.id);
      if (who.stamina < 20) {
        expect([Math.round(fight.clock), who.id, Math.floor(who.stamina)]).toEqual([
          6993,
          "enemy",
          9,
        ]);
        break;
      }
      const target = who.id === "hero" ? "enemy" : "hero";
      table.run(GM, { type: "set-attack", who: who.id, target }, plainHit());
      table.run(GM, { type: "set-done" });
    }
  });

  test("a fight needs someone standing on each side, and one fight at a time", () => {
    const table = tableWith([["Ada", character()]], []);
    expect(table.submit(GM, { type: "set-start" })).toBe(
      "A fight needs someone standing on each side: /recruit and /foe.",
    );
    table.run(GM, { type: "set-foe", name: "Grub", character: character() });
    expect(table.submit(ALICE, { type: "set-start" })).toBe("Only the GM can use /start.");
    table.run(GM, { type: "set-start" });
    expect(table.submit(GM, { type: "set-start" })).toBe("A fight is on already; /end ends it.");
    table.run(GM, { type: "set-end" });
    expect(last(table)).toEqual(["The fight is over."]);
    expect(table.submit(GM, { type: "set-done" })).toBe(
      "No fight is on; the GM starts one with /start.",
    );
  });
});

describe("stamina", () => {
  test("an attack costs 20; 10 a second comes back, up to the maximum; short of 20 is a rest", () => {
    const table = tableWith(
      [["Ada", character({ stamina: 30 })]],
      [["Grub", character({ initiative: 0.25 })]],
    );
    table.run(GM, { type: "set-start" });
    expect(last(table)).toEqual(["1.00 s · Ada's turn: stamina 30, speed 5."]);
    table.run(GM, { type: "set-attack", who: "ada", target: "grub" }, plainHit());
    expect(fighter(table, "ada").stamina).toBe(10);
    table.run(GM, { type: "set-done" });
    expect(last(table, 2)).toEqual([
      "Ada's turn ends.",
      "2.00 s · Ada's turn: stamina 20, speed 5.",
    ]);
    table.run(GM, { type: "set-attack", who: "ada", target: "grub" }, plainHit());
    table.run(GM, { type: "set-done" });
    expect(last(table)).toEqual([
      "3.00 s · Ada's turn: stamina 10, speed 5. Too tired to attack: /done rests.",
    ]);
    expect(table.submit(GM, { type: "set-attack", who: "ada", target: "grub" }, noDice)).toBe(
      "Ada has 10 stamina, short of the 20 an attack costs: /done rests.",
    );
    table.run(GM, { type: "set-done" });
    // Grub's first turn is at 4 s too, but the party goes first. Grub hasn't spent any.
    expect(last(table, 2)).toEqual(["Ada rests.", "4.00 s · Ada's turn: stamina 20, speed 5."]);
    table.run(GM, { type: "set-done" });
    expect(last(table)).toEqual(["4.00 s · Grub's turn: stamina 100, speed 5."]);
  });

  test("recovery keeps its fraction, is shown rounded down, and never passes the maximum", () => {
    const table = tableWith(
      [["Ada", character({ stamina: 50, initiative: 1.5 })]],
      [["Grub", character({ initiative: 0.1 })]],
    );
    table.run(GM, { type: "set-start" });
    table.run(GM, { type: "set-attack", who: "ada", target: "grub" }, plainHit());
    table.run(GM, { type: "set-done" });
    // 666.7 ms later: 30 + 6.67, shown as 36 and kept as 36.67.
    expect(last(table)).toEqual(["1.33 s · Ada's turn: stamina 36, speed 5."]);
    expect(fighter(table, "ada").stamina).toBeCloseTo(36.667, 3);
    for (let i = 0; i < 4; i++) table.run(GM, { type: "set-done" });
    expect(fighter(table, "ada").stamina).toBe(50);
  });

  test("when a fight ends stamina refills; health stays as it is", () => {
    const table = tableWith([["Ada", character()]], [["Grub", character()]]);
    table.run(GM, { type: "set-start" });
    table.run(GM, { type: "set-attack", who: "ada", target: "grub" }, plainHit());
    table.run(GM, { type: "set-end" });
    expect(fighter(table, "ada").stamina).toBe(100);
    expect(fighter(table, "grub").health).toBe(70);
  });
});

describe("a hit", () => {
  test("lands max(1, floor(raw × (1 − reduction) × (1 − globalResistance) × critical))", () => {
    // Set's own worked example: floor(27 × (1 − 0.128) × (1 − 0.088)) = 21.
    expect(landedDamage(27, 0.128, 0.088, false)).toBe(21);
    expect(landedDamage(27, 0.128, 0.088, true)).toBe(42);
    expect(landedDamage(1, 0.9, 0.9, false)).toBe(1);
  });

  test("a d1000 against dodgeRate × (1 − clarity) comes first; a dodge draws nothing more", () => {
    const table = tableWith(
      [["Ada", character({ clarity: 0.5 })]],
      [["Grub", character({ dodgeRate: 0.2, initiative: 0.5 })]],
    );
    table.run(GM, { type: "set-start" });
    // The chance is 10%: a 100 dodges, and only one die is cast.
    table.run(GM, { type: "set-attack", who: "ada", target: "grub" }, fixedDice(100));
    expect(last(table)).toEqual(["Ada strikes at Grub: Grub dodges (a 10% chance)."]);
    expect(fighter(table, "grub").health).toBe(100);
    expect(fighter(table, "ada").stamina).toBe(80);
    expect(table.submit(GM, { type: "set-attack", who: "ada", target: "grub" })).toBe(
      "Ada has attacked this turn; /done ends it.",
    );
    table.run(GM, { type: "set-done" });
    table.run(GM, { type: "set-attack", who: "ada", target: "grub" }, fixedDice(101, 1000));
    expect(last(table)).toEqual(["Ada strikes at Grub: 30 damage → 70/100."]);
  });

  test("then a d1000 against criticalHitChance doubles it", () => {
    const table = tableWith(
      [["Ada", character({ criticalHitChance: 0.15 })]],
      [["Grub", character({ initiative: 0.5, physicalDamageReduction: 0.1 })]],
    );
    table.run(GM, { type: "set-start" });
    table.run(GM, { type: "set-attack", who: "ada", target: "grub" }, fixedDice(1000, 150));
    // floor(30 × 0.9 × 2) = 54.
    expect(last(table)).toEqual(["Ada strikes at Grub: a critical hit, 54 damage → 46/100."]);
    expect(table.last?.payload).toMatchObject({ dodgeRoll: 1000, critRoll: 150, critical: true });
  });

  test("a wave or aura weapon hits with magicalDamage against magicalDamageReduction", () => {
    const table = tableWith(
      [["Wix", character({}, "wand")]],
      [["Grub", character({ magicalDamageReduction: 0.5, physicalDamageReduction: 0.9 })]],
    );
    table.run(GM, { type: "set-start" });
    table.run(GM, { type: "set-attack", who: "wix", target: "grub" }, plainHit());
    expect(last(table)).toEqual(["Wix casts at Grub: 10 damage → 90/100."]);
  });

  test("takes at most the health left; the last foe down ends the fight", () => {
    const table = tableWith([["Ada", character()]], [["Grub", character({ maxHealth: 25 })]]);
    table.run(GM, { type: "set-start" });
    table.run(GM, { type: "set-attack", who: "ada", target: "grub" }, plainHit());
    expect(last(table, 2)).toEqual([
      "Ada strikes at Grub: 25 damage → 0/25, down.",
      "The fight is over: the party wins.",
    ]);
    expect(table.state.sw.fight).toBeUndefined();
  });

  test("only at a standing foe, on its own turn", () => {
    const table = tableWith(
      [
        ["Ada", character()],
        ["Bo", character({ initiative: 0.5 })],
      ],
      [["Grub", character({ initiative: 0.5 })]],
    );
    expect(table.submit(GM, { type: "set-attack", who: "ada", target: "grub" })).toBe(
      "No fight is on; the GM starts one with /start.",
    );
    table.run(GM, { type: "set-start" });
    expect(table.submit(GM, { type: "set-attack", who: "ada", target: "bo" })).toBe(
      "Bo fights on Ada's side.",
    );
    expect(table.submit(GM, { type: "set-attack", who: "grub", target: "ada" })).toBe(
      "It isn't Grub's turn.",
    );
  });
});

describe("the grid", () => {
  /** Ada (a sword) at a1, Sky (a sling) at a3 and Grub at d1, the map loaded, the fight on. */
  function onField(): Table {
    const table = tableWith(
      [
        ["Ada", character()],
        ["Sky", character({ initiative: 0.5 }, "sling")],
      ],
      [["Grub", character({ initiative: 0.5 })]],
    );
    table.run(GM, { type: "set-map", id: "field", grid: FIELD });
    table.run(GM, { type: "set-place", who: "ada", at: { x: 0, y: 0 } });
    table.run(GM, { type: "set-place", who: "sky", at: { x: 0, y: 2 } });
    table.run(GM, { type: "set-place", who: "grub", at: { x: 3, y: 0 } });
    table.run(ALICE, { type: "set-play", who: "ada" });
    table.run(GM, { type: "set-start" });
    return table;
  }

  test("a weapon reaches by its delivery: a sword 1 square, a sling 10", () => {
    const table = onField();
    expect(table.submit(ALICE, { type: "set-attack", who: "ada", target: "grub" })).toBe(
      "Grub is 3 squares away; Ada's sword (melee) reaches 1.",
    );
    table.run(ALICE, { type: "set-move", who: "ada", to: { x: 2, y: 0 } });
    table.run(ALICE, { type: "set-attack", who: "ada", target: "grub" }, plainHit());
    expect(table.last?.payload).toMatchObject({ apart: 1, delivery: "melee" });
    // Ada's next turn, Sky's and Grub's first all fall at 2 s: in the order they came.
    table.run(ALICE, { type: "set-done" });
    table.run(ALICE, { type: "set-done" });
    expect(table.state.sw.fight?.turn?.id).toBe("sky");
    table.run(GM, { type: "set-attack", who: "sky", target: "grub" }, plainHit());
    expect(table.last?.payload).toMatchObject({ apart: 3, delivery: "projectile" });
    expect(last(table)).toEqual(["Sky shoots at Grub: 30 damage → 40/100."]);
  });

  test("a turn's moves add up to the speed; the GM's may go over; walls and others' squares refuse", () => {
    const table = onField();
    expect(table.submit(ALICE, { type: "set-move", who: "ada", to: { x: 6, y: 0 } })).toBe(
      "g1 is 6 squares away; Ada has 5 left.",
    );
    table.run(ALICE, { type: "set-move", who: "ada", to: { x: 2, y: 1 } });
    expect(last(table)).toEqual(["Ada moves to c2 (2 squares)."]);
    expect(table.submit(ALICE, { type: "set-move", who: "ada", to: { x: 5, y: 1 } })).toBe(
      "f2 is a wall.",
    );
    expect(table.submit(ALICE, { type: "set-move", who: "ada", to: { x: 3, y: 0 } })).toBe(
      "d1 is taken by Grub.",
    );
    expect(table.submit(ALICE, { type: "set-move", who: "ada", to: { x: 6, y: 2 } })).toBe(
      "g3 is 4 squares away; Ada has 3 left.",
    );
    table.run(GM, { type: "set-move", who: "ada", to: { x: 6, y: 2 } });
    expect(table.state.sw.fight?.turn?.moved).toBe(6);
  });

  test("off its turn a player moves nobody, and places only before the fight", () => {
    const table = onField();
    table.run(BOB, { type: "set-play", who: "sky" });
    expect(table.submit(BOB, { type: "set-move", who: "sky", to: { x: 0, y: 1 } })).toBe(
      "It isn't Sky's turn.",
    );
    expect(table.submit(BOB, { type: "set-place", who: "sky", at: { x: 1, y: 2 } })).toBe(
      "Sky is on the map already; /move instead.",
    );
    expect(table.submit(BOB, { type: "set-move", who: "ada", to: { x: 0, y: 1 } })).toBe(
      "You don't play Ada.",
    );
  });

  test("off the map, nothing reaches or blocks: Set's own fight has no positions", () => {
    const table = tableWith([["Ada", character()]], [["Grub", character({ initiative: 0.5 })]]);
    table.run(GM, { type: "set-start" });
    table.run(GM, { type: "set-attack", who: "ada", target: "grub" }, plainHit());
    expect(table.last?.payload).not.toHaveProperty("apart");
  });
});

describe("players", () => {
  test("a player plays one party member, acts for it alone, and ends only its turn", () => {
    const table = tableWith(
      [
        ["Ada", character()],
        ["Sky", character()],
      ],
      [["Grub", character({ initiative: 0.5 })]],
    );
    expect(table.submit(ALICE, { type: "set-play", who: "grub" })).toBe(
      "Grub fights for the foes.",
    );
    table.run(ALICE, { type: "set-play", who: "ada" });
    expect(last(table)).toEqual(["abcdefgh takes Ada."]);
    expect(table.submit(ALICE, { type: "set-play", who: "sky" })).toBe(
      "You play Ada; /unplay first.",
    );
    expect(table.submit(BOB, { type: "set-play", who: "ada" })).toBe("Someone else plays Ada.");
    expect(table.submit(GM, { type: "set-play", who: "sky" })).toBe(
      "The GM plays every fighter already.",
    );
    table.run(GM, { type: "set-start" });
    expect(table.submit(BOB, { type: "set-done" })).toBe("It's Ada's turn, not yours to end.");
    table.run(ALICE, { type: "set-done" });
    expect(table.submit(ALICE, { type: "set-done" })).toBe("It's Sky's turn, not yours to end.");
    table.run(ALICE, { type: "set-unplay" });
    expect(last(table)).toEqual(["abcdefgh stops playing Ada."]);
  });

  test("a player can't take back an attack, which rolled; the GM can", () => {
    const table = tableWith([["Ada", character()]], [["Grub", character({ initiative: 0.5 })]]);
    table.run(ALICE, { type: "set-play", who: "ada" });
    table.run(GM, { type: "set-start" });
    table.run(ALICE, { type: "set-attack", who: "ada", target: "grub" }, plainHit());
    expect(table.submit(ALICE, { type: "undo", now: table.now })).toBe(
      "That change rolled dice, so only the GM can take it back.",
    );
    table.run(GM, { type: "undo" });
    expect(fighter(table, "grub").health).toBe(100);
    expect(fighter(table, "ada").stamina).toBe(100);
    table.run(GM, { type: "redo" });
    expect(fighter(table, "grub").health).toBe(70);
  });
});
