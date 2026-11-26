import {
	sheetProblems,
	ContentReadError,
	SIZE_PATTERN,
	when,
	ifDefined,
	listIf,
} from "@supervillain/domain";
import type {
	Ability,
	Characteristic,
	DamageModifier,
	Organization,
	StatBlock,
} from "@supervillain/domain";
import { Effect, FileSystem, Path, Predicate, Result, Schema } from "effect";

import { decodeMonster, monsterYaml, ORGANIZATIONS } from "./sheetFiles.ts";

export type Converted =
	| {
			readonly ok: true;
			readonly sheet: StatBlock;
			readonly skipped: ReadonlyArray<string>;
	  }
	| {
			readonly ok: false;
			readonly name: string;
			readonly problems: ReadonlyArray<string>;
	  };

type Json = Schema.Json;

type Raw = Schema.JsonObject;

const EMPTY: Raw = {};

const isList = (value: Json | undefined): value is Schema.JsonArray =>
	Array.isArray(value);

const isRaw = (value: Json | undefined): value is Raw =>
	Predicate.isObject(value) && !isList(value);

const rawOf = (value: Json | undefined): Raw => (isRaw(value) ? value : EMPTY);

const isGiven = (value: Json | undefined): value is Json =>
	value !== undefined && value !== null;

const isFilled = (value: Json | undefined): value is Json =>
	isGiven(value) && value !== "";

const jsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

const show = (v: Json) => jsonText(v);

const normalized = (s: string) => s.replaceAll(/[−–]/gu, "-").trim();

const trimmed = (v: Json | undefined) =>
	Predicate.isString(v) && v.trim() !== "" ? v.trim() : undefined;

const LEADING_INT = /^(?<n>[+-]?\d+)\s*(?<rest>.*)$/su;

interface LeadingInt {
	readonly n: number;
	readonly rest: string;
}

const leadingInt = (value: Json): LeadingInt | undefined => {
	if (Predicate.isNumber(value)) {
		return Number.isInteger(value) ? { n: value, rest: "" } : undefined;
	}

	if (!Predicate.isString(value)) {
		return undefined;
	}

	const groups = LEADING_INT.exec(normalized(value))?.groups;

	return groups === undefined
		? undefined
		: { n: Number(groups.n), rest: (groups.rest ?? "").trim() };
};

const MODIFIER_LEAD =
	/^(?:damage\s+)?(?:immunit(?:y|ies)|weakness(?:es)?)\s*:?\s*/u;

const MODIFIER = /^(?<type>[a-z][a-z ]*?)?\s*(?<value>\d+)$/u;

const modifier = (item: Json): DamageModifier | undefined => {
	if (!Predicate.isString(item)) {
		return undefined;
	}

	const said = normalized(item).toLowerCase().replace(MODIFIER_LEAD, "");
	const groups = MODIFIER.exec(said)?.groups;

	if (groups?.value === undefined) {
		return undefined;
	}

	const type = (groups.type ?? "").trim().replace(/\s*damage$/u, "");

	return { type: type === "" ? "all" : type, value: Number(groups.value) };
};

const textList = (value: Json | undefined): ReadonlyArray<Json> => {
	if (Predicate.isString(value)) {
		return value
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s !== "");
	}

	return isList(value) ? value : [];
};

const textOf = (v: Json) => (Predicate.isString(v) ? v : show(v));

const stringsOf = (values: ReadonlyArray<Json>): ReadonlyArray<string> =>
	values.filter(Predicate.isString);

export const slug = (name: string) =>
	name
		.normalize("NFKD")
		.replaceAll(/[̀-ͯ]/gu, "")
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/gu, "-")
		.replaceAll(/^-|-$/gu, "") || "monster";

interface Notes {
	readonly problems: Array<string>;
	readonly skipped: Array<string>;
}

const required = (notes: Notes, field: string, value: Json | undefined) => {
	if (!isGiven(value)) {
		notes.problems.push(`${field}: missing`);

		return 0;
	}

	const read = leadingInt(value);

	if (read === undefined) {
		notes.problems.push(`${field}: no number in ${show(value)}`);

		return 0;
	}

	if (read.rest !== "") {
		notes.skipped.push(`${field}: kept ${read.n}, left out ${show(read.rest)}`);
	}

	return read.n;
};

