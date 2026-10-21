import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { Effect, Option, Schema } from "effect";
import type {
  Ability,
  Characteristic,
  DamageModifier,
  Organization,
  StatBlock,
} from "../game/drawSteel/sheets.ts";
import { ContentReadError } from "./errors.ts";
import { CHARACTERISTICS, decodeMonster, monsterYaml, ORGANIZATIONS } from "./sheetFiles.ts";

// Steel Compendium's data-bestiary-json, one creature per file: `level`, `roles` ("Minion
// Harrier", organization and role in one string), `ev` and `stamina` as text, `speed`,
// `stability`, `free_strike`, `with_captain`, the five characteristics (numbers or "+2"), and
// `features[]` whose `effects[]` carry `roll` and `tier1..3`. We read a GM's local copy; we never
// bundle theirs. The converter is tolerant: what it can't read it leaves out and says so.

/** A converted stat block and what was left out of it, or why the creature couldn't be read. */
export type Converted =
  | { readonly ok: true; readonly sheet: StatBlock; readonly skipped: ReadonlyArray<string> }
  | { readonly ok: false; readonly name: string; readonly problems: ReadonlyArray<string> };

const Raw = Schema.Record(Schema.String, Schema.Unknown);
type Raw = typeof Raw.Type;
const decodeRaw = Schema.decodeUnknownOption(Raw);

const Named = Schema.Struct({ name: Schema.String.check(Schema.isNonEmpty()) });
const decodeNamed = Schema.decodeUnknownOption(Named);

const Strings = Schema.Array(Schema.String);
const decodeStrings = Schema.decodeUnknownOption(Strings);

const show = (v: unknown) => JSON.stringify(v) ?? String(v);

/** Their text uses a real minus sign (−) and the odd en dash. */
const normalized = (s: string) => s.replace(/[−–]/g, "-").trim();

/** A whole number at the start of `value` ("5", "+2", "5 (swim)") and the text after it. */
function leadingInt(value: unknown): { readonly n: number; readonly rest: string } | undefined {
  if (typeof value === "number")
    return Number.isInteger(value) ? { n: value, rest: "" } : undefined;
  if (typeof value !== "string") return undefined;
  const m = /^([+-]?\d+)\s*(.*)$/s.exec(normalized(value));
  return m === null ? undefined : { n: Number(m[1]), rest: m[2]!.trim() };
}

/** "Fire 5" → { type: "fire", value: 5 }. */
function modifier(item: unknown): DamageModifier | undefined {
  if (typeof item !== "string") return undefined;
  const m = /^([a-z][a-z ]*?)\s+(\d+)$/i.exec(normalized(item));
  return m === null ? undefined : { type: m[1]!.toLowerCase(), value: Number(m[2]) };
}

/** A list of strings, or one comma-separated string. */
const textList = (value: unknown): ReadonlyArray<unknown> =>
  typeof value === "string"
    ? value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "")
    : Array.isArray(value)
      ? value
      : [];

/** "Goblin Warrior" → "goblin-warrior". */
export const slug = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "monster";

