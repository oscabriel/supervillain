import {
	charsOf,
	isMekmodeText,
	MAP_HEIGHT,
	MAP_WIDTH,
	readMapText,
	terrainOf,
	MapInvalid,
} from "@supervillain/domain";
import type { MapGrid } from "@supervillain/domain";
import { Effect } from "effect";

export const MAP_BYTES = 8 * 1024;

const LEGEND =
	"draw maps with . floor, # wall, ~ difficult terrain and space for outside.";

const MEKMODE_LEGEND =
	'a mekmode map is drawn in Ding Mode letters (see "Maps in MEKMODE letters" in the campaign README).';

const TERRAIN = /^[.#~ ]$/u;

const PRINTABLE = /^[\u0020-\u007E]$/u;

const hex = (code: number) =>
	`U+${code.toString(16).toUpperCase().padStart(4, "0")}`;

const describe = (char: string): string => {
	const code = char.codePointAt(0) ?? 0;

	if (char === "\t") {
		return "a tab";
	}

	if (code < 0x20 || (code >= 0x7f && code < 0xa0)) {
		return `a control character (${hex(code)})`;
	}

	return `"${char}" (${hex(code)})`;
};

export const tooBig = (file: string, size: number): MapInvalid | undefined =>
	size > MAP_BYTES
		? new MapInvalid({
				file,
				message: `${file} is ${Math.ceil(size / 1024)} KB; a map file is at most ${MAP_BYTES / 1024} KB (${MAP_WIDTH} columns by ${MAP_HEIGHT} rows).`,
			})
		: undefined;

export const decodeMap = (
	file: string,
	id: string,
	bytes: Uint8Array
): Effect.Effect<MapGrid, MapInvalid> => {
	const invalid = (message: string) =>
		Effect.fail(new MapInvalid({ file, message }));

	const big = tooBig(file, bytes.length);

	if (big !== undefined) {
		return Effect.fail(big);
	}

	let text: string;

	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return invalid(`${file} isn't UTF-8 text.`);
	}

	const lines = text.replaceAll(/\r\n?/gu, "\n").split("\n");
	const mekmode = isMekmodeText(lines);
	let headers = 0;

	while (headers < 2 && /^(?:name|style):/iu.test(lines[headers] ?? "")) {
		headers += 1;
	}

	const square = (c: string) =>
		mekmode ? terrainOf(c) !== undefined : TERRAIN.test(c);

	for (const [row, line] of lines.entries()) {
		const chars = charsOf(line);

		const column = chars.findIndex(
			(c) => !(row < headers ? PRINTABLE.test(c) : square(c))
		);

		const bad = chars[column];

		if (bad !== undefined) {
			return invalid(
				`${file} line ${row + 1}, column ${column + 1} is ${describe(bad)}; ${mekmode ? MEKMODE_LEGEND : LEGEND}`
			);
		}
	}

	const grid = readMapText(id, text, file);

	return "refusal" in grid ? invalid(grid.refusal) : Effect.succeed(grid);
};