const isOrganization = (word: string): word is Organization =>
	ORGANIZATIONS.some((o) => o === word);

const rolesOf = (notes: Notes, roles: Json | undefined) => {
	const words = stringsOf(textList(roles)).flatMap((r) =>
		r.split(/\s+/u).filter((w) => w !== "")
	);

	const organization = words.map((w) => w.toLowerCase()).find(isOrganization);

	const role = words
		.filter((w) => w.toLowerCase() !== organization)
		.join(" ")
		.toLowerCase();

	if (roles === undefined) {
		notes.problems.push("roles: missing");
	} else if (organization === undefined) {
		notes.problems.push(
			`roles: no organization in ${show(textList(roles).map(textOf).join(", "))} (expected one of ${ORGANIZATIONS.join(", ")})`
		);
	}

	return { organization, role };
};

const evOf = (notes: Notes, ev: Json | undefined) => {
	const text = trimmed(ev) ?? (Predicate.isNumber(ev) ? String(ev) : undefined);

	if (text === undefined && isFilled(ev)) {
		notes.skipped.push(`ev: left out ${show(ev)} (not text)`);
	}

	return text;
};

const characteristicsOf = (
	notes: Notes,
	raw: Raw
): Record<Characteristic, number> => {
	const nested = rawOf(raw.characteristics);
	const read = (c: Characteristic) => required(notes, c, raw[c] ?? nested[c]);

	return {
		might: read("might"),
		agility: read("agility"),
		reason: read("reason"),
		intuition: read("intuition"),
		presence: read("presence"),
	};
};

const modifiersOf = (
	notes: Notes,
	raw: Raw,
	field: "immunities" | "weaknesses"
) => {
	const out: Array<DamageModifier> = [];
	const singular = field === "immunities" ? "immunity" : "weakness";

	for (const item of textList(raw[field] ?? raw[singular])) {
		const m = modifier(item);

		if (m === undefined) {
			notes.skipped.push(
				`${field}: left out ${show(item)} (expected a damage type and a number, like "fire 5")`
			);
		} else {
			out.push(m);
		}
	}

	return out;
};

const sizeOf = (notes: Notes, size: Json | undefined) => {
	const text =
		Predicate.isNumber(size) || Predicate.isString(size)
			? String(size).trim().toUpperCase()
			: undefined;

	const placed =
		text !== undefined && SIZE_PATTERN.test(text) ? text : undefined;

	if (placed === undefined && isFilled(size)) {
		notes.skipped.push(
			`size: left out ${show(size)} (expected a size like 1M, 1L, 2 or 3)`
		);
	}

	return placed;
};

const withCaptainOf = (notes: Notes, withCaptain: Json | undefined) => {
	const text = trimmed(withCaptain);

	if (text === undefined && isFilled(withCaptain)) {
		notes.skipped.push(
			`with_captain: left out ${show(withCaptain)} (not text)`
		);
	}

	return text;
};

const abilitiesOf = (notes: Notes, features: Json | undefined) => {
	const abilities: Array<Ability> = [];

	if (features !== undefined && !isList(features)) {
		notes.skipped.push("features: left out (not a list)");

		return abilities;
	}

	for (const [i, feature] of (features ?? []).entries()) {
		const ability = convertFeature(feature, notes.skipped);

		if (ability === undefined) {
			notes.skipped.push(
				`features[${i + 1}]: left out (not a feature with a name)`
			);
		} else {
			abilities.push(ability);
		}
	}

	return abilities;
};

