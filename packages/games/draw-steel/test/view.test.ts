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
	seats: [{ actor: "gm-key", id: "gm" }],
};
const stateWithRoster = (): DsState => {
	let state = init();
	for (const event of [
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
		{ type: "ds.encounter-started" },
		{ id: "c1", name: "Coda", side: "heroes", type: "ds.combatant-added" },
		{ id: "c2", name: "Goblin", side: "enemies", type: "ds.combatant-added" },
	] satisfies DsEvent[]) {
		state = apply(state, event);
	}
	return state;
};

describe("Draw Steel view", () => {
	test("renders the independence notice and initiative rows", () => {
		expect(view.notices).toEqual([
			{ runs: [{ text: independenceNotice, token: "muted" }] },
		]);
		const [panel] = view.panels;
		if (panel === undefined) {
			throw new Error("initiative panel missing");
		}
		const inactive = panel.render({
			dispatch: () => {},
			state: init(),
			table,
		});
		expect(inactive.map(text)).toEqual(["Initiative", "no encounter"]);
		const active = panel.render({
			dispatch: () => {},
			state: stateWithRoster(),
			table,
		});
		expect(active.map(text)).toContain("round 1 — either side act next");
		expect(active.map(text)).toContain("▸ · Coda [H]");
		expect(active.map(text)).toContain("  · Goblin [E]");
		expect(active.map(text)).toContain("M+2 A+1 R+0 I+1 P+2 · stamina 20");
	});

	test("renders every event type from payloads, with turn names from state", () => {
		const state = stateWithRoster();
		const [statBlock] = state.characters;
		if (statBlock === undefined) {
			throw new Error("character missing");
		}
		const cases: readonly [DsEvent, string][] = [
			[
				{ statBlock, type: "ds.character-entered" },
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
		const roll: DsEvent = {
			banes: 0,
			characterName: "Coda",
			characteristic: "might",
			critical: true,
			dice: [9, 10],
			edges: 1,
			modifier: 2,
			tier: 3,
			total: 23,
			type: "ds.power-rolled",
		};
		const rendered = view.renderEvent(roll, state);
		expect(text(rendered)).toBe(
			"Coda — power roll (might): 9 + 10 + 2, edge = 23 → tier 3 · crit!"
		);
		expect(rendered?.runs.find((run) => run.text === "23")?.token).toBe(
			"accent"
		);
		expect(rendered?.runs.find((run) => run.text === "tier 3")?.token).toBe(
			"success"
		);
	});

	test("dispatches add and roll builder flows with and without a character match", () => {
		const [panel] = view.panels;
		if (panel?.onKey === undefined) {
			throw new Error("interactive panel missing");
		}
		const dispatched: DsCommand[] = [];
		const input: GamePanelInput<DsState, DsCommand> = {
			dispatch: (command) => dispatched.push(command),
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
