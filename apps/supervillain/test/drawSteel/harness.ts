import { type Dice, type Envelope, fold } from "@supervillain/engine";
import { core, labelOf } from "../../src/game/core.ts";
import type { HeroSheet, StatBlock } from "../../src/game/drawSteel/sheets.ts";
import { drawSteel } from "../../src/game/drawSteel/index.ts";
import { compose, GM } from "../../src/game/module.ts";
import { feedLines, plainText, tableLabel } from "../../src/game/table.ts";

export { GM };
export const ALICE = "key:SHA256:abcdefghIJKLMNOPqrstuvwxyz0123456789ABCDEFG";
export const BOB = "key:SHA256:Zyxwvuts+/0123456789abcdefghijklmnopqrstuvw";

/** The table with Draw Steel beside core, as the integrator will wire it. */
export const table = compose([core, drawSteel] as const, {
  label: (state, actor) => labelOf(state)(actor),
});
export type State = typeof table.rules.initial;
export type Command = Parameters<typeof table.rules.decide>[2];

/** Dice that return the given faces in order, then complain. */
export const fixedDice = (...faces: number[]): Dice => {
  let i = 0;
  return () => {
    const face = faces[i++];
    if (face === undefined) throw new Error("the fake dice ran out");
    return face;
  };
};

/** Dice for commands that must not roll. */
export const noDice: Dice = () => {
  throw new Error("rolled when it should not have");
};

/**
 * A room without the host: decide against the replayed state, append envelopes, and replay the
 * whole log with the engine's strict fold every time state is read, so every check is a replay.
 * Like the room, it stamps one submission's envelopes alike and each submission later than the
 * last: its clock moves a second per submission, so every submission is its own undo batch.
 */
export class Table {
  readonly envelopes: Envelope[] = [];
  private clock = Date.parse("2026-10-21T19:00:00.000Z");

  /** The time on the clock, as the host would put it in a player's /undo. */
  get now(): string {
    return new Date(this.clock).toISOString();
  }

  get state(): State {
    const folded = fold(table.rules, this.envelopes, { strict: true });
    if (folded.error) throw new Error(`replay halted: ${folded.error.message}`);
    return folded.state;
  }

  get ds() {
    return this.state.ds;
  }

  /** Runs one command. Returns the refusal, or undefined when it was accepted. */
  submit(actor: string, command: Command, dice: Dice = noDice): string | undefined {
    const decision = table.rules.decide(this.state, actor, command, dice);
    if ("refusal" in decision) return decision.refusal;
    const timestamp = this.now;
    for (const event of decision.events) {
      this.envelopes.push({
        actor,
        seq: this.envelopes.length + 1,
        timestamp,
        type: event.type,
        payload: event.payload,
      });
    }
    this.clock += 1000;
    return undefined;
  }

  /** Like `submit`, but fails the test on a refusal. */
  run(actor: string, command: Command, dice: Dice = noDice): void {
    const refusal = this.submit(actor, command, dice);
    if (refusal !== undefined) throw new Error(`refused: ${refusal}`);
  }

  /** The feed as the table shows it, one plain string per line. */
  get feed(): ReadonlyArray<string> {
    const state = this.state;
    return feedLines(state, tableLabel(state)).map(plainText);
  }

  /** The last `n` feed lines. */
  lastFeed(n = 1): ReadonlyArray<string> {
    return this.feed.slice(-n);
  }

  hero(id: string) {
    const hero = this.ds.heroes.find((h) => h.id === id);
    if (!hero) throw new Error(`no hero ${id}`);
    return hero;
  }

  creature(id: string) {
    const creature = this.ds.creatures.find((c) => c.id === id);
    if (!creature) throw new Error(`no creature ${id}`);
    return creature;
  }
}