export const convertMonster = (input: Json): Converted => {
	const raw = rawOf(input);
	const name = trimmed(raw.name);
	const notes: Notes = { problems: [], skipped: [] };

	if (name === undefined) {
		notes.problems.push("name: missing");
	}

	const level = required(notes, "level", raw.level);
	const { organization, role } = rolesOf(notes, raw.roles);
	const ev = evOf(notes, raw.ev);
	const stamina = required(notes, "stamina", raw.stamina);
	const speed = required(notes, "speed", raw.speed);
	const stability = required(notes, "stability", raw.stability);
	const freeStrike = required(notes, "free_strike", raw.free_strike);
	const characteristics = characteristicsOf(notes, raw);
	const immunities = modifiersOf(notes, raw, "immunities");
	const weaknesses = modifiersOf(notes, raw, "weaknesses");
	const size = sizeOf(notes, raw.size);
	const withCaptain = withCaptainOf(notes, raw.with_captain);
	const abilities = abilitiesOf(notes, raw.features);
	const { problems, skipped } = notes;

	if (problems.length > 0 || name === undefined || organization === undefined) {
		return { ok: false, name: name ?? "(no name)", problems };
	}

	return {
		ok: true,
		sheet: {
			id: slug(name),
			name,
			level,
			organization,
			...when(role !== "", () => ({ role })),
			...ifDefined(ev, (value) => ({ ev: value })),
			stamina,
			...ifDefined(size, (value) => ({ size: value })),
			speed,
			stability,
			freeStrike,
			characteristics,
			...when(immunities.length > 0, () => ({ immunities })),
			...when(weaknesses.length > 0, () => ({ weaknesses })),
			abilities,
			...ifDefined(withCaptain, (value) => ({ withCaptain: value })),
		},
		skipped,
	};
};

const TIERS = ["tier1", "tier2", "tier3"] as const;

type Tier = (typeof TIERS)[number];

const digitsOf = (cost: Json) => {
	if (Predicate.isNumber(cost)) {
		return String(cost);
	}

	return Predicate.isString(cost) ? /\d+/u.exec(cost)?.[0] : undefined;
};

const costOf = (
	name: string,
	cost: Json | undefined,
	skipped: Array<string>
) => {
	const digits = isGiven(cost) ? digitsOf(cost) : undefined;

	if (digits === undefined && isGiven(cost)) {
		skipped.push(`${name}: left out the cost (no number in ${show(cost)})`);
	}

	return digits === undefined ? undefined : Number(digits);
};

const ROLL_BONUS = /(?<sign>[+-])\s*(?<n>\d+)/u;

const bonusOf = (name: string, roll: Json, skipped: Array<string>) => {
	const groups = ROLL_BONUS.exec(normalized(textOf(roll)))?.groups;

	if (groups === undefined) {
		skipped.push(
			`${name}: left out the roll bonus (no number in ${show(roll)})`
		);
	}

	return groups === undefined
		? undefined
		: Number(`${groups.sign ?? ""}${groups.n ?? ""}`);
};

interface Rolled {
	bonus: number | undefined;
	readonly tiers: Partial<Record<Tier, string>>;
	readonly effects: Array<string>;
}

const readEffect = (
	name: string,
	effect: Raw,
	rolled: Rolled,
	skipped: Array<string>
) => {
	if (effect.roll !== undefined && rolled.bonus === undefined) {
		rolled.bonus = bonusOf(name, effect.roll, skipped);
	}

	for (const tier of TIERS) {
		if (effect[tier] !== undefined && rolled.tiers[tier] === undefined) {
			const t = trimmed(effect[tier]);

			if (t === undefined) {
				skipped.push(`${name}: left out ${tier} (not text)`);
			} else {
				rolled.tiers[tier] = t;
			}
		}
	}

	const said = trimmed(effect.effect);

	if (said !== undefined) {
		const label = trimmed(effect.name);
		const plain = label === undefined || label.toLowerCase() === "effect";
		rolled.effects.push(plain ? said : `${label}: ${said}`);
	}
};

const convertFeature = (
	feature: Json,
	skipped: Array<string>
): Ability | undefined => {
	const raw = rawOf(feature);
	const name = Predicate.isString(raw.name) ? raw.name.trim() : "";

	if (!Predicate.isString(raw.name) || raw.name === "") {
		return undefined;
	}

	const kind =
		trimmed(raw.usage) ?? (raw.feature_type === "trait" ? "Trait" : undefined);

	const keywords = stringsOf(textList(raw.keywords));
	const cost = costOf(name, raw.cost, skipped);
	const rolled: Rolled = { bonus: undefined, tiers: {}, effects: [] };

	for (const entry of isList(raw.effects) ? raw.effects : []) {
		readEffect(name, rawOf(entry), rolled, skipped);
	}

	return {
		name,
		...ifDefined(kind, (value) => ({ kind: value })),
		...when(keywords.length > 0, () => ({ keywords })),
		...ifDefined(trimmed(raw.distance), (value) => ({ distance: value })),
		...ifDefined(trimmed(raw.target), (value) => ({ target: value })),
		...ifDefined(cost, (value) => ({ cost: value })),
		...ifDefined(rolled.bonus, (value) => ({ bonus: value })),
		...rolled.tiers,
		...when(rolled.effects.length > 0, () => ({
			effect: rolled.effects.join(" "),
		})),
	};
};

