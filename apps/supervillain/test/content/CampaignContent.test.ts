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
