import { describe, expect } from "bun:test";

import { MapForge } from "@supervillain/domain";
import { Effect, Layer } from "effect";

import { generateMap } from "../../src/content/mapgen.ts";
import { mapForgeMemory, MemoryMaps } from "../../src/host/memoryPorts.ts";
import { effect } from "./effect.ts";

describe("a sandbox's maps", () => {
	effect("a full sandbox refuses a new map before it generates one", () =>
		Effect.gen(function* () {
			let made = 0;

			const forge = mapForgeMemory((kind, seed) => {
				made += 1;

				return generateMap(kind, seed);
			}).pipe(Layer.provide(MemoryMaps.layer(1)));

			const context = yield* Layer.build(forge);
			const maps = yield* Effect.provideContext(MapForge, context);

			expect(yield* maps.generate({ kind: "keep", seed: 1 })).toEqual({
				id: "keep-1",
			});
			expect(made).toBe(1);

			const full = yield* Effect.flip(maps.generate({ kind: "keep", seed: 2 }));

			expect(full.message).toBe("this sandbox holds at most 1 new maps");
			expect(made).toBe(1);

			const again = yield* Effect.flip(
				maps.generate({ kind: "keep", seed: 1 })
			);

			expect(again.message).toBe("there's already a map called keep-1");
			expect(made).toBe(1);
		})
	);
});