/** Converts one creature from Steel Compendium JSON into a stat block. Pure. */
export function convertMonster(input: unknown): Converted {
  const raw = Option.getOrElse(decodeRaw(input), (): Raw => ({}));
  const name = typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name.trim() : undefined;
  const problems: string[] = [];
  const skipped: string[] = [];

  /** A whole number the stat block can't do without. */
  const required = (field: string, value: unknown): number => {
    if (value === undefined || value === null) {
      problems.push(`${field}: missing`);
      return 0;
    }
    const read = leadingInt(value);
    if (read === undefined) {
      problems.push(`${field}: no number in ${show(value)}`);
      return 0;
    }
    if (read.rest !== "") skipped.push(`${field}: kept ${read.n}, left out ${show(read.rest)}`);
    return read.n;
  };

  if (name === undefined) problems.push("name: missing");
  const level = required("level", raw.level);

  const roleWords = textList(raw.roles)
    .filter((r): r is string => typeof r === "string")
    .flatMap((r) => r.split(/\s+/).filter((w) => w !== ""));
  const organization = roleWords
    .map((w) => w.toLowerCase())
    .find((w): w is Organization => (ORGANIZATIONS as ReadonlyArray<string>).includes(w));
  const role = roleWords
    .filter((w) => w.toLowerCase() !== organization)
    .join(" ")
    .toLowerCase();
  if (raw.roles === undefined) problems.push("roles: missing");
  else if (organization === undefined)
    problems.push(
      `roles: no organization in ${show(textList(raw.roles).join(", "))} (expected one of ${ORGANIZATIONS.join(", ")})`,
    );

  let ev: string | undefined;
  if (typeof raw.ev === "string" && raw.ev.trim() !== "") ev = raw.ev.trim();
  else if (typeof raw.ev === "number") ev = String(raw.ev);
  else if (raw.ev !== undefined && raw.ev !== null && raw.ev !== "")
    skipped.push(`ev: left out ${show(raw.ev)} (not text)`);

  const stamina = required("stamina", raw.stamina);
  const speed = required("speed", raw.speed);
  const stability = required("stability", raw.stability);
  const freeStrike = required("free_strike", raw.free_strike);
  const nested = Option.getOrElse(decodeRaw(raw.characteristics), (): Raw => ({}));
  const characteristics = Object.fromEntries(
    CHARACTERISTICS.map((c) => [c, required(c, raw[c] ?? nested[c])]),
  ) as Record<Characteristic, number>;

  const modifiers = (field: "immunities" | "weaknesses") => {
    const out: DamageModifier[] = [];
    for (const item of textList(raw[field])) {
      const m = modifier(item);
      if (m === undefined)
        skipped.push(
          `${field}: left out ${show(item)} (expected a damage type and a number, like "fire 5")`,
        );
      else out.push(m);
    }
    return out;
  };
  const immunities = modifiers("immunities");
  const weaknesses = modifiers("weaknesses");

  let withCaptain: string | undefined;
  if (typeof raw.with_captain === "string" && raw.with_captain.trim() !== "")
    withCaptain = raw.with_captain.trim();
  else if (raw.with_captain !== undefined && raw.with_captain !== null && raw.with_captain !== "")
    skipped.push(`with_captain: left out ${show(raw.with_captain)} (not text)`);

  const abilities: Ability[] = [];
  if (raw.features !== undefined && !Array.isArray(raw.features))
    skipped.push("features: left out (not a list)");
  else
    (raw.features ?? []).forEach((feature: unknown, i: number) => {
      const ability = convertFeature(feature, skipped);
      if (ability === undefined)
        skipped.push(`features[${i + 1}]: left out (not a feature with a name)`);
      else abilities.push(ability);
    });

  if (problems.length > 0 || name === undefined || organization === undefined)
    return { ok: false, name: name ?? "(no name)", problems };
  return {
    ok: true,
    sheet: {
      id: slug(name),
      name,
      level,
      organization,
      ...(role === "" ? {} : { role }),
      ...(ev === undefined ? {} : { ev }),
      stamina,
      speed,
      stability,
      freeStrike,
      characteristics,
      ...(immunities.length === 0 ? {} : { immunities }),
      ...(weaknesses.length === 0 ? {} : { weaknesses }),
      abilities,
      ...(withCaptain === undefined ? {} : { withCaptain }),
    },
    skipped,
  };
}

const TIERS = ["tier1", "tier2", "tier3"] as const;

/** One feature (an ability or a trait) as an ability; undefined when it has no name. */
function convertFeature(feature: unknown, skipped: string[]): Ability | undefined {
  const named = decodeNamed(feature);
  if (Option.isNone(named)) return undefined;
  const raw = Option.getOrElse(decodeRaw(feature), (): Raw => ({}));
  const name = named.value.name.trim();
  const ability: { -readonly [K in keyof Ability]: Ability[K] } = { name };

  const text = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
  const kind = text(raw.usage) ?? (raw.feature_type === "trait" ? "Trait" : undefined);
  if (kind !== undefined) ability.kind = kind;
  const keywords = Option.getOrElse(decodeStrings(textList(raw.keywords)), () => []);
  if (keywords.length > 0) ability.keywords = keywords;
  const distance = text(raw.distance);
  if (distance !== undefined) ability.distance = distance;
  const target = text(raw.target);
  if (target !== undefined) ability.target = target;
  if (raw.cost !== undefined && raw.cost !== null) {
    const m = typeof raw.cost === "number" ? [String(raw.cost)] : /\d+/.exec(String(raw.cost));
    if (m === null) skipped.push(`${name}: left out the cost (no number in ${show(raw.cost)})`);
    else ability.cost = Number(m[0]);
  }

  const effects: string[] = [];
  for (const entry of Array.isArray(raw.effects) ? raw.effects : []) {
    const effect = Option.getOrElse(decodeRaw(entry), (): Raw => ({}));
    if (effect.roll !== undefined && ability.bonus === undefined) {
      const m = /([+-])\s*(\d+)/.exec(normalized(String(effect.roll)));
      if (m === null)
        skipped.push(`${name}: left out the roll bonus (no number in ${show(effect.roll)})`);
      else ability.bonus = Number(`${m[1]}${m[2]}`);
    }
    for (const tier of TIERS) {
      if (effect[tier] === undefined || ability[tier] !== undefined) continue;
      const t = text(effect[tier]);
      if (t === undefined) skipped.push(`${name}: left out ${tier} (not text)`);
      else ability[tier] = t;
    }
    const said = text(effect.effect);
    if (said !== undefined) {
      const label = text(effect.name);
      effects.push(
        label === undefined || label.toLowerCase() === "effect" ? said : `${label}: ${said}`,
      );
    }
  }
  // One line, as the table draws every field.
  if (effects.length > 0) ability.effect = effects.join(" ");
  return ability;
}

