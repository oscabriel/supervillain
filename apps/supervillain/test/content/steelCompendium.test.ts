import { describe, expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import {
  CampaignContent,
  convertMonster,
  importBestiary,
  importReportText,
} from "../../src/content/index.ts";
import type { StatBlock } from "../../src/game/drawSteel/sheets.ts";
import { effect } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";

const bestiary = join(import.meta.dir, "fixtures", "bestiary");
const statblock = (path: string) =>
  readFile(join(bestiary, "Monsters", path), "utf8").then((t) => JSON.parse(t) as unknown);

const gutterRat: StatBlock = {
  id: "gutter-rat",
  name: "Gutter Rat",
  level: 1,
  organization: "minion",
  role: "harrier",
  ev: "3 for four minions",
  stamina: 4,
  speed: 7,
  stability: 0,
  freeStrike: 1,
  characteristics: { might: -2, agility: 2, reason: -4, intuition: 1, presence: -3 },
  weaknesses: [{ type: "fire", value: 3 }],
  withCaptain: "+1 damage bonus to strikes",
  abilities: [
    {
      name: "Bite",
      kind: "Main action",
      bonus: 2,
      keywords: ["Melee", "Strike", "Weapon"],
      distance: "Melee 1",
      target: "One creature or object per minion",
      tier1: "1 damage",
      tier2: "2 damage",
      tier3: "3 damage",
    },
    { name: "Underfoot", kind: "Trait", effect: "The rat can move through an enemy's space." },
  ],
};

describe("convertMonster", () => {
  test("a minion: organization and role split from one string, signed text read as numbers", async () => {
    expect(convertMonster(await statblock("Rats/Statblocks/Gutter Rat.json"))).toEqual({
      ok: true,
      sheet: gutterRat,
      skipped: [],
    });
  });

  test("keeps what it can read and reports each thing it left out", async () => {
    expect(convertMonster(await statblock("Bog/Statblocks/Bog Brute.json"))).toEqual({
      ok: true,
      sheet: {
        id: "bog-brute",
        name: "Bog Brute",
        level: 1,
        organization: "platoon",
        role: "brute",
        ev: "3",
        stamina: 20,
        speed: 5,
        stability: 2,
        freeStrike: 2,
        characteristics: { might: 2, agility: -1, reason: -2, intuition: 0, presence: -1 },
        immunities: [{ type: "acid", value: 2 }],
        abilities: [
          {
            name: "Mud Slam",
            kind: "Main action",
            bonus: 2,
            keywords: ["Melee", "Strike", "Weapon"],
            distance: "Melee 1",
            target: "One creature",
            tier1: "4 damage",
            tier3: "7 damage; push 2",
            effect: "The target is slowed until the end of its next turn.",
          },
          { name: "Sinkhole", kind: "Maneuver", cost: 3, tier1: "Slowed (save ends)" },
        ],
      },
      skipped: [
        `speed: kept 5, left out "(swim)"`,
        `immunities: left out "most things" (expected a damage type and a number, like "fire 5")`,
        `Mud Slam: left out tier2 (not text)`,
        `Sinkhole: left out the roll bonus (no number in "Power Roll + lots")`,
        `features[3]: left out (not a feature with a name)`,
      ],
    });
  });

  test("a field the stat block can't do without fails that monster, naming the field", async () => {
    expect(convertMonster(await statblock("Bog/Statblocks/Mire Witch.json"))).toEqual({
      ok: false,
      name: "Mire Witch",
      problems: [`stamina: no number in "eighty"`],
    });
  });

  test("organization is required too", () => {
    const result = convertMonster({
      name: "Odd One",
      level: 1,
      roles: ["Retainer"],
      stamina: "10",
      speed: 5,
      stability: 0,
      free_strike: 1,
      might: 0,
      agility: 0,
      reason: 0,
      intuition: 0,
      presence: 0,
    });
    expect(result).toEqual({
      ok: false,
      name: "Odd One",
      problems: [
        `roles: no organization in "Retainer" (expected one of minion, horde, platoon, elite, leader, solo)`,
      ],
    });
  });
});

describe("importBestiary", () => {
  effect("writes the named monsters into the campaign as files the loader reads back", () =>
    Effect.gen(function* () {
      const into = yield* tempDir;
      const report = yield* importBestiary({
        from: bestiary,
        into,
        names: ["gutter rat", "bog", "mire witch", "owlbear"],
      });
      expect(report.imported).toEqual([
        {
          name: "Bog Brute",
          id: "bog-brute",
          file: "monsters/bog-brute.yaml",
          status: "written",
          skipped: expect.any(Array),
        },
        {
          name: "Gutter Rat",
          id: "gutter-rat",
          file: "monsters/gutter-rat.yaml",
          status: "written",
          skipped: [],
        },
      ]);
      expect(report.failed).toEqual([
        {
          name: "Mire Witch",
          source: "Monsters/Bog/Statblocks/Mire Witch.json",
          problems: [`stamina: no number in "eighty"`],
        },
      ]);
      expect(report.notFound).toEqual(["owlbear"]);

      const rat = yield* Effect.flatMap(CampaignContent, (c) => c.monster("gutter-rat")).pipe(
        Effect.provide(CampaignContent.layer(into)),
      );
      expect(rat).toEqual(gutterRat);
      const brute = yield* Effect.promise(() =>
        readFile(join(into, "monsters", "bog-brute.yaml"), "utf8"),
      );
      expect(brute).toStartWith(
        "# Imported by supervillain from Monsters/Bog/Statblocks/Bog Brute.json.\n" +
          "# Check it against Draw Steel: Monsters before play.\n" +
          "# Left out:\n" +
          `#   speed: kept 5, left out "(swim)"\n`,
      );
    }),
  );

  effect(
    "a campaign folder the import makes is readable by its owner alone, as `new` makes one",
    () =>
      Effect.gen(function* () {
        const into = join(yield* tempDir, "new-campaign");
        yield* importBestiary({ from: bestiary, into, names: ["gutter"] });
        const mode = (yield* Effect.promise(() => stat(into))).mode & 0o777;
        expect(mode.toString(8)).toBe("700");
      }),
  );

  effect("with no names it imports every monster, and never overwrites a GM's file", () =>
    Effect.gen(function* () {
      const into = yield* tempDir;
      yield* importBestiary({ from: bestiary, into, names: ["gutter"] });
      const edited = join(into, "monsters", "gutter-rat.yaml");
      yield* Effect.promise(() => writeFile(edited, "# the GM's own rat\n"));
      const report = yield* importBestiary({ from: bestiary, into });
      expect(report.imported.map((m) => [m.id, m.status])).toEqual([
        ["bog-brute", "written"],
        ["gutter-rat", "exists"],
      ]);
      expect(report.failed.map((m) => m.name)).toEqual(["Mire Witch"]);
      expect(yield* Effect.promise(() => readFile(edited, "utf8"))).toBe("# the GM's own rat\n");

      const forced = yield* importBestiary({
        from: bestiary,
        into,
        names: ["gutter"],
        overwrite: true,
      });
      expect(forced.imported.map((m) => m.status)).toEqual(["written"]);
      expect(yield* Effect.promise(() => readFile(edited, "utf8"))).toStartWith("# Imported");
    }),
  );

  effect(
    "a name that fits several monsters is reported with the choices, and none is written",
    () =>
      Effect.gen(function* () {
        const from = yield* tempDir;
        const into = yield* tempDir;
        const rat = yield* Effect.promise(() => statblock("Rats/Statblocks/Gutter Rat.json"));
        yield* Effect.promise(async () => {
          for (const name of ["Gutter Rat", "Gutter Rat Queen"])
            await writeFile(
              join(from, `${name}.json`),
              JSON.stringify({ ...(rat as object), name }),
            );
        });
        const report = yield* importBestiary({ from, into, names: ["gutter", "gutter rat"] });
        expect(report.ambiguous).toEqual([
          { query: "gutter", matches: ["Gutter Rat", "Gutter Rat Queen"] },
        ]);
        // An exact name wins over a longer one it's a prefix of.
        expect(report.imported.map((m) => m.id)).toEqual(["gutter-rat"]);
      }),
  );

  effect("a name too long for an id is reported with the id it made, not as a file name", () =>
    Effect.gen(function* () {
      const from = yield* tempDir;
      const into = yield* tempDir;
      const rat = yield* Effect.promise(() => statblock("Rats/Statblocks/Gutter Rat.json"));
      const name = "Gutter Rat of the Long Drowned Northern Sewers";
      yield* Effect.promise(() =>
        writeFile(join(from, "rat.json"), JSON.stringify({ ...(rat as object), name })),
      );
      const report = yield* importBestiary({ from, into });
      expect(report.imported).toEqual([]);
      expect(report.failed).toEqual([
        {
          name,
          source: "rat.json",
          problems: [
            `id "gutter-rat-of-the-long-drowned-northern-sewers" (made from the name) must be at most 40 characters`,
            "name must be one line of up to 40 characters",
          ],
        },
      ]);
    }),
  );

  effect("reads one file as well as a folder, and reports files that aren't JSON", () =>
    Effect.gen(function* () {
      const from = yield* tempDir;
      const into = yield* tempDir;
      const rat = yield* Effect.promise(() =>
        readFile(join(bestiary, "Monsters/Rats/Statblocks/Gutter Rat.json"), "utf8"),
      );
      yield* Effect.promise(async () => {
        await writeFile(join(from, "rat.json"), rat);
        await writeFile(join(from, "broken.json"), "{ not json");
      });
      const report = yield* importBestiary({ from, into });
      expect(report.imported.map((m) => m.id)).toEqual(["gutter-rat"]);
      expect(report.unreadable).toEqual(["broken.json: not valid JSON"]);

      const single = yield* importBestiary({ from: join(from, "rat.json"), into, overwrite: true });
      expect(single.imported.map((m) => m.id)).toEqual(["gutter-rat"]);
      expect(single.unreadable).toEqual([]);
    }),
  );

  effect("a source that isn't there is a typed error", () =>
    Effect.gen(function* () {
      const into = yield* tempDir;
      const error = yield* Effect.flip(importBestiary({ from: join(into, "nowhere"), into }));
      expect(error._tag).toBe("ContentReadError");
      expect(error.message).toContain("nowhere");
    }),
  );

  test("the report reads as lines for the terminal", () => {
    expect(
      importReportText({
        imported: [
          {
            name: "Gutter Rat",
            id: "gutter-rat",
            file: "monsters/gutter-rat.yaml",
            status: "written",
            skipped: [],
          },
          {
            name: "Bog Brute",
            id: "bog-brute",
            file: "monsters/bog-brute.yaml",
            status: "exists",
            skipped: [],
          },
        ],
        failed: [
          { name: "Mire Witch", source: "Mire Witch.json", problems: ["stamina: no number"] },
        ],
        notFound: ["owlbear"],
        ambiguous: [{ query: "go", matches: ["Goblin Warrior", "Goblin Sniper"] }],
        unreadable: ["broken.json: not valid JSON"],
      }),
    ).toEqual([
      "wrote monsters/gutter-rat.yaml (Gutter Rat)",
      "kept monsters/bog-brute.yaml (Bog Brute): it exists; --overwrite replaces it",
      "couldn't import Mire Witch (Mire Witch.json):",
      "  stamina: no number",
      `no monster named "owlbear"`,
      `"go" could be: Goblin Warrior, Goblin Sniper`,
      "broken.json: not valid JSON",
    ]);
  });
});
