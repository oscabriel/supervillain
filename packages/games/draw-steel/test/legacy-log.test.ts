/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; the runner is the runtime claim. */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Envelope, HostRegistry, ViewEntry } from "@supervillain/core";

import { RoomHost } from "../../../room-host/src/index.js";
import { createTableFold } from "../../../table/src/fold.js";
import { decide } from "../src/authority.js";
import { apply, eventTypes, init } from "../src/model.js";
import type { DsCommand, DsEvent, DsState } from "../src/model.js";
import { view } from "../src/view.js";

/** A permanent old-log fixture: every shape a released host ever wrote folds
 * forever, so each schema change adds a fixture beside its upgrade-on-read
 * branch (ADR-0010). This one carries the `statBlock`-shaped
 * `ds.character-entered` alongside the current `sheet` shape. */
const fixturePath = path.join(
	import.meta.dirname,
	"fixtures",
	"legacy-character-entered.jsonl"
);

const registry: HostRegistry = {
	get: (gameId) =>
		gameId === "draw-steel"
			? {
					authority: { decide },
					grammar: { eventTypes },
					model: { apply, init },
				}
			: undefined,
};

const entry: ViewEntry<DsState, DsCommand, DsEvent> = {
	model: { apply, init },
	view,
};

const readFixture = async (): Promise<{
	readonly text: string;
	readonly envelopes: readonly Envelope[];
}> => {
	const text = await readFile(fixturePath, "utf-8");
	return {
		envelopes: text
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as Envelope),
		text,
	};
};

describe("legacy Draw Steel log", () => {
	test("the writer fold replays it without halting", async () => {
		const { text } = await readFixture();
		const folder = await mkdtemp(
			path.join(tmpdir(), "supervillain-ds-legacy-")
		);
		try {
			await writeFile(path.join(folder, "events.jsonl"), text);
			const host = await RoomHost.open({ campaignFolder: folder, registry });
			const snapshot = host.snapshot();
			const state = snapshot.game as DsState;

			expect(snapshot.gameId).toBe("draw-steel");
			expect(state.characters.map((character) => character.name)).toEqual([
				"Ramona",
				"Sable",
			]);
			// The upgraded stat block keeps its name, characteristics and
			// stamina, and fills the fields the old shape never carried.
			expect(state.characters[0]).toEqual({
				abilities: [],
				ancestry: "",
				characteristics: {
					agility: 1,
					intuition: 1,
					might: 2,
					presence: -1,
					reason: 0,
				},
				className: "",
				heroicResource: "",
				kit: null,
				name: "Ramona",
				recoveries: 0,
				stamina: 20,
				surges: 0,
				victories: 0,
			});
			// The old shape carries no play state; the current one seeds it.
			expect(Object.keys(state.play)).toEqual(["Sable"]);
			expect(state.encounter.active).toBe(true);
		} finally {
			await rm(folder, { force: true, recursive: true });
		}
	});

	test("the render fold replays it with no loud skips", async () => {
		const { envelopes } = await readFixture();
		const fold = createTableFold(entry, "draw-steel", "actor-gm");
		const lines = envelopes.map((envelope) => fold.apply(envelope));

		expect(fold.endReplay()).toBeNull();
		expect(fold.skips()).toEqual([]);
		expect(fold.state().characters.map((character) => character.name)).toEqual([
			"Ramona",
			"Sable",
		]);
		expect(lines[2]?.runs[0]).toEqual({
			attrs: ["bold"],
			text: "Ramona",
			token: "accent",
		});
	});
});
