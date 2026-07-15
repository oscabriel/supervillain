/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; the runner is the runtime claim. */
import { describe, expect, test } from "bun:test";

import type { Rejection, TableView } from "@supervillain/core";

import { createDecide, decide } from "../src/authority.js";
import { apply, init } from "../src/model.js";
import type { DsCommand, DsEvent, DsState } from "../src/model.js";

const gmTable: TableView = {
	actor: "gm-key",
	gmSeatId: "gm",
	seats: [
		{ actor: "gm-key", id: "gm" },
		{ actor: "player-key", id: "player-1" },
	],
};
const playerTable: TableView = { ...gmTable, actor: "player-key" };
const outsiderTable: TableView = { ...gmTable, actor: "outsider-key" };
const characterText = (might = 2): string =>
	JSON.stringify({
		characteristics: {
			agility: 1,
			intuition: 1,
			might,
			presence: 2,
			reason: 0,
		},
		name: "Coda",
		stamina: 20,
		unknown: "ignored",
	});
const rejectionMessage = (result: DsEvent[] | Rejection): string =>
	"rejected" in result ? result.message : "accepted";
const fold = (events: readonly DsEvent[], state = init()): DsState => {
	let next = state;
	for (const event of events) {
		next = apply(next, event);
	}
	return next;
};
const rollWithDice = (dice: readonly [number, number]) => {
	let index = 0;
	return createDecide(() => {
		const die = dice[index] ?? dice[1];
		index += 1;
		return (die - 1) / 10;
	});
};
const power = (
	dice: readonly [number, number],
	command: Partial<Extract<DsCommand, { type: "ds.power-roll" }>> = {},
	state = init()
): Extract<DsEvent, { type: "ds.power-rolled" }> => {
	const result = rollWithDice(dice)(
		state,
		{
			banes: 0,
			characteristic: "might",
			edges: 0,
			type: "ds.power-roll",
			...command,
		},
		gmTable
	);
	if ("rejected" in result) {
		throw new Error(result.message);
	}
	return result[0] as Extract<DsEvent, { type: "ds.power-rolled" }>;
};

const activeState = (): DsState =>
	fold([
		{ type: "ds.encounter-started" },
		{ id: "c1", name: "Hero One", side: "heroes", type: "ds.combatant-added" },
		{
			id: "c2",
			name: "Enemy One",
			side: "enemies",
			type: "ds.combatant-added",
		},
		{ id: "c3", name: "Hero Two", side: "heroes", type: "ds.combatant-added" },
	]);

