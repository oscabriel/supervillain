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

/** Bounds on the live token set, in the same spirit as the grid bounds: they
 * are what keeps #38's per-move wire estimates valid. */
export const MAP_MAX_TOKENS = 200;
export const TOKEN_ID_MAX_LENGTH = 60;
export const TOKEN_LABEL_MAX_LENGTH = 40;

/** A validated battle map: terrain only, exactly as its author wrote it. */
export interface BattleMap {
	readonly name: string;
	readonly legend: MapLegend;
	readonly rows: readonly string[];
}

/**
 * A movable marker on the battle map: id, glyph, label, position, optional
 * seat binding — and never a game field. Token-to-character reach is
 * transitive through the `TableView` character↔seat bindings; a module badge
 * here would be real seam growth and sits in the churn ledger (ADR-0006).
 */
export interface MapToken {
	readonly id: string;
	readonly glyph: string;
	readonly label: string;
	readonly seatId: string | null;
	readonly x: number;
	readonly y: number;
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

/** The map's cell extent. Every row is the same width by construction. */
export const mapDimensions = (
	map: BattleMap
): { readonly width: number; readonly height: number } => ({
	height: map.rows.length,
	width: [...(map.rows[0] ?? "")].length,
});

/** Whether a cell coordinate addresses a cell the map actually has. */
export const isInsideMap = (map: BattleMap, x: number, y: number): boolean => {
	const { height, width } = mapDimensions(map);
	return (
		Number.isSafeInteger(x) &&
		Number.isSafeInteger(y) &&
		x >= 0 &&
		y >= 0 &&
		x < width &&
		y < height
	);
};

/** The author's own character at a cell, or `null` outside the grid. */
export const mapGlyphAt = (
	map: BattleMap,
	x: number,
	y: number
): string | null => {
	const row = map.rows[y];
	return row === undefined ? null : ([...row][x] ?? null);
};

/** The tile a cell's character means, or `null` outside the grid. */
export const mapTileAt = (
	map: BattleMap,
	x: number,
	y: number
): MapTile | null => {
	const glyph = mapGlyphAt(map, x, y);
	return glyph === null ? null : (map.legend[glyph] ?? null);
};

/** One token-event fold step: the new token set, or the reason it was refused.
 * The host halts on a refusal, render folds skip it loudly (ADR-0010). */
export type TokenFold =
	| { readonly ok: true; readonly tokens: readonly MapToken[] }
	| { readonly ok: false; readonly reason: string };

const TOKEN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/u;
const UNPRINTABLE = /[\p{C}\p{Z}]/u;
const CONTROL_CHARACTER = /\p{C}/u;

/** Whether a string may name a token — filename-safe, like a map name. */
export const isValidTokenId = (id: string): boolean => TOKEN_ID.test(id);

/** Whether a string is a token glyph: exactly one printable character. */
export const isValidTokenGlyph = (glyph: string): boolean =>
	[...glyph].length === 1 && !UNPRINTABLE.test(glyph);

const isValidTokenLabel = (label: string): boolean =>
	label.length <= TOKEN_LABEL_MAX_LENGTH && !CONTROL_CHARACTER.test(label);

/** Reads a `core.token-placed` payload back into a token, or `null` when the
 * payload is known-invalid. Bounds are checked against the map separately. */
export const readTokenPlacedPayload = (payload: unknown): MapToken | null => {
	if (!isRecord(payload)) {
		return null;
	}
	const { glyph, id, label, seatId, x, y } = payload;
	if (
		typeof id !== "string" ||
		!isValidTokenId(id) ||
		typeof glyph !== "string" ||
		!isValidTokenGlyph(glyph) ||
		typeof label !== "string" ||
		!isValidTokenLabel(label) ||
		(seatId !== null &&
			(typeof seatId !== "string" ||
				seatId.length === 0 ||
				seatId.length > TOKEN_ID_MAX_LENGTH)) ||
		typeof x !== "number" ||
		typeof y !== "number" ||
		!(Number.isSafeInteger(x) && Number.isSafeInteger(y))
	) {
		return null;
	}
	return { glyph, id, label, seatId, x, y };
};

/** Reads a `core.token-moved` payload, or `null` when it is known-invalid. */
export const readTokenMovedPayload = (
	payload: unknown
): { readonly id: string; readonly x: number; readonly y: number } | null => {
	if (!isRecord(payload)) {
		return null;
	}
	const { id, x, y } = payload;
	if (
		typeof id !== "string" ||
		!isValidTokenId(id) ||
		typeof x !== "number" ||
		typeof y !== "number" ||
		!(Number.isSafeInteger(x) && Number.isSafeInteger(y))
	) {
		return null;
	}
	return { id, x, y };
};

/** Reads a `core.token-removed` payload, or `null` when known-invalid. */
export const readTokenRemovedPayload = (
	payload: unknown
): { readonly id: string } | null => {
	if (!isRecord(payload)) {
		return null;
	}
	const { id } = payload;
	return typeof id === "string" && isValidTokenId(id) ? { id } : null;
};

/**
 * Folds `core.token-placed` over the token set. Placing onto an id that is
 * already on the surface replaces it — that is how a re-glyph, relabel, or
 * reseat is expressed, since ADR-0006 pins the token vocabulary at exactly
 * placed/moved/removed.
 */
export const foldTokenPlaced = (
	map: BattleMap | null,
	tokens: readonly MapToken[],
	payload: unknown
): TokenFold => {
	const token = readTokenPlacedPayload(payload);
	if (token === null) {
		return { ok: false, reason: "malformed token" };
	}
	if (map === null) {
		return { ok: false, reason: "no map is loaded" };
	}
	if (!isInsideMap(map, token.x, token.y)) {
		return {
			ok: false,
			reason: `position ${token.x},${token.y} is outside the map`,
		};
	}
	const index = tokens.findIndex((candidate) => candidate.id === token.id);
	if (index === -1 && tokens.length >= MAP_MAX_TOKENS) {
		return {
			ok: false,
			reason: `the map already holds ${MAP_MAX_TOKENS} tokens`,
		};
	}
	if (index === -1) {
		return { ok: true, tokens: [...tokens, token] };
	}
	return { ok: true, tokens: tokens.with(index, token) };
};

/** Folds `core.token-moved` over the token set. */
export const foldTokenMoved = (
	map: BattleMap | null,
	tokens: readonly MapToken[],
	payload: unknown
): TokenFold => {
	const move = readTokenMovedPayload(payload);
	if (move === null) {
		return { ok: false, reason: "malformed token move" };
	}
	if (map === null) {
		return { ok: false, reason: "no map is loaded" };
	}
	const index = tokens.findIndex((candidate) => candidate.id === move.id);
	const token = tokens[index];
	if (token === undefined) {
		return { ok: false, reason: `no token '${move.id}' is on the map` };
	}
	if (!isInsideMap(map, move.x, move.y)) {
		return {
			ok: false,
			reason: `position ${move.x},${move.y} is outside the map`,
		};
	}
	return {
		ok: true,
		tokens: tokens.with(index, { ...token, x: move.x, y: move.y }),
	};
};

/** Folds `core.token-removed` over the token set. */
export const foldTokenRemoved = (
	tokens: readonly MapToken[],
	payload: unknown
): TokenFold => {
	const removal = readTokenRemovedPayload(payload);
	if (removal === null) {
		return { ok: false, reason: "malformed token removal" };
	}
	if (!tokens.some((candidate) => candidate.id === removal.id)) {
		return { ok: false, reason: `no token '${removal.id}' is on the map` };
	}
	return {
		ok: true,
		tokens: tokens.filter((candidate) => candidate.id !== removal.id),
	};
};

/** The token standing on a cell, or `null`. Last placed wins a shared cell —
 * the map adjudicates nothing, so stacking is legal and the top one shows. */
export const tokenAt = (
	tokens: readonly MapToken[],
	x: number,
	y: number
): MapToken | null =>
	tokens.findLast((token) => token.x === x && token.y === y) ?? null;
