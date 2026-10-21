/**
 * Hero and monster data as the Draw Steel module reads it. The host loads these from the campaign
 * folder (or an import) and puts the whole sheet in the command, so the event payload carries it
 * and replay never reads a file.
 */

export type Characteristic = "might" | "agility" | "reason" | "intuition" | "presence";

export type Characteristics = Readonly<Record<Characteristic, number>>;

/** A damage type with a number: "fire 5" immunity, "holy 3" weakness. "all" matches every type. */
export interface DamageModifier {
  readonly type: string;
  readonly value: number;
}

/** One ability's power roll and what each tier does, as printed. */
export interface Ability {
  readonly name: string;
  /** Main action, maneuver, triggered action, free strike…, as printed. */
  readonly kind?: string;
  /** Heroes roll 2d10 + the best of these characteristics. Absent for an ability with no power roll. */
  readonly characteristics?: ReadonlyArray<Characteristic>;
  /** Monsters print a flat roll bonus instead ("2d10 + 2"). */
  readonly bonus?: number;
  /** Heroic resource or Malice cost, if any. */
  readonly cost?: number;
  readonly keywords?: ReadonlyArray<string>;
  readonly distance?: string;
  readonly target?: string;
  readonly tier1?: string;
  readonly tier2?: string;
  readonly tier3?: string;
  /** Effect text that applies whatever the tier. */
  readonly effect?: string;
}

export interface HeroSheet {
  /** A short id unique in the campaign, e.g. "vex"; the file name without extension. */
  readonly id: string;
  readonly name: string;
  readonly class: string;
  readonly level: number;
  readonly characteristics: Characteristics;
  readonly stamina: number;
  readonly recoveries: number;
  /** Defaults to a third of max Stamina, rounded down. */
  readonly recoveryValue?: number;
  readonly speed: number;
  readonly stability: number;
  /**
   * The class's heroic resource and what each of the hero's turns gains ("1d3" or a number).
   * `min` is how far below 0 it may be spent, for a class that allows it (a Talent's clarity
   * goes to -(1 + Reason)); 0 if left out.
   */
  readonly resource: {
    readonly name: string;
    readonly perTurn: string | number;
    readonly min?: number;
  };
  readonly victories: number;
  readonly immunities?: ReadonlyArray<DamageModifier>;
  readonly weaknesses?: ReadonlyArray<DamageModifier>;
  readonly abilities: ReadonlyArray<Ability>;
}

export type Organization = "minion" | "horde" | "platoon" | "elite" | "leader" | "solo";

export interface StatBlock {
  /** A short id unique in the campaign, e.g. "goblin-warrior". */
  readonly id: string;
  readonly name: string;
  readonly level: number;
  readonly organization: Organization;
  readonly role?: string;
  /** Encounter value, as printed ("3 for four minions"); informational. */
  readonly ev?: string;
  /** For a minion, one minion's Stamina. */
  readonly stamina: number;
  readonly speed: number;
  readonly stability: number;
  readonly freeStrike: number;
  readonly characteristics: Characteristics;
  readonly immunities?: ReadonlyArray<DamageModifier>;
  readonly weaknesses?: ReadonlyArray<DamageModifier>;
  readonly abilities: ReadonlyArray<Ability>;
  /** What a minion squad gains while it has a captain, as printed. */
  readonly withCaptain?: string;
}
