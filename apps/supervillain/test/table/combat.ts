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