export const VEX: HeroSheet = {
  id: "vex",
  name: "Vex",
  class: "Censor",
  level: 1,
  characteristics: { might: 2, agility: 0, reason: -1, intuition: 1, presence: 2 },
  stamina: 21,
  recoveries: 8,
  speed: 5,
  stability: 1,
  resource: { name: "Wrath", perTurn: 2 },
  victories: 2,
  abilities: [
    {
      name: "Spinning Strike",
      kind: "Main action",
      characteristics: ["might", "agility"],
      keywords: ["Melee", "Strike", "Weapon"],
      distance: "Melee 1",
      target: "One creature",
      tier1: "3 damage",
      tier2: "5 damage; push 1",
      tier3: "7 damage; push 2",
    },
    {
      name: "Spirit Lash",
      kind: "Main action",
      characteristics: ["presence"],
      tier1: "2 holy damage",
      tier2: "4 holy damage",
      tier3: "6 holy damage; taunted (EoT)",
    },
  ],
};

export const KOR: HeroSheet = {
  id: "kor",
  name: "Kor",
  class: "Fury",
  level: 1,
  characteristics: { might: 2, agility: 2, reason: -1, intuition: 0, presence: -1 },
  stamina: 24,
  recoveries: 10,
  recoveryValue: 9,
  speed: 6,
  stability: 0,
  resource: { name: "Ferocity", perTurn: "1d3" },
  victories: 2,
  weaknesses: [{ type: "holy", value: 3 }],
  abilities: [
    {
      name: "Brutal Slam",
      characteristics: ["might"],
      tier1: "3 damage",
      tier2: "6 damage",
      tier3: "9 damage",
    },
  ],
};

export const GOBLIN: StatBlock = {
  id: "goblin-warrior",
  name: "Goblin Warrior",
  level: 1,
  organization: "horde",
  role: "Harrier",
  stamina: 15,
  speed: 6,
  stability: 0,
  freeStrike: 2,
  characteristics: { might: -2, agility: 2, reason: 0, intuition: 0, presence: -1 },
  abilities: [
    {
      name: "Spear Charge",
      kind: "Main action",
      bonus: 2,
      tier1: "3 damage",
      tier2: "4 damage",
      tier3: "5 damage",
    },
  ],
};

export const RUNNER: StatBlock = {
  id: "goblin-runner",
  name: "Goblin Runner",
  level: 1,
  organization: "minion",
  role: "Harrier",
  ev: "3 for four minions",
  stamina: 5,
  speed: 7,
  stability: 0,
  freeStrike: 1,
  characteristics: { might: -2, agility: 2, reason: 0, intuition: 0, presence: -2 },
  abilities: [
    { name: "Dagger", bonus: 2, tier1: "1 damage", tier2: "2 damage", tier3: "3 damage" },
  ],
  withCaptain: "Edge on strikes",
};

export const ARCHER: StatBlock = {
  ...GOBLIN,
  id: "goblin-archer",
  name: "Goblin Archer",
  abilities: [{ name: "Bow", bonus: 2, tier1: "2 damage", tier2: "3 damage", tier3: "4 damage" }],
};

/** A creature with every damage modifier the worked examples need. */
export const IMP: StatBlock = {
  id: "ember-imp",
  name: "Ember Imp",
  level: 2,
  organization: "elite",
  stamina: 40,
  speed: 5,
  stability: 1,
  freeStrike: 4,
  characteristics: { might: 0, agility: 3, reason: 1, intuition: 1, presence: 0 },
  immunities: [
    { type: "fire", value: 5 },
    { type: "all", value: 2 },
  ],
  weaknesses: [
    { type: "holy", value: 4 },
    { type: "all", value: 1 },
  ],
  abilities: [],
};

/** A party of Vex (played by Alice) and Kor, as the GM sets it up. */
export function party(): Table {
  const t = new Table();
  t.run(GM, { type: "hero", hero: "vex", sheet: VEX });
  t.run(GM, { type: "hero", hero: "kor", sheet: KOR });
  t.run(ALICE, { type: "play", hero: "vex" });
  return t;
}
