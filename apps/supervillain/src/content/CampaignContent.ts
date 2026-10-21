import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import type { HeroSheet, StatBlock } from "../game/drawSteel/sheets.ts";
import {
  ContentReadError,
  SheetAmbiguous,
  SheetInvalid,
  type SheetKind,
  SheetNotFound,
} from "./errors.ts";
import { decodeHero, decodeMonster, idOf } from "./sheetFiles.ts";

/** Why a load by id can fail. */
export type LoadError = SheetNotFound | SheetAmbiguous | SheetInvalid | ContentReadError;

const FOLDER: Record<SheetKind, string> = { hero: "heroes", monster: "monsters" };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One sheet file: its id and its path in the campaign ("heroes/vex.yaml"). */
interface Entry {
  readonly id: string;
  readonly file: string;
}

/**
 * The sheet files in one folder of the campaign, by id. A missing folder has none. `.yaml` wins
 * over `.yml` if both name one id; hidden files and anything else are ignored.
 */
const entries = (
  dir: string,
  kind: SheetKind,
): Effect.Effect<ReadonlyArray<Entry>, ContentReadError> =>
  Effect.tryPromise({
    try: async () => {
      const folder = FOLDER[kind];
      try {
        return (await readdir(join(dir, folder), { withFileTypes: true }))
          .filter((d) => !d.isDirectory() && !d.name.startsWith(".") && /\.ya?ml$/i.test(d.name))
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
      const yamlFirst = [
        ...names.filter((n) => /\.yaml$/i.test(n)),
        ...names.filter((n) => /\.yml$/i.test(n)),
      ];
      for (const name of yamlFirst)
        if (!byId.has(idOf(name)))
          byId.set(idOf(name), { id: idOf(name), file: `${FOLDER[kind]}/${name}` });
      return [...byId.values()].toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }),
  );

/** The exact id, ignoring case, or else the only id the query starts. */
const find = (
  kind: SheetKind,
  all: ReadonlyArray<Entry>,
  query: string,
): Effect.Effect<Entry, SheetNotFound | SheetAmbiguous> => {
  const q = query.trim().toLowerCase();
  const exact = all.find((e) => e.id.toLowerCase() === q);
  if (exact !== undefined) return Effect.succeed(exact);
  const matches = q === "" ? [] : all.filter((e) => e.id.toLowerCase().startsWith(q));
  if (matches.length === 1) return Effect.succeed(matches[0]!);
  if (matches.length > 1) {
    const ids = matches.map((e) => e.id);
    return Effect.fail(
      new SheetAmbiguous({
        kind,
        query,
        matches: ids,
        message: `"${query}" could be any of these ${FOLDER[kind]}: ${ids.join(", ")}`,
      }),
    );
  }
  const have =
    all.length === 0 ? "it has no .yaml files" : `there are: ${all.map((e) => e.id).join(", ")}`;
  return Effect.fail(
    new SheetNotFound({
      kind,
      query,
      message: `no ${kind} "${query}" in ${FOLDER[kind]}/ (${have})`,
    }),
  );
};

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
 * The heroes and monsters in a campaign folder: `heroes/<id>.yaml` and `monsters/<id>.yaml`.
 * Nothing is cached, so a file the GM edits mid-session counts the next time it's loaded.
 */
export class CampaignContent extends Context.Service<
  CampaignContent,
  {
    readonly dir: string;
    /** Hero ids, sorted. */
    readonly heroes: Effect.Effect<ReadonlyArray<string>, ContentReadError>;
    /** Monster ids, sorted. */
    readonly monsters: Effect.Effect<ReadonlyArray<string>, ContentReadError>;
    /** The hero whose id is `query` (ignoring case), or else the only one whose id starts with it. */
    readonly hero: (query: string) => Effect.Effect<HeroSheet, LoadError>;
    /** The same, for a monster. */
    readonly monster: (query: string) => Effect.Effect<StatBlock, LoadError>;
  }
>()("supervillain/content/CampaignContent") {
  static readonly layer = (campaignDir: string): Layer.Layer<CampaignContent> =>
    Layer.succeed(CampaignContent, {
      dir: campaignDir,
      heroes: Effect.map(entries(campaignDir, "hero"), (all) => all.map((e) => e.id)),
      monsters: Effect.map(entries(campaignDir, "monster"), (all) => all.map((e) => e.id)),
      hero: load(campaignDir, "hero", decodeHero),
      monster: load(campaignDir, "monster", decodeMonster),
    });
}
