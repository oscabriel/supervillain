import type { Combatant, CombatView } from "../../src/table/view.ts";

/** A combatant with quiet defaults: full Stamina, no conditions, waiting to act. */
export const combatant = (
  over: Partial<Combatant> & Pick<Combatant, "id" | "name">,
): Combatant => ({
  side: "director",
  stamina: 10,
  max: 10,
  temp: 0,
  conditions: [],
  acted: false,
  acting: false,
  mine: false,
  ...over,
});

export const vex = combatant({
  id: "vex",
  name: "Vex",
  side: "heroes",
  stamina: 14,
  max: 21,
  temp: 5,
  conditions: ["slowed (EoT)"],
  resource: "Wrath 3",
  recoveries: { left: 6, max: 8 },
  surges: 2,
  acting: true,
  mine: true,
});

export const brakka = combatant({
  id: "brakka",
  name: "Brakka",
  side: "heroes",
  stamina: 8,
  max: 24,
  health: "winded",
  resource: "Focus 2",
  recoveries: { left: 4, max: 10 },
  acted: true,
});

export const sera = combatant({
  id: "sera",
  name: "Sera",
  side: "heroes",
  stamina: -3,
  max: 18,
  health: "dying",
  conditions: ["bleeding (save)"],
  resource: "Insight 1",
  recoveries: { left: 0, max: 8 },
});

export const spearmen = combatant({
  id: "spearmen-a",
  name: "Goblin Spearmen",
  stamina: 12,
  max: 15,
  count: 3,
  acted: true,
});

export const ogre = combatant({ id: "ogre", name: "Ogre", stamina: 40, max: 76 });

export const sniper = combatant({
  id: "sniper",
  name: "Goblin Sniper",
  stamina: 0,
  max: 10,
  health: "dead",
});

/** Round 2 of a fight, the director's side next. */
export const fight = (
  combatants: ReadonlyArray<Combatant>,
  over: Partial<CombatView> = {},
): CombatView => ({
  round: 2,
  active: true,
  next: "director",
  malice: 5,
  heroTokens: 2,
  combatants,
  ...over,
});

/** `count` plain goblins, `goblin-1`…, to fill the band. */
export const goblins = (count: number): ReadonlyArray<Combatant> =>
  Array.from({ length: count }, (_, i) =>
    combatant({ id: `goblin-${i + 1}`, name: `Goblin ${i + 1}`, stamina: 5, max: 5 }),
  );

/** The fight at the ford as the GM saw it at round 3: four heroes, two dead squads, the chief and five bruisers. */
export const ford: ReadonlyArray<Combatant> = [
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

/**
 * The sample campaign's own fight (examples/campaign) as the table shows it with The Ford Road
 * loaded: four heroes with their marks and the suggested bandits, the chief, two bruisers and a
 * squad each of cutpurses and slingers. Healthy at the start of round 1, the chief acting.
 */
export const sampleFord: ReadonlyArray<Combatant> = [
  combatant({
    id: "brann",
    name: "Brann (Alice)",
    mark: "B",
    side: "heroes",
    stamina: 24,
    max: 24,
    resource: "wrath 2",
    recoveries: { left: 12, max: 12 },
  }),
  combatant({
    id: "ilsa",
    name: "Ilsa (Dan)",
    mark: "I",
    side: "heroes",
    stamina: 24,
    max: 24,
    resource: "focus 2",
    recoveries: { left: 10, max: 10 },
  }),
  combatant({
    id: "kesh",
    name: "Kesh (Bob)",
    mark: "K",
    side: "heroes",
    stamina: 24,
    max: 24,
    resource: "ferocity 3",
    recoveries: { left: 10, max: 10 },
  }),
  combatant({
    id: "wren",
    name: "Wren (Cara)",
    mark: "W",
    side: "heroes",
    stamina: 21,
    max: 21,
    resource: "insight 1",
    recoveries: { left: 8, max: 8 },
  }),
  combatant({
    id: "bandit-chief",
    name: "Bandit Chief",
    mark: "c",
    stamina: 80,
    max: 80,
    acting: true,
  }),
  combatant({ id: "bandit-bruiser-1", name: "Bandit Bruiser 1", mark: "b1", stamina: 20, max: 20 }),
  combatant({ id: "bandit-bruiser-2", name: "Bandit Bruiser 2", mark: "b2", stamina: 20, max: 20 }),
  combatant({
    id: "bandit-cutpurse-a",
    name: "Bandit Cutpurse A",
    mark: "cA",
    stamina: 20,
    max: 20,
    count: 4,
  }),
  combatant({
    id: "bandit-slinger-a",
    name: "Bandit Slinger A",
    mark: "sA",
    stamina: 12,
    max: 12,
    count: 4,
  }),
];

/**
 * The same fight in round 3: Brann dead, Wren dying and bleeding, Ilsa winded and weakened, Kesh
 * slowed and with surges; the chief hurt, a bruiser winded and both squads thinned.
 */
export const sampleFordMidFight: ReadonlyArray<Combatant> = sampleFord.map((c) => {
  switch (c.id) {
    case "brann":
      return { ...c, stamina: -13, health: "dead", resource: "wrath 5", acted: true };
    case "ilsa":
      return {
        ...c,
        stamina: 7,
        health: "winded",
        conditions: ["weakened (save)", "frightened (EoT)"],
        resource: "focus 6",
        recoveries: { left: 7, max: 10 },
        acted: true,
      };
    case "kesh":
      return {
        ...c,
        stamina: 15,
        temp: 4,
        conditions: ["slowed (EoT)"],
        resource: "ferocity 7",
        recoveries: { left: 9, max: 10 },
        surges: 2,
        acted: true,
      };
    case "wren":
      return {
        ...c,
        stamina: -6,
        health: "dying",
        deadAt: -10,
        conditions: ["bleeding", "dazed (save)", "prone"],
        resource: "insight 4",
        recoveries: { left: 0, max: 8 },
      };
    case "bandit-chief":
      return { ...c, stamina: 41, conditions: ["taunted (EoT)"], acting: true };
    case "bandit-bruiser-1":
      return { ...c, stamina: 8, health: "winded", acted: true };
    case "bandit-cutpurse-a":
      return { ...c, stamina: 10, count: 2, acted: true };
    case "bandit-slinger-a":
      return { ...c, stamina: 6, count: 2 };
    default:
      return c;
  }
});

/**
 * Whether `text` shows a living combatant's turn marker, mark and Stamina, as in
 * `· b2 Brui… 2 ▐██████▌ 20/20`, however its name was cut.
 */
export const showsStamina = (text: string, c: Combatant): boolean =>
  new RegExp(`[▶✓·] ${c.mark ?? ""} +\\S[^▐]*▐[█░]+▌ +${c.stamina}/${c.max}`).test(text);
