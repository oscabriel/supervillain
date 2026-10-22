import { Effect } from "effect";
import { MAP_HEIGHT, MAP_WIDTH, type MapGrid, readMapText } from "../game/drawSteel/map.ts";
import { MapInvalid } from "./errors.ts";

// The map files a GM draws by hand: maps/<id>.txt, an optional `name: …` first line, then one line
// per row, one character per square. The rules check the grid's shape (game/drawSteel/map.ts);
// this checks what only a file can get wrong, and says where, before the rules see the text.

/** Far more than 60 columns by 40 rows needs; a bigger file is a mistake, not a map. */
export const MAP_BYTES = 8 * 1024;

const LEGEND = "draw maps with . floor, # wall, ~ difficult terrain and space for outside.";
/** What a square may be drawn with; the name line may have any printable ASCII. */
const TERRAIN = /^[.#~ ]$/;
const PRINTABLE = /^[\x20-\x7e]$/;

const hex = (code: number) => `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;

/** What a character that can't be a square is, for a message: never the character itself if it's a control. */
function describe(char: string): string {
  const code = char.codePointAt(0)!;
  if (char === "\t") return "a tab";
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return `a control character (${hex(code)})`;
  return `"${char}" (${hex(code)})`;
}

/** The refusal for a map file of `size` bytes, if it's too big to be a map. */
export const tooBig = (file: string, size: number): MapInvalid | undefined =>
  size > MAP_BYTES
    ? new MapInvalid({
        file,
        message: `${file} is ${Math.ceil(size / 1024)} KB; a map file is at most ${MAP_BYTES / 1024} KB (${MAP_WIDTH} columns by ${MAP_HEIGHT} rows).`,
      })
    : undefined;

/**
 * A map file's bytes as a grid: at most MAP_BYTES, UTF-8, the name line plain printable ASCII and
 * every square one of the terrain characters (the first that isn't is named by line and column, so
 * no letter in the terrain passes for a token), then the rules' own reading (`readMapText`). `file`
 * names it in errors, as it is on disk.
 */
export function decodeMap(
  file: string,
  id: string,
  bytes: Uint8Array,
): Effect.Effect<MapGrid, MapInvalid> {
  const invalid = (message: string) => Effect.fail(new MapInvalid({ file, message }));
  const big = tooBig(file, bytes.length);
  if (big !== undefined) return Effect.fail(big);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalid(`${file} isn't UTF-8 text.`);
  }
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const named = /^name:/i.test(lines[0] ?? "");
  // PROTOTYPE (prototype-map-gen): a `style: mekmode` map is written in letters the rules check.
  if (lines.slice(0, 2).some((line) => /^style:\s*mekmode\s*$/i.test(line))) {
    const grid = readMapText(id, text, file);
    return "refusal" in grid ? invalid(grid.refusal) : Effect.succeed(grid);
  }
  for (const [row, line] of lines.entries()) {
    const chars = [...line];
    const allowed = named && row === 0 ? PRINTABLE : TERRAIN;
    const column = chars.findIndex((c) => !allowed.test(c));
    if (column !== -1)
      return invalid(
        `${file} line ${row + 1}, column ${column + 1} is ${describe(chars[column]!)}; ${LEGEND}`,
      );
  }
  const grid = readMapText(id, text, file);
  return "refusal" in grid ? invalid(grid.refusal) : Effect.succeed(grid);
}
