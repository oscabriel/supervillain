import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { type MapGrid, MAP_WORDS } from "../game/drawSteel/map.ts";
import { ID } from "../game/drawSteel/schema.ts";
import type { HeroSheet, StatBlock } from "../game/drawSteel/sheets.ts";
import type { PrepCatalog, PrepEntry } from "../game/prep.ts";
import type { Ruleset } from "../game/table.ts";
import { readCampaignConfig } from "./campaignFile.ts";
import {
  type CampaignConfigInvalid,
  ContentReadError,
  MapInvalid,
  MapNotFound,
  SheetAmbiguous,
  SheetInvalid,
  type SheetKind,
  SheetNotFound,
} from "./errors.ts";
import { decodeMap, MAP_BYTES, tooBig } from "./mapFiles.ts";
import { decodeHero, decodeMonster, idOf } from "./sheetFiles.ts";

/** Why a load by id can fail. */
export type LoadError = SheetNotFound | SheetAmbiguous | SheetInvalid | ContentReadError;

/** Why a map load can fail. */
export type MapLoadError = MapNotFound | MapInvalid | ContentReadError;

/** A map file as the host read it: its id (the file name) and its grid, for the /map command. */
export interface LoadedMap {
  readonly id: string;
  readonly grid: MapGrid;
}

type Kind = SheetKind | "map";

const FOLDER: Record<Kind, string> = { hero: "heroes", monster: "monsters", map: "maps" };
/** The files a folder's ids come from; the first pattern wins when two files name one id. */
const EXTENSIONS: Record<Kind, ReadonlyArray<RegExp>> = {
  hero: [/\.yaml$/i, /\.yml$/i],
  monster: [/\.yaml$/i, /\.yml$/i],
  map: [/\.txt$/i],
};

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One sheet file: its id and its path in the campaign ("heroes/vex.yaml"). */
interface Entry {
  readonly id: string;
  readonly file: string;
}

/**
 * The sheet or map files in one folder of the campaign, by id. A missing folder has none. `.yaml`
 * wins over `.yml` if both name one id; hidden files and anything else are ignored.
 */
const entries = (dir: string, kind: Kind): Effect.Effect<ReadonlyArray<Entry>, ContentReadError> =>
  Effect.tryPromise({
    try: async () => {
      const folder = FOLDER[kind];
      try {
        return (await readdir(join(dir, folder), { withFileTypes: true }))
          .filter(
            (d) =>
              !d.isDirectory() &&
              !d.name.startsWith(".") &&
              EXTENSIONS[kind].some((x) => x.test(d.name)),
          )
          .map((d) => d.name);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw e;
      }
    },
    catch: (e) => new ContentReadError({ message: `can't list ${FOLDER[kind]}/: ${messageOf(e)}` }),
  }).pipe(
    Effect.map((names) => {
      const byId = new Map<string, Entry>();
      const inOrder = EXTENSIONS[kind].flatMap((x) => names.filter((n) => x.test(n)));
      for (const name of inOrder)
        if (!byId.has(idOf(name)))
          byId.set(idOf(name), { id: idOf(name), file: `${FOLDER[kind]}/${name}` });
      return [...byId.values()].toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }),
  );

/** The exact id, ignoring case, else the only id the query starts; else every id it starts. */
const match = (
  all: ReadonlyArray<Entry>,
  query: string,
): Entry | { readonly several: ReadonlyArray<string> } => {
  const q = query.trim().toLowerCase();
  const exact = all.find((e) => e.id.toLowerCase() === q);
  if (exact !== undefined) return exact;
  const matches = q === "" ? [] : all.filter((e) => e.id.toLowerCase().startsWith(q));
  return matches.length === 1 ? matches[0]! : { several: matches.map((e) => e.id) };
};

/** What a folder has, for a message that a query fit none of it. */
const have = (kind: Kind, all: ReadonlyArray<Entry>) =>
  all.length === 0
    ? `it has no ${kind === "map" ? ".txt" : ".yaml"} files`
    : `there are: ${all.map((e) => e.id).join(", ")}`;

