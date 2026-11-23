import { charsOf, quote } from "../../text.ts";
import type { Refused } from "../engine.ts";
import { terrainOf } from "./mekmode.ts";

export interface Square {
	readonly x: number;
	readonly y: number;
}

export interface MapGrid {
	readonly name: string;
	readonly terrain: ReadonlyArray<string>;
	readonly dressing?: ReadonlyArray<string>;
}

export const MAP_WIDTH = 60;

export const MAP_HEIGHT = 40;

const NAME_MAX = 40;

export const MAP_KINDS = ["crossing", "keep"] as const;

export type MapKind = (typeof MAP_KINDS)[number];

export const MAP_SEED_MAX = 0xff_ff_ff_ff;

export interface MapGeneration {
	readonly kind: MapKind;
	readonly seed?: number;
}

export const NOT_GENERATED =
	"No map was generated for that; the host generates a /map new.";

export const MAP_WORDS: ReadonlyArray<string> = ["off", "new"];

export const MAP_USAGE = "/map <map id>|off|new crossing|keep [seed]";

export type MapArgs =
	| { readonly id?: string; readonly generate?: undefined }
	| { readonly generate: MapGeneration };

const SPACE = /\s/u;

const SPACES = /\s+/u;

const SEED = /^\d{1,10}$/u;

const NEW_KIND = /^new\s+(?<kind>\S*)$/u;

const wordsOf = (args: string): Array<string> =>
	args
		.trim()
		.split(SPACES)
		.filter((w) => w !== "");

const parseNew = (rest: ReadonlyArray<string>): MapArgs | Refused => {
	const usage = { refusal: `Usage: ${MAP_USAGE}` };
	const [kindTyped, seedTyped, extra] = rest;

	if (kindTyped === undefined || extra !== undefined) {
		return usage;
	}

	const kind = MAP_KINDS.find((k) => k === kindTyped.toLowerCase());

	if (kind === undefined) {
		return {
			refusal: `There's no kind of map called '${quote(kindTyped)}'; there are: ${MAP_KINDS.join(", ")}.`,
		};
	}

	if (seedTyped === undefined) {
		return { generate: { kind } };
	}

	const seed = SEED.test(seedTyped) ? Number(seedTyped) : undefined;

	if (seed === undefined || seed > MAP_SEED_MAX) {
		return {
			refusal: `A map's seed is a whole number from 0 to ${MAP_SEED_MAX}.`,
		};
	}

	return { generate: { kind, seed } };
};

export const parseMapArgs = (args: string): MapArgs | Refused => {
	const [first, ...rest] = wordsOf(args);

	if (first === undefined) {
		return { refusal: `Usage: ${MAP_USAGE}` };
	}

	const word = first.toLowerCase();

	if (word === "new") {
		return parseNew(rest);
	}

	if (rest.length > 0) {
		return { refusal: `Usage: ${MAP_USAGE}` };
	}

	return word === "off" ? {} : { id: word };
};

export const completeMapArgs = (partial: string): Array<string> => {
	const typed = partial.trimStart().toLowerCase();
	const kind = NEW_KIND.exec(typed)?.groups?.kind;

	if (kind !== undefined) {
		return MAP_KINDS.flatMap((k) => (k.startsWith(kind) ? [`new ${k}`] : []));
	}

	if (SPACE.test(typed)) {
		return [];
	}

	return ["off", "new "].filter((w) => w.startsWith(typed));
};

export type Terrain = "floor" | "wall" | "difficult" | "outside";

