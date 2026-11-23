import { Predicate, Result, Schema } from "effect";

import { cleanText, hasTerminalControls, quote } from "../../text.ts";
import type { Refused } from "../engine.ts";
import { CHARACTERISTICS } from "./sheets.ts";
import type { HeroSheet, StatBlock } from "./sheets.ts";

const Characteristic = Schema.Literals(CHARACTERISTICS);

const Characteristics = Schema.Struct({
	might: Schema.Int,
	agility: Schema.Int,
	reason: Schema.Int,
	intuition: Schema.Int,
	presence: Schema.Int,
});

const DamageModifier = Schema.Struct({
	type: Schema.String,
	value: Schema.Int,
});

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
	size: Schema.optionalKey(Schema.String),
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

export const StatBlockSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	level: Schema.Int,
	organization: Schema.Literals([
		"minion",
		"horde",
		"platoon",
		"elite",
		"leader",
		"solo",
	]),
	role: Schema.optionalKey(Schema.String),
	ev: Schema.optionalKey(Schema.String),
	stamina: Schema.Int,
	size: Schema.optionalKey(Schema.String),
	speed: Schema.Int,
	stability: Schema.Int,
	freeStrike: Schema.Int,
	characteristics: Characteristics,
	immunities: Schema.optionalKey(Schema.Array(DamageModifier)),
	weaknesses: Schema.optionalKey(Schema.Array(DamageModifier)),
	abilities: Schema.Array(Ability),
	withCaptain: Schema.optionalKey(Schema.String),
});

const heroFits = (s: typeof HeroSheetSchema.Type): HeroSheet => s;

const blockFits = (s: typeof StatBlockSchema.Type): StatBlock => s;

const heroBack = (s: HeroSheet): typeof HeroSheetSchema.Type => s;

const blockBack = (s: StatBlock): typeof StatBlockSchema.Type => s;

void [heroFits, blockFits, heroBack, blockBack];

export const ID_MAX = 40;

export const ID = /^[a-z0-9][a-z0-9-]{0,39}$/u;

const ID_LETTERS = /^[a-z0-9][a-z0-9-]*$/u;

export const SIZE_PATTERN = /^(?:1[TSML]?|[2-9]|1\d)$/u;

export const PER_TURN = /^(?:\d+|\d*d\d+(?:[+-]\d+)?)$/u;

const REQUIRED_HERO = [
	"id",
	"name",
	"class",
	"stamina",
	"recoveries",
	"resource",
	"abilities",
];

const REQUIRED_BLOCK = [
	"id",
	"name",
	"organization",
	"stamina",
	"freeStrike",
	"abilities",
];

const oneLine = (message: string): string =>
	message.replaceAll(/\s*\n\s*/gu, " ");

const isJsonArray = (value: Schema.Json): value is Schema.JsonArray =>
	Array.isArray(value);

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
	Predicate.isObject(value) && !isJsonArray(value);

const strings = (
	value: Schema.Json,
	path = ""
): ReadonlyArray<readonly [string, string]> => {
	if (Predicate.isString(value)) {
		return [[path, value]];
	}

	if (isJsonArray(value)) {
		return value.flatMap((v, i) => strings(v, `${path}[${i + 1}]`));
	}

	if (isJsonObject(value)) {
		return Object.entries(value).flatMap(([k, v]) =>
			strings(v, path === "" ? k : `${path}.${k}`)
		);
	}

	return [];
};

const heroJson = Schema.encodeSync(Schema.toCodecJson(HeroSheetSchema));

const blockJson = Schema.encodeSync(Schema.toCodecJson(StatBlockSchema));

const sheetJson = (sheet: HeroSheet | StatBlock): Schema.Json =>
	"resource" in sheet ? heroJson(sheet) : blockJson(sheet);

export const safeSheet = (sheet: HeroSheet | StatBlock): boolean =>
	strings(sheetJson(sheet)).every(([, text]) => !hasTerminalControls(text));

const cleanName = (name: string) =>
	name !== "" && cleanText(name) === name && name.length <= 40;

export interface SheetProblem {
	readonly field: string;
	readonly problem: string;
}

