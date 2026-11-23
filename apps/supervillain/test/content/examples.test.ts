import { describe, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";

import { effect } from "../host/effect.ts";
import { withContent } from "./content.ts";

const example = path.join(
	import.meta.dir,
	"..",
	"..",
	"..",
	"..",
	"examples",
	"campaign"
);

const loadAll = withContent(example, (content) =>
	Effect.gen(function* () {
		const heroIds = yield* content.heroes;
		const monsterIds = yield* content.monsters;

		const heroes = yield* Effect.forEach(heroIds, (id) => content.hero(id), {
			concurrency: 1,
		});

		const monsters = yield* Effect.forEach(
			monsterIds,
			(id) => content.monster(id),
			{ concurrency: 1 }
		);

		return { heroIds, monsterIds, heroes, monsters };
	})
);

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
			expect(
				monsters.some(
					(m) => m.organization !== "minion" && m.organization !== "leader"
				)
			).toBe(true);
		})
	);

	effect("every file says it's a sample to check against the books", () =>
		Effect.gen(function* () {
			const { heroIds, monsterIds } = yield* loadAll;

			const files = [
				...heroIds.map((id) => path.join(example, "heroes", `${id}.yaml`)),
				...monsterIds.map((id) => path.join(example, "monsters", `${id}.yaml`)),
			];

			expect(files.length).toBeGreaterThanOrEqual(7);

			for (const file of files) {
				const text = yield* Effect.promise(
					async () => await readFile(file, "utf-8")
				);

				expect(text).toStartWith("# Sample ");
				expect(text).toMatch(
					/check against Draw Steel: (?:Heroes|Monsters) before real play/u
				);
			}
		})
	);

	effect(
		"the map loads: the ford road, with walls and difficult terrain to fight around",
		() =>
			Effect.gen(function* () {
				const { ids, ford } = yield* withContent(example, (content) =>
					Effect.gen(function* () {
						return {
							ids: yield* content.maps,
							ford: yield* content.map("ford-road"),
						};
					})
				);

				expect(ids).toEqual(["ford-road"]);
				expect(ford.grid.name).toBe("The Ford Road");
				const cells = ford.grid.terrain.join("");

				for (const terrain of [".", "#", "~", " "]) {
					expect(cells).toContain(terrain);
				}
			})
	);
});
