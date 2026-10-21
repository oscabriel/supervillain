import * as Schema from "effect/Schema";
import type { Refused } from "../module.ts";
import { cleanText, hasTerminalControls, quote } from "../text.ts";
import type { HeroSheet, StatBlock } from "./sheets.ts";

const Characteristic = Schema.Literals(["might", "agility", "reason", "intuition", "presence"]);

const Characteristics = Schema.Struct({
  might: Schema.Int,
  agility: Schema.Int,
  reason: Schema.Int,
  intuition: Schema.Int,
  presence: Schema.Int,
});

const DamageModifier = Schema.Struct({ type: Schema.String, value: Schema.Int });

const Ability = Schema.Struct({
  name: Schema.String,
  kind: Schema.optionalKey(Schema.String),
  characteristics: Schema.optionalKey(Schema.Array(Characteristic)),
  bonus: Schema.optionalKey(Schema.Int),
  cost: Schema.optionalKey(Schema.Int),
  keywords: Schema.optionalKey(Schema.Array(Schema.String)),
  distance: Schema.optionalKey(Schema.String),
  target: Schema.optionalKey(Schema.String),
  tier1: Schema.optionalKey(Schema.String),
  tier2: Schema.optionalKey(Schema.String),
  tier3: Schema.optionalKey(Schema.String),
  effect: Schema.optionalKey(Schema.String),
});

/** A hero sheet as it travels in a `ds.hero-joined` payload, and as the host reads it from a file. */
export const HeroSheetSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  class: Schema.String,
  level: Schema.Int,
  characteristics: Characteristics,
  stamina: Schema.Int,
  recoveries: Schema.Int,
  recoveryValue: Schema.optionalKey(Schema.Int),
  speed: Schema.Int,
  stability: Schema.Int,
  resource: Schema.Struct({
    name: Schema.String,
    perTurn: Schema.Union([Schema.String, Schema.Int]),
    min: Schema.optionalKey(Schema.Int),
  }),
  victories: Schema.Int,
  immunities: Schema.optionalKey(Schema.Array(DamageModifier)),
  weaknesses: Schema.optionalKey(Schema.Array(DamageModifier)),
  abilities: Schema.Array(Ability),
});

/** A stat block as it travels in a `ds.creatures-added` payload, and as the host reads it from a file. */
export const StatBlockSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  level: Schema.Int,
  organization: Schema.Literals(["minion", "horde", "platoon", "elite", "leader", "solo"]),
  role: Schema.optionalKey(Schema.String),
  ev: Schema.optionalKey(Schema.String),
  stamina: Schema.Int,
  speed: Schema.Int,
  stability: Schema.Int,
  freeStrike: Schema.Int,
  characteristics: Characteristics,
  immunities: Schema.optionalKey(Schema.Array(DamageModifier)),
  weaknesses: Schema.optionalKey(Schema.Array(DamageModifier)),
  abilities: Schema.Array(Ability),
  withCaptain: Schema.optionalKey(Schema.String),
});

// The schemas and the contract in sheets.ts must agree: each line fails to compile if they drift.
const heroFits = (s: typeof HeroSheetSchema.Type): HeroSheet => s;
const blockFits = (s: typeof StatBlockSchema.Type): StatBlock => s;
const heroBack = (s: HeroSheet): typeof HeroSheetSchema.Type => s;
const blockBack = (s: StatBlock): typeof StatBlockSchema.Type => s;
void [heroFits, blockFits, heroBack, blockBack];

/** Ids are what commands type: lowercase letters, digits and dashes. */
export const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** "a dice notation like 1d3, or a whole number", for a resource's per-turn gain. */
export const PER_TURN = /^(\d+|\d*d\d+([+-]\d+)?)$/;

const REQUIRED_HERO = ["id", "name", "class", "stamina", "recoveries", "resource", "abilities"];
const REQUIRED_BLOCK = ["id", "name", "organization", "stamina", "freeStrike", "abilities"];

/** "Expected an integer\n  at ["n"]" as one line: "Expected an integer at ["n"]". */
const oneLine = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(/\s*\n\s*/g, " ");