export interface ImportOptions {
	readonly from: string;
	readonly into: string;
	readonly names?: ReadonlyArray<string>;
	readonly overwrite?: boolean;
}

export interface ImportedMonster {
	readonly name: string;
	readonly id: string;
	readonly file: string;
	readonly status: "written" | "exists";
	readonly skipped: ReadonlyArray<string>;
}

export interface ImportReport {
	readonly imported: ReadonlyArray<ImportedMonster>;
	readonly failed: ReadonlyArray<{
		readonly name: string;
		readonly source: string;
		readonly problems: ReadonlyArray<string>;
	}>;
	readonly notFound: ReadonlyArray<string>;
	readonly ambiguous: ReadonlyArray<{
		readonly query: string;
		readonly matches: ReadonlyArray<string>;
	}>;
	readonly unreadable: ReadonlyArray<string>;
}

interface Candidate {
	readonly name: string;
	readonly source: string;
	readonly raw: Raw;
}

const isCreature = (v: Json): v is Raw & { readonly name: string } =>
	isRaw(v) &&
	Predicate.isString(v.name) &&
	(v.stamina !== undefined ||
		v.free_strike !== undefined ||
		v.roles !== undefined);

const decodeJsonText = Schema.decodeUnknownEffect(
	Schema.fromJsonString(Schema.Json)
);

const isListed = (file: string) =>
	file.toLowerCase().endsWith(".json") &&
	!file
		.split(/[\\/]/u)
		.some((part) => part.startsWith(".") || part === "node_modules");

const readError = (from: string) => (cause: { readonly message: string }) =>
	new ContentReadError({
		message: `can't read ${from}: ${cause.message}`,
		cause,
	});

const readSource = Effect.fn("readSource")(function* (from: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const info = yield* fs.stat(from).pipe(Effect.mapError(readError(from)));
	const folder = info.type === "Directory";

	const files = folder
		? (yield* fs
				.readDirectory(from, { recursive: true })
				.pipe(Effect.mapError(readError(from))))
				.filter(isListed)
				.toSorted()
				.map((file) => path.join(from, file))
		: [from];

	const creatures: Array<Candidate> = [];
	const unreadable: Array<string> = [];

	for (const file of files) {
		const source = folder ? path.relative(from, file) : path.basename(file);

		const parsed = yield* fs.readFileString(file).pipe(
			Effect.mapError((cause) => `${source}: ${cause.message}`),
			Effect.flatMap((text) =>
				decodeJsonText(text).pipe(
					Effect.mapError(() => `${source}: not valid JSON`)
				)
			),
			Effect.result
		);

		if (Result.isFailure(parsed)) {
			unreadable.push(parsed.failure);
		} else {
			const found = isList(parsed.success) ? parsed.success : [parsed.success];

			for (const v of found.filter(isCreature)) {
				creatures.push({ name: v.name.trim(), source, raw: v });
			}
		}
	}

	return { creatures, unreadable };
});

const pick = (
	creatures: ReadonlyArray<Candidate>,
	names: ReadonlyArray<string>
) => {
	if (names.length === 0) {
		return { chosen: creatures, notFound: [], ambiguous: [] };
	}

	const chosen = new Set<Candidate>();
	const notFound: Array<string> = [];
	const ambiguous: Array<{ query: string; matches: Array<string> }> = [];

	for (const query of names) {
		const q = query.trim().toLowerCase();
		const id = slug(query);

		const exact = creatures.filter(
			(c) => c.name.toLowerCase() === q || slug(c.name) === id
		);

		const prefix = creatures.filter(
			(c) => c.name.toLowerCase().startsWith(q) || slug(c.name).startsWith(id)
		);

		const found = exact.length > 0 ? exact.slice(0, 1) : prefix;

		const [first] = found;
		const matches = new Set(found.map((c) => c.name));

		if (first === undefined) {
			notFound.push(query);
		} else if (matches.size > 1) {
			ambiguous.push({ query, matches: [...matches].toSorted() });
		} else {
			chosen.add(first);
		}
	}

	return { chosen: [...chosen], notFound, ambiguous };
};

