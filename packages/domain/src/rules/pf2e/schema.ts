import { Predicate, Result, Schema } from "effect";

import { listIf, orEmpty } from "../../present.ts";
import { hasTerminalControls, quote } from "../../text.ts";
import { ID, ID_MAX } from "../drawSteel/schema.ts";
import type { Refused } from "../engine.ts";
import { parseDamage } from "./math.ts";
import { SAVES, SIZES } from "./sheets.ts";
import type { PfSheet } from "./sheets.ts";

const Amount = Schema.Struct({ type: Schema.String, value: Schema.Int });

const Strike = Schema.Struct({
	name: Schema.String,
	bonus: Schema.Int,
	damage: Schema.String,
	damageType: Schema.String,
	traits: Schema.optionalKey(Schema.Array(Schema.String)),
	range: Schema.optionalKey(Schema.Int),
	reach: Schema.optionalKey(Schema.Int),
});

const Ability = Schema.Struct({
	name: Schema.String,
	actions: Schema.optionalKey(Schema.String),
	traits: Schema.optionalKey(Schema.Array(Schema.String)),
	text: Schema.optionalKey(Schema.String),
});

const Spell = Schema.Struct({
	name: Schema.String,
	rank: Schema.Int,
	actions: Schema.optionalKey(Schema.Int),
	attack: Schema.optionalKey(Schema.Boolean),
	save: Schema.optionalKey(Schema.Literals(SAVES)),
	basic: Schema.optionalKey(Schema.Boolean),
	damage: Schema.optionalKey(Schema.String),
	damageType: Schema.optionalKey(Schema.String),
	heal: Schema.optionalKey(Schema.String),
	range: Schema.optionalKey(Schema.Int),
	text: Schema.optionalKey(Schema.String),
});

const Spells = Schema.Struct({
	tradition: Schema.optionalKey(Schema.String),
	dc: Schema.optionalKey(Schema.Int),
	attack: Schema.optionalKey(Schema.Int),
	slots: Schema.optionalKey(
		Schema.Array(Schema.Struct({ rank: Schema.Int, count: Schema.Int }))
	),
	list: Schema.Array(Spell),
});

const SheetFields = {
	id: Schema.String,
	name: Schema.String,
	level: Schema.Int,
	size: Schema.Literals(SIZES),
	ancestry: Schema.optionalKey(Schema.String),
	class: Schema.optionalKey(Schema.String),
	traits: Schema.optionalKey(Schema.Array(Schema.String)),
	attributes: Schema.Struct({
		str: Schema.Int,
		dex: Schema.Int,
		con: Schema.Int,
		int: Schema.Int,
		wis: Schema.Int,
		cha: Schema.Int,
	}),
	hp: Schema.Int,
	speed: Schema.Int,
	perception: Schema.Int,
	ac: Schema.Int,
	saves: Schema.Struct({ fort: Schema.Int, ref: Schema.Int, will: Schema.Int }),
	classDc: Schema.optionalKey(Schema.Int),
	skills: Schema.Array(
		Schema.Struct({ name: Schema.String, bonus: Schema.Int })
	),
	shield: Schema.optionalKey(
		Schema.Struct({
			bonus: Schema.Int,
			hardness: Schema.Int,
			hp: Schema.Int,
			broken: Schema.Int,
		})
	),
	strikes: Schema.Array(Strike),
	abilities: Schema.optionalKey(Schema.Array(Ability)),
	spells: Schema.optionalKey(Spells),
	immunities: Schema.optionalKey(Schema.Array(Schema.String)),
	weaknesses: Schema.optionalKey(Schema.Array(Amount)),
	resistances: Schema.optionalKey(Schema.Array(Amount)),
	flurry: Schema.optionalKey(Schema.Boolean),
};

export const PfHeroSheetSchema = Schema.Struct(SheetFields);

export const PfCreatureBlockSchema = Schema.Struct(SheetFields);

const sheetFits = (s: typeof PfHeroSheetSchema.Type): PfSheet => s;

const sheetBack = (s: PfSheet): typeof PfHeroSheetSchema.Type => s;

void [sheetFits, sheetBack];

export interface PfSheetProblem {
	readonly field: string;
	readonly problem: string;
}

const LEVEL_MIN = -1;

