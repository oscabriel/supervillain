/**
 * The text map's grid (ASSESSMENT Q7): squares, the coordinates people type, map files and
 * terrain. Pure: the host reads `<campaign>/maps/<id>.txt` and puts the grid in the command, so the
 * event carries it and replay never reads a file.
 */
import type { Refused } from "../module.ts";
import { quote } from "../text.ts";
import { terrainOf } from "./mekmode.ts";

/** One square: `x` is the column from 0 (a), `y` the row from 0 (row 1). */
export interface Square {
  readonly x: number;
  readonly y: number;
}

/** A map as the host loaded it: its name and one string per row, all the same width. */
export interface MapGrid {
  readonly name: string;
  readonly terrain: ReadonlyArray<string>;
  /**
   * A `style: mekmode` map's own letters, one per square (see mekmode.ts). The rules read only
   * `terrain`, which the legend makes from them; the letters are for the picture map to draw.
   */
  readonly dressing?: ReadonlyArray<string>;
}

export const MAP_WIDTH = 60;
export const MAP_HEIGHT = 40;
const NAME_MAX = 40;

/** The kinds of map the host generates from a seed (content/mapgen.ts): `/map new <kind>`. */
export const MAP_KINDS = ["crossing", "keep"] as const;
export type MapKind = (typeof MAP_KINDS)[number];

/** A generated map's seed: any whole number a 32-bit generator takes. */
export const MAP_SEED_MAX = 0xffff_ffff;

/** A `/map new`: the kind to generate, and the seed as typed (the host picks one if it's not). */
export interface MapGeneration {
  readonly kind: MapKind;
  readonly seed?: number;
}

/** Refused for a `/map new` the host hasn't generated: only the host writes map files. */
export const NOT_GENERATED = "No map was generated for that; the host generates a /map new.";

/** The words `/map` reads as themselves, so no map can have one as its id. */
export const MAP_WORDS: ReadonlyArray<string> = ["off", "new"];

/** How `/map` is typed, at a table of either ruleset. */
export const MAP_USAGE = "/map <map id>|off|new crossing|keep [seed]";

/**
 * What follows `/map`: a map's id to load, `off` to put the map away, or `new <kind> [seed]` to
 * generate one into the campaign's maps/ and load it. `new` alone is no map's id here: it asks how
 * to generate one.
 */
export function parseMapArgs(
  args: string,
):
  | { readonly id?: string; readonly generate?: undefined }
  | { readonly generate: MapGeneration }
  | Refused {
  const words = args
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "");
  const usage = { refusal: `Usage: ${MAP_USAGE}` };
  const [first, ...rest] = words;
  if (first === undefined) return usage;
  const word = first.toLowerCase();
  if (word === "new") {
    const [kindTyped, seedTyped, extra] = rest;
    const kind = MAP_KINDS.find((k) => k === kindTyped?.toLowerCase());
    if (kindTyped === undefined || extra !== undefined) return usage;
    if (kind === undefined)
      return {
        refusal: `There's no kind of map called '${quote(kindTyped)}'; there are: ${MAP_KINDS.join(", ")}.`,
      };
    if (seedTyped === undefined) return { generate: { kind } };
    const seed = /^\d{1,10}$/.test(seedTyped) ? Number(seedTyped) : undefined;
    if (seed === undefined || seed > MAP_SEED_MAX)
      return { refusal: `A map's seed is a whole number from 0 to ${MAP_SEED_MAX}.` };
    return { generate: { kind, seed } };
  }
  if (rest.length > 0) return usage;
  return word === "off" ? {} : { id: word };
}

/** What Tab offers after `/map`: off and new, then the kinds after new. */
export function completeMapArgs(partial: string): string[] {
  const typed = partial.trimStart().toLowerCase();
  const kind = /^new\s+(\S*)$/.exec(typed);
  if (kind !== null) return MAP_KINDS.filter((k) => k.startsWith(kind[1]!)).map((k) => `new ${k}`);
  if (/\s/.test(typed)) return [];
  return ["off", "new"].filter((w) => w.startsWith(typed)).map((w) => (w === "new" ? "new " : w));
}

