import { basename, extname } from "node:path";
import { Effect, Schema, SchemaIssue } from "effect";
import {
  decodeHeroSheet,
  decodeStatBlock,
  ID_MAX,
  sheetProblems,
} from "../game/drawSteel/schema.ts";
import type {
  Ability,
  Characteristic,
  DamageModifier,
  HeroSheet,
  Organization,
  StatBlock,
} from "../game/drawSteel/sheets.ts";
import { SheetInvalid } from "./errors.ts";
import { toYaml } from "./yaml.ts";

// The hero and monster files a GM writes by hand: one YAML file per sheet, named for its id
// (heroes/vex.yaml, monsters/goblin-warrior.yaml). Field names are the sheet's own, so the
// decoded file is the sheet less its id, with a few friendlier shapes: immunities as
// `{ fire: 5 }`, a single characteristic without brackets, keywords as one comma-separated line.
// Text may run over several lines (a folded `>` or literal `|` block): every run of whitespace in
// it becomes one space, since the table draws each field on one line.

export const CHARACTERISTICS: ReadonlyArray<Characteristic> = [
  "might",
  "agility",
  "reason",
  "intuition",
  "presence",
];

export const ORGANIZATIONS: ReadonlyArray<Organization> = [
  "minion",
  "horde",
  "platoon",
  "elite",
  "leader",
  "solo",
];

// Every schema carries the message a GM reads after the field's name, on the type and on each
// check, so "characteristics.might must be a whole number from -5 to 5" is the whole story.

const text = Schema.String.annotate({ message: "must be text" });

const nonEmptyText = Schema.String.annotate({ message: "must be text" }).check(
  Schema.isNonEmpty({ message: "must not be empty" }),
);

const wholeNumber = (message: string) =>
  Schema.Number.annotate({ message }).check(Schema.isInt({ message }));

const atLeast = (minimum: number) => {
  const message = `must be a whole number, ${minimum} or more`;
  return Schema.Number.annotate({ message }).check(
    Schema.isInt({ message }),
    Schema.isGreaterThanOrEqualTo(minimum, { message }),
  );
};

const between = (minimum: number, maximum: number) => {
  const message = `must be a whole number from ${minimum} to ${maximum}`;
  return Schema.Number.annotate({ message }).check(
    Schema.isInt({ message }),
    Schema.isBetween({ minimum, maximum }, { message }),
  );
};

const CharacteristicName = Schema.Literals(CHARACTERISTICS).annotate({
  message: `must be one of ${CHARACTERISTICS.join(", ")}`,
});

const Characteristics = Schema.Struct({
  might: between(-5, 5),
  agility: between(-5, 5),
  reason: between(-5, 5),
  intuition: between(-5, 5),
  presence: between(-5, 5),
});

/** `{ fire: 5, poison: 3 }`; "all" matches every damage type. */
const DamageModifiers = Schema.Record(Schema.String, atLeast(0)).annotate({
  message: "must be damage types with numbers, like { fire: 5 }",
});

const AbilityFile = Schema.Struct({
  name: nonEmptyText,
  kind: Schema.optionalKey(text),
  characteristics: Schema.optionalKey(
    Schema.Union([CharacteristicName, Schema.Array(CharacteristicName)]).annotate({
      message: "must be a characteristic, or a list of them like [might, agility]",
    }),
  ),
  bonus: Schema.optionalKey(wholeNumber("must be a whole number")),
  cost: Schema.optionalKey(atLeast(0)),
  keywords: Schema.optionalKey(
    Schema.Union([text, Schema.Array(text)]).annotate({
      message: "must be text, or a list like [Melee, Strike]",
    }),
  ),
  distance: Schema.optionalKey(text),
  target: Schema.optionalKey(text),
  tier1: Schema.optionalKey(text),
  tier2: Schema.optionalKey(text),
  tier3: Schema.optionalKey(text),
  effect: Schema.optionalKey(text),
});

const perTurnMessage = "must be a whole number or dice like 1d3";
const PerTurn = Schema.Union([
  wholeNumber(perTurnMessage),
  Schema.String.check(Schema.isPattern(/^\d*d\d+([+-]\d+)?$/, { message: perTurnMessage })),
]).annotate({ message: perTurnMessage });

const sharedFields = {
  name: nonEmptyText,
  characteristics: Characteristics,
  stamina: atLeast(1),
  speed: atLeast(0),
  stability: Schema.optionalKey(atLeast(0)),
  immunities: Schema.optionalKey(DamageModifiers),
  weaknesses: Schema.optionalKey(DamageModifiers),
  abilities: Schema.optionalKey(
    Schema.Array(AbilityFile).annotate({
      message: "must be a list of abilities, each starting with -",
    }),
  ),
};