const LEVEL_MAX = 25;

const textsOf = (sheet: PfSheet): ReadonlyArray<string> => [
	sheet.name,
	sheet.ancestry ?? "",
	sheet.class ?? "",
	...orEmpty(sheet.traits),
	...sheet.skills.map((s) => s.name),
	...sheet.strikes.flatMap((s) => [
		s.name,
		s.damage,
		s.damageType,
		...orEmpty(s.traits),
	]),
	...orEmpty(sheet.abilities).flatMap((a) => [
		a.name,
		a.actions ?? "",
		a.text ?? "",
		...orEmpty(a.traits),
	]),
	...orEmpty(sheet.spells?.list).flatMap((s) => [
		s.name,
		s.damage ?? "",
		s.damageType ?? "",
		s.heal ?? "",
		s.text ?? "",
	]),
	sheet.spells?.tradition ?? "",
	...orEmpty(sheet.immunities),
	...orEmpty(sheet.weaknesses).map((w) => w.type),
	...orEmpty(sheet.resistances).map((r) => r.type),
];

const idProblems = (id: string): ReadonlyArray<PfSheetProblem> => {
	if (id.length > ID_MAX) {
		return [{ field: "id", problem: `must be at most ${ID_MAX} characters` }];
	}

	return ID.test(id)
		? []
		: [
				{
					field: "id",
					problem:
						"must be lower-case letters, digits and hyphens, starting with a letter or digit",
				},
			];
};

const damageProblems = (
	field: string,
	expression: string | undefined
): ReadonlyArray<PfSheetProblem> =>
	expression === undefined || !("refusal" in parseDamage(expression))
		? []
		: [{ field, problem: `must be damage like 1d8+4, not '${expression}'` }];

export const pfSheetProblems = (
	sheet: PfSheet
): ReadonlyArray<PfSheetProblem> => [
	...idProblems(sheet.id),
	...listIf(sheet.name.trim() === "", () => [
		{ field: "name", problem: "must not be empty" },
	]),
	...listIf(sheet.level < LEVEL_MIN || sheet.level > LEVEL_MAX, () => [
		{ field: "level", problem: `must be from ${LEVEL_MIN} to ${LEVEL_MAX}` },
	]),
	...listIf(sheet.hp < 1, () => [
		{ field: "hp", problem: "must be 1 or more" },
	]),
	...listIf(sheet.speed < 0, () => [
		{ field: "speed", problem: "must be 0 or more" },
	]),
	...sheet.strikes.flatMap((s, i) =>
		damageProblems(`strikes[${i + 1}].damage`, s.damage)
	),
	...orEmpty(sheet.spells?.list).flatMap((s, i) => [
		...damageProblems(`spells.list[${i + 1}].damage`, s.damage),
		...damageProblems(`spells.list[${i + 1}].heal`, s.heal),
	]),
	...listIf(textsOf(sheet).some(hasTerminalControls), () => [
		{ field: "text", problem: "holds characters the table can't show" },
	]),
];

const oneLine = (message: string): string =>
	message.replaceAll(/\s+/gu, " ").trim();

const isJsonObject = (
	raw: Schema.Json
): raw is { readonly [key: string]: Schema.Json } =>
	Predicate.isObject(raw) && !Array.isArray(raw);

const labelOf = (raw: Schema.Json): string => {
	const id = isJsonObject(raw) ? raw.id : undefined;

	return Predicate.isString(id) ? `'${quote(id)}'` : "That";
};

export const checkPfSheet = (sheet: PfSheet): PfSheet | Refused => {
	const problems = pfSheetProblems(sheet);

	return problems.length === 0
		? sheet
		: {
				refusal: `'${quote(sheet.id)}' isn't a sheet the table can use: ${problems.map((p) => `${p.field} ${p.problem}`).join("; ")}.`,
			};
};

export const decodePfSheet = (raw: Schema.Json): PfSheet | Refused => {
	const label = labelOf(raw);
	const decoded = Schema.decodeUnknownResult(PfHeroSheetSchema)(raw);

	if (Result.isFailure(decoded)) {
		return {
			refusal: `${label} isn't a PF2e sheet: ${oneLine(decoded.failure.message)}.`,
		};
	}

	return checkPfSheet(decoded.success);
};
