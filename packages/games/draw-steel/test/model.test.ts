/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; the runner is the runtime claim. */
import { describe, expect, test } from "bun:test";

import { apply, init } from "../src/model.js";
import type { DsCharacterSheet, DsEvent, DsState } from "../src/model.js";

const sheet = (might = 2): DsCharacterSheet => ({
	abilities: [],
	ancestry: "Human",
	characteristics: {
		agility: 1,
		intuition: 1,
		might,
		presence: 2,
		reason: 0,
	},
	className: "Troubadour",
	heroicResource: "Drama",
	kit: null,
	name: "Coda",
	recoveries: 8,
	stamina: 20,
	surges: 0,
	victories: 0,
});

const events: readonly DsEvent[] = [
	{ sheet: sheet(), type: "ds.character-entered" },
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

	test("upserts characters, preserves play, clamps recoveries, and resets encounters", () => {
		let state = replay();
		state = apply(state, {
			characterName: "Coda",
			remaining: 7,
			type: "ds.recovery-spent",
		});
		state = apply(state, {
			sheet: { ...sheet(3), recoveries: 6 },
			type: "ds.character-entered",
		});
		expect(state.characters).toHaveLength(1);
		expect(state.characters[0]?.characteristics.might).toBe(3);
		expect(state.play.Coda).toEqual({
			heroicResource: 0,
			recoveries: 6,
			surges: 0,
			victories: 0,
		});
		state = apply(state, { rounds: 2, type: "ds.encounter-ended" });
		expect(state.encounter).toEqual({
			active: false,
			combatants: [],
			lastSide: null,
			round: 0,
		});
	});

	test("folds v0 character payloads into deterministic v1 sheets", () => {
		const legacyEnvelopes = [
			{
				actor: "gm-key",
				payload: {
					statBlock: {
						characteristics: {
							agility: 1,
							intuition: 1,
							might: 2,
							presence: 2,
							reason: 0,
						},
						name: "Coda",
						stamina: 20,
					},
				},
				seq: 3,
				type: "ds.character-entered",
			},
			{
				actor: "gm-key",
				payload: {
					statBlock: {
						characteristics: {
							agility: 0,
							intuition: 2,
							might: 1,
							presence: 1,
							reason: 2,
						},
						name: "Echo",
					},
				},
				seq: 4,
				type: "ds.character-entered",
			},
		] as const;
		let state = init();
		for (const envelope of legacyEnvelopes) {
			state = apply(state, {
				...envelope.payload,
				type: envelope.type,
			} as unknown as DsEvent);
		}
		expect(state.play).toEqual({
			Coda: { heroicResource: 0, recoveries: 0, surges: 0, victories: 0 },
			Echo: { heroicResource: 0, recoveries: 0, surges: 0, victories: 0 },
		});
		expect(state.characters).toEqual([
			{
				abilities: [],
				ancestry: "",
				characteristics: legacyEnvelopes[0].payload.statBlock.characteristics,
				className: "",
				heroicResource: "",
				kit: null,
				name: "Coda",
				recoveries: 0,
				stamina: 20,
				surges: 0,
				victories: 0,
			},
			{
				abilities: [],
				ancestry: "",
				characteristics: legacyEnvelopes[1].payload.statBlock.characteristics,
				className: "",
				heroicResource: "",
				kit: null,
				name: "Echo",
				recoveries: 0,
				stamina: 0,
				surges: 0,
				victories: 0,
			},
		]);
	});

	test("folds conditions and sets play values from event payloads", () => {
		let state = replay();
		state = apply(state, {
			combatantId: "c1",
			condition: "bleeding",
			type: "ds.condition-applied",
		});
		state = apply(state, {
			combatantId: "c1",
			condition: "prone",
			type: "ds.condition-applied",
		});
		expect(state.encounter.combatants[0]?.conditions).toEqual([
			"bleeding",
			"prone",
		]);
		state = apply(state, {
			combatantId: "c1",
			condition: "bleeding",
			type: "ds.condition-removed",
		});
		state = apply(state, {
			characterName: "Coda",
			delta: 99,
			total: 4,
			type: "ds.resource-changed",
		});
		state = apply(state, {
			characterName: "Coda",
			delta: -10,
			total: 3,
			type: "ds.surges-changed",
		});
		state = apply(state, {
			characterName: "Coda",
			total: 2,
			type: "ds.victory-gained",
		});
		expect(state.encounter.combatants[0]?.conditions).toEqual(["prone"]);
		expect(state.play.Coda).toEqual({
			heroicResource: 4,
			recoveries: 8,
			surges: 3,
			victories: 2,
		});
	});
});