export interface ImportOptions {
  /** A local copy of data-bestiary-json: the folder (searched all the way down) or one file. */
  readonly from: string;
  /** The campaign folder; files go in its `monsters/`. */
  readonly into: string;
  /** Creatures to import, by name or id: exact first, then a unique prefix. All of them if empty. */
  readonly names?: ReadonlyArray<string>;
  /** Replace a monster file that's already there. Off, so a GM's edits are never lost. */
  readonly overwrite?: boolean;
}

export interface ImportedMonster {
  readonly name: string;
  readonly id: string;
  /** Relative to the campaign: "monsters/goblin-warrior.yaml". */
  readonly file: string;
  /** "exists" when the file was there already and left alone. */
  readonly status: "written" | "exists";
  readonly skipped: ReadonlyArray<string>;
}

export interface ImportReport {
  readonly imported: ReadonlyArray<ImportedMonster>;
  readonly failed: ReadonlyArray<{
    readonly name: string;
    /** The source file, relative to `from`. */
    readonly source: string;
    readonly problems: ReadonlyArray<string>;
  }>;
  /** Names asked for that matched no creature. */
  readonly notFound: ReadonlyArray<string>;
  /** Names that matched several creatures; none of them was imported. */
  readonly ambiguous: ReadonlyArray<{
    readonly query: string;
    readonly matches: ReadonlyArray<string>;
  }>;
  /** Source files that couldn't be read: "path: why". */
  readonly unreadable: ReadonlyArray<string>;
}

