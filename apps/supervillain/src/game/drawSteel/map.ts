/**
 * The text map's grid (ASSESSMENT Q7): squares, the coordinates people type, map files and
 * terrain. Pure: the host reads `<campaign>/maps/<id>.txt` and puts the grid in the command, so the
 * event carries it and replay never reads a file.
 */
import type { Refused } from "../module.ts";
import { terrainOf } from "../prototype-map-gen/legend.ts";

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
   * PROTOTYPE (prototype-map-gen): the MEKMODE letter drawn on each square, from a `style:
   * mekmode` map file; the rules read `terrain`, which the legend makes from it.
   */
  readonly dressing?: ReadonlyArray<string>;
}

export const MAP_WIDTH = 60;
export const MAP_HEIGHT = 40;
const NAME_MAX = 40;

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
  const dressing = grid.dressing
    ?.slice(0, rows.length)
    .map((row) => row.slice(0, width).padEnd(width, " "));
  return dressing ? { name, terrain, dressing } : { name, terrain };
}

/**
 * A map file's text as a grid: an optional first line `name: <name>` (else the id is the name),
 * then one line per row of terrain.
 */
export function readMapText(id: string, text: string, file?: string): MapGrid | Refused {
  let lines = text.replace(/\r\n?/g, "\n").split("\n");
  let name = id;
  let mekmode = false;
  // PROTOTYPE: header lines `name: <name>` and `style: mekmode`, in either order.
  for (;;) {
    const named = /^name:\s*(.*)$/i.exec(lines[0] ?? "");
    const styled = /^style:\s*mekmode\s*$/i.test(lines[0] ?? "");
    if (named) name = named[1]!;
    else if (styled) mekmode = true;
    else break;
    lines = lines.slice(1);
  }
  if (!mekmode) return checkGrid(id, { name, terrain: lines }, file);
  const terrain: string[] = [];
  for (const [row, line] of lines.entries()) {
    let out = "";
    for (const [column, letter] of [...line].entries()) {
      const t = terrainOf(letter);
      if (t === undefined)
        return {
          refusal: `${file ?? `maps/${id}.txt`} row ${row + 1}, column ${column + 1} is "${letter}", which isn't a MEKMODE map letter.`,
        };
      out += t;
    }
    terrain.push(out);
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
