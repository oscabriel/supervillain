import { ifDefined, orEmpty } from "@supervillain/domain";
import type { PrepEntry, PrepScene, PrepTracker } from "@supervillain/domain";

import type { ContentIndex } from "./ContentIndex.ts";

export interface StageCatalog {
	readonly scenes: ReadonlyArray<PrepScene>;
	readonly npcs: ReadonlyArray<PrepEntry>;
	readonly handouts: ReadonlyArray<PrepEntry>;
	readonly items: ReadonlyArray<PrepEntry>;
	readonly trackers: ReadonlyArray<PrepTracker>;
}

export const stageCatalog = (index: ContentIndex): StageCatalog => ({
	scenes: index.scenes.map((d): PrepScene => ({
		id: d.id,
		name: d.front.title,
		...ifDefined(d.front.encounter, (encounter) => ({
			encounter: {
				...ifDefined(encounter.map, (map) => ({ map })),
				monsters: encounter.monsters.map((m) => ({
					id: m.id,
					...ifDefined(m.count, (count) => ({ count })),
				})),
			},
		})),
	})),
	npcs: index.npcs.map((d) => ({ id: d.id, name: d.front.name })),
	handouts: index.handouts.map((d) => ({ id: d.id, name: d.front.title })),
	items: index.items.map((d) => ({ id: d.id, name: d.front.name })),
	trackers: index.scenes.flatMap((d) =>
		orEmpty(d.front.trackers).map((t): PrepTracker => ({
			id: t.id,
			label: t.label,
			kind: t.kind,
			...ifDefined(t.max, (max) => ({ max })),
			...ifDefined(t.value, (value) => ({ value })),
			scene: d.id,
		}))
	),
});
