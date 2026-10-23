// Writing a generated map into a campaign's maps/: the one way both `supervillain map` and the
// table's `/map new` do it. Generation is seeded (mapgen.ts), so the seed, in the default id
// `<kind>-<seed>`, is the record; the table then loads the file as a typed `/map <id>`, so the
// event carries the grid and replay never generates or reads a file.
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { MAP_SEED_MAX, MAP_WORDS, type MapKind } from "../game/drawSteel/map.ts";
import { ID } from "../game/drawSteel/schema.ts";
import { MapWriteFailed } from "./errors.ts";
import { type GeneratedMap, generateMap, mapFileText } from "./mapgen.ts";

/** A generated map, written: its id (the file name in maps/), the file and the map itself. */
export interface WrittenMap {
  readonly id: string;
  /** The file, relative to the campaign folder: `maps/crossing-42.txt`. */
  readonly file: string;
  readonly kind: MapKind;
  readonly seed: number;
  readonly map: GeneratedMap;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A file already in `folder` that loads as map `id`: ids are file names in lower case. */
const sameId = async (folder: string, id: string): Promise<string | undefined> => {
  try {
    return (await readdir(folder)).find((name) => name.toLowerCase() === `${id}.txt`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
};

/**
 * Generates a `kind` of map from `seed` (0 to MAP_SEED_MAX, as `/map new` takes it) and writes it
 * to `<campaignDir>/maps/<id>.txt`, `id` being `<kind>-<seed>` unless given. It never overwrites a
 * file, nor writes one beside a file that would load by the same id (`Keep-42.txt`), nor takes an
 * id `/map` reads as a word (`off`, `new`). It makes maps/ if the campaign has none, but never the
 * campaign folder itself.
 */
export const writeGeneratedMap = (
  campaignDir: string,
  kind: MapKind,
  seed: number,
  id: string = `${kind}-${seed}`,
): Effect.Effect<WrittenMap, MapWriteFailed> =>
  Effect.gen(function* () {
    const mapId = id.toLowerCase();
    const failed = (reason: MapWriteFailed["reason"], message: string) =>
      new MapWriteFailed({ reason, id: mapId, message });
    if (!Number.isInteger(seed) || seed < 0 || seed > MAP_SEED_MAX)
      return yield* failed("bad-seed", `a map's seed is a whole number from 0 to ${MAP_SEED_MAX}`);
    if (!ID.test(mapId))
      return yield* failed("bad-id", `a map id is up to 40 of a-z, 0-9 and -, not ${mapId}`);
    if (MAP_WORDS.includes(mapId))
      return yield* failed(
        "bad-id",
        `a map can't be called ${mapId}, since /map ${mapId} means that`,
      );
    const map = yield* Effect.try({
      try: () => generateMap(kind, seed),
      catch: (e) => failed("generate", messageOf(e)),
    });
    const file = `maps/${mapId}.txt`;
    const exists = failed("exists", `there's already a map called ${mapId} in maps/`);
    const written = yield* Effect.tryPromise({
      try: async () => {
        await stat(campaignDir);
        const folder = join(campaignDir, "maps");
        if ((await sameId(folder, mapId)) !== undefined) return false;
        await mkdir(folder, { recursive: true });
        await writeFile(join(campaignDir, file), mapFileText(map), { flag: "wx" });
        return true;
      },
      catch: (e) => {
        const code = (e as NodeJS.ErrnoException).code;
        return code === "EEXIST"
          ? exists
          : code === "ENOENT"
            ? failed("no-campaign", `there's no campaign at ${campaignDir}`)
            : failed("write", `can't write ${file}: ${messageOf(e)}`);
      },
    });
    if (!written) return yield* exists;
    return { id: mapId, file, kind, seed, map } satisfies WrittenMap;
  });
