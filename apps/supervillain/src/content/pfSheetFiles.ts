import {
	decodePfSheet,
	ifDefined,
	pfSheetProblems,
	SAVES,
	SIZES,
} from "@supervillain/domain";
import type {
	SheetInvalid,
	PfAbility,
	PfAmount,
	PfSheet,
	PfSpell,
	PfSpells,
	PfStrikeEntry,
} from "@supervillain/domain";
import { Effect, Option, Predicate, Schema } from "effect";

import {
	fieldPath,
	formatIssues,
	idOf,
	invalid,
	parseYaml,
	problemText,
} from "./sheetFiles.ts";
import { toYaml } from "./yaml.ts";
import type { YamlMap } from "./yaml.ts";

const text = Schema.String.annotate({ message: "must be text" });

const nonEmptyText = text.check(
	Schema.isNonEmpty({ message: "must not be empty" })
);

const whole = (message: string) =>
	Schema.Number.annotate({ message }).check(Schema.isInt({ message }));

const between = (minimum: number, maximum: number) => {
	const message = `must be a whole number from ${minimum} to ${maximum}`;

	return Schema.Number.annotate({ message }).check(
		Schema.isInt({ message }),
		Schema.isBetween({ minimum, maximum }, { message })
	);
};

const atLeast = (minimum: number) => {
	const message = `must be a whole number, ${minimum} or more`;

	return Schema.Number.annotate({ message }).check(
		Schema.isInt({ message }),
		Schema.isGreaterThanOrEqualTo(minimum, { message })
	);
};

const bonus = whole("must be a whole number like 7 or -1");

const textList = Schema.Union([text, Schema.Array(text)]).annotate({
	message: "must be text, or a list like [agile, finesse]",
});

const numbers = Schema.Record(Schema.String, atLeast(0)).annotate({
	message: "must be damage types with numbers, like { fire: 5 }",
});

const StrikeFile = Schema.Struct({
	name: nonEmptyText,
	bonus,
	damage: nonEmptyText,
	damageType: Schema.optionalKey(text),
	traits: Schema.optionalKey(textList),
	range: Schema.optionalKey(atLeast(5)),
	reach: Schema.optionalKey(atLeast(5)),
});

const AbilityFile = Schema.Struct({
	name: nonEmptyText,
	actions: Schema.optionalKey(Schema.Union([text, Schema.Finite])),
	traits: Schema.optionalKey(textList),
	text: Schema.optionalKey(text),
});

const SpellFile = Schema.Struct({
	name: nonEmptyText,
	rank: between(0, 10),
	actions: Schema.optionalKey(between(1, 3)),
	attack: Schema.optionalKey(Schema.Boolean),
	save: Schema.optionalKey(
		Schema.Literals(SAVES).annotate({ message: "must be fort, ref or will" })
	),
	basic: Schema.optionalKey(Schema.Boolean),
	damage: Schema.optionalKey(text),
	damageType: Schema.optionalKey(text),
	heal: Schema.optionalKey(text),
	range: Schema.optionalKey(atLeast(0)),
	text: Schema.optionalKey(text),
});

const SpellsFile = Schema.Struct({
	tradition: Schema.optionalKey(text),
	dc: Schema.optionalKey(atLeast(0)),
	attack: Schema.optionalKey(bonus),
	slots: Schema.optionalKey(
		Schema.Record(Schema.String, atLeast(0)).annotate({
			message: "must be ranks with counts, like { 1: 2 }",
		})
	),
	list: Schema.Array(SpellFile).annotate({
		message: "must be a list of spells, each starting with -",
	}),
});

const SheetFile = Schema.Struct({
	name: nonEmptyText,
	level: between(-1, 25),
	size: Schema.optionalKey(
		Schema.Literals(SIZES).annotate({
			message: `must be one of ${SIZES.join(", ")}`,
		})
	),
	ancestry: Schema.optionalKey(text),
	class: Schema.optionalKey(text),
	traits: Schema.optionalKey(textList),
	attributes: Schema.Struct({
		str: between(-5, 10),
		dex: between(-5, 10),
		con: between(-5, 10),
		int: between(-5, 10),
		wis: between(-5, 10),
		cha: between(-5, 10),
	}),
	hp: atLeast(1),
	speed: atLeast(0),
	perception: bonus,
	ac: atLeast(0),
	saves: Schema.Struct({ fort: bonus, ref: bonus, will: bonus }),
	classDc: Schema.optionalKey(atLeast(0)),
	skills: Schema.optionalKey(
		Schema.Record(Schema.String, bonus).annotate({
			message: "must be skills with bonuses, like { athletics: 9 }",
		})
	),
	shield: Schema.optionalKey(
		Schema.Struct({
			bonus: atLeast(0),
			hardness: atLeast(0),
			hp: atLeast(1),
			broken: atLeast(0),
		})
	),
	strikes: Schema.optionalKey(
		Schema.Array(StrikeFile).annotate({
			message: "must be a list of Strikes, each starting with -",
		})
	),
	abilities: Schema.optionalKey(
		Schema.Array(AbilityFile).annotate({
			message: "must be a list of abilities, each starting with -",
		})
	),
	spells: Schema.optionalKey(SpellsFile),
	immunities: Schema.optionalKey(textList),
	weaknesses: Schema.optionalKey(numbers),
	resistances: Schema.optionalKey(numbers),
	flurry: Schema.optionalKey(Schema.Boolean),
}).annotate({
	message: "must be a list of fields like `name: Ari`, one per line",
});

