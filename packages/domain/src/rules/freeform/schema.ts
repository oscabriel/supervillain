import { Schema } from "effect";

import { parseNotation } from "../../dice.ts";
import { proseBytes, proseSafe, ProseSchema } from "../../prose.ts";
import { hasTerminalControls, lengthOf } from "../../text.ts";
import { ID } from "../drawSteel/schema.ts";
import { isRefused } from "../engine.ts";

export const STAT_KEY = /^[a-z][a-z0-9-]{0,15}$/u;

export const TAG = /^[a-z0-9][a-z0-9-]{0,23}$/u;

export const STATS_MAX = 16;

export const TAGS_MAX = 12;

export const STAT_LIMIT = 9999;

export const FF_NAME_MAX = 40;

const TEXT_MAX = 80;

const NOTES_BYTES = 8 * 1024;

export const StatKeySchema = Schema.String.check(
	Schema.isPattern(STAT_KEY)
).annotate({
	description:
		"A stat's key: a lower-case letter, then up to 15 lower-case letters, digits or hyphens.",
	examples: ["might", "hp", "fate-points"],
});

export const StatsSchema = Schema.Record(StatKeySchema, Schema.Int).annotate({
	description: "Named numbers, like might: 2 or wits: 1.",
	examples: [{ might: 2, wits: 1 }],
});

export const FfSheetSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	pronouns: Schema.optionalKey(Schema.String),
	concept: Schema.optionalKey(Schema.String),
	dice: Schema.optionalKey(Schema.String),
	stats: Schema.optionalKey(StatsSchema),
	resources: Schema.optionalKey(StatsSchema),
	tags: Schema.optionalKey(Schema.Array(Schema.String)),
	portrait: Schema.optionalKey(Schema.String),
	notes: Schema.optionalKey(ProseSchema),
}).annotate({
	identifier: "FfSheet",
	description:
		"A freeform character: a name, a concept, named stats, resources that count down from a maximum, tags and player-safe notes.",
});

export type FfSheet = typeof FfSheetSchema.Type;

const safe = (text: string | undefined, max = TEXT_MAX): boolean =>
	text === undefined ||
	(text.trim() !== "" && lengthOf(text) <= max && !hasTerminalControls(text));

const numbersOk = (record: Readonly<Record<string, number>> | undefined) =>
	record === undefined ||
	(Object.keys(record).length <= STATS_MAX &&
		Object.entries(record).every(
			([key, value]) =>
				STAT_KEY.test(key) &&
				Number.isInteger(value) &&
				Math.abs(value) <= STAT_LIMIT
		));

export const ffSheetProblem = (sheet: FfSheet): string | undefined => {
	if (!ID.test(sheet.id)) {
		return `'${sheet.id}' isn't an id (lower-case letters, digits and hyphens)`;
	}

	if (!safe(sheet.name, FF_NAME_MAX)) {
		return `the name must be text of at most ${FF_NAME_MAX} characters`;
	}

	if (![sheet.pronouns, sheet.concept, sheet.portrait].every((t) => safe(t))) {
		return `pronouns, concept and portrait must be text of at most ${TEXT_MAX} characters`;
	}

	if (sheet.dice !== undefined && isRefused(parseNotation(sheet.dice))) {
		return `dice '${sheet.dice}' isn't dice like d20 or 2d6`;
	}

	if (!numbersOk(sheet.stats) || !numbersOk(sheet.resources)) {
		return `stats and resources hold at most ${STATS_MAX} whole numbers within ${STAT_LIMIT}, keyed like might or hp`;
	}

	const shared = Object.keys(sheet.stats ?? {}).filter((key) =>
		Object.hasOwn(sheet.resources ?? {}, key)
	);

	if (shared.length > 0) {
		return `${shared.join(", ")} can't be both a stat and a resource`;
	}

	if (Object.values(sheet.resources ?? {}).some((max) => max < 0)) {
		return "a resource's maximum can't be below 0";
	}

	const tags = sheet.tags ?? [];

	if (tags.length > TAGS_MAX || !tags.every((t) => safe(t, 24))) {
		return `tags are at most ${TAGS_MAX}, each at most 24 characters`;
	}

	const { notes } = sheet;

	if (
		notes !== undefined &&
		(!proseSafe(notes) || proseBytes(notes) > NOTES_BYTES)
	) {
		return `notes must be plain text within ${NOTES_BYTES / 1024} KB`;
	}

	return undefined;
};