export const sheetProblems = (
	sheet: HeroSheet | StatBlock
): ReadonlyArray<SheetProblem> => {
	const problems: Array<SheetProblem> = [];

	if (sheet.id.length > ID_MAX) {
		problems.push({
			field: "id",
			problem: `must be at most ${ID_MAX} characters`,
		});
	}

	if (!ID_LETTERS.test(sheet.id)) {
		problems.push({
			field: "id",
			problem: "must be lowercase letters, digits and dashes",
		});
	}

	const names: ReadonlyArray<readonly [string, string]> = [
		["name", sheet.name],
		...sheet.abilities.map(
			(a, i) => [`abilities[${i + 1}].name`, a.name] as const
		),
	];

	for (const [field, name] of names) {
		if (!cleanName(name)) {
			problems.push({
				field,
				problem: "must be one line of up to 40 characters",
			});
		}
	}

	for (const [field, text] of strings(sheetJson(sheet))) {
		if (hasTerminalControls(text)) {
			problems.push({ field, problem: "holds control characters" });
		}
	}

	if (sheet.stamina < 1) {
		problems.push({ field: "stamina", problem: "must be at least 1" });
	}

	const atLeastZero = (field: string, value: number | undefined) => {
		if (value !== undefined && value < 0) {
			problems.push({ field, problem: "must be 0 or more" });
		}
	};

	atLeastZero("level", sheet.level);

	if (sheet.size !== undefined && !SIZE_PATTERN.test(sheet.size)) {
		problems.push({
			field: "size",
			problem: "must be a size like 1T, 1S, 1M, 1L, 2, 3 or 4",
		});
	}

	if ("resource" in sheet) {
		const { perTurn, min } = sheet.resource;

		if (Predicate.isString(perTurn) && !PER_TURN.test(perTurn)) {
			problems.push({
				field: "resource.perTurn",
				problem: "must be a number or dice like 1d3",
			});
		}

		if (min !== undefined && min > 0) {
			problems.push({ field: "resource.min", problem: "must be 0 or below" });
		}

		atLeastZero("recoveries", sheet.recoveries);
		atLeastZero("recoveryValue", sheet.recoveryValue);
		atLeastZero("victories", sheet.victories);
	} else {
		atLeastZero("freeStrike", sheet.freeStrike);
	}

	return problems;
};

const problemsRefusal = (
	label: string,
	problems: ReadonlyArray<SheetProblem>
): Refused => ({
	refusal: `${label} can't be used: ${problems.map((p) => `${p.field} ${p.problem}`).join("; ")}.`,
});

const checked = <S extends HeroSheet | StatBlock>(
	sheet: S,
	schema: Schema.Codec<S>,
	required: ReadonlyArray<string>,
	what: string
): S | Refused => {
	const label = `'${quote(sheet.id)}'`;
	const missing = required.find((key) => !Object.hasOwn(sheet, key));

	if (missing !== undefined) {
		return { refusal: `${label} isn't ${what}: ${missing} is missing.` };
	}

	const decoded = Schema.decodeResult(schema)(sheet);

	if (Result.isFailure(decoded)) {
		return {
			refusal: `${label} isn't ${what}: ${oneLine(decoded.failure.message)}.`,
		};
	}

	const problems = sheetProblems(decoded.success);

	return problems.length > 0 ? problemsRefusal(label, problems) : sheet;
};

export const checkHeroSheet = (sheet: HeroSheet): HeroSheet | Refused =>
	checked(sheet, HeroSheetSchema, REQUIRED_HERO, "a hero sheet");

export const checkStatBlock = (block: StatBlock): StatBlock | Refused =>
	checked(block, StatBlockSchema, REQUIRED_BLOCK, "a stat block");

const labelOf = (raw: Schema.Json): string => {
	const id = isJsonObject(raw) ? raw.id : undefined;

	return Predicate.isString(id) ? `'${quote(id)}'` : "That";
};

const missingOf = (
	raw: Schema.Json,
	required: ReadonlyArray<string>
): string | undefined =>
	required.find((key) => !isJsonObject(raw) || !Object.hasOwn(raw, key));

export const decodeHeroSheet = (raw: Schema.Json): HeroSheet | Refused => {
	const label = labelOf(raw);
	const missing = missingOf(raw, REQUIRED_HERO);

	if (missing !== undefined) {
		return { refusal: `${label} isn't a hero sheet: ${missing} is missing.` };
	}

	const decoded = Schema.decodeUnknownResult(HeroSheetSchema)(raw);

	if (Result.isFailure(decoded)) {
		return {
			refusal: `${label} isn't a hero sheet: ${oneLine(decoded.failure.message)}.`,
		};
	}

	const problems = sheetProblems(decoded.success);

	return problems.length > 0
		? problemsRefusal(label, problems)
		: decoded.success;
};

export const decodeStatBlock = (raw: Schema.Json): StatBlock | Refused => {
	const label = labelOf(raw);
	const missing = missingOf(raw, REQUIRED_BLOCK);

	if (missing !== undefined) {
		return { refusal: `${label} isn't a stat block: ${missing} is missing.` };
	}

	const decoded = Schema.decodeUnknownResult(StatBlockSchema)(raw);

	if (Result.isFailure(decoded)) {
		return {
			refusal: `${label} isn't a stat block: ${oneLine(decoded.failure.message)}.`,
		};
	}

	const problems = sheetProblems(decoded.success);

	return problems.length > 0
		? problemsRefusal(label, problems)
		: decoded.success;
};
