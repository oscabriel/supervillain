import { isRecord } from "./validation.js";
import type { ValidationIssue, ValidationResult } from "./validation.js";

/** The core-pinned tile vocabulary a legend character may name. */
export type MapTile = "difficult" | "door" | "floor" | "hazard" | "wall";

export const MAP_TILES: readonly MapTile[] = [
	"difficult",
	"door",
	"floor",
	"hazard",
	"wall",
];

/** A legend maps the author's own characters onto the tile vocabulary. */
export type MapLegend = Readonly<Record<string, MapTile>>;

/** NetHack-informed legend used when a map file declares none of its own. */
export const DEFAULT_MAP_LEGEND: MapLegend = {
	"#": "wall",
	"+": "door",
	".": "floor",
	"^": "hazard",
	"~": "difficult",
};

/** The campaign folder subdirectory map files are authored in. */
export const MAP_DIRECTORY = "maps";
export const MAP_FILE_EXTENSION = ".map";
/** The line that separates a map file's header from its grid. */
export const MAP_SEPARATOR = "---";

export const MAP_MAX_WIDTH = 200;
export const MAP_MAX_HEIGHT = 100;
export const MAP_MAX_LEGEND_ENTRIES = 64;
export const MAP_NAME_MAX_LENGTH = 60;

/** A validated battle map: terrain only, exactly as its author wrote it. */
export interface BattleMap {
	readonly name: string;
	readonly legend: MapLegend;
	readonly rows: readonly string[];
}

export type MapParseResult =
	| { readonly ok: true; readonly map: BattleMap }
	| { readonly ok: false; readonly errors: readonly ValidationIssue[] };

const MAX_REPORTED_ISSUES = 8;
const HEADER_LINE = /^(?<key>[a-z][a-z-]*):(?<value>.*)$/u;
const LEGEND_ENTRY = /^(?<character>[!-~])\s+(?<tile>[a-z]+)$/u;
const MAP_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/u;
const BYTE_ORDER_MARK = 0xfe_ff;
const LINE_BREAK = /\r?\n/u;

const failure = (
	...messages: readonly string[]
): { readonly ok: false; readonly errors: readonly ValidationIssue[] } => ({
	errors: messages.map((message) => ({ message })),
	ok: false,
});

/** Whether a name may address a map file — filename-safe, never a path. */
export const isValidMapName = (name: string): boolean => MAP_NAME.test(name);

/** The map file a map name addresses, relative to the campaign folder. */
export const mapFilePath = (name: string): string =>
	`${MAP_DIRECTORY}/${name}${MAP_FILE_EXTENSION}`;

const isMapTile = (value: unknown): value is MapTile =>
	MAP_TILES.includes(value as MapTile);

interface Header {
	name: string | undefined;
	declaredLegend: boolean;
	readonly legend: Record<string, MapTile>;
	readonly errors: string[];
}

const parseLegendEntry = (
	value: string,
	legend: Record<string, MapTile>
): string | undefined => {
	const match = LEGEND_ENTRY.exec(value.trim());
	const character = match?.groups?.character;
	const tile = match?.groups?.tile;
	if (character === undefined || tile === undefined) {
		return `Legend line 'legend: ${value.trim()}' must read '<character> <tile>'.`;
	}
	if (!isMapTile(tile)) {
		return `Legend names unknown tile '${tile}'; use one of ${MAP_TILES.join(", ")}.`;
	}
	if (character in legend) {
		return `Legend defines character '${character}' more than once.`;
	}
	legend[character] = tile;
	return undefined;
};

const parseHeaderLine = (line: string, header: Header): string | undefined => {
	const match = HEADER_LINE.exec(line);
	const key = match?.groups?.key;
	const value = match?.groups?.value;
	if (key === undefined || value === undefined) {
		return `Header line '${line}' must read '<key>: <value>'.`;
	}
	if (key === "name") {
		if (header.name !== undefined) {
			return "Header declares 'name' more than once.";
		}
		const name = value.trim();
		if (name.length === 0 || name.length > MAP_NAME_MAX_LENGTH) {
			return `Header 'name' must be a non-empty string of at most ${MAP_NAME_MAX_LENGTH} characters.`;
		}
		header.name = name;
		return undefined;
	}
	if (key === "legend") {
		header.declaredLegend = true;
		return Object.keys(header.legend).length >= MAP_MAX_LEGEND_ENTRIES
			? `Legend may define at most ${MAP_MAX_LEGEND_ENTRIES} characters.`
			: parseLegendEntry(value, header.legend);
	}
	return `Header key '${key}' is not one of name, legend.`;
};

