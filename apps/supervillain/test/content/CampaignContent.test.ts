import { describe, expect } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { CampaignContent } from "../../src/content/index.ts";
import { effect } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";

const hero = (name: string, stamina = 18) => `name: ${name}
class: Fury
level: 1
characteristics: { might: 2, agility: 2, reason: -1, intuition: 0, presence: -1 }
stamina: ${stamina}
recoveries: 10
speed: 5
resource: { name: ferocity, perTurn: 1d3 }
`;

const monster = (name: string) => `name: ${name}
level: 1
organization: platoon
stamina: 20
speed: 5
freeStrike: 2
characteristics: { might: 2, agility: 0, reason: -1, intuition: 0, presence: -1 }
`;

/** A campaign folder with these files in it, relative to the folder. */
const campaign = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    yield* Effect.promise(async () => {
      for (const [path, text] of Object.entries(files)) {
        await mkdir(join(dir, path, ".."), { recursive: true });
        await writeFile(join(dir, path), text);
      }
    });
    return dir;
  });

const withContent = <A, E>(
  dir: string,
  body: (content: CampaignContent["Service"]) => Effect.Effect<A, E>,
) => Effect.flatMap(CampaignContent, body).pipe(Effect.provide(CampaignContent.layer(dir)));

describe("CampaignContent", () => {
  effect("lists heroes and monsters by id, ignoring other files", () =>
    Effect.gen(function* () {
      const dir = yield* campaign({
        "heroes/vex.yaml": hero("Vex"),
        "heroes/aric.yml": hero("Aric"),
        "heroes/notes.txt": "not a hero",
        "heroes/.hidden.yaml": hero("Hidden"),
        "monsters/bog-brute.yaml": monster("Bog Brute"),
      });
      const [heroes, monsters] = yield* withContent(dir, (c) => Effect.all([c.heroes, c.monsters]));
      expect(heroes).toEqual(["aric", "vex"]);
      expect(monsters).toEqual(["bog-brute"]);
    }),
  );

  effect("an empty campaign has no heroes or monsters", () =>
    Effect.gen(function* () {
      const dir = yield* campaign({});
      expect(yield* withContent(dir, (c) => Effect.all([c.heroes, c.monsters]))).toEqual([[], []]);
    }),
  );

  effect("loads by exact id first, then by a unique prefix, ignoring case", () =>
    Effect.gen(function* () {
      const dir = yield* campaign({
        "heroes/ash.yaml": hero("Ash"),
        "heroes/ashen.yaml": hero("Ashen"),
        "heroes/vex.yaml": hero("Vex"),
        "monsters/bog-brute.yaml": monster("Bog Brute"),
      });
      const names = yield* withContent(dir, (c) =>
        Effect.all([c.hero("ash"), c.hero("ashe"), c.hero("V"), c.hero("VEX"), c.monster("bog")]),
      );
      expect(names.map((s) => [s.id, s.name])).toEqual([
        ["ash", "Ash"],
        ["ashen", "Ashen"],
        ["vex", "Vex"],
        ["vex", "Vex"],
        ["bog-brute", "Bog Brute"],
      ]);
    }),
  );

  effect("a prefix that fits several, or none, is a typed error that lists the choices", () =>
    Effect.gen(function* () {
      const dir = yield* campaign({
        "heroes/ash.yaml": hero("Ash"),
        "heroes/ashen.yaml": hero("Ashen"),
        "heroes/aric.yaml": hero("Aric"),
      });
      const [ambiguous, missing, noMonsters] = yield* withContent(dir, (c) =>
        Effect.all([
          Effect.flip(c.hero("a")),
          Effect.flip(c.hero("zed")),
          Effect.flip(c.monster("rat")),
        ]),
      );
      expect(ambiguous._tag).toBe("SheetAmbiguous");
      expect(ambiguous.message).toBe(`"a" could be any of these heroes: aric, ash, ashen`);
      expect(missing._tag).toBe("SheetNotFound");
      expect(missing.message).toBe(`no hero "zed" in heroes/ (there are: aric, ash, ashen)`);
      expect(noMonsters.message).toBe(`no monster "rat" in monsters/ (it has no .yaml files)`);
    }),
  );

  effect("a bad file is a typed error naming the file and the field", () =>
    Effect.gen(function* () {
      const dir = yield* campaign({ "heroes/vex.yaml": hero("Vex").replace("stamina: 18\n", "") });
      const error = yield* withContent(dir, (c) => Effect.flip(c.hero("vex")));
      expect(error._tag).toBe("SheetInvalid");
      expect(error.message).toBe("heroes/vex.yaml: stamina is required");
    }),
  );

  effect("reads the file again on every load, so a GM's edit counts at once", () =>
    Effect.gen(function* () {
      const dir = yield* campaign({ "heroes/vex.yaml": hero("Vex", 18) });
      const [before, after, listed] = yield* withContent(dir, (c) =>
        Effect.gen(function* () {
          const before = yield* c.hero("vex");
          yield* Effect.promise(async () => {
            await writeFile(join(dir, "heroes/vex.yaml"), hero("Vex", 24));
            await writeFile(join(dir, "heroes/nyx.yaml"), hero("Nyx"));
          });
          return [before, yield* c.hero("vex"), yield* c.heroes] as const;
        }),
      );
      expect(before.stamina).toBe(18);
      expect(after.stamina).toBe(24);
      expect(listed).toEqual(["nyx", "vex"]);
    }),
  );
});