/** "." floor, "#" wall, "~" difficult terrain, " " outside the map. */
export type Terrain = "floor" | "wall" | "difficult" | "outside";

/** The characters a map is drawn with, and nothing else, so no square passes for a token. */
const TERRAIN_CHARS = /^[.#~ ]*$/;
const LEGEND = ". floor, # wall, ~ difficult terrain, space for outside";

/** Column letters: a to z, then aa, ab and on, like a spreadsheet. */
export function columnLabel(x: number): string {
  let n = x + 1;
  let label = "";
  while (n > 0) {
    const digit = (n - 1) % 26;
    label = String.fromCharCode(97 + digit) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

/** "c5" for column c, row 5. */
export const formatSquare = (square: Square): string => `${columnLabel(square.x)}${square.y + 1}`;

/** A square from what was typed ("c5", "AA3"), or undefined if it isn't one. */
export function parseSquare(typed: string): Square | undefined {
  const match = /^([a-z]{1,2})([1-9]\d{0,2})$/i.exec(typed.trim());
  if (match === null) return undefined;
  let x = 0;
  for (const letter of match[1]!.toLowerCase()) x = x * 26 + (letter.charCodeAt(0) - 96);
  return { x: x - 1, y: Number(match[2]) - 1 };
}

const same = (a: Square, b: Square) => a.x === b.x && a.y === b.y;
export { same as sameSquare };

/** Plain printable ASCII: one character is one cell, and nothing a terminal acts on. */
const DRAWABLE = /^[\x20-\x7e]*$/;

/**
 * A grid that fits the table: at most MAP_WIDTH by MAP_HEIGHT, at least one row, only the terrain
 * characters, rows padded with outside squares to the widest. Refusals name `file`, by default
 * the one `id` comes from.
 */
export function checkGrid(id: string, grid: MapGrid, file = `maps/${id}.txt`): MapGrid | Refused {
  const rows = [...grid.terrain];
  while (rows.length > 0 && rows.at(-1)!.trim() === "") rows.pop();
  if (rows.length === 0) return { refusal: `${file} has no rows.` };
  const bad = rows.findIndex((row) => !TERRAIN_CHARS.test(row));
  if (bad !== -1) {
    const row = rows[bad]!;
    const column = [...row].findIndex((c) => !TERRAIN_CHARS.test(c));
    const char = [...row][column]!;
    const what = DRAWABLE.test(char) ? `"${char}"` : "a character a map can't draw";
    return {
      refusal: `${file} row ${bad + 1}, column ${column + 1} is ${what}; draw maps with ${LEGEND}.`,
    };
  }
  const limits = `keep maps to ${MAP_WIDTH} columns and ${MAP_HEIGHT} rows.`;
  const width = Math.max(...rows.map((row) => row.trimEnd().length));
  if (width > MAP_WIDTH) return { refusal: `${file} is ${width} columns wide; ${limits}` };
  if (rows.length > MAP_HEIGHT)
    return { refusal: `${file} is ${rows.length} rows tall; ${limits}` };
  const name = grid.name.trim();
  if (name === "" || name.length > NAME_MAX || !DRAWABLE.test(name))
    return { refusal: `${file} needs a plain name of up to ${NAME_MAX} characters.` };
  const terrain = rows.map((row) => row.trimEnd().padEnd(width, " "));
  if (grid.dressing === undefined) return { name, terrain };
  const dressing = terrain.map((_, y) => (grid.dressing![y] ?? "").trimEnd().padEnd(width, " "));
  return { name, terrain, dressing };
}

/** The header line that makes a map file one written in MEKMODE letters. */
const MEKMODE_STYLE = /^style:\s*mekmode\s*$/i;

/** Whether a map file's text is written in MEKMODE letters: a `style: mekmode` header line. */
export const isMekmodeText = (lines: ReadonlyArray<string>): boolean =>
  lines.slice(0, 2).some((line) => MEKMODE_STYLE.test(line));

/**
 * A map file's text as a grid: optional header lines `name: <name>` (else the id is the name) and
 * `style: mekmode`, in either order, then one line per row. A plain map's rows are terrain; a
 * mekmode map's rows are Ding Mode letters, which the legend turns into terrain, kept as well.
 */
export function readMapText(id: string, text: string, file?: string): MapGrid | Refused {
  let lines = text.replace(/\r\n?/g, "\n").split("\n");
  let name = id;
  let mekmode = false;
  for (let header = 0; header < 2; header++) {
    const named = /^name:\s*(.*)$/i.exec(lines[0] ?? "");
    if (named !== null) name = named[1]!;
    else if (MEKMODE_STYLE.test(lines[0] ?? "")) mekmode = true;
    else break;
    lines = lines.slice(1);
  }
  if (!mekmode) return checkGrid(id, { name, terrain: lines }, file);
  const terrain: string[] = [];
  for (const [row, line] of lines.entries()) {
    let rules = "";
    for (const [column, letter] of [...line].entries()) {
      const square = terrainOf(letter);
      if (square === undefined)
        return {
          refusal: `${file ?? `maps/${id}.txt`} row ${row + 1}, column ${column + 1} is ${DRAWABLE.test(letter) ? `"${letter}"` : "a character a map can't draw"}, which isn't a map letter; see "Maps in MEKMODE letters" in the campaign README.`,
        };
      rules += square;
    }
    terrain.push(rules);
  }
  return checkGrid(id, { name, terrain, dressing: lines }, file);
}

/**
 * Why a grid can't be drawn, if it can't: no rows, rows of different widths, or a character or
 * name that isn't plain printable ASCII. What replay checks, never today's limits.
 */
export function misshapen(grid: MapGrid): string | undefined {
  const width = grid.terrain[0]?.length ?? 0;
  if (width === 0) return "it has no squares";
  if (grid.terrain.some((row) => row.length !== width)) return "its rows aren't one width";
  if (!grid.terrain.every((row) => DRAWABLE.test(row)) || !DRAWABLE.test(grid.name))
    return "it isn't plain ASCII";
  if (grid.name.trim() === "") return "it has no name";
  if (
    grid.dressing !== undefined &&
    (grid.dressing.length !== grid.terrain.length ||
      grid.dressing.some((row) => row.length !== width || !DRAWABLE.test(row)))
  )
    return "its letters don't fit its squares";
  return undefined;
}

export const widthOf = (terrain: ReadonlyArray<string>): number => terrain[0]?.length ?? 0;

export const inBounds = (terrain: ReadonlyArray<string>, square: Square): boolean =>
  square.x >= 0 && square.y >= 0 && square.y < terrain.length && square.x < widthOf(terrain);

export function terrainAt(terrain: ReadonlyArray<string>, square: Square): Terrain {
  if (!inBounds(terrain, square)) return "outside";
  const cell = terrain[square.y]![square.x]!;
  return cell === "#" ? "wall" : cell === "~" ? "difficult" : cell === " " ? "outside" : "floor";
}

/** Whether a creature may stand there: not a wall, and on the map. */
export const standable = (terrain: ReadonlyArray<string>, square: Square): boolean => {
  const t = terrainAt(terrain, square);
  return t === "floor" || t === "difficult";
};

/**
 * Squares between two squares. Every adjacent square is 1, diagonals included: "there's no
 * Pythagorean theorem on the grid" (Combat, "Movement"), and Melee 1 reaches every adjacent
 * square (Classes, "Distance").
 */
export const distance = (a: Square, b: Square): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