const parseHeader = (lines: readonly string[]): Header => {
	const header: Header = {
		declaredLegend: false,
		errors: [],
		legend: {},
		name: undefined,
	};
	for (const line of lines) {
		if (line.trim().length === 0) {
			continue;
		}
		const error = parseHeaderLine(line, header);
		if (error !== undefined && header.errors.length < MAX_REPORTED_ISSUES) {
			header.errors.push(error);
		}
	}
	if (header.name === undefined) {
		header.errors.push("Header must declare a 'name'.");
	}
	return header;
};

const gridSizeErrors = (rows: readonly string[]): readonly string[] => {
	if (rows.length === 0) {
		return ["Map grid is empty."];
	}
	if (rows.length > MAP_MAX_HEIGHT) {
		return [
			`Map grid is ${rows.length} rows tall; the limit is ${MAP_MAX_HEIGHT}.`,
		];
	}
	const width = [...(rows[0] ?? "")].length;
	if (width === 0) {
		return ["Map grid is empty."];
	}
	if (width > MAP_MAX_WIDTH) {
		return [`Map grid is ${width} cells wide; the limit is ${MAP_MAX_WIDTH}.`];
	}
	const errors: string[] = [];
	for (const [index, row] of rows.entries()) {
		const rowWidth = [...row].length;
		if (rowWidth !== width && errors.length < MAX_REPORTED_ISSUES) {
			errors.push(
				`Row ${index + 1} is ${rowWidth} cells wide; row 1 is ${width}. Every row must be the same width.`
			);
		}
	}
	return errors;
};

const gridCharacterErrors = (
	rows: readonly string[],
	legend: MapLegend
): readonly string[] => {
	const errors: string[] = [];
	const reported = new Set<string>();
	for (const [index, row] of rows.entries()) {
		for (const character of row) {
			if (
				character in legend ||
				reported.has(character) ||
				errors.length >= MAX_REPORTED_ISSUES
			) {
				continue;
			}
			reported.add(character);
			errors.push(
				`Row ${index + 1} uses character '${character}', which the legend does not define.`
			);
		}
	}
	return errors;
};

/**
 * Parses a `maps/<name>.map` file: a `<key>: <value>` header, a `---` line,
 * then the ASCII grid — one character per map cell, terrain only.
 */
export const parseMapFile = (bytes: Uint8Array): MapParseResult => {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return failure("Map file must contain valid UTF-8 text.");
	}
	const lines = (
		text.codePointAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text
	).split(LINE_BREAK);
	const separator = lines.findIndex((line) => line.trim() === MAP_SEPARATOR);
	if (separator === -1) {
		return failure(
			`Map file must separate its header from its grid with a '${MAP_SEPARATOR}' line.`
		);
	}
	const header = parseHeader(lines.slice(0, separator));
	const rows = lines.slice(separator + 1);
	if (rows.at(-1) === "") {
		rows.pop();
	}
	const legend = header.declaredLegend ? header.legend : DEFAULT_MAP_LEGEND;
	const sizeErrors = gridSizeErrors(rows);
	const errors = [
		...header.errors,
		...sizeErrors,
		...(sizeErrors.length > 0 ? [] : gridCharacterErrors(rows, legend)),
	];
	if (errors.length > 0 || header.name === undefined) {
		return failure(...errors);
	}
	return { map: { legend, name: header.name, rows }, ok: true };
};

/** The `ContentValidator`-shaped face of {@link parseMapFile}. */
export const validateMapFile = (bytes: Uint8Array): ValidationResult => {
	const parsed = parseMapFile(bytes);
	return parsed.ok ? { ok: true } : { errors: parsed.errors, ok: false };
};

const isLegend = (value: unknown): value is MapLegend =>
	isRecord(value) &&
	Object.keys(value).length > 0 &&
	Object.keys(value).length <= MAP_MAX_LEGEND_ENTRIES &&
	Object.entries(value).every(
		([character, tile]) => [...character].length === 1 && isMapTile(tile)
	);

const isGrid = (
	value: unknown,
	legend: MapLegend
): value is readonly string[] => {
	if (!Array.isArray(value) || !value.every((row) => typeof row === "string")) {
		return false;
	}
	const rows: readonly string[] = value;
	return (
		gridSizeErrors(rows).length === 0 &&
		gridCharacterErrors(rows, legend).length === 0
	);
};

/**
 * Reads a `core.map-loaded` payload back into a map, or `null` when the
 * payload is known-invalid. Folds decide the posture: writers halt, readers
 * tolerate (ADR-0010).
 */
export const readMapLoadedPayload = (payload: unknown): BattleMap | null => {
	if (!isRecord(payload)) {
		return null;
	}
	const { legend, name, rows } = payload;
	if (
		typeof name !== "string" ||
		name.trim().length === 0 ||
		name.length > MAP_NAME_MAX_LENGTH ||
		!isLegend(legend) ||
		!isGrid(rows, legend)
	) {
		return null;
	}
	return { legend, name, rows };
};