describe("CampaignContent maps", () => {
  const ford = "name: The Ford\n..~..\n.#~..\n..~..\n";

  effect("lists maps/<id>.txt by id and loads one by exact id or a unique prefix", () =>
    Effect.gen(function* () {
      const dir = yield* campaign({
        "maps/ford.txt": ford,
        "maps/forest-edge.txt": "...\n...\n",
        "maps/notes.md": "not a map",
        "maps/.hidden.txt": "...",
      });
      const [ids, exact, prefix] = yield* withContent(dir, (c) =>
        Effect.all([c.maps, c.map("FORD"), c.map("forest")]),
      );
      expect(ids).toEqual(["ford", "forest-edge"]);
      expect(exact).toEqual({
        id: "ford",
        grid: { name: "The Ford", terrain: ["..~..", ".#~..", "..~.."] },
      });
      // No name line: the id is the name.
      expect(prefix).toEqual({
        id: "forest-edge",
        grid: { name: "forest-edge", terrain: ["...", "..."] },
      });
    }),
  );

  effect("a map it can't find, or can't tell apart, names the choices", () =>
    Effect.gen(function* () {
      const dir = yield* campaign({ "maps/ford.txt": ford, "maps/forest.txt": "..\n" });
      const empty = yield* campaign({});
      const [missing, ambiguous, none] = yield* Effect.all([
        withContent(dir, (c) => Effect.flip(c.map("cave"))),
        withContent(dir, (c) => Effect.flip(c.map("fo"))),
        withContent(empty, (c) => Effect.flip(c.map("ford"))),
      ]);
      expect([missing._tag, missing.message]).toEqual([
        "MapNotFound",
        `no map "cave" in maps/ (there are: ford, forest)`,
      ]);
      expect(ambiguous.message).toBe(`"fo" could be any of these maps: ford, forest`);
      expect(none.message).toBe(`no map "ford" in maps/ (it has no .txt files)`);
    }),
  );

  effect("a map in MEKMODE letters loads with its letters; a stray character names its line", () =>
    Effect.gen(function* () {
      const dir = yield* campaign({
        "maps/ruin.txt": "name: Ruin\nstyle: mekmode\nqsk\nuzT\n",
        "maps/stray.txt": "style: mekmode\nqsk\nu.T\n",
      });
      const [ruin, stray] = yield* withContent(dir, (c) =>
        Effect.all([c.map("ruin"), Effect.flip(c.map("stray"))]),
      );
      expect(ruin).toEqual({
        id: "ruin",
        grid: { name: "Ruin", terrain: [".##", ".~#"], dressing: ["qsk", "uzT"] },
      });
      expect(stray.message).toBe(
        'maps/stray.txt line 3, column 2 is "." (U+002E); a mekmode map is drawn in Ding Mode letters (see "Maps in MEKMODE letters" in the campaign README).',
      );
    }),
  );

  effect("a file too big, not text, or with a character a cell can't draw names where", () =>
    Effect.gen(function* () {
      const dir = yield* campaign({
        "maps/huge.txt": `${".".repeat(60)}\n`.repeat(200),
        "maps/tabs.txt": "name: Tabs\n.....\n..\t..\n",
        "maps/accents.txt": "....\n...é\n",
        "maps/wide.txt": `${".".repeat(61)}\n`,
        "maps/bell.txt": "..\x07.\n",
      });
      yield* Effect.promise(() =>
        writeFile(join(dir, "maps/binary.txt"), new Uint8Array([0x2e, 0xff, 0xfe, 0x0a])),
      );
      const problems = yield* withContent(dir, (c) =>
        Effect.forEach(["huge", "tabs", "accents", "wide", "bell", "binary"], (id) =>
          Effect.flip(c.map(id)).pipe(Effect.map((e) => [e._tag, e.message])),
        ),
      );
      expect(problems).toEqual([
        [
          "MapInvalid",
          "maps/huge.txt is 12 KB; a map file is at most 8 KB (60 columns by 40 rows).",
        ],
        [
          "MapInvalid",
          "maps/tabs.txt line 3, column 3 is a tab; draw maps with . floor, # wall, ~ difficult terrain and space for outside.",
        ],
        [
          "MapInvalid",
          'maps/accents.txt line 2, column 4 is "é" (U+00E9); draw maps with . floor, # wall, ~ difficult terrain and space for outside.',
        ],
        ["MapInvalid", "maps/wide.txt is 61 columns wide; keep maps to 60 columns and 40 rows."],
        [
          "MapInvalid",
          "maps/bell.txt line 1, column 3 is a control character (U+0007); draw maps with . floor, # wall, ~ difficult terrain and space for outside.",
        ],
        ["MapInvalid", "maps/binary.txt isn't UTF-8 text."],
      ]);
    }),
  );

  effect(
    "only files whose name can be a map id are maps; the rest are named when nothing fits",
    () =>
      Effect.gen(function* () {
        const long = "a".repeat(45);
        const dir = yield* campaign({
          "maps/ford.txt": ford,
          "maps/Cave-Big.TXT": "...\n...\n",
          "maps/Bad Name.txt": "...\n",
          [`maps/${long}.txt`]: "...\n",
        });
        const [ids, cave, missing] = yield* withContent(dir, (c) =>
          Effect.all([c.maps, c.map("cave"), Effect.flip(c.map("bad"))]),
        );
        expect(ids).toEqual(["cave-big", "ford"]);
        expect(cave.id).toBe("cave-big");
        expect(missing.message).toBe(
          `no map "bad" in maps/ (there are: cave-big, ford); not maps, since a map's file name is its id (lower-case letters, digits and hyphens, at most 40): Bad Name.txt, ${long}.txt`,
        );
      }),
  );

  effect("a letter in the terrain would read as a token, and errors name the file as it is", () =>
    Effect.gen(function* () {
      const dir = yield* campaign({
        "maps/letters.txt": "name: Letters\n..B.x..\n",
        "maps/Cave-Big.TXT": `${".".repeat(61)}\n`,
      });
      const problems = yield* withContent(dir, (c) =>
        Effect.forEach(["letters", "cave"], (id) =>
          Effect.flip(c.map(id)).pipe(Effect.map((e) => e.message)),
        ),
      );
      expect(problems).toEqual([
        'maps/letters.txt line 2, column 3 is "B" (U+0042); draw maps with . floor, # wall, ~ difficult terrain and space for outside.',
        "maps/Cave-Big.TXT is 61 columns wide; keep maps to 60 columns and 40 rows.",
      ]);
    }),
  );

  effect("reads the file again on every load, so a GM's edit counts at once", () =>
    Effect.gen(function* () {
      const dir = yield* campaign({ "maps/ford.txt": ford });
      const [before, after] = yield* withContent(dir, (c) =>
        Effect.gen(function* () {
          const before = yield* c.map("ford");
          yield* Effect.promise(() =>
            writeFile(join(dir, "maps/ford.txt"), "name: Dry Ford\n..\n"),
          );
          return [before, yield* c.map("ford")] as const;
        }),
      );
      expect(before.grid.name).toBe("The Ford");
      expect(after.grid).toEqual({ name: "Dry Ford", terrain: [".."] });
    }),
  );
});
