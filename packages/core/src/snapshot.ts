import {
	MAP_MAX_HEIGHT,
	MAP_MAX_LEGEND_ENTRIES,
	MAP_MAX_WIDTH,
	MAP_NAME_MAX_LENGTH,
} from "./map.js";
import type { TextAttribute, ThemeToken } from "./text.js";
import type { ValidationIssue } from "./validation.js";
import { isRecord } from "./validation.js";

/**
 * Snapshot document schema version 1 — the core-owned publish wire contract.
 *
 * The CLI produces one of the three closed artifact variants; the game-blind
 * web surface consumes it. Version 1 carries semantic sections, labeled string
 * fields, timestamped text/map blocks, and a strings-only card section. It has
 * no coordinates, widths, line breaks, collapse flags, ANSI, or other layout
 * instructions. Every object is closed-keyed so vocabulary growth requires a
 * new integer schema version rather than silently changing this contract.
 *
 * Artifact identity (owner/type/name and capability URL) belongs to the publish
 * transport, not this document. Map names are content and therefore remain in
 * the shared map-grid block. The five terrain values below are copied on
 * purpose: version 1 must not widen if the live BattleMap vocabulary does.
 */
export const SNAPSHOT_SCHEMA_VERSION = 1;

export const SNAPSHOT_ARTIFACT_TYPES = ["character", "log", "map"] as const;
export type SnapshotArtifactType = (typeof SNAPSHOT_ARTIFACT_TYPES)[number];

/** Version-frozen copies: future live FeedLine growth cannot widen v1. */
export const SNAPSHOT_THEME_TOKENS_V1 = [
	"accent",
	"danger",
	"muted",
	"primary",
	"success",
] as const satisfies readonly ThemeToken[];
export type SnapshotThemeTokenV1 = (typeof SNAPSHOT_THEME_TOKENS_V1)[number];

export const SNAPSHOT_TEXT_ATTRIBUTES_V1 = [
	"bold",
	"dim",
	"italic",
	"reverse",
	"underline",
] as const satisfies readonly TextAttribute[];
export type SnapshotTextAttributeV1 =
	(typeof SNAPSHOT_TEXT_ATTRIBUTES_V1)[number];

export const SNAPSHOT_MAP_TILES_V1 = [
	"difficult",
	"door",
	"floor",
	"hazard",
	"wall",
] as const;
export type SnapshotMapTileV1 = (typeof SNAPSHOT_MAP_TILES_V1)[number];
export type SnapshotMapLegendV1 = Readonly<Record<string, SnapshotMapTileV1>>;

export interface SnapshotFieldV1 {
	readonly label: string;
	readonly value: string;
}

/** Strings only: the OG generator never learns a game or terminal color API. */
export interface SnapshotCardV1 {
	readonly title: string;
	readonly description: string;
	readonly fields: readonly SnapshotFieldV1[];
	readonly glyph?: string;
	readonly accentHint?: SnapshotThemeTokenV1;
}

export interface SnapshotSectionV1 {
	readonly title: string;
	readonly fields: readonly SnapshotFieldV1[];
}

/** Terrain-only map content shared by map documents and inline log blocks. */
export interface SnapshotMapGridV1 {
	readonly type: "map-grid";
	readonly name: string;
	readonly legend: SnapshotMapLegendV1;
	readonly rows: readonly string[];
}

export interface SnapshotTextRunV1 {
	readonly text: string;
	readonly token: SnapshotThemeTokenV1;
	readonly attrs?: readonly SnapshotTextAttributeV1[];
}

export interface SnapshotTextBlockV1 {
	readonly type: "text";
	readonly runs: readonly SnapshotTextRunV1[];
}

export type SnapshotLogBlockV1 = SnapshotTextBlockV1 | SnapshotMapGridV1;

/** `timestamp` is the source Envelope's canonical UTC ISO instant. */
export interface SnapshotLogEntryV1 {
	readonly timestamp: string;
	readonly block: SnapshotLogBlockV1;
}

interface SnapshotDocumentBaseV1 {
	readonly schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
	readonly artifactType: SnapshotArtifactType;
	readonly card: SnapshotCardV1;
}

export interface CharacterSnapshotDocumentV1 extends SnapshotDocumentBaseV1 {
	readonly artifactType: "character";
	readonly sections: readonly SnapshotSectionV1[];
}

