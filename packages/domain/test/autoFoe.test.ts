import { describe, expect, test } from "bun:test";

import type { Square } from "../src/rules/board/grid.ts";
import { decideAutoFoeStep } from "../src/rules/setWorld/autoFoe.ts";
import type { Fighter, SetState } from "../src/rules/setWorld/state.ts";
import { character } from "./fixtures.ts";

const fighter = (
	id: string,
	side: Fighter["side"],
	at: Square,
	over: Partial<Fighter> = {}
): Fighter => ({
	id,
	name: id,
	side,
	character: character(),
	health: 100,
	stamina: 100,
	at,
	...over,
});

const near = (stamina: number) => [
	fighter("ada", "party", { x: 2, y: 1 }),
	fighter("grub", "foes", { x: 3, y: 1 }, { stamina }),
];

const ground = {
	id: "ground",
	name: "Ground",
	terrain: ["..........", "..........", ".........."],
};

const fight = (
	fighters: ReadonlyArray<Fighter>,
	turn: {
		readonly id: string;
		readonly moved: number;
		readonly attacked: boolean;
	}
): SetState => ({
	fighters,
	map: ground,
	fight: { clock: 0, turns: 1, next: {}, turn },
});

describe("a foe's turn, played by the table", () => {
	test("attacks the nearest of the party in reach", () => {
		const state = fight(
			[
				fighter("ada", "party", { x: 2, y: 1 }),
				fighter("bo", "party", { x: 9, y: 1 }),
				fighter("grub", "foes", { x: 3, y: 1 }),
			],
			{ id: "grub", moved: 0, attacked: false }
		);

		expect(decideAutoFoeStep(state)).toEqual({
			type: "set-attack",
			who: "grub",
			target: "ada",
		});
	});

	test("closes in on the nearest when none is in reach, then rests", () => {
		const far = [
			fighter("ada", "party", { x: 0, y: 1 }),
			fighter("grub", "foes", { x: 9, y: 1 }),
		];

		expect(
			decideAutoFoeStep(fight(far, { id: "grub", moved: 0, attacked: false }))
		).toEqual({ type: "set-move", who: "grub", to: { x: 4, y: 1 } });
		expect(
			decideAutoFoeStep(fight(far, { id: "grub", moved: 5, attacked: false }))
		).toEqual({ type: "set-done" });
	});

	test("rests short of the stamina an attack costs, or after attacking", () => {
		expect(
			decideAutoFoeStep(
				fight(near(19), { id: "grub", moved: 0, attacked: false })
			)
		).toEqual({ type: "set-done" });
		expect(
			decideAutoFoeStep(
				fight(near(100), { id: "grub", moved: 0, attacked: true })
			)
		).toEqual({ type: "set-done" });
	});

	test("leaves the party's turns, and a fight that's over, alone", () => {
		const fighters = [
			fighter("ada", "party", { x: 2, y: 1 }),
			fighter("grub", "foes", { x: 3, y: 1 }),
		];

		expect(
			decideAutoFoeStep(
				fight(fighters, { id: "ada", moved: 0, attacked: false })
			)
		).toBeUndefined();
		expect(
			decideAutoFoeStep(
				fight(
					[
						fighter("ada", "party", { x: 2, y: 1 }, { health: 0 }),
						...fighters.slice(1),
					],
					{ id: "grub", moved: 0, attacked: false }
				)
			)
		).toBeUndefined();
		expect(decideAutoFoeStep({ fighters })).toBeUndefined();
	});
});
