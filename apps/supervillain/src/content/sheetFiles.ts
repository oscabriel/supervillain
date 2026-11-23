import path from "node:path";

import {
	CHARACTERISTICS,
	decodeHeroSheet,
	decodeStatBlock,
	ID_MAX,
	sheetProblems,
	SheetInvalid,
	ifDefined,
} from "@supervillain/domain";
import type {
	Ability,
	DamageModifier,
	HeroSheet,
	Organization,
	StatBlock,
} from "@supervillain/domain";
import { Effect, Option, Predicate, Schema, SchemaIssue } from "effect";

import { toYaml } from "./yaml.ts";

export { CHARACTERISTICS };

export const ORGANIZATIONS: ReadonlyArray<Organization> = [
	"minion",
	"horde",
	"platoon",
	"elite",
	"leader",
	"solo",
];

const text = Schema.String.annotate({ message: "must be text" });

const nonEmptyText = Schema.String.annotate({ message: "must be text" }).check(
	Schema.isNonEmpty({ message: "must not be empty" })
);

const wholeNumber = (message: string) =>
	Schema.Number.annotate({ message }).check(Schema.isInt({ message }));

const atLeast = (minimum: number) => {
	const message = `must be a whole number, ${minimum} or more`;

	return Schema.Number.annotate({ message }).check(
		Schema.isInt({ message }),
		Schema.isGreaterThanOrEqualTo(minimum, { message })
	);
};

