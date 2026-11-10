/**
 * Hero and monster data as the Draw Steel module reads it. The host loads these from the campaign
 * folder (or an import) and puts the whole sheet in the command, so the event payload carries it
 * and replay never reads a file.
 */

/** The five characteristics, in the order sheets print them. */
export const CHARACTERISTICS = ["might", "agility", "reason", "intuition", "presence"] as const;

export type Characteristic = (typeof CHARACTERISTICS)[number];

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

/** A trait is always on: there's nothing to use or roll. */
export const isTrait = (ability: Ability): boolean => /^\s*trait\b/i.test(ability.kind ?? "");

/** Whether using it is a main action or a triggered action, which bleeding follows. */
export const isActionThatBleeds = (ability: Ability): boolean =>
  /\b(main|triggered) action\b/i.test(ability.kind ?? "");

/**
 * How far an ability reaches, from its distance as printed: the most squares any "Melee N" or
 * "Ranged N" in it names. Undefined when it names neither (Self, a burst, a line).
 */
export function reachOf(ability: Ability): number | undefined {
  const reaches = [...(ability.distance ?? "").matchAll(/\b(?:melee|ranged)\s+(\d+)/gi)].map((m) =>
    Number(m[1]),
  );
  return reaches.length === 0 ? undefined : Math.max(...reaches);
}

const LETTERS: Readonly<Record<string, Characteristic>> = {
  M: "might",
  A: "agility",
  R: "reason",
  I: "intuition",
  P: "presence",
};

/**
 * A tier's number and the characteristics added to it: "6", "6 + M", "2 + M or A", "5 + M, A, or
 * P". Never a number after a plus, so "1d6 + 2" reads as nothing.
 */
const PLUS = String.raw`(?<!\+\s*)\b(\d+)(?:\s*\+\s*([MARIP](?:\s*,\s*(?:or\s+)?[MARIP]|\s+or\s+[MARIP])*)\b)?`;

/** "6 + M" and the like, everywhere in a tier's text. */
export const TIER_PLUS = new RegExp(PLUS, "gi");

const DAMAGE = new RegExp(String.raw`${PLUS}(?:\s+([a-z]+))?\s+damage\b`, "i");

/** The best of the characteristics a tier adds, by their letters ("M or A"), as heroes roll. */
export const bestScore = (letters: string, scores: Characteristics | undefined): number =>
  Math.max(
    ...[...letters.matchAll(/\b[MARIP]\b/gi)].map(
      ([l]) => scores?.[LETTERS[l.toUpperCase()]!] ?? 0,
    ),
  );

/**
 * The damage a tier's text deals, as printed: "6 + M damage" with Might 2 is 8, "6 holy damage"
 * is 6 holy, and never below 0. Undefined when the text deals none it can read.
 */
export function tierDamage(
  text: string | undefined,
  scores: Characteristics | undefined,
): { readonly amount: number; readonly type?: string } | undefined {
  const match = DAMAGE.exec(text ?? "");
  if (match === null) return undefined;
  const added = match[2] === undefined ? 0 : bestScore(match[2], scores);
  const amount = Math.max(0, Number(match[1]) + added);
  const type = match[3]?.toLowerCase();
  return type === undefined ? { amount } : { amount, type };
}