const HeroFile = Schema.Struct({
  ...sharedFields,
  class: nonEmptyText,
  level: between(1, 10),
  recoveries: atLeast(0),
  recoveryValue: Schema.optionalKey(atLeast(0)),
  resource: Schema.Struct({
    name: nonEmptyText,
    perTurn: PerTurn,
    min: Schema.optionalKey(between(-10, 0)),
  }),
  victories: Schema.optionalKey(atLeast(0)),
}).annotate({ message: "must be a list of fields like `name: Vex`, one per line" });

const MonsterFile = Schema.Struct({
  ...sharedFields,
  level: atLeast(1),
  organization: Schema.Literals(ORGANIZATIONS).annotate({
    message: `must be one of ${ORGANIZATIONS.join(", ")}`,
  }),
  role: Schema.optionalKey(text),
  ev: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Number]).annotate({ message: "must be text or a number" }),
  ),
  freeStrike: atLeast(0),
  withCaptain: Schema.optionalKey(text),
}).annotate({ message: "must be a list of fields like `name: Goblin Warrior`, one per line" });

type AbilityFile = typeof AbilityFile.Type;

/** The sheet id a file stands for: its name without the extension. */
export const idOf = (file: string) => basename(file, extname(file));

/** "abilities[2].tier1": keys joined with dots, list positions counted from 1 as a GM would. */
const fieldPath = (path: ReadonlyArray<PropertyKey>) =>
  path.reduce<string>(
    (s, key) =>
      typeof key === "number" ? `${s}[${key + 1}]` : s === "" ? String(key) : `${s}.${String(key)}`,
    "",
  );

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) =>
    issue._tag === "MissingKey"
      ? "is required"
      : issue._tag === "UnexpectedKey"
        ? "is not a field supervillain knows (check the spelling)"
        : SchemaIssue.defaultLeafHook(issue),
});

const invalid = (file: string, problems: ReadonlyArray<string>) =>
  new SheetInvalid({
    file,
    problems,
    message: problems.map((p) => `${file}: ${p}`).join("\n"),
  });

/** Every string value in parsed YAML, however deep, with its whitespace folded to single spaces. */
const folded = (value: unknown): unknown =>
  typeof value === "string"
    ? value.replace(/\s+/g, " ").trim()
    : Array.isArray(value)
      ? value.map(folded)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, folded(v)]))
        : value;

/** Parses the YAML and decodes it with `schema`, every problem named by file and field. */
const decodeFile = <S extends Schema.Decoder<unknown>>(schema: S, file: string, text: string) =>
  Effect.try({
    try: () => folded(Bun.YAML.parse(text)),
    catch: (e) =>
      invalid(file, [
        `isn't valid YAML (${(e instanceof Error ? e.message : String(e)).replace(/^YAML Parse error: /, "")})`,
      ]),
  }).pipe(
    Effect.flatMap((data) =>
      Schema.decodeUnknownEffect(schema)(data, { errors: "all", onExcessProperty: "error" }),
    ),
    Effect.catchTag("SchemaError", (e) =>
      Effect.fail(
        invalid(
          file,
          formatIssues(e.issue).issues.map(({ path = [], message }) =>
            path.length === 0 ? message : `${fieldPath(path.map(keyOf))} ${message}`,
          ),
        ),
      ),
    ),
  );

/** Standard Schema paths may hold `{ key }` segments; ours are plain keys, but be safe. */
const keyOf = (segment: PropertyKey | { readonly key: PropertyKey }): PropertyKey =>
  typeof segment === "object" ? segment.key : segment;

const modifiers = (record: Readonly<Record<string, number>>) =>
  Object.entries(record).map(([type, value]): DamageModifier => ({ type, value }));

const toAbility = (a: AbilityFile): Ability => {
  const { characteristics, keywords, ...rest } = a;
  return {
    ...rest,
    ...(characteristics === undefined
      ? {}
      : {
          characteristics:
            typeof characteristics === "string" ? [characteristics] : characteristics,
        }),
    ...(keywords === undefined
      ? {}
      : {
          keywords:
            typeof keywords === "string"
              ? keywords
                  .split(",")
                  .map((k) => k.trim())
                  .filter((k) => k !== "")
              : keywords,
        }),
  };
};