const between = (minimum: number, maximum: number) => {
	const message = `must be a whole number from ${minimum} to ${maximum}`;

	return Schema.Number.annotate({ message }).check(
		Schema.isInt({ message }),
		Schema.isBetween({ minimum, maximum }, { message })
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

const DamageModifiers = Schema.Record(Schema.String, atLeast(0)).annotate({
	message: "must be damage types with numbers, like { fire: 5 }",
});

const AbilityFile = Schema.Struct({
	name: nonEmptyText,
	kind: Schema.optionalKey(text),
	characteristics: Schema.optionalKey(
		Schema.Union([
			CharacteristicName,
			Schema.Array(CharacteristicName),
		]).annotate({
			message:
				"must be a characteristic, or a list of them like [might, agility]",
		})
	),
	bonus: Schema.optionalKey(wholeNumber("must be a whole number")),
	cost: Schema.optionalKey(atLeast(0)),
	keywords: Schema.optionalKey(
		Schema.Union([text, Schema.Array(text)]).annotate({
			message: "must be text, or a list like [Melee, Strike]",
		})
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
	Schema.String.check(
		Schema.isPattern(/^\d*d\d+(?:[+-]\d+)?$/u, { message: perTurnMessage })
	),
]).annotate({ message: perTurnMessage });

const sharedFields = {
	name: nonEmptyText,
	characteristics: Characteristics,
	stamina: atLeast(1),
	speed: atLeast(0),
	stability: Schema.optionalKey(atLeast(0)),
	size: Schema.optionalKey(
		Schema.Union([Schema.String, Schema.Finite]).annotate({
			message: "must be a size like 1T, 1S, 1M, 1L, 2, 3 or 4",
		})
	),
	immunities: Schema.optionalKey(DamageModifiers),
	weaknesses: Schema.optionalKey(DamageModifiers),
	abilities: Schema.optionalKey(
		Schema.Array(AbilityFile).annotate({
			message: "must be a list of abilities, each starting with -",
		})
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
}).annotate({
	message: "must be a list of fields like `name: Vex`, one per line",
});

const MonsterFile = Schema.Struct({
	...sharedFields,
	level: atLeast(1),
	organization: Schema.Literals(ORGANIZATIONS).annotate({
		message: `must be one of ${ORGANIZATIONS.join(", ")}`,
	}),
	role: Schema.optionalKey(text),
	ev: Schema.optionalKey(
		Schema.Union([Schema.String, Schema.Finite]).annotate({
			message: "must be text or a number",
		})
	),
	freeStrike: atLeast(0),
	withCaptain: Schema.optionalKey(text),
}).annotate({
	message: "must be a list of fields like `name: Goblin Warrior`, one per line",
});

type AbilityFile = typeof AbilityFile.Type;

export const idOf = (file: string) => path.basename(file, path.extname(file));

const keyText = (
	segment: PropertyKey | { readonly key: PropertyKey }
): string => {
	if (Predicate.isNumber(segment)) {
		return `[${segment + 1}]`;
	}

	if (Predicate.isString(segment)) {
		return segment;
	}

	return Predicate.isSymbol(segment) ? String(segment) : keyText(segment.key);
};

export const fieldPath = (
	segments: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>
): string =>
	segments
		.map(keyText)
		.map((part, i) => (i === 0 || part.startsWith("[") ? part : `.${part}`))
		.join("");

export const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1({
	leafHook: (issue) => {
		if (Predicate.isTagged(issue, "MissingKey")) {
			return "is required";
		}

		return Predicate.isTagged(issue, "UnexpectedKey")
			? "is not a field supervillain knows (check the spelling)"
			: SchemaIssue.defaultLeafHook(issue);
	},
});

export const invalid = (file: string, problems: ReadonlyArray<string>) =>
	new SheetInvalid({
		file,
		problems,
		message: problems.map((p) => `${file}: ${p}`).join("\n"),
	});

export type YamlValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| ReadonlyArray<YamlValue>
	| { readonly [key: string]: YamlValue };

const YamlNumber = Schema.declare(Predicate.isNumber);

export const YamlValueSchema: Schema.Codec<YamlValue> = Schema.suspend(() =>
	Schema.Union([
		Schema.String,
		YamlNumber,
		Schema.Boolean,
		Schema.Null,
		Schema.Undefined,
		Schema.Array(YamlValueSchema),
		Schema.Record(Schema.String, YamlValueSchema),
	])
);

const decodeYamlValue = Schema.decodeUnknownSync(YamlValueSchema);

const isYamlList = (value: YamlValue): value is ReadonlyArray<YamlValue> =>
	Array.isArray(value);

const isYamlRecord = (
	value: YamlValue
): value is { readonly [key: string]: YamlValue } =>
	Predicate.isObject(value) && !isYamlList(value);

const folded = (value: YamlValue): YamlValue => {
	if (Predicate.isString(value)) {
		return value.replaceAll(/\s+/gu, " ").trim();
	}

	if (isYamlList(value)) {
		return value.map(folded);
	}

	if (isYamlRecord(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([k, v]) => [k, folded(v)])
		);
	}

	return value;
};

export const parseYaml = (file: string, source: string) =>
	Effect.try({
		try: () => decodeYamlValue(Bun.YAML.parse(source)),
		catch: (cause) =>
			invalid(file, [
				`isn't valid YAML (${(Predicate.isError(cause) ? cause.message : String(cause)).replace(/^YAML Parse error: /u, "")})`,
			]),
	}).pipe(Effect.map(folded));

const decodeFile = <S extends Schema.Decoder<unknown>>(
	schema: S,
	file: string,
	source: string
) =>
	parseYaml(file, source).pipe(
		Effect.flatMap((data) =>
			Schema.decodeEffect(schema)(data, {
				errors: "all",
				onExcessProperty: "error",
			})
		),
		Effect.catchTag("SchemaError", (e) =>
			Effect.fail(
				invalid(
					file,
					formatIssues(e.issue).issues.map(({ path: at = [], message }) =>
						at.length === 0 ? message : `${fieldPath(at)} ${message}`
					)
				)
			)
		)
	);

export const problemText = (field: string, problem: string): string => {
	if (field !== "id") {
		return `${field} ${problem}`;
	}

	return problem === `must be at most ${ID_MAX} characters`
		? `the file name (the id) ${problem}`
		: `the file name is the id, so it ${problem}`;
};

const modifiers = (record: Readonly<Record<string, number>>) =>
	Object.entries(record).map(([type, value]): DamageModifier => ({
		type,
		value,
	}));

const toAbility = (a: AbilityFile): Ability => {
	const { characteristics, keywords, ...rest } = a;

	return {
		...rest,
		...ifDefined(characteristics, (value) => ({
			characteristics: Predicate.isString(value) ? [value] : value,
		})),
		...ifDefined(keywords, (value) => ({
			keywords: Predicate.isString(value)
				? value
						.split(",")
						.map((k) => k.trim())
						.filter((k) => k !== "")
				: value,
		})),
	};
};

const shared = (file: SharedDecoded) => ({
	...ifDefined(file.immunities, (value) => ({ immunities: modifiers(value) })),
	...ifDefined(file.weaknesses, (value) => ({ weaknesses: modifiers(value) })),
	...ifDefined(file.size, (value) => ({
		size: String(value).trim().toUpperCase(),
	})),
	stability: file.stability ?? 0,
	abilities: (file.abilities ?? []).map(toAbility),
});

type SharedDecoded = Pick<
	typeof HeroFile.Type,
	"immunities" | "weaknesses" | "stability" | "abilities" | "size"
>;

const usable =
	<A extends HeroSheet | StatBlock>(
		file: string,
		decode: (raw: Schema.Json) => A | { refusal: string }
	) =>
	(sheet: A): Effect.Effect<A, SheetInvalid> => {
		const problems = sheetProblems(sheet).map(({ field, problem }) =>
			problemText(field, problem)
		);

		if (problems.length > 0) {
			return Effect.fail(invalid(file, problems));
		}

		const json = Schema.decodeUnknownOption(Schema.Json)(sheet);

		if (Option.isNone(json)) {
			return Effect.fail(invalid(file, ["isn't plain data"]));
		}

		const decoded = decode(json.value);

		return "refusal" in decoded
			? Effect.fail(invalid(file, [decoded.refusal]))
			: Effect.succeed(sheet);
	};

export const decodeHero = (
	file: string,
	source: string
): Effect.Effect<HeroSheet, SheetInvalid> =>
	Effect.map(decodeFile(HeroFile, file, source), (h): HeroSheet => ({
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
	})).pipe(Effect.flatMap(usable<HeroSheet>(file, decodeHeroSheet)));

export const decodeMonster = (
	file: string,
	source: string
): Effect.Effect<StatBlock, SheetInvalid> =>
	Effect.map(decodeFile(MonsterFile, file, source), (m): StatBlock => ({
		id: idOf(file),
		name: m.name,
		level: m.level,
		organization: m.organization,
		...ifDefined(m.role, (value) => ({ role: value })),
		...ifDefined(m.ev, (value) => ({ ev: String(value) })),
		stamina: m.stamina,
		speed: m.speed,
		freeStrike: m.freeStrike,
		characteristics: m.characteristics,
		...ifDefined(m.withCaptain, (value) => ({ withCaptain: value })),
		...shared(m),
	})).pipe(Effect.flatMap(usable<StatBlock>(file, decodeStatBlock)));

const modifierRecord = (list: ReadonlyArray<DamageModifier> | undefined) =>
	list === undefined || list.length === 0
		? undefined
		: Object.fromEntries(list.map((m) => [m.type, m.value]));

const inPrintedOrder = (a: Ability) => ({
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

export const monsterYaml = (
	block: StatBlock,
	header: ReadonlyArray<string> = []
): string =>
	toYaml(
		{
			name: block.name,
			level: block.level,
			organization: block.organization,
			role: block.role,
			ev: block.ev,
			stamina: block.stamina,
			size: block.size,
			speed: block.speed,
			stability: block.stability,
			freeStrike: block.freeStrike,
			characteristics: block.characteristics,
			immunities: modifierRecord(block.immunities),
			weaknesses: modifierRecord(block.weaknesses),
			withCaptain: block.withCaptain,
			abilities:
				block.abilities.length === 0
					? undefined
					: block.abilities.map(inPrintedOrder),
		},
		header
	);