const find = (
  kind: SheetKind,
  all: ReadonlyArray<Entry>,
  query: string,
): Effect.Effect<Entry, SheetNotFound | SheetAmbiguous> => {
  const found = match(all, query);
  if (!("several" in found)) return Effect.succeed(found);
  if (found.several.length > 1)
    return Effect.fail(
      new SheetAmbiguous({
        kind,
        query,
        matches: found.several,
        message: `"${query}" could be any of these ${FOLDER[kind]}: ${found.several.join(", ")}`,
      }),
    );
  return Effect.fail(
    new SheetNotFound({
      kind,
      query,
      message: `no ${kind} "${query}" in ${FOLDER[kind]}/ (${have(kind, all)})`,
    }),
  );
};

/**
 * The map files in a campaign: those whose file name, lower case, is an id (`usable`, by that id),
 * and those that can't be maps for their name (`unnamed`, as file names).
 */
const mapEntries = (dir: string) =>
  Effect.map(entries(dir, "map"), (all) => {
    const usable: Entry[] = [];
    const unnamed: string[] = [];
    for (const e of all)
      if (ID.test(e.id.toLowerCase())) usable.push({ ...e, id: e.id.toLowerCase() });
      else unnamed.push(e.file.slice("maps/".length));
    usable.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { usable, unnamed };
  });

/**
 * The map file `query` names, found the way sheets are, read whole (its size is checked first)
 * and decoded. Its id is the file name, lower case; a file whose name can't be an id is no map,
 * and is named when nothing fits.
 */
const loadMap = (dir: string) =>
  Effect.fn(function* (query: string) {
    const { usable, unnamed } = yield* mapEntries(dir);
    const found = match(usable, query);
    if ("several" in found) {
      const skipped =
        unnamed.length === 0
          ? ""
          : `; not maps, since a map's file name is its id (lower-case letters, digits and hyphens, at most 40): ${unnamed.join(", ")}`;
      return yield* new MapNotFound({
        query,
        message:
          found.several.length > 1
            ? `"${query}" could be any of these maps: ${found.several.join(", ")}`
            : `no map "${query}" in maps/ (${have("map", usable)})${skipped}`,
      });
    }
    const { id, file } = found;
    const path = join(dir, file);
    const readError = (e: unknown) =>
      new ContentReadError({ message: `can't read ${file}: ${messageOf(e)}` });
    // Too big to be a map: say so without reading it.
    const big = tooBig(
      file,
      (yield* Effect.tryPromise({ try: () => stat(path), catch: readError })).size,
    );
    if (big !== undefined) return yield* big;
    const bytes = yield* Effect.tryPromise({ try: () => readFile(path), catch: readError });
    const grid = yield* decodeMap(file, id, bytes);
    return { id, grid } satisfies LoadedMap;
  });

const load = <A>(
  dir: string,
  kind: SheetKind,
  decode: (file: string, text: string) => Effect.Effect<A, SheetInvalid>,
) =>
  Effect.fn(function* (query: string) {
    const entry = yield* find(kind, yield* entries(dir, kind), query);
    const text = yield* Effect.tryPromise({
      try: () => readFile(join(dir, entry.file), "utf8"),
      catch: (e) => new ContentReadError({ message: `can't read ${entry.file}: ${messageOf(e)}` }),
    });
    return yield* decode(entry.file, text);
  });

/**
 * Each file in a folder by its id and the name inside it, for the GM's prep panel: the name is the
 * id's when the file doesn't read or decode, since loading it says why. With `maxBytes`, a bigger
 * file is listed by its id without being read, as loading a map refuses it unread.
 */