type SheetFile = typeof SheetFile.Type;

type StrikeFile = typeof StrikeFile.Type;

type SpellFile = typeof SpellFile.Type;

const asJson = Schema.decodeUnknownOption(Schema.Json);

const decodeFile = (file: string, source: string) =>
	parseYaml(file, source).pipe(
		Effect.flatMap((data) =>
			Schema.decodeUnknownEffect(SheetFile)(data, {
				errors: "all",
				onExcessProperty: "error",
			})
		),
		Effect.catchTag("SchemaError", (e) =>
			Effect.fail(
				invalid(
					file,
					formatIssues(e.issue).issues.map(({ path = [], message }) =>
						path.length === 0 ? message : `${fieldPath(path)} ${message}`
					)
				)
			)
		)
	);

const listOf = (
	value: string | ReadonlyArray<string> | undefined
): ReadonlyArray<string> | undefined => {
	if (value === undefined) {
		return undefined;
	}

	const items = Predicate.isString(value)
		? value.split(",").map((t) => t.trim())
		: value;

	return items.filter((t) => t !== "");
};

const amounts = (
	record: Readonly<Record<string, number>> | undefined
): ReadonlyArray<PfAmount> | undefined =>
	record === undefined
		? undefined
		: Object.entries(record).map(([type, value]) => ({ type, value }));

const DICE = /^[\dd+-]+$/u;

export interface SplitDamage {
	readonly damage: string;
	readonly damageType: string;
}

export const splitDamage = (
	damage: string,
	damageType: string | undefined
): SplitDamage => {
	if (damageType !== undefined) {
		return { damage, damageType: damageType.toLowerCase() };
	}

	const words = damage.split(" ");
	const dice = words.filter((w) => DICE.test(w)).join("");
	const kind = words.filter((w) => !DICE.test(w)).join(" ");

	return {
		damage: dice === "" ? damage : dice,
		damageType: kind.toLowerCase(),
	};
};

const toStrike = (s: StrikeFile): PfStrikeEntry => {
	const split = splitDamage(s.damage, s.damageType);

	return {
		name: s.name,
		bonus: s.bonus,
		damage: split.damage,
		damageType: split.damageType,
		...ifDefined(listOf(s.traits), (value) => ({ traits: value })),
		...ifDefined(s.range, (value) => ({ range: value })),
		...ifDefined(s.reach, (value) => ({ reach: value })),
	};
};

const toSpell = (s: SpellFile): PfSpell => {
	const split =
		s.damage === undefined ? undefined : splitDamage(s.damage, s.damageType);

	return {
		name: s.name,
		rank: s.rank,
		...ifDefined(s.actions, (value) => ({ actions: value })),
		...ifDefined(s.attack, (value) => ({ attack: value })),
		...ifDefined(s.save, (value) => ({ save: value })),
		...ifDefined(s.basic, (value) => ({ basic: value })),
		...ifDefined(split?.damage, (value) => ({ damage: value })),
		...ifDefined(
			split === undefined || split.damageType === ""
				? undefined
				: split.damageType,
			(value) => ({ damageType: value })
		),
		...ifDefined(s.heal, (value) => ({ heal: value })),
		...ifDefined(s.range, (value) => ({ range: value })),
		...ifDefined(s.text, (value) => ({ text: value })),
	};
};

const toAbility = (a: typeof AbilityFile.Type): PfAbility => ({
	name: a.name,
	...ifDefined(
		a.actions === undefined ? undefined : String(a.actions),
		(value) => ({ actions: value })
	),
	...ifDefined(listOf(a.traits), (value) => ({ traits: value })),
	...ifDefined(a.text, (value) => ({ text: value })),
});

const toSpells = (spells: typeof SpellsFile.Type): PfSpells => ({
	...ifDefined(spells.tradition, (value) => ({ tradition: value })),
	...ifDefined(spells.dc, (value) => ({ dc: value })),
	...ifDefined(spells.attack, (value) => ({ attack: value })),
	...ifDefined(spells.slots, (value) => ({
		slots: Object.entries(value).map(([rank, count]) => ({
			rank: Number(rank),
			count,
		})),
	})),
	list: spells.list.map(toSpell),
});