/** The fields heroes and monsters share, with their defaults. */
const shared = (file: SharedDecoded) => ({
  ...(file.immunities === undefined ? {} : { immunities: modifiers(file.immunities) }),
  ...(file.weaknesses === undefined ? {} : { weaknesses: modifiers(file.weaknesses) }),
  stability: file.stability ?? 0,
  abilities: (file.abilities ?? []).map(toAbility),
});

type SharedDecoded = Pick<
  typeof HeroFile.Type,
  "immunities" | "weaknesses" | "stability" | "abilities"
>;

/**
 * Holds a decoded sheet to the rules' own checks, so a file that loads is one the table accepts:
 * the problems name the file and the field, as the file's own do.
 */
const usable =
  <A extends HeroSheet | StatBlock>(
    file: string,
    decode: (raw: unknown) => A | { refusal: string },
  ) =>
  (sheet: A): Effect.Effect<A, SheetInvalid> => {
    // The id is the file name, so a problem with it is said of the file name.
    const problems = sheetProblems(sheet).map(({ field, problem }) =>
      field !== "id"
        ? `${field} ${problem}`
        : problem === `must be at most ${ID_MAX} characters`
          ? `the file name (the id) ${problem}`
          : `the file name is the id, so it ${problem}`,
    );
    if (problems.length > 0) return Effect.fail(invalid(file, problems));
    // The same gate decide runs; anything it still refuses is a gap between the two schemas.
    const decoded = decode(sheet);
    return "refusal" in decoded
      ? Effect.fail(invalid(file, [decoded.refusal]))
      : Effect.succeed(sheet);
  };

/**
 * Decodes a hero file. `file` is its path in the campaign ("heroes/vex.yaml"): the id comes from
 * it and every error names it. Recovery value defaults to a third of Stamina, rounded down.
 */
export const decodeHero = (file: string, text: string): Effect.Effect<HeroSheet, SheetInvalid> =>
  Effect.map(
    decodeFile(HeroFile, file, text),
    (h): HeroSheet => ({
      id: idOf(file),
      name: h.name,
      class: h.class,
      level: h.level,
      characteristics: h.characteristics,
      stamina: h.stamina,
      recoveries: h.recoveries,
      recoveryValue: h.recoveryValue ?? Math.floor(h.stamina / 3),
      speed: h.speed,
      resource: h.resource,
      victories: h.victories ?? 0,
      ...shared(h),
    }),
  ).pipe(Effect.flatMap(usable<HeroSheet>(file, decodeHeroSheet)));

/** Decodes a monster file, as `decodeHero` does a hero. */
export const decodeMonster = (file: string, text: string): Effect.Effect<StatBlock, SheetInvalid> =>
  Effect.map(
    decodeFile(MonsterFile, file, text),
    (m): StatBlock => ({
      id: idOf(file),
      name: m.name,
      level: m.level,
      organization: m.organization,
      ...(m.role === undefined ? {} : { role: m.role }),
      ...(m.ev === undefined ? {} : { ev: String(m.ev) }),
      stamina: m.stamina,
      speed: m.speed,
      freeStrike: m.freeStrike,
      characteristics: m.characteristics,
      ...(m.withCaptain === undefined ? {} : { withCaptain: m.withCaptain }),
      ...shared(m),
    }),
  ).pipe(Effect.flatMap(usable<StatBlock>(file, decodeStatBlock)));

const modifierRecord = (list: ReadonlyArray<DamageModifier> | undefined) =>
  list === undefined || list.length === 0
    ? undefined
    : Object.fromEntries(list.map((m) => [m.type, m.value]));

/** An ability's fields in the order a stat block prints them. */
const inPrintedOrder = (a: Ability): Ability => ({
  name: a.name,
  kind: a.kind,
  characteristics: a.characteristics,
  bonus: a.bonus,
  cost: a.cost,
  keywords: a.keywords,
  distance: a.distance,
  target: a.target,
  tier1: a.tier1,
  tier2: a.tier2,
  tier3: a.tier3,
  effect: a.effect,
});

/** A stat block as a monster file, `header` lines as comments on top. The id is the file's name. */
export function monsterYaml(block: StatBlock, header: ReadonlyArray<string> = []): string {
  return toYaml(
    {
      name: block.name,
      level: block.level,
      organization: block.organization,
      role: block.role,
      ev: block.ev,
      stamina: block.stamina,
      speed: block.speed,
      stability: block.stability,
      freeStrike: block.freeStrike,
      characteristics: block.characteristics,
      immunities: modifierRecord(block.immunities),
      weaknesses: modifierRecord(block.weaknesses),
      withCaptain: block.withCaptain,
      abilities: block.abilities.length === 0 ? undefined : block.abilities.map(inPrintedOrder),
    },
    header,
  );
}