describe("Draw Steel authority", () => {
	test("enforces seating and GM authority", () => {
		expect(
			rejectionMessage(
				decide(init(), { type: "ds.start-encounter" }, outsiderTable)
			)
		).toBe("You do not hold a seat at this table.");
		expect(
			rejectionMessage(
				decide(init(), { type: "ds.start-encounter" }, playerTable)
			)
		).toBe("Only the GM can do that.");
		expect(
			decide(
				init(),
				{ banes: 0, characteristic: "might", edges: 0, type: "ds.power-roll" },
				playerTable
			)
		).toBeArray();
	});

	test("loads derived character data idempotently and emits edits", () => {
		const command = {
			fileName: "coda.json",
			text: characterText(),
			type: "ds.load-character",
		} as const;
		const first = decide(init(), command, gmTable);
		expect(first).toEqual([
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
					stamina: 20,
				},
				type: "ds.character-entered",
			},
		]);
		if ("rejected" in first) {
			throw new Error(first.message);
		}
		const loaded = fold(first);
		expect(decide(loaded, command, gmTable)).toEqual([]);
		const edited = decide(
			loaded,
			{ ...command, text: characterText(3) },
			gmTable
		);
		expect(edited).toMatchObject([
			{
				statBlock: { characteristics: { might: 3 } },
				type: "ds.character-entered",
			},
		]);
		expect(
			rejectionMessage(
				decide(init(), { ...command, text: "not json" }, gmTable)
			)
		).toBe("Character file must contain valid UTF-8 JSON.");
	});

	test("validates encounter lifecycle and roster commands", () => {
		expect(
			rejectionMessage(decide(init(), { type: "ds.end-encounter" }, gmTable))
		).toBe("No encounter is underway.");
		expect(
			rejectionMessage(
				decide(
					init(),
					{ name: "X", side: "heroes", type: "ds.add-combatant" },
					gmTable
				)
			)
		).toBe("Start an encounter first.");
		const started = fold([{ type: "ds.encounter-started" }]);
		expect(
			rejectionMessage(decide(started, { type: "ds.start-encounter" }, gmTable))
		).toBe("An encounter is already underway.");
		expect(
			rejectionMessage(
				decide(
					started,
					{ name: "  ", side: "heroes", type: "ds.add-combatant" },
					gmTable
				)
			)
		).toBe("Combatant name must not be empty.");
		expect(
			rejectionMessage(
				decide(
					started,
					{ name: "x".repeat(61), side: "heroes", type: "ds.add-combatant" },
					gmTable
				)
			)
		).toBe("Combatant name must be at most 60 characters.");
		const added = decide(
			started,
			{ name: " Hero ", side: "heroes", type: "ds.add-combatant" },
			gmTable
		);
		expect(added).toEqual([
			{ id: "c1", name: "Hero", side: "heroes", type: "ds.combatant-added" },
		]);
		if ("rejected" in added) {
			throw new Error(added.message);
		}
		const roster = fold(added, started);
		expect(
			rejectionMessage(
				decide(
					roster,
					{ name: "Hero", side: "enemies", type: "ds.add-combatant" },
					gmTable
				)
			)
		).toBe("'Hero' is already in the encounter.");
		expect(decide(roster, { type: "ds.end-encounter" }, gmTable)).toEqual([
			{ rounds: 1, type: "ds.encounter-ended" },
		]);
	});

	test("enforces alternating sides and rolls the round over", () => {
		let state = activeState();
		expect(
			rejectionMessage(
				decide(state, { combatantId: "missing", type: "ds.take-turn" }, gmTable)
			)
		).toBe("No combatant 'missing' is in the encounter.");
		const first = decide(
			state,
			{ combatantId: "c1", type: "ds.take-turn" },
			gmTable
		);
		expect(first).toEqual([
			{ combatantId: "c1", round: 1, type: "ds.turn-taken" },
		]);
		if ("rejected" in first) {
			throw new Error(first.message);
		}
		state = fold(first, state);
		expect(
			rejectionMessage(
				decide(state, { combatantId: "c1", type: "ds.take-turn" }, gmTable)
			)
		).toBe("Hero One has already acted this round.");
		expect(
			rejectionMessage(
				decide(state, { combatantId: "c3", type: "ds.take-turn" }, gmTable)
			)
		).toBe("The enemies act next.");
		const enemy = decide(
			state,
			{ combatantId: "c2", type: "ds.take-turn" },
			gmTable
		);
		if ("rejected" in enemy) {
			throw new Error(enemy.message);
		}
		state = fold(enemy, state);
		const rollover = decide(
			state,
			{ combatantId: "c3", type: "ds.take-turn" },
			gmTable
		);
		expect(rollover).toEqual([
			{ combatantId: "c3", round: 1, type: "ds.turn-taken" },
			{ round: 2, type: "ds.round-started" },
		]);
	});

	test("allows a side again after the other side is exhausted", () => {
		let state = activeState();
		for (const id of ["c1", "c2"] as const) {
			const events = decide(
				state,
				{ combatantId: id, type: "ds.take-turn" },
				gmTable
			);
			if ("rejected" in events) {
				throw new Error(events.message);
			}
			state = fold(events, state);
		}
		expect(
			decide(state, { combatantId: "c3", type: "ds.take-turn" }, gmTable)
		).toBeArray();
	});

	test("covers tier boundaries and every net edge/bane result", () => {
		expect([
			power([5, 6]).tier,
			power([6, 6]).tier,
			power([8, 8]).tier,
			power([8, 9]).tier,
		]).toEqual([1, 2, 2, 3]);
		expect(power([6, 6], { banes: 2 }).tier).toBe(1);
		expect(power([7, 7], { banes: 1 }).tier).toBe(2);
		expect(power([6, 6], { banes: 1 }).total).toBe(10);
		expect(power([6, 6], { edges: 0 }).tier).toBe(2);
		expect(power([5, 5], { edges: 1 }).total).toBe(12);
		expect(power([6, 6], { edges: 2 }).tier).toBe(3);
		expect(power([5, 6], { banes: 2 }).tier).toBe(1);
		expect(power([8, 9], { edges: 2 }).tier).toBe(3);
	});

	test("forces natural 19 and 20 to tier 3 and uses loaded modifiers", () => {
		expect(power([9, 10], { banes: 2 }).critical).toBe(true);
		expect(power([9, 10], { banes: 2 }).tier).toBe(3);
		expect(power([10, 10], { banes: 2 }).tier).toBe(3);
		const loaded = fold([
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
		]);
		const rolled = power([5, 5], { characterName: "Coda" }, loaded);
		expect(rolled.modifier).toBe(2);
		expect(rolled.total).toBe(12);
	});

	test("rejects invalid power-roll inputs", () => {
		const invalidCharacteristic = {
			banes: 0,
			characteristic: "speed",
			edges: 0,
			type: "ds.power-roll",
		} as unknown as DsCommand;
		expect(
			rejectionMessage(decide(init(), invalidCharacteristic, gmTable))
		).toBe("Unknown characteristic 'speed'.");
		expect(
			rejectionMessage(
				decide(
					init(),
					{
						banes: 0,
						characteristic: "might",
						edges: 3,
						type: "ds.power-roll",
					},
					gmTable
				)
			)
		).toBe("Edges and banes are 0, 1, or 2.");
		expect(
			rejectionMessage(
				decide(
					init(),
					{
						banes: 0,
						characterName: "Missing",
						characteristic: "might",
						edges: 0,
						type: "ds.power-roll",
					},
					gmTable
				)
			)
		).toBe("No character named 'Missing' has entered play.");
	});
});
