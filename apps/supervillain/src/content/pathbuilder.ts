import {
	ContentReadError,
	ID,
	SIZES,
	ifDefined,
	when,
	listIf,
} from "@supervillain/domain";
import type {
	PfAttribute,
	PfSheet,
	PfSize,
	PfSkill,
	PfSpell,
	PfStrikeEntry,
} from "@supervillain/domain";
import { Effect, FileSystem, Path, Predicate, Result, Schema } from "effect";

import { decodePfSheetFile, pfSheetYaml } from "./pfSheetFiles.ts";

const Loose = Schema.Unknown;

const Num = Schema.Finite;

const Weapon = Schema.Struct({
	name: Schema.optionalKey(Schema.String),
	display: Schema.optionalKey(Schema.String),
	die: Schema.optionalKey(Schema.String),
	str: Schema.optionalKey(Schema.String),
	damageType: Schema.optionalKey(Schema.String),
	attack: Schema.optionalKey(Num),
	damageBonus: Schema.optionalKey(Num),
	runes: Schema.optionalKey(Schema.Array(Loose)),
	extraDamage: Schema.optionalKey(Schema.Array(Loose)),
});

const Armor = Schema.Struct({
	name: Schema.optionalKey(Schema.String),
	display: Schema.optionalKey(Schema.String),
	prof: Schema.optionalKey(Schema.String),
	worn: Schema.optionalKey(Schema.Boolean),
});

const SpellRank = Schema.Struct({
	spellLevel: Num,
	list: Schema.Array(Schema.String),
});

const Caster = Schema.Struct({
	name: Schema.optionalKey(Schema.String),
	magicTradition: Schema.optionalKey(Schema.String),
	ability: Schema.optionalKey(Schema.String),
	proficiency: Schema.optionalKey(Num),
	perDay: Schema.optionalKey(Schema.Array(Num)),
	spells: Schema.optionalKey(Schema.Array(SpellRank)),
	innate: Schema.optionalKey(Schema.Boolean),
});

const Build = Schema.Struct({
	name: Schema.String,
	class: Schema.optionalKey(Schema.String),
	level: Num,
	ancestry: Schema.optionalKey(Schema.String),
	heritage: Schema.optionalKey(Schema.String),
	sizeName: Schema.optionalKey(Schema.String),
	size: Schema.optionalKey(Num),
	keyability: Schema.optionalKey(Schema.String),
	attributes: Schema.optionalKey(
		Schema.Struct({
			ancestryhp: Schema.optionalKey(Num),
			classhp: Schema.optionalKey(Num),
			bonushp: Schema.optionalKey(Num),
			bonushpPerLevel: Schema.optionalKey(Num),
			speed: Schema.optionalKey(Num),
			speedBonus: Schema.optionalKey(Num),
		})
	),
	abilities: Schema.Struct({
		str: Num,
		dex: Num,
		con: Num,
		int: Num,
		wis: Num,
		cha: Num,
	}),
	proficiencies: Schema.optionalKey(Schema.Record(Schema.String, Num)),
	lores: Schema.optionalKey(Schema.Array(Schema.Tuple([Schema.String, Num]))),
	feats: Schema.optionalKey(Schema.Array(Schema.Array(Loose))),
	specials: Schema.optionalKey(Schema.Array(Schema.String)),
	weapons: Schema.optionalKey(Schema.Array(Weapon)),
	armor: Schema.optionalKey(Schema.Array(Armor)),
	spellCasters: Schema.optionalKey(Schema.Array(Caster)),
	acTotal: Schema.optionalKey(
		Schema.Struct({
			acTotal: Schema.optionalKey(Num),
			shieldBonus: Schema.optionalKey(
				Schema.Union([Schema.String, Num, Schema.Null])
			),
		})
	),
	equipment: Schema.optionalKey(Schema.Array(Loose)),
	pets: Schema.optionalKey(Schema.Array(Loose)),
	familiars: Schema.optionalKey(Schema.Array(Loose)),
	formula: Schema.optionalKey(Schema.Array(Loose)),
	money: Schema.optionalKey(Loose),
});

type Build = typeof Build.Type;

const Export = Schema.Struct({
	success: Schema.optionalKey(Schema.Boolean),
	build: Build,
});

const decodeExport = Schema.decodeUnknownResult(Schema.fromJsonString(Export));