const byText = (a: string, b: string) => {
	if (a === b) {
		return 0;
	}

	return a < b ? -1 : 1;
};

interface Failed {
	readonly name: string;
	readonly source: string;
	readonly problems: ReadonlyArray<string>;
}

const idProblems = (sheet: StatBlock) => {
	const problems = sheetProblems(sheet);

	if (!problems.some((p) => p.field === "id")) {
		return [];
	}

	return problems.map(({ field, problem }) =>
		field === "id"
			? `id ${show(sheet.id)} (made from the name) ${problem}`
			: `${field} ${problem}`
	);
};

const headerOf = (source: string, skipped: ReadonlyArray<string>) => [
	`Imported by supervillain from ${source}.`,
	"Check it against Draw Steel: Monsters before play.",
	...listIf(skipped.length > 0, () => [
		"Left out:",
		...skipped.map((s) => `  ${s}`),
	]),
];

export const importBestiary = Effect.fn("importBestiary")(function* (
	options: ImportOptions
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const { creatures, unreadable } = yield* readSource(options.from);

	const { chosen, notFound, ambiguous } = pick(creatures, options.names ?? []);

	const imported: Array<ImportedMonster> = [];
	const failed: Array<Failed> = [];
	const written = new Set<string>();

	const write = (file: string, text: string) =>
		Effect.gen(function* () {
			yield* fs.makeDirectory(options.into, { recursive: true, mode: 0o700 });
			yield* fs.makeDirectory(path.join(options.into, "monsters"), {
				recursive: true,
			});
			yield* fs.writeFileString(file, text);
		}).pipe(
			Effect.mapError(
				(cause) =>
					new ContentReadError({
						message: `can't write ${file}: ${cause.message}`,
						cause,
					})
			)
		);

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
		const problems = idProblems(sheet);

		if (problems.length > 0) {
			failed.push({ name: sheet.name, source: creature.source, problems });
			continue;
		}

		const file = `monsters/${sheet.id}.yaml`;

		if (written.has(sheet.id)) {
			failed.push({
				name: sheet.name,
				source: creature.source,
				problems: [
					`another creature in this import was already written to ${file}`,
				],
			});
			continue;
		}

		const text = monsterYaml(sheet, headerOf(creature.source, skipped));
		const check = yield* Effect.result(decodeMonster(file, text));

		if (Result.isFailure(check)) {
			failed.push({
				name: sheet.name,
				source: creature.source,
				problems: check.failure.problems,
			});
			continue;
		}

		const target = path.join(options.into, file);

		const there = yield* fs
			.exists(target)
			.pipe(Effect.orElseSucceed(() => false));

		if (options.overwrite !== true && there) {
			imported.push({
				name: sheet.name,
				id: sheet.id,
				file,
				status: "exists",
				skipped,
			});
			continue;
		}

		yield* write(target, text);
		written.add(sheet.id);
		imported.push({
			name: sheet.name,
			id: sheet.id,
			file,
			status: "written",
			skipped,
		});
	}

	const report: ImportReport = {
		imported: imported.toSorted((a, b) => byText(a.id, b.id)),
		failed: failed.toSorted((a, b) => byText(a.name, b.name)),
		notFound,
		ambiguous,
		unreadable,
	};

	return report;
});

const writtenLine = (m: ImportedMonster) => {
	if (m.skipped.length === 0) {
		return `wrote ${m.file} (${m.name})`;
	}

	const count =
		m.skipped.length === 1 ? "one thing" : `${m.skipped.length} things`;

	return `wrote ${m.file} (${m.name}), leaving out ${count} (see its header)`;
};

export const importReportText = (
	report: ImportReport
): ReadonlyArray<string> => [
	...report.imported.map((m) =>
		m.status === "written"
			? writtenLine(m)
			: `kept ${m.file} (${m.name}): it exists; --overwrite replaces it`
	),
	...report.failed.flatMap((m) => [
		`couldn't import ${m.name} (${m.source}):`,
		...m.problems.map((p) => `  ${p}`),
	]),
	...report.notFound.map((n) => `no monster named ${show(n)}`),
	...report.ambiguous.map(
		(a) => `${show(a.query)} could be: ${a.matches.join(", ")}`
	),
	...report.unreadable,
];