const TERRAIN_CHARS = /^[.#~ ]*$/u;

const LEGEND = ". floor, # wall, ~ difficult terrain, space for outside";

export const columnLabel = (x: number): string => {
	let n = x + 1;
	let label = "";

	while (n > 0) {
		const digit = (n - 1) % 26;

		label = String.fromCodePoint(97 + digit) + label;
		n = Math.floor((n - 1) / 26);
	}

	return label;
};

export const formatSquare = (square: Square): string =>
	`${columnLabel(square.x)}${square.y + 1}`;

const SQUARE = /^(?<column>[a-z]{1,2})(?<row>[1-9]\d{0,2})$/iu;

export const parseSquare = (typed: string): Square | undefined => {
	const groups = SQUARE.exec(typed.trim())?.groups;

	if (groups === undefined) {
		return undefined;
	}

	const { column = "", row = "" } = groups;
	let x = 0;

	for (const letter of column.toLowerCase()) {
		x = x * 26 + ((letter.codePointAt(0) ?? 96) - 96);
	}

	return { x: x - 1, y: Number(row) - 1 };
};

export const sameSquare = (a: Square, b: Square): boolean =>
	a.x === b.x && a.y === b.y;

const DRAWABLE = /^[ -~]*$/u;

const drawn = (char: string): string =>
	DRAWABLE.test(char) ? `"${char}"` : "a character a map can't draw";

const trimmedRows = (terrain: ReadonlyArray<string>): Array<string> => {
	const rows = [...terrain];

	while (rows.length > 0 && (rows.at(-1) ?? "").trim() === "") {
		rows.pop();
	}

	return rows;
};

const strayCharacter = (
	rows: ReadonlyArray<string>,
	file: string
): Refused | undefined => {
	for (const [y, row] of rows.entries()) {
		for (const [x, char] of charsOf(row).entries()) {
			if (!TERRAIN_CHARS.test(char)) {
				return {
					refusal: `${file} row ${y + 1}, column ${x + 1} is ${drawn(char)}; draw maps with ${LEGEND}.`,
				};
			}
		}
	}

	return undefined;
};

export const checkGrid = (
	id: string,
	grid: MapGrid,
	file = `maps/${id}.txt`
): MapGrid | Refused => {
	const rows = trimmedRows(grid.terrain);

	if (rows.length === 0) {
		return { refusal: `${file} has no rows.` };
	}

	const stray = strayCharacter(rows, file);

	if (stray !== undefined) {
		return stray;
	}

	const limits = `keep maps to ${MAP_WIDTH} columns and ${MAP_HEIGHT} rows.`;
	const width = Math.max(...rows.map((row) => row.trimEnd().length));

	if (width > MAP_WIDTH) {
		return { refusal: `${file} is ${width} columns wide; ${limits}` };
	}

	if (rows.length > MAP_HEIGHT) {
		return { refusal: `${file} is ${rows.length} rows tall; ${limits}` };
	}

	const name = grid.name.trim();

	if (name === "" || name.length > NAME_MAX || !DRAWABLE.test(name)) {
		return {
			refusal: `${file} needs a plain name of up to ${NAME_MAX} characters.`,
		};
	}

	const terrain = rows.map((row) => row.trimEnd().padEnd(width, " "));
	const letters = grid.dressing;

	if (letters === undefined) {
		return { name, terrain };
	}

	const dressing = terrain.map((_, y) =>
		(letters[y] ?? "").trimEnd().padEnd(width, " ")
	);

	return { name, terrain, dressing };
};

const MEKMODE_STYLE = /^style:\s*mekmode\s*$/iu;

const NAMED = /^name:\s*(?<name>.*)$/iu;

const LINE_BREAKS = /\r\n?/gu;

export const isMekmodeText = (lines: ReadonlyArray<string>): boolean =>
	lines.slice(0, 2).some((line) => MEKMODE_STYLE.test(line));

interface Header {
	readonly name: string;
	readonly mekmode: boolean;
	readonly lines: ReadonlyArray<string>;
}

const readHeader = (id: string, text: string): Header => {
	let lines = text.replaceAll(LINE_BREAKS, "\n").split("\n");
	let name = id;
	let mekmode = false;

	for (const _header of [0, 1]) {
		const first = lines[0] ?? "";
		const named = NAMED.exec(first)?.groups?.name;

		if (named !== undefined) {
			name = named;
		} else if (MEKMODE_STYLE.test(first)) {
			mekmode = true;
		} else {
			break;
		}

		lines = lines.slice(1);
	}

	return { name, mekmode, lines };
};

const mekmodeTerrain = (
	lines: ReadonlyArray<string>,
	file: string
): Array<string> | Refused => {
	const terrain: Array<string> = [];

	for (const [row, line] of lines.entries()) {
		let rules = "";

		for (const [column, letter] of charsOf(line).entries()) {
			const square = terrainOf(letter);

			if (square === undefined) {
				return {
					refusal: `${file} row ${row + 1}, column ${column + 1} is ${drawn(letter)}, which isn't a map letter; see "Maps in MEKMODE letters" in the campaign README.`,
				};
			}

			rules += square;
		}

		terrain.push(rules);
	}

	return terrain;
};

export const readMapText = (
	id: string,
	text: string,
	file?: string
): MapGrid | Refused => {
	const { name, mekmode, lines } = readHeader(id, text);

	if (!mekmode) {
		return checkGrid(id, { name, terrain: lines }, file);
	}

	const terrain = mekmodeTerrain(lines, file ?? `maps/${id}.txt`);

	if ("refusal" in terrain) {
		return terrain;
	}

	return checkGrid(id, { name, terrain, dressing: lines }, file);
};

export const malformed = (grid: MapGrid): string | undefined => {
	const width = grid.terrain[0]?.length ?? 0;

	if (width === 0) {
		return "it has no squares";
	}

	if (grid.terrain.some((row) => row.length !== width)) {
		return "its rows aren't one width";
	}

	if (
		!grid.terrain.every((row) => DRAWABLE.test(row)) ||
		!DRAWABLE.test(grid.name)
	) {
		return "it isn't plain ASCII";
	}

	if (grid.name.trim() === "") {
		return "it has no name";
	}

	if (
		grid.dressing !== undefined &&
		(grid.dressing.length !== grid.terrain.length ||
			grid.dressing.some((row) => row.length !== width || !DRAWABLE.test(row)))
	) {
		return "its letters don't fit its squares";
	}

	return undefined;
};

export const widthOf = (terrain: ReadonlyArray<string>): number =>
	terrain[0]?.length ?? 0;

export const inBounds = (
	terrain: ReadonlyArray<string>,
	square: Square
): boolean =>
	square.x >= 0 &&
	square.y >= 0 &&
	square.y < terrain.length &&
	square.x < widthOf(terrain);

export const cellAt = (
	grid: ReadonlyArray<string>,
	square: Square
): string | undefined =>
	inBounds(grid, square) ? grid[square.y]?.[square.x] : undefined;

const TERRAIN_OF = new Map<string, Terrain>([
	["#", "wall"],
	["~", "difficult"],
	[" ", "outside"],
]);

export const terrainAt = (
	terrain: ReadonlyArray<string>,
	square: Square
): Terrain => {
	const cell = cellAt(terrain, square);

	if (cell === undefined) {
		return "outside";
	}

	return TERRAIN_OF.get(cell) ?? "floor";
};

export const standable = (
	terrain: ReadonlyArray<string>,
	square: Square
): boolean => {
	const t = terrainAt(terrain, square);

	return t === "floor" || t === "difficult";
};

export const distance = (a: Square, b: Square): number =>
	Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