const SKILLS: ReadonlyArray<readonly [string, PfAttribute]> = [
	["acrobatics", "dex"],
	["arcana", "int"],
	["athletics", "str"],
	["crafting", "int"],
	["deception", "cha"],
	["diplomacy", "cha"],
	["intimidation", "cha"],
	["medicine", "wis"],
	["nature", "wis"],
	["occultism", "int"],
	["performance", "cha"],
	["religion", "wis"],
	["society", "int"],
	["stealth", "dex"],
	["survival", "wis"],
	["thievery", "dex"],
];

const DAMAGE_TYPES = new Map([
	["B", "bludgeoning"],
	["P", "piercing"],
	["S", "slashing"],
]);

const STRIKING = new Map([
	["striking", 2],
	["greaterStriking", 3],
	["majorStriking", 4],
]);

interface ShieldStats {
	readonly bonus: number;
	readonly hardness: number;
	readonly hp: number;
	readonly broken: number;
}

const SHIELDS: ReadonlyArray<readonly [RegExp, ShieldStats]> = [
	[/buckler/iu, { bonus: 1, hardness: 3, hp: 6, broken: 3 }],
	[/wooden shield/iu, { bonus: 2, hardness: 3, hp: 12, broken: 6 }],
	[/steel shield/iu, { bonus: 2, hardness: 5, hp: 20, broken: 10 }],
	[/tower shield/iu, { bonus: 2, hardness: 5, hp: 20, broken: 10 }],
];

const ATTRIBUTE_NAMES: ReadonlyArray<PfAttribute> = [
	"str",
	"dex",
	"con",
	"int",
	"wis",
	"cha",
];

const modifierOf = (value: number): number =>
	value > 7 ? Math.floor((value - 10) / 2) : Math.trunc(value);

const proficient = (rank: number, level: number): number =>
	rank > 0 ? rank + level : 0;

export const pathbuilderId = (name: string): string =>
	name
		.normalize("NFKD")
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/gu, "-")
		.replaceAll(/^-+|-+$/gu, "")
		.slice(0, 40)
		.replace(/-+$/u, "");

const sizeOf = (build: Build): PfSize => {
	const named = SIZES.find((s) => s === build.sizeName?.toLowerCase());

	if (named !== undefined) {
		return named;
	}

	return SIZES[build.size ?? 2] ?? "medium";
};

export interface Converted {
	readonly sheet: PfSheet;
	readonly skipped: ReadonlyArray<string>;
}

const strikesOf = (
	build: Build,
	skipped: Array<string>
): ReadonlyArray<PfStrikeEntry> =>
	(build.weapons ?? []).flatMap((w): ReadonlyArray<PfStrikeEntry> => {
		const name = w.display ?? w.name ?? "";
		const die = w.die ?? "";

		if (name === "" || !/^d\d+$/u.test(die) || w.attack === undefined) {
			skipped.push(
				`weapon ${name === "" ? "(unnamed)" : name}: no die or attack`
			);

			return [];
		}

		const count = STRIKING.get(w.str ?? "") ?? 1;
		const plus = Math.trunc(w.damageBonus ?? 0);
		const flat = plus === 0 ? "" : `${plus > 0 ? "+" : ""}${plus}`;

		if ((w.extraDamage ?? []).length > 0) {
			skipped.push(`${name}: extra damage isn't converted`);
		}

		return [
			{
				name,
				bonus: Math.trunc(w.attack),
				damage: `${count}${die}${flat}`,
				damageType: DAMAGE_TYPES.get(w.damageType ?? "") ?? "bludgeoning",
			},
		];
	});

const spellsOf = (
	build: Build,
	level: number,
	mods: Readonly<Record<PfAttribute, number>>,
	skipped: Array<string>
): PfSheet["spells"] => {
	const [caster, ...others] = build.spellCasters ?? [];

	if (caster === undefined) {
		return undefined;
	}

	if (others.length > 0) {
		skipped.push(
			`spellcasting from ${others.map((o) => o.name ?? "another source").join(", ")} (only the first caster is kept)`
		);
	}

	const ability = ATTRIBUTE_NAMES.find((a) => a === caster.ability) ?? "int";
	const bonus = mods[ability] + proficient(caster.proficiency ?? 0, level);

	const list = (caster.spells ?? []).flatMap((rank) =>
		rank.list.map((name): PfSpell => ({ name, rank: rank.spellLevel }))
	);

	const slots = (caster.perDay ?? []).flatMap((count, rank) =>
		rank > 0 && count > 0 ? [{ rank, count }] : []
	);

	if (list.length > 0) {
		skipped.push(
			"spell effects (attack, save, damage, healing) aren't in the export; add them to each spell by hand"
		);
	}

	return {
		...ifDefined(caster.magicTradition, (value) => ({ tradition: value })),
		dc: 10 + bonus,
		attack: bonus,
		...when(!(slots.length === 0), () => ({ slots })),
		list,
	};
};