const toSheet = (file: string, f: SheetFile): PfSheet => ({
	id: idOf(file),
	name: f.name,
	level: f.level,
	size: f.size ?? "medium",
	...ifDefined(f.ancestry, (value) => ({ ancestry: value })),
	...ifDefined(f.class, (value) => ({ class: value })),
	...ifDefined(listOf(f.traits), (value) => ({ traits: value })),
	attributes: f.attributes,
	hp: f.hp,
	speed: f.speed,
	perception: f.perception,
	ac: f.ac,
	saves: f.saves,
	...ifDefined(f.classDc, (value) => ({ classDc: value })),
	skills: Object.entries(f.skills ?? {}).map(([name, value]) => ({
		name: name.toLowerCase(),
		bonus: value,
	})),
	...ifDefined(f.shield, (value) => ({ shield: value })),
	strikes: (f.strikes ?? []).map(toStrike),
	...ifDefined(f.abilities?.map(toAbility), (value) => ({ abilities: value })),
	...ifDefined(f.spells, (value) => ({ spells: toSpells(value) })),
	...ifDefined(listOf(f.immunities), (value) => ({ immunities: value })),
	...ifDefined(amounts(f.weaknesses), (value) => ({ weaknesses: value })),
	...ifDefined(amounts(f.resistances), (value) => ({ resistances: value })),
	...ifDefined(f.flurry, (value) => ({ flurry: value })),
});

const usable =
	(file: string) =>
	(sheet: PfSheet): Effect.Effect<PfSheet, SheetInvalid> => {
		const problems = pfSheetProblems(sheet).map((p) =>
			problemText(p.field, p.problem)
		);

		if (problems.length > 0) {
			return Effect.fail(invalid(file, problems));
		}

		const json = asJson(sheet);

		if (Option.isNone(json)) {
			return Effect.fail(invalid(file, ["isn't plain data"]));
		}

		const decoded = decodePfSheet(json.value);

		return "refusal" in decoded
			? Effect.fail(invalid(file, [decoded.refusal]))
			: Effect.succeed(decoded);
	};

export const decodePfSheetFile = (
	file: string,
	source: string
): Effect.Effect<PfSheet, SheetInvalid> =>
	decodeFile(file, source).pipe(
		Effect.map((f) => toSheet(file, f)),
		Effect.flatMap(usable(file))
	);

const recordOf = (
	list: ReadonlyArray<PfAmount> | undefined
): Readonly<Record<string, number>> | undefined =>
	list === undefined || list.length === 0
		? undefined
		: Object.fromEntries(list.map((a) => [a.type, a.value]));

const strikeYaml = (s: PfStrikeEntry) => ({
	name: s.name,
	bonus: s.bonus,
	damage: `${s.damage} ${s.damageType}`.trim(),
	traits:
		s.traits === undefined || s.traits.length === 0 ? undefined : s.traits,
	range: s.range,
	reach: s.reach,
});

const shieldYaml = (s: PfSheet["shield"]): YamlMap | undefined =>
	s === undefined
		? undefined
		: { bonus: s.bonus, hardness: s.hardness, hp: s.hp, broken: s.broken };

const abilityYaml = (a: PfAbility): YamlMap => ({
	name: a.name,
	actions: a.actions,
	traits: a.traits,
	text: a.text,
});

const slotsYaml = (slots: NonNullable<PfSheet["spells"]>["slots"]) =>
	slots === undefined
		? undefined
		: Object.fromEntries(slots.map((s) => [String(s.rank), s.count]));

const spellYaml = (s: PfSpell) => ({
	name: s.name,
	rank: s.rank,
	actions: s.actions,
	attack: s.attack,
	save: s.save,
	basic: s.basic,
	damage:
		s.damage === undefined
			? undefined
			: `${s.damage} ${s.damageType ?? ""}`.trim(),
	heal: s.heal,
	range: s.range,
	text: s.text,
});

export const pfSheetYaml = (
	sheet: PfSheet,
	header: ReadonlyArray<string> = []
): string =>
	toYaml(
		{
			name: sheet.name,
			level: sheet.level,
			size: sheet.size,
			ancestry: sheet.ancestry,
			class: sheet.class,
			traits:
				sheet.traits === undefined || sheet.traits.length === 0
					? undefined
					: sheet.traits,
			attributes: sheet.attributes,
			hp: sheet.hp,
			speed: sheet.speed,
			perception: sheet.perception,
			ac: sheet.ac,
			saves: sheet.saves,
			classDc: sheet.classDc,
			skills:
				sheet.skills.length === 0
					? undefined
					: Object.fromEntries(sheet.skills.map((s) => [s.name, s.bonus])),
			shield: shieldYaml(sheet.shield),
			strikes:
				sheet.strikes.length === 0 ? undefined : sheet.strikes.map(strikeYaml),
			abilities:
				sheet.abilities === undefined || sheet.abilities.length === 0
					? undefined
					: sheet.abilities.map(abilityYaml),
			spells:
				sheet.spells === undefined
					? undefined
					: {
							tradition: sheet.spells.tradition,
							dc: sheet.spells.dc,
							attack: sheet.spells.attack,
							slots: slotsYaml(sheet.spells.slots),
							list: sheet.spells.list.map(spellYaml),
						},
			immunities:
				sheet.immunities === undefined || sheet.immunities.length === 0
					? undefined
					: sheet.immunities,
			weaknesses: recordOf(sheet.weaknesses),
			resistances: recordOf(sheet.resistances),
			flurry: sheet.flurry,
		},
		header
	);

export const PfSheetFileSchema = SheetFile;