const named = (
  dir: string,
  all: ReadonlyArray<Entry>,
  nameIn: (entry: Entry, bytes: Uint8Array) => Effect.Effect<string, unknown>,
  maxBytes?: number,
): Effect.Effect<ReadonlyArray<PrepEntry>> =>
  Effect.forEach(
    all,
    (e) =>
      Effect.tryPromise(async () => {
        const path = join(dir, e.file);
        if (maxBytes !== undefined && (await stat(path)).size > maxBytes)
          throw new Error(`${e.file} is too big`);
        return readFile(path);
      }).pipe(
        Effect.flatMap((bytes) => nameIn(e, bytes)),
        Effect.match({
          onFailure: () => ({ id: e.id, name: e.id }),
          onSuccess: (name) => ({ id: e.id, name }),
        }),
      ),
    { concurrency: 8 },
  );

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/**
 * What the GM's prep panel lists: every hero, monster and map, read now, with their names; not a
 * map whose id `/map` reads as a word (`off`, `new`), since its line would do that instead.
 */
const catalogOf = (dir: string): Effect.Effect<PrepCatalog, ContentReadError> =>
  Effect.gen(function* () {
    const heroes = yield* entries(dir, "hero");
    const monsters = yield* entries(dir, "monster");
    const { usable: maps } = yield* mapEntries(dir);
    return {
      heroes: yield* named(dir, heroes, (e, b) =>
        Effect.map(decodeHero(e.file, text(b)), (h) => h.name),
      ),
      monsters: yield* named(dir, monsters, (e, b) =>
        Effect.map(decodeMonster(e.file, text(b)), (m) => m.name),
      ),
      maps: yield* named(
        dir,
        maps.filter((e) => !MAP_WORDS.includes(e.id)),
        (e, b) => Effect.map(decodeMap(e.file, e.id, b), (g) => g.name),
        MAP_BYTES,
      ),
    };
  });

/**
 * A campaign folder: the ruleset its `campaign.yaml` names, read once when the table opens, and
 * the heroes, monsters and maps in it: `heroes/<id>.yaml`, `monsters/<id>.yaml` and `maps/<id>.txt`.
 * Those are never cached, so a file the GM edits mid-session counts the next time it's loaded.
 */
export class CampaignContent extends Context.Service<
  CampaignContent,
  {
    readonly dir: string;
    /** What the campaign plays: draw-steel unless its `campaign.yaml` says otherwise. */
    readonly ruleset: Ruleset;
    /** Hero ids, sorted. */
    readonly heroes: Effect.Effect<ReadonlyArray<string>, ContentReadError>;
    /** Monster ids, sorted. */
    readonly monsters: Effect.Effect<ReadonlyArray<string>, ContentReadError>;
    /** The hero whose id is `query` (ignoring case), or else the only one whose id starts with it. */
    readonly hero: (query: string) => Effect.Effect<HeroSheet, LoadError>;
    /** The same, for a monster. */
    readonly monster: (query: string) => Effect.Effect<StatBlock, LoadError>;
    /** Map ids (`maps/<id>.txt`), sorted. */
    readonly maps: Effect.Effect<ReadonlyArray<string>, ContentReadError>;
    /** The map whose id is `query`, or else the only one whose id starts with it. */
    readonly map: (query: string) => Effect.Effect<LoadedMap, MapLoadError>;
    /** Every hero, monster and map with the name inside it, for the GM's prep panel. */
    readonly catalog: Effect.Effect<PrepCatalog, ContentReadError>;
  }
>()("supervillain/content/CampaignContent") {
  /** Fails when `campaign.yaml` can't be read or names a ruleset the table doesn't know. */
  static readonly layer = (
    campaignDir: string,
  ): Layer.Layer<CampaignContent, CampaignConfigInvalid | ContentReadError> =>
    Layer.effect(
      CampaignContent,
      Effect.map(readCampaignConfig(campaignDir), (config) =>
        CampaignContent.of({
          dir: campaignDir,
          ruleset: config.rules,
          heroes: Effect.map(entries(campaignDir, "hero"), (all) => all.map((e) => e.id)),
          monsters: Effect.map(entries(campaignDir, "monster"), (all) => all.map((e) => e.id)),
          hero: load(campaignDir, "hero", decodeHero),
          monster: load(campaignDir, "monster", decodeMonster),
          maps: Effect.map(mapEntries(campaignDir), ({ usable }) => usable.map((e) => e.id)),
          map: loadMap(campaignDir),
          catalog: catalogOf(campaignDir),
        }),
      ),
    );
}