const skillsOf = (
	build: Build,
	level: number,
	mods: Readonly<Record<PfAttribute, number>>
): ReadonlyArray<PfSkill> => {
	const ranks = build.proficiencies ?? {};

	const trained = SKILLS.flatMap(
		([name, attribute]): ReadonlyArray<PfSkill> => {
			const rank = ranks[name] ?? 0;

			return rank > 0
				? [{ name, bonus: mods[attribute] + proficient(rank, level) }]
				: [];
		}
	);

	const lores = (build.lores ?? []).map(([name, rank]) => ({
		name: `${name.toLowerCase()} lore`,
		bonus: mods.int + proficient(rank, level),
	}));

	return [...trained, ...lores];
};

const shieldOf = (build: Build, skipped: Array<string>) => {
	const carried = (build.armor ?? []).find(
		(a) =>
			a.prof === "shield" ||
			/shield|buckler/iu.test(`${a.name ?? ""} ${a.display ?? ""}`)
	);

	const label =
		carried === undefined
			? undefined
			: (carried.display ?? carried.name ?? "shield");

	const known =
		label === undefined
			? undefined
			: SHIELDS.find(([pattern]) => pattern.test(label));

	if (label !== undefined && known === undefined) {
		skipped.push(
			`${label}: its Hardness and HP aren't in the export; add a shield: line by hand`
		);
	}

	return known?.[1];
};

const leftOut = (build: Build): ReadonlyArray<string> => [
	...listIf((build.equipment ?? []).length > 0, () => ["equipment"]),
	...listIf((build.pets ?? []).length > 0, () => ["pets"]),
	...listIf((build.familiars ?? []).length > 0, () => ["familiars"]),
	...listIf((build.formula ?? []).length > 0, () => ["formulas"]),
	...listIf(build.money !== undefined, () => ["money"]),
];

export const convertPathbuilder = (build: Build): Converted => {
	const skipped: Array<string> = [];
	const level = Math.max(1, Math.trunc(build.level));
	const scores = build.abilities;

	const mods: Readonly<Record<PfAttribute, number>> = {
		str: modifierOf(scores.str),
		dex: modifierOf(scores.dex),
		con: modifierOf(scores.con),
		int: modifierOf(scores.int),
		wis: modifierOf(scores.wis),
		cha: modifierOf(scores.cha),
	};

	const ranks = build.proficiencies ?? {};
	const rank = (name: string) => proficient(ranks[name] ?? 0, level);
	const hp = build.attributes ?? {};

	const total =
		(hp.ancestryhp ?? 0) +
		(hp.bonushp ?? 0) +
		((hp.classhp ?? 0) + mods.con + (hp.bonushpPerLevel ?? 0)) * level;

	const key = ATTRIBUTE_NAMES.find((a) => a === build.keyability);
	const shield = shieldOf(build, skipped);
	const strikes = strikesOf(build, skipped);
	const spells = spellsOf(build, level, mods, skipped);

	const feats = (build.feats ?? []).flatMap((f) => {
		const [name] = f;

		return Predicate.isString(name) && name !== "" ? [{ name }] : [];
	});

	const specials = (build.specials ?? []).map((name) => ({ name }));

	const abilities = [...specials, ...feats].filter(
		(a, i, all) =>
			all.findIndex((b) => b.name.toLowerCase() === a.name.toLowerCase()) === i
	);

	skipped.push(
		...leftOut(build).map((what) => `${what} (not part of a sheet)`)
	);

	if (build.acTotal?.acTotal === undefined) {
		skipped.push("AC: the export has no acTotal, so it's 10 + Dex");
	}

	const sheet: PfSheet = {
		id: pathbuilderId(build.name) || "hero",
		name: build.name.trim(),
		level,
		size: sizeOf(build),
		...ifDefined(build.ancestry, (value) => ({ ancestry: value })),
		...ifDefined(build.class, (value) => ({ class: value })),
		attributes: mods,
		hp: Math.max(1, total),
		speed: Math.max(0, (hp.speed ?? 25) + (hp.speedBonus ?? 0)),
		perception: mods.wis + rank("perception"),
		ac: build.acTotal?.acTotal ?? 10 + mods.dex,
		saves: {
			fort: mods.con + rank("fortitude"),
			ref: mods.dex + rank("reflex"),
			will: mods.wis + rank("will"),
		},
		...ifDefined(key, (value) => ({
			classDc: 10 + mods[value] + rank("classDC"),
		})),
		skills: skillsOf(build, level, mods),
		...ifDefined(shield, (value) => ({ shield: value })),
		strikes,
		...when(!(abilities.length === 0), () => ({ abilities })),
		...ifDefined(spells, (value) => ({ spells: value })),
	};

	return { sheet, skipped };
};