export interface LogSnapshotDocumentV1 extends SnapshotDocumentBaseV1 {
	readonly artifactType: "log";
	readonly entries: readonly SnapshotLogEntryV1[];
}

export interface MapSnapshotDocumentV1 extends SnapshotDocumentBaseV1 {
	readonly artifactType: "map";
	readonly map: SnapshotMapGridV1;
}

export type SnapshotDocumentV1 =
	| CharacterSnapshotDocumentV1
	| LogSnapshotDocumentV1
	| MapSnapshotDocumentV1;

/** All schema versions accepted by this build. Launch accepts version 1 only. */
export type SnapshotDocument = SnapshotDocumentV1;

export type SnapshotValidationResult =
	| { readonly ok: true; readonly document: SnapshotDocument }
	| { readonly ok: false; readonly errors: readonly ValidationIssue[] };

const CONTROL_CHARACTER = /\p{C}/u;
const UNPRINTABLE = /[\p{C}\p{Z}]/u;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const THEME_TOKEN_SET: ReadonlySet<string> = new Set(SNAPSHOT_THEME_TOKENS_V1);
const TEXT_ATTRIBUTE_SET: ReadonlySet<string> = new Set(
	SNAPSHOT_TEXT_ATTRIBUTES_V1
);
const SNAPSHOT_MAP_TILE_SET: ReadonlySet<string> = new Set(
	SNAPSHOT_MAP_TILES_V1
);

const failure = (message: string): SnapshotValidationResult => ({
	errors: [{ message }],
	ok: false,
});

const hasOnlyKeys = (
	value: Readonly<Record<string, unknown>>,
	keys: readonly string[]
): boolean => Object.keys(value).every((key) => keys.includes(key));

const isSemanticString = (value: unknown): value is string =>
	typeof value === "string" && !CONTROL_CHARACTER.test(value);

const isNonEmptySemanticString = (value: unknown): value is string =>
	isSemanticString(value) && value.length > 0;

const isThemeToken = (value: unknown): value is SnapshotThemeTokenV1 =>
	typeof value === "string" && THEME_TOKEN_SET.has(value);

const isField = (value: unknown): value is SnapshotFieldV1 =>
	isRecord(value) &&
	hasOnlyKeys(value, ["label", "value"]) &&
	isNonEmptySemanticString(value.label) &&
	isSemanticString(value.value);

const isCard = (value: unknown): value is SnapshotCardV1 =>
	isRecord(value) &&
	hasOnlyKeys(value, [
		"accentHint",
		"description",
		"fields",
		"glyph",
		"title",
	]) &&
	isNonEmptySemanticString(value.title) &&
	isSemanticString(value.description) &&
	Array.isArray(value.fields) &&
	value.fields.every(isField) &&
	(value.glyph === undefined ||
		(isNonEmptySemanticString(value.glyph) &&
			[...value.glyph].length === 1 &&
			!UNPRINTABLE.test(value.glyph))) &&
	(value.accentHint === undefined || isThemeToken(value.accentHint));

const isSection = (value: unknown): value is SnapshotSectionV1 =>
	isRecord(value) &&
	hasOnlyKeys(value, ["fields", "title"]) &&
	isNonEmptySemanticString(value.title) &&
	Array.isArray(value.fields) &&
	value.fields.every(isField);

const isCharacterDocument = (
	value: Readonly<Record<string, unknown>>
): value is Readonly<Record<string, unknown>> & CharacterSnapshotDocumentV1 =>
	hasOnlyKeys(value, ["artifactType", "card", "schemaVersion", "sections"]) &&
	value.artifactType === "character" &&
	isCard(value.card) &&
	Array.isArray(value.sections) &&
	value.sections.every(isSection);

const isTextRun = (value: unknown): value is SnapshotTextRunV1 =>
	isRecord(value) &&
	hasOnlyKeys(value, ["attrs", "text", "token"]) &&
	isSemanticString(value.text) &&
	isThemeToken(value.token) &&
	(value.attrs === undefined ||
		(Array.isArray(value.attrs) &&
			value.attrs.every(
				(attribute) =>
					typeof attribute === "string" && TEXT_ATTRIBUTE_SET.has(attribute)
			)));

