/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; the runner is the runtime claim. */
import { describe, expect, test } from "bun:test";

import type { FeedLine, GamePanelInput, TableView } from "@supervillain/core";

import { independenceNotice } from "../src/content.js";
import { apply, init } from "../src/model.js";
import type { DsCommand, DsEvent, DsState } from "../src/model.js";
import { view } from "../src/view.js";

const text = (line: FeedLine | null): string =>
	line?.runs.map((run) => run.text).join("") ?? "";
const table: TableView = {
	actor: "gm-key",
	gmSeatId: "gm",
	seats: [{ actor: "gm-key", characterId: null, id: "gm" }],
};
const stateWithRoster = (): DsState => {
	let state = init();
	for (const event of [
		{
			sheet: {
				abilities: [],
				ancestry: "Human",
				characteristics: {
					agility: 1,
					intuition: 1,
					might: 2,
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
			},
			type: "ds.character-entered",
		},
		{ type: "ds.encounter-started" },
		{ id: "c1", name: "Coda", side: "heroes", type: "ds.combatant-added" },
		{ id: "c2", name: "Goblin", side: "enemies", type: "ds.combatant-added" },
	] satisfies DsEvent[]) {
		state = apply(state, event);
	}
	return state;
};

const stateWithCharacters = (names: readonly string[]): DsState => {
	const [base] = stateWithRoster().characters;
	if (base === undefined) {
		throw new Error("character missing");
	}
	let state = init();
	for (const name of names) {
		state = apply(state, {
			sheet: { ...base, name },
			type: "ds.character-entered",
		});
	}
	return state;
};

const threeCharacterTable: TableView = {
	actor: "b-key",
	gmSeatId: "a",
	seats: [
		{ actor: "a-key", characterId: "A", id: "a" },
		{ actor: "b-key", characterId: "B", id: "b" },
		{ actor: "c-key", characterId: "C", id: "c" },
	],
};

describe("Draw Steel view", () => {
	test("renders the independence notice and initiative rows", () => {
		expect(view.notices).toEqual([
			{ runs: [{ text: independenceNotice, token: "muted" }] },
		]);
		const [panel] = view.createPanels();
		if (panel === undefined) {
			throw new Error("initiative panel missing");
		}
		const inactive = panel.render({
			dispatch: () => {},
			focused: false,
			state: init(),
			table,
		});
		expect(inactive.map(text)).toEqual(["Initiative", "no encounter"]);
		const active = panel.render({
			dispatch: () => {},
			focused: true,
			state: stateWithRoster(),
			table,
		});
		expect(active.map(text)).toContain("round 1 — either side act next");
		expect(active.map(text)).toContain("▸ · Coda [H]");
		expect(active.map(text)).toContain("  · Goblin [E]");
		let conditioned = apply(stateWithRoster(), {
			combatantId: "c1",
			condition: "bleeding",
			type: "ds.condition-applied",
		});
		conditioned = apply(conditioned, {
			combatantId: "c1",
			condition: "prone",
			type: "ds.condition-applied",
		});
		const conditionRows = panel.render({
			dispatch: () => {},
			focused: false,
			state: conditioned,
			table,
		});
		expect(conditionRows.map(text)).toContain("▸ · Coda [H] · bleeding, prone");
		expect(
			conditionRows.find((row) => text(row).includes("bleeding"))?.runs.at(-1)
				?.token
		).toBe("muted");
		expect(active.map(text)).toContain("M+2 A+1 R+0 I+1 P+2 · stamina 20");
		expect(active.map(text)).toContain("↑/↓ select · s/e · t · a/m · r");
		expect(inactive.map(text)).not.toContain("↑/↓ select · s/e · t · a/m · r");
	});

	test("renders every event type from payloads, with turn names from state", () => {
		const state = stateWithRoster();
		const [sheet] = state.characters;
		if (sheet === undefined) {
			throw new Error("character missing");
		}
		const cases: readonly [DsEvent, string][] = [
			[
				{ sheet, type: "ds.character-entered" },
				"Coda enters play (M+2 A+1 R+0 I+1 P+2)",
			],
			[{ type: "ds.encounter-started" }, "encounter started — round 1"],
			[
				{ id: "c3", name: "Orc", side: "enemies", type: "ds.combatant-added" },
				"Orc joins the enemies.",
			],
			[
				{ combatantId: "c1", round: 1, type: "ds.turn-taken" },
				"Coda takes their turn",
			],
			[{ round: 2, type: "ds.round-started" }, "round 2 begins"],
			[
				{ rounds: 2, type: "ds.encounter-ended" },
				"encounter ends after 2 rounds",
			],
		];
		for (const [event, expected] of cases) {
			expect(text(view.renderEvent(event, state))).toBe(expected);
		}
		const playCases: readonly [DsEvent, string][] = [
			[
				{
					combatantId: "c1",
					condition: "bleeding",
					type: "ds.condition-applied",
				},
				"Coda is bleeding",
			],
			[
				{
					combatantId: "c1",
					condition: "bleeding",
					type: "ds.condition-removed",
				},
				"Coda is no longer bleeding",
			],
			[
				{
					characterName: "Coda",
					delta: 2,
					total: 5,
					type: "ds.resource-changed",
				},
				"Coda +2 drama → 5",
			],
			[
				{
					characterName: "Coda",
					delta: -2,
					total: 3,
					type: "ds.resource-changed",
				},
				"Coda −2 drama → 3",
			],
			[
				{
					characterName: "Coda",
					remaining: 1,
					type: "ds.recovery-spent",
				},
				"Coda spends a recovery (1 left)",
			],
			[
				{
					characterName: "Coda",
					delta: 1,
					total: 2,
					type: "ds.surges-changed",
				},
				"Coda +1 surges → 2",
			],
			[
				{
					characterName: "Coda",
					delta: -2,
					total: 0,
					type: "ds.surges-changed",
				},
				"Coda −2 surges → 0",
			],
			[
				{ characterName: "Coda", total: 2, type: "ds.victory-gained" },
				"Coda earns a victory (2)",
			],
		];
		for (const [event, expected] of playCases) {
			const rendered = view.renderEvent(event, state);
			expect(text(rendered)).toBe(expected);
			expect(rendered?.runs[0]?.token).toBe("accent");
			expect(rendered?.runs[1]?.token).toBe("primary");
		}
		const rollCases: readonly [Partial<DsEvent>, string][] = [
			[{}, "Sir Vile — power roll (might): 8 + 2 + 2 = 12 → tier 2"],
			[
				{ edges: 1, total: 14 },
				"Sir Vile — power roll (might): 8 + 2 + 2 + 2 (edge) = 14 → tier 2",
			],
			[
				{ banes: 1, tier: 1, total: 10 },
				"Sir Vile — power roll (might): 8 + 2 + 2 − 2 (bane) = 10 → tier 1",
			],
			[
				{ edges: 2, tier: 3 },
				"Sir Vile — power roll (might): 8 + 2 + 2 = 12 → tier 3 (double edge: tier up)",
			],
			[
				{ banes: 2, tier: 1 },
				"Sir Vile — power roll (might): 8 + 2 + 2 = 12 → tier 1 (double bane: tier down)",
			],
			[
				{ critical: true },
				"Sir Vile — power roll (might): 8 + 2 + 2 = 12 → tier 2 · crit!",
			],
		];
		for (const [overrides, expected] of rollCases) {
			const roll: DsEvent = {
				banes: 0,
				characterName: "Sir Vile",
				characteristic: "might",
				critical: false,
				dice: [8, 2],
				edges: 0,
				modifier: 2,
				tier: 2,
				total: 12,
				type: "ds.power-rolled",
				...overrides,
			};
			expect(text(view.renderEvent(roll, state))).toBe(expected);
		}
		const rendered = view.renderEvent(
			{
				banes: 0,
				characterName: "Sir Vile",
				characteristic: "might",
				critical: false,
				dice: [8, 2],
				edges: 0,
				modifier: 2,
				tier: 2,
				total: 12,
				type: "ds.power-rolled",
			},
			state
		);
		expect(rendered?.runs.find((run) => run.text === "12")?.token).toBe(
			"accent"
		);
		expect(rendered?.runs.find((run) => run.text === "tier 2")?.token).toBe(
			"primary"
		);
	});

	test("renders legacy character events", () => {
		const event = {
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
		} as unknown as DsEvent;

		expect(text(view.renderEvent(event, init()))).toBe(
			"Coda enters play (M+2 A+1 R+0 I+1 P+2)"
		);
	});

	test("skips unknown future events", () => {
		const event = { type: "ds.unknown-future" } as unknown as DsEvent;

		expect(view.renderEvent(event, stateWithRoster())).toBeNull();
	});

	test("renders bound sheets, pages between seats, and reflects folded play state", () => {
		let state = stateWithRoster();
		state = apply(state, {
			sheet: {
				abilities: [
					{
						cost: "3 discipline",
						name: "Driving Pounce",
						text: "Leap into the fray.",
					},
				],
				ancestry: "Orc",
				characteristics: {
					agility: 2,
					intuition: 0,
					might: 3,
					presence: 1,
					reason: -1,
				},
				className: "Fury",
				heroicResource: "Ferocity",
				kit: "Panther",
				name: "Rook",
				recoveries: 10,
				stamina: 24,
				surges: 1,
				victories: 2,
			},
			type: "ds.character-entered",
		});
		const boundTable: TableView = {
			actor: "coda-key",
			gmSeatId: "gm",
			seats: [
				{ actor: "coda-key", characterId: "Coda", id: "gm" },
				{ actor: "rook-key", characterId: "Rook", id: "player" },
			],
		};
		const [, sheetPanel] = view.createPanels();
		if (sheetPanel?.onKey === undefined) {
			throw new Error("sheet panel missing");
		}
		const ownInput: GamePanelInput<DsState, DsCommand> = {
			dispatch: () => {},
			focused: false,
			state,
			table: boundTable,
		};
		const ownRows = sheetPanel.render(ownInput);
		expect(text(ownRows[0] ?? null)).toBe("Coda — Human Troubadour");
		expect(ownRows.map(text)).toEqual([
			"Coda — Human Troubadour",
			"M+2 A+1 R+0 I+1 P+2",
			"stamina 20",
			"drama 0",
			"recoveries 8/8",
			"surges 0",
			"victories 0",
		]);
		expect(ownRows.map(text)).not.toContain("[/] other sheets");

		const fallbackRows = sheetPanel.render({
			...ownInput,
			table: { ...boundTable, actor: "unseated-key" },
		});
		expect(text(fallbackRows[0] ?? null)).toBe("Coda — Human Troubadour");

		state = apply(state, {
			combatantId: "c1",
			condition: "bleeding",
			type: "ds.condition-applied",
		});
		state = apply(state, {
			characterName: "Coda",
			delta: 3,
			total: 3,
			type: "ds.resource-changed",
		});
		const liveRows = sheetPanel.render({ ...ownInput, state });
		expect(liveRows.map(text)).toContain("conditions: bleeding");
		expect(liveRows.map(text)).toContain("drama 3");

		const focusedInput: GamePanelInput<DsState, DsCommand> = {
			...ownInput,
			focused: true,
			state,
		};
		expect(sheetPanel.onKey({ name: "x", text: "x" }, focusedInput)).toBe(
			false
		);
		expect(sheetPanel.onKey({ name: "]", text: "]" }, focusedInput)).toBe(true);
		const pagedRows = sheetPanel.render(focusedInput);
		expect(text(pagedRows[0] ?? null)).toBe("Rook — Orc Fury · Panther");
		expect(pagedRows.map(text)).toContain("Driving Pounce · 3 discipline");
		expect(pagedRows.map(text)).toContain("Leap into the fray.");
		expect(pagedRows.map(text).at(-1)).toBe("[/] other sheets");
		expect(
			sheetPanel.onKey({ name: "left" }, { ...focusedInput, focused: false })
		).toBe(false);

		const emptyRows = sheetPanel.render({
			dispatch: () => {},
			focused: false,
			state: init(),
			table: {
				actor: "gm-key",
				gmSeatId: "gm",
				seats: [{ actor: "gm-key", characterId: null, id: "gm" }],
			},
		});
		expect(emptyRows).toEqual([
			{ runs: [{ text: "no character bound", token: "muted" }] },
		]);
	});

	test("keeps the selected seat when an earlier seat unbinds", () => {
		const [, sheetPanel] = view.createPanels();
		if (sheetPanel?.onKey === undefined) {
			throw new Error("sheet panel missing");
		}
		const input: GamePanelInput<DsState, DsCommand> = {
			dispatch: () => {},
			focused: true,
			state: stateWithCharacters(["A", "B", "C"]),
			table: threeCharacterTable,
		};
		expect(text(sheetPanel.render(input)[0] ?? null)).toBe(
			"B — Human Troubadour"
		);
		expect(sheetPanel.onKey({ name: "right" }, input)).toBe(true);
		expect(text(sheetPanel.render(input)[0] ?? null)).toBe(
			"C — Human Troubadour"
		);

		const unbound = {
			...input,
			table: {
				...threeCharacterTable,
				seats: threeCharacterTable.seats.map((seat) =>
					seat.id === "a" ? { ...seat, characterId: null } : seat
				),
			},
		};
		expect(text(sheetPanel.render(unbound)[0] ?? null)).toBe(
			"C — Human Troubadour"
		);
	});

	test("falls back to the viewer's sheet when the selected seat unbinds", () => {
		const [, sheetPanel] = view.createPanels();
		if (sheetPanel?.onKey === undefined) {
			throw new Error("sheet panel missing");
		}
		const input: GamePanelInput<DsState, DsCommand> = {
			dispatch: () => {},
			focused: true,
			state: stateWithCharacters(["A", "B", "C"]),
			table: threeCharacterTable,
		};
		expect(sheetPanel.onKey({ name: "right" }, input)).toBe(true);

		const selectedUnbound = {
			...input,
			table: {
				...threeCharacterTable,
				seats: threeCharacterTable.seats.map((seat) =>
					seat.id === "c" ? { ...seat, characterId: null } : seat
				),
			},
		};
		expect(text(sheetPanel.render(selectedUnbound)[0] ?? null)).toBe(
			"B — Human Troubadour"
		);
	});

	test("mints independent panel state for each table session", () => {
		let state = stateWithRoster();
		const [coda] = state.characters;
		if (coda === undefined) {
			throw new Error("character missing");
		}
		state = apply(state, {
			sheet: {
				...coda,
				ancestry: "Orc",
				className: "Fury",
				heroicResource: "Ferocity",
				name: "Rook",
			},
			type: "ds.character-entered",
		});
		const boundTable: TableView = {
			actor: "coda-key",
			gmSeatId: "gm",
			seats: [
				{ actor: "coda-key", characterId: "Coda", id: "gm" },
				{ actor: "rook-key", characterId: "Rook", id: "player" },
			],
		};
		const [, firstSheetPanel] = view.createPanels();
		const [, secondSheetPanel] = view.createPanels();
		if (
			firstSheetPanel?.onKey === undefined ||
			secondSheetPanel === undefined
		) {
			throw new Error("sheet panel missing");
		}
		const input: GamePanelInput<DsState, DsCommand> = {
			dispatch: () => {},
			focused: true,
			state,
			table: boundTable,
		};

		expect(firstSheetPanel.onKey({ name: "right" }, input)).toBe(true);
		expect(text(firstSheetPanel.render(input)[0] ?? null)).toBe(
			"Rook — Orc Fury"
		);
		expect(text(secondSheetPanel.render(input)[0] ?? null)).toBe(
			"Coda — Human Troubadour"
		);
	});

	test("dispatches add and roll builder flows with and without a character match", () => {
		const [panel] = view.createPanels();
		if (panel?.onKey === undefined) {
			throw new Error("interactive panel missing");
		}
		const dispatched: DsCommand[] = [];
		const input: GamePanelInput<DsState, DsCommand> = {
			dispatch: (command) => dispatched.push(command),
			focused: true,
			state: stateWithRoster(),
			table,
		};
		expect(panel.onKey({ name: "a", text: "a" }, input)).toBe(true);
		for (const character of " New Hero ") {
			panel.onKey({ name: character.toLowerCase(), text: character }, input);
		}
		expect(panel.render(input).map(text)).toContain("add hero:  New Hero _");
		panel.onKey({ name: "backspace" }, input);
		panel.onKey({ name: "return" }, input);
		expect(dispatched.at(-1)).toEqual({
			name: "New Hero",
			side: "heroes",
			type: "ds.add-combatant",
		});

		panel.onKey({ name: "r", text: "r" }, input);
		panel.onKey({ name: "a", text: "a" }, input);
		panel.onKey({ name: "e", text: "e" }, input);
		expect(panel.render(input).map(text)).toContain(
			"roll agility e1 b0 — enter rolls"
		);
		panel.onKey({ name: "return" }, input);
		expect(dispatched.at(-1)).toEqual({
			banes: 0,
			characterName: "Coda",
			characteristic: "agility",
			edges: 1,
			type: "ds.power-roll",
		});

		panel.onKey({ name: "down" }, input);
		panel.onKey({ name: "r", text: "r" }, input);
		panel.onKey({ name: "return" }, input);
		expect(dispatched.at(-1)).toEqual({
			banes: 0,
			characteristic: "might",
			edges: 0,
			type: "ds.power-roll",
		});
	});
});