export interface PathbuilderOptions {
	readonly from: string;
	readonly into: string;
	readonly overwrite?: boolean;
}

export interface PathbuilderReport {
	readonly id: string;
	readonly name: string;
	readonly file: string;
	readonly skipped: ReadonlyArray<string>;
}

const readError = (message: string) => (cause: unknown) =>
	new ContentReadError({
		message: `${message}: ${Predicate.isError(cause) ? cause.message : String(cause)}`,
		cause,
	});

export const importPathbuilder = Effect.fn("importPathbuilder")(function* (
	options: PathbuilderOptions
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	const source = yield* fs
		.readFileString(options.from)
		.pipe(Effect.mapError(readError(`can't read ${options.from}`)));

	const decoded = decodeExport(source);

	if (Result.isFailure(decoded)) {
		return yield* new ContentReadError({
			message: `${options.from} isn't a Pathbuilder 2e export (Export JSON from Pathbuilder's menu): ${decoded.failure.message.split("\n")[0] ?? ""}`,
		});
	}

	const { sheet, skipped } = convertPathbuilder(decoded.success.build);

	if (!ID.test(sheet.id)) {
		return yield* new ContentReadError({
			message: `can't make a file name from "${sheet.name}"`,
		});
	}

	const heroes = path.join(options.into, "heroes");
	const file = path.join(heroes, `${sheet.id}.yaml`);
	const relative = `heroes/${sheet.id}.yaml`;

	const there = yield* fs
		.exists(file)
		.pipe(Effect.mapError(readError(`can't look in ${heroes}`)));

	if (there && options.overwrite !== true) {
		return yield* new ContentReadError({
			message: `${relative} is there already; pass --overwrite to replace it`,
		});
	}

	const yaml = pfSheetYaml(sheet, [
		`${sheet.name}, imported from Pathbuilder 2e.`,
		...listIf(!(skipped.length === 0), () => [
			"Left out:",
			...skipped.map((s) => `- ${s}`),
		]),
	]);

	const check = yield* Effect.result(decodePfSheetFile(relative, yaml));

	if (Result.isFailure(check)) {
		return yield* new ContentReadError({
			message: `the converted sheet doesn't load: ${check.failure.message}`,
		});
	}

	yield* fs
		.makeDirectory(heroes, { recursive: true })
		.pipe(Effect.mapError(readError(`can't make ${heroes}`)));

	yield* fs
		.writeFileString(file, yaml)
		.pipe(Effect.mapError(readError(`can't write ${file}`)));

	const written = yield* fs
		.readFileString(file)
		.pipe(Effect.mapError(readError(`can't read ${file} back`)));

	const loaded = yield* decodePfSheetFile(relative, written).pipe(
		Effect.mapError(
			(e) =>
				new ContentReadError({
					message: `${relative} was written but doesn't load: ${e.message}`,
				})
		)
	);

	const report: PathbuilderReport = {
		id: loaded.id,
		name: loaded.name,
		file: relative,
		skipped,
	};

	return report;
});

export const pathbuilderReportText = (
	report: PathbuilderReport
): ReadonlyArray<string> => [
	`imported ${report.name} to ${report.file}`,
	...report.skipped.map((s) => `  skipped: ${s}`),
	`bring them to the table with: /pc ${report.id}`,
];