/** Every string in a value, however deep, with where it is: "abilities[2].effect". */
function* strings(value: unknown, path = ""): Generator<readonly [string, string]> {
  if (typeof value === "string") yield [path, value];
  else if (Array.isArray(value))
    for (const [i, v] of value.entries()) yield* strings(v, `${path}[${i + 1}]`);
  else if (value !== null && typeof value === "object")
    for (const [k, v] of Object.entries(value)) yield* strings(v, path === "" ? k : `${path}.${k}`);
}

/** Whether every string in a sheet is safe to draw on a player's terminal. Replay holds payloads to it. */
export const safeSheet = (sheet: unknown): boolean =>
  [...strings(sheet)].every(([, s]) => !hasTerminalControls(s));

/** Names are drawn in the band and the feed: one clean line each. */
const cleanName = (name: string) => name !== "" && cleanText(name) === name && name.length <= 40;

/** Something about a decoded sheet the table can't use: the field, and what's wrong with it. */
export interface SheetProblem {
  /** "name", "abilities[2].effect": list positions count from 1, as a GM would. */
  readonly field: string;
  readonly problem: string;
}

/**
 * Everything that makes a decoded sheet unusable at the table. The rules refuse a sheet with any,
 * and the host's loader runs the same checks, so a file that loads is a sheet /hero or /add takes.
 */
export function sheetProblems(sheet: HeroSheet | StatBlock): ReadonlyArray<SheetProblem> {
  const problems: SheetProblem[] = [];
  if (!ID.test(sheet.id))
    problems.push({ field: "id", problem: "must be lowercase letters, digits and dashes" });
  const names: ReadonlyArray<readonly [string, string]> = [
    ["name", sheet.name],
    ...sheet.abilities.map((a, i) => [`abilities[${i + 1}].name`, a.name] as const),
  ];
  for (const [field, name] of names)
    if (!cleanName(name))
      problems.push({ field, problem: "must be one line of up to 40 characters" });
  for (const [field, text] of strings(sheet))
    if (hasTerminalControls(text)) problems.push({ field, problem: "holds control characters" });
  if (sheet.stamina < 1) problems.push({ field: "stamina", problem: "must be at least 1" });
  if ("resource" in sheet) {
    const { perTurn, min } = sheet.resource;
    if (typeof perTurn === "string" && !PER_TURN.test(perTurn))
      problems.push({ field: "resource.perTurn", problem: "must be a number or dice like 1d3" });
    if (min !== undefined && min > 0)
      problems.push({ field: "resource.min", problem: "must be 0 or below" });
    if (sheet.recoveries < 0) problems.push({ field: "recoveries", problem: "must be 0 or more" });
  }
  return problems;
}

function decodeSheet<S extends typeof HeroSheetSchema | typeof StatBlockSchema>(
  schema: S,
  required: ReadonlyArray<string>,
  what: string,
  raw: unknown,
): S["Type"] | Refused {
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const label = typeof record.id === "string" ? `'${quote(record.id)}'` : "That";
  const missing = required.find((key) => !(key in record));
  if (missing !== undefined) return { refusal: `${label} isn't ${what}: ${missing} is missing.` };
  let sheet: S["Type"];
  try {
    sheet = Schema.decodeUnknownSync(schema)(raw) as S["Type"];
  } catch (e) {
    return { refusal: `${label} isn't ${what}: ${oneLine(e)}.` };
  }
  const problems = sheetProblems(sheet);
  if (problems.length > 0)
    return {
      refusal: `${label} can't be used: ${problems.map((p) => `${p.field} ${p.problem}`).join("; ")}.`,
    };
  return sheet;
}

/** Reads a hero sheet from parsed JSON, YAML or TOML, or says what is wrong with it. */
export function decodeHeroSheet(raw: unknown): HeroSheet | Refused {
  return decodeSheet(HeroSheetSchema, REQUIRED_HERO, "a hero sheet", raw);
}

/** Reads a stat block from parsed JSON, YAML or TOML, or says what is wrong with it. */
export function decodeStatBlock(raw: unknown): StatBlock | Refused {
  return decodeSheet(StatBlockSchema, REQUIRED_BLOCK, "a stat block", raw);
}