interface Candidate {
  readonly name: string;
  readonly source: string;
  readonly raw: unknown;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A creature looks like `{ name, stamina | free_strike | roles, … }`; other JSON is ignored. */
const isCreature = (v: unknown): v is Raw & { name: string } =>
  Option.match(decodeRaw(v), {
    onNone: () => false,
    onSome: (r) =>
      typeof r.name === "string" &&
      (r.stamina !== undefined || r.free_strike !== undefined || r.roles !== undefined),
  });

/** Every creature in the source, from each JSON file (one creature or a list of them). */
const readSource = (from: string) =>
  Effect.tryPromise({
    try: async () => {
      const info = await stat(from);
      const files = info.isDirectory()
        ? (await readdir(from, { recursive: true }))
            .map(String)
            .filter((p) => p.toLowerCase().endsWith(".json"))
            .filter(
              (p) =>
                !p.split(/[\\/]/).some((part) => part.startsWith(".") || part === "node_modules"),
            )
            .toSorted()
            .map((p) => join(from, p))
        : [from];
      const creatures: Candidate[] = [];
      const unreadable: string[] = [];
      for (const path of files) {
        const source = info.isDirectory() ? relative(from, path) : basename(path);
        let parsed: unknown;
        try {
          parsed = JSON.parse(await readFile(path, "utf8"));
        } catch (e) {
          unreadable.push(
            `${source}: ${e instanceof SyntaxError ? "not valid JSON" : messageOf(e)}`,
          );
          continue;
        }
        for (const v of Array.isArray(parsed) ? parsed : [parsed])
          if (isCreature(v)) creatures.push({ name: v.name.trim(), source, raw: v });
      }
      return { creatures, unreadable };
    },
    catch: (e) => new ContentReadError({ message: `can't read ${from}: ${messageOf(e)}` }),
  });

/** The creatures the names pick out: exact name or id first, then a unique prefix of either. */
function pick(creatures: ReadonlyArray<Candidate>, names: ReadonlyArray<string>) {
  if (names.length === 0) return { chosen: creatures, notFound: [], ambiguous: [] };
  const chosen = new Set<Candidate>();
  const notFound: string[] = [];
  const ambiguous: { query: string; matches: string[] }[] = [];
  for (const query of names) {
    const q = query.trim().toLowerCase();
    const id = slug(query);
    const exact = creatures.filter((c) => c.name.toLowerCase() === q || slug(c.name) === id);
    const prefix = creatures.filter(
      (c) => c.name.toLowerCase().startsWith(q) || slug(c.name).startsWith(id),
    );
    const found = exact.length > 0 ? exact.slice(0, 1) : prefix;
    if (found.length === 0) notFound.push(query);
    else if (found.length > 1 && new Set(found.map((c) => c.name)).size > 1)
      ambiguous.push({ query, matches: [...new Set(found.map((c) => c.name))].toSorted() });
    else chosen.add(found[0]!);
  }
  return { chosen: [...chosen], notFound, ambiguous };
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/**
 * Imports creatures from a local copy of Steel Compendium's data-bestiary-json into a campaign's
 * `monsters/` folder as monster files, each checked by reading it back as the loader would.
 * Reports per monster what was written, what was left out, and what couldn't be read.
 */
export const importBestiary = (
  options: ImportOptions,
): Effect.Effect<ImportReport, ContentReadError> =>
  Effect.gen(function* () {
    const { creatures, unreadable } = yield* readSource(options.from);
    const { chosen, notFound, ambiguous } = pick(creatures, options.names ?? []);
    const imported: ImportedMonster[] = [];
    const failed: { name: string; source: string; problems: ReadonlyArray<string> }[] = [];
    const written = new Set<string>();

    for (const creature of chosen) {
      const converted = convertMonster(creature.raw);
      if (!converted.ok) {
        failed.push({
          name: converted.name,
          source: creature.source,
          problems: converted.problems,
        });
        continue;
      }
      const { sheet, skipped } = converted;
      const file = `monsters/${sheet.id}.yaml`;
      if (written.has(sheet.id)) {
        failed.push({
          name: sheet.name,
          source: creature.source,
          problems: [`another creature in this import was already written to ${file}`],
        });
        continue;
      }
      const text = monsterYaml(sheet, [
        `Imported by supervillain from ${creature.source}.`,
        "Check it against Draw Steel: Monsters before play.",
        ...(skipped.length === 0 ? [] : ["Left out:", ...skipped.map((s) => `  ${s}`)]),
      ]);
      // What we write must load; a converter bug shows up here, not at the table.
      const check = yield* Effect.result(decodeMonster(file, text));
      if (check._tag === "Failure") {
        failed.push({
          name: sheet.name,
          source: creature.source,
          problems: check.failure.problems,
        });
        continue;
      }
      const path = join(options.into, file);
      if (!options.overwrite && (yield* Effect.promise(() => exists(path)))) {
        imported.push({ name: sheet.name, id: sheet.id, file, status: "exists", skipped });
        continue;
      }
      yield* Effect.tryPromise({
        try: async () => {
          // A campaign folder will hold every word said at the table: a new one is its owner's alone.
          await mkdir(options.into, { recursive: true, mode: 0o700 });
          await mkdir(join(options.into, "monsters"), { recursive: true });
          await writeFile(path, text);
        },
        catch: (e) => new ContentReadError({ message: `can't write ${path}: ${messageOf(e)}` }),
      });
      written.add(sheet.id);
      imported.push({ name: sheet.name, id: sheet.id, file, status: "written", skipped });
    }

    return {
      imported: imported.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      failed: failed.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      notFound,
      ambiguous,
      unreadable,
    };
  });

/** The report as lines for the terminal. */
export function importReportText(report: ImportReport): ReadonlyArray<string> {
  return [
    ...report.imported.map((m) =>
      m.status === "written"
        ? `wrote ${m.file} (${m.name})${m.skipped.length === 0 ? "" : `, leaving out ${m.skipped.length === 1 ? "one thing" : `${m.skipped.length} things`} (see its header)`}`
        : `kept ${m.file} (${m.name}): it exists; --overwrite replaces it`,
    ),
    ...report.failed.flatMap((m) => [
      `couldn't import ${m.name} (${m.source}):`,
      ...m.problems.map((p) => `  ${p}`),
    ]),
    ...report.notFound.map((n) => `no monster named ${show(n)}`),
    ...report.ambiguous.map((a) => `${show(a.query)} could be: ${a.matches.join(", ")}`),
    ...report.unreadable,
  ];
}
