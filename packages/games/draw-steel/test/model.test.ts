/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; the runner is the runtime claim. */
import { describe, expect, test } from "bun:test";

import { apply, init } from "../src/model.js";
import type { DsEvent, DsState } from "../src/model.js";

const events: readonly DsEvent[] = [
	{
		statBlock: {
			characteristics: {
				agility: 1,
				intuition: 1,
				might: 2,
				presence: 2,
				reason: 0,
			},
			name: "Coda",
		},
		type: "ds.character-entered",
	},
	{ type: "ds.encounter-started" },
	{ id: "c1", name: "Coda", side: "heroes", type: "ds.combatant-added" },
	{ combatantId: "c1", round: 1, type: "ds.turn-taken" },
	{ round: 2, type: "ds.round-started" },
	{
		banes: 0,
		characterName: "Coda",
		characteristic: "might",
		critical: false,
		dice: [5, 5],
		edges: 1,
		modifier: 2,
		tier: 2,
		total: 14,
		type: "ds.power-rolled",
	},
];
const replay = (): DsState => {
	let state = init();
	for (const event of events) {
		state = apply(state, event);
	}
	return state;
};

describe("Draw Steel model", () => {
	test("replays byte-identically and survives a JSON round-trip", () => {
		expect(JSON.stringify(replay())).toBe(JSON.stringify(replay()));
		const state = replay();
		// oxlint-disable-next-line unicorn/prefer-structured-clone -- JSON portability is the invariant under test.
		expect(JSON.parse(JSON.stringify(state))).toEqual(state);
	});

	test("upserts characters and resets ended encounters", () => {
		let state = replay();
		state = apply(state, {
			statBlock: {
				characteristics: {
					agility: 1,
					intuition: 1,
					might: 3,
					presence: 2,
					reason: 0,
				},
				name: "Coda",
			},
			type: "ds.character-entered",
		});
		expect(state.characters).toHaveLength(1);
		expect(state.characters[0]?.characteristics.might).toBe(3);
		state = apply(state, { rounds: 2, type: "ds.encounter-ended" });
		expect(state.encounter).toEqual({
			active: false,
			combatants: [],
			lastSide: null,
			round: 0,
		});
	});
});
