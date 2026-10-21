import { describe, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { CampaignContent } from "../../src/content/index.ts";
import { effect } from "../host/effect.ts";

const example = join(import.meta.dir, "..", "..", "..", "..", "examples", "campaign");

const loadAll = Effect.gen(function* () {
  const content = yield* CampaignContent;
  const heroIds = yield* content.heroes;
  const monsterIds = yield* content.monsters;
  const heroes = yield* Effect.forEach(heroIds, (id) => content.hero(id));
  const monsters = yield* Effect.forEach(monsterIds, (id) => content.monster(id));
  return { heroIds, monsterIds, heroes, monsters };
}).pipe(Effect.provide(CampaignContent.layer(example)));

describe("examples/campaign", () => {
  effect("every hero and monster file decodes", () =>
    Effect.gen(function* () {
      const { heroes, monsters } = yield* loadAll;
      expect(heroes.map((h) => h.class).toSorted()).toEqual([
        "Censor",
        "Fury",
        "Shadow",
        "Tactician",
      ]);
      for (const hero of heroes) {
        expect(hero.level).toBe(1);
        expect(hero.abilities.length).toBeGreaterThan(0);
      }
      const organizations = new Set(monsters.map((m) => m.organization));
      expect(organizations).toContain("minion");
      expect(organizations).toContain("leader");
      expect(monsters.some((m) => m.organization !== "minion" && m.organization !== "leader")).toBe(
        true,
      );
    }),
  );

  effect("every file says it's a sample to check against the books", () =>
    Effect.gen(function* () {
      const { heroIds, monsterIds } = yield* loadAll;
      const files = [
        ...heroIds.map((id) => join(example, "heroes", `${id}.yaml`)),
        ...monsterIds.map((id) => join(example, "monsters", `${id}.yaml`)),
      ];
      expect(files.length).toBeGreaterThanOrEqual(7);
      for (const file of files) {
        const text = yield* Effect.promise(() => readFile(file, "utf8"));
        expect(text).toStartWith("# Sample ");
        expect(text).toMatch(/check against Draw Steel: (Heroes|Monsters) before real play/);
      }
    }),
  );
});