const isTextBlock = (value: unknown): value is SnapshotTextBlockV1 =>
	isRecord(value) &&
	hasOnlyKeys(value, ["runs", "type"]) &&
	value.type === "text" &&
	Array.isArray(value.runs) &&
	value.runs.every(isTextRun);

const isSnapshotLegend = (value: unknown): value is SnapshotMapLegendV1 =>
	isRecord(value) &&
	Object.keys(value).length > 0 &&
	Object.keys(value).length <= MAP_MAX_LEGEND_ENTRIES &&
	Object.entries(value).every(
		([character, tile]) =>
			[...character].length === 1 &&
			!UNPRINTABLE.test(character) &&
			typeof tile === "string" &&
			SNAPSHOT_MAP_TILE_SET.has(tile)
	);

const isSnapshotGrid = (
	value: unknown,
	legend: SnapshotMapLegendV1
): value is readonly string[] => {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.length > MAP_MAX_HEIGHT ||
		!value.every((row) => typeof row === "string")
	) {
		return false;
	}
	const rows: readonly string[] = value;
	const width = [...(rows[0] ?? "")].length;
	return (
		width > 0 &&
		width <= MAP_MAX_WIDTH &&
		rows.every(
			(row) =>
				[...row].length === width &&
				[...row].every((character) => Object.hasOwn(legend, character))
		)
	);
};

const isMapGrid = (value: unknown): value is SnapshotMapGridV1 =>
	isRecord(value) &&
	hasOnlyKeys(value, ["legend", "name", "rows", "type"]) &&
	value.type === "map-grid" &&
	isNonEmptySemanticString(value.name) &&
	value.name.length <= MAP_NAME_MAX_LENGTH &&
	isSnapshotLegend(value.legend) &&
	isSnapshotGrid(value.rows, value.legend);

const isCanonicalUtcTimestamp = (value: unknown): value is string => {
	if (typeof value !== "string" || !UTC_TIMESTAMP.test(value)) {
		return false;
	}
	try {
		return new Date(value).toISOString() === value;
	} catch {
		return false;
	}
};

const isLogEntry = (value: unknown): value is SnapshotLogEntryV1 =>
	isRecord(value) &&
	hasOnlyKeys(value, ["block", "timestamp"]) &&
	isCanonicalUtcTimestamp(value.timestamp) &&
	(isTextBlock(value.block) || isMapGrid(value.block));

const isLogDocument = (
	value: Readonly<Record<string, unknown>>
): value is Readonly<Record<string, unknown>> & LogSnapshotDocumentV1 =>
	hasOnlyKeys(value, ["artifactType", "card", "entries", "schemaVersion"]) &&
	value.artifactType === "log" &&
	isCard(value.card) &&
	Array.isArray(value.entries) &&
	value.entries.every(isLogEntry);

const isMapDocument = (
	value: Readonly<Record<string, unknown>>
): value is Readonly<Record<string, unknown>> & MapSnapshotDocumentV1 =>
	hasOnlyKeys(value, ["artifactType", "card", "map", "schemaVersion"]) &&
	value.artifactType === "map" &&
	isCard(value.card) &&
	isMapGrid(value.map);

/** Validates an already-decoded snapshot document and narrows it for generic
 * consumers. JSON decoding stays at the HTTP/file edge; this seam owns schema. */
export const validateSnapshotDocument = (
	value: unknown
): SnapshotValidationResult => {
	if (!isRecord(value)) {
		return failure("Snapshot document must be an object.");
	}
	if (
		!Number.isSafeInteger(value.schemaVersion) ||
		value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION
	) {
		return failure("Snapshot document schemaVersion must be the integer 1.");
	}
	if (
		typeof value.artifactType !== "string" ||
		!SNAPSHOT_ARTIFACT_TYPES.includes(
			value.artifactType as SnapshotArtifactType
		)
	) {
		return failure(
			"Snapshot document artifactType must be character, log, or map."
		);
	}
	if (value.artifactType === "character" && isCharacterDocument(value)) {
		return { document: value, ok: true };
	}
	if (value.artifactType === "log" && isLogDocument(value)) {
		return { document: value, ok: true };
	}
	if (value.artifactType === "map" && isMapDocument(value)) {
		return { document: value, ok: true };
	}
	return failure(
		`Snapshot document is not a valid version-1 ${value.artifactType} artifact.`
	);
};
