import { describe, expect, test } from "bun:test";

import { Story } from "@alchemy.run/domain/Story";
import { Schema } from "effect";

import {
	SwAttack,
	SwEndFight,
	SwEndTurn,
	SwFoe,
	SwLoadMap,
	SwMove,
	SwPlace,
	SwPlay,
	SwRecruit,
	SwStartFight,
	SwUnplay,
} from "../src/commands/setWorld.ts";
import {
	SwAttacked,
	SwFightEnded,
	SwFighterClaimed,
	SwFighterJoined,
	SwFighterReleased,
	SwFightStarted,
	SwMapLoaded,
	SwMoved,
	SwPlaced,
	SwTurnBegan,
	SwTurnEnded,
} from "../src/events/setWorld.ts";
import { readLog } from "../src/readLog.ts";
import { Refused } from "../src/Refused.rejection.ts";
import { SetCharacterSchema } from "../src/rules/setWorld/events.ts";
import { RULES_STAMP } from "../src/rules/setWorld/state.ts";
import { reachOf } from "../src/rules/setWorld/weapons.ts";
import {
	actionsOf,
	bandOf,
	feedLines,
	mapOf,
	plainText,
	prepOf,
	sheetOf,
	tableLabel,
} from "../src/table.ts";
import type { TableState } from "../src/table.ts";
import { effect, must } from "./effect.ts";
import {
	ALICE,
	as,
	BOB,
	character,
	FIELD,
	GM,
	seeded,
	seedRolling,
	story,
	table,
	openDoor,
} from "./fixtures.ts";

const { advance, given, rejected, state, then, when } = Story;

const feedOf = (s: TableState): ReadonlyArray<string> =>
	feedLines(s, tableLabel(s, "set-world")).map(plainText);

const lastLines = (...lines: ReadonlyArray<string>) =>
	state(table, (s) => {
		expect(feedOf(s).slice(-lines.length)).toEqual([...lines]);
	});

const refused = (message: string) => rejected(new Refused({ message }));

const asGm = as(GM);

const ADA = character("sword", 1, { criticalHitChance: 0.5 });

const RAT = character("bow", 2, {
	initiative: 2,
	dodgeRate: 0.5,
	maxHealth: 40,
});

const adaJoins = new SwFighterJoined({
	actor: GM,
	id: "ada",
	name: "Ada",
	side: "party",
	character: ADA,
});

const ratJoins = new SwFighterJoined({
	actor: GM,
	id: "rat",
	name: "Rat",
	side: "foes",
	character: RAT,
});

const aliceTakesAda = new SwFighterClaimed({
	actor: ALICE,
	id: "ada",
	player: ALICE,
});

const setUp = [
	given(table, adaJoins),
	advance("1 second"),
	given(table, ratJoins),
	advance("1 second"),
	given(table, aliceTakesAda),
	advance("1 second"),
	given(table, new SwMapLoaded({ actor: GM, id: "field", ...FIELD })),
	advance("1 second"),
	given(table, new SwPlaced({ actor: GM, id: "ada", at: { x: 0, y: 0 } })),
	advance("1 second"),
	given(table, new SwPlaced({ actor: GM, id: "rat", at: { x: 1, y: 0 } })),
	advance("1 second"),
] as const;

describe("fighters", () => {
	effect("are rolled at set.world, then recruited or sent as foes", () =>
		story(
			openDoor,
			seeded(1),
			asGm,
			when(table, new SwRecruit({ name: "Ada", seed: 1 })),
			refused("No roll came from set.world for that; try again."),
			when(table, new SwRecruit({ name: "Ada", seed: 1, character: ADA })),
			then(table, adaJoins),
			when(table, new SwFoe({ name: "Rat", seed: 2, character: RAT })),
			then(table, ratJoins),
			as(ALICE),
			when(table, new SwPlay({ who: "ada", seated: [ALICE] })),
			then(table, aliceTakesAda),
			when(table, new SwPlay({ who: "rat", seated: [ALICE] })),
			refused("Rat fights for the foes."),
			as(BOB),
			when(table, new SwPlay({ who: "ada", seated: [ALICE, BOB] })),
			refused("Someone else plays Ada."),
			as(ALICE),
			when(table, new SwUnplay({})),
			then(table, new SwFighterReleased({ actor: ALICE, id: "ada" })),
			lastLines(
				"Ada the Tester joins the party: 100 health, 100 stamina, a sword (melee, reach 1), speed 5, set.world seed 1.",
				"Rat the Tester comes as a foe: 40 health, 100 stamina, a bow (projectile, reach 10), speed 5, set.world seed 2.",
				"abcdefgh takes Ada.",
				"abcdefgh stops playing Ada."
			)
		)
	);
});

describe("the fight", () => {
	effect(
		"turns follow initiative on the clock; attacks dodge, crit and fell",
		() =>
			story(
				openDoor,
				...setUp,
				seeded(1),
				asGm,
				when(table, new SwStartFight()),
				then(
					table,
					new SwFightStarted({ actor: GM, rules: RULES_STAMP }),
					new SwTurnBegan({
						actor: GM,
						id: "rat",
						at: 500,
						stamina: { ada: 100, rat: 100 },
					})
				),
				seeded(seedRolling([1000, 900], [1000, 999])),
				when(table, new SwAttack({ who: "rat", target: "ada" })),
				then(
					table,
					new SwAttacked({
						actor: GM,
						id: "rat",
						target: "ada",
						delivery: "projectile",
						magic: false,
						raw: 30,
						dodgeChance: 0,
						dodgeRoll: 900,
						dodged: false,
						critRoll: 999,
						critical: false,
						landed: 30,
						damage: 30,
						apart: 1,
					})
				),
				when(table, new SwAttack({ who: "rat", target: "ada" })),
				refused("Rat has attacked this turn; /done ends it."),
				when(table, new SwEndTurn()),
				then(
					table,
					new SwTurnEnded({ actor: GM, id: "rat", rested: false }),
					new SwTurnBegan({
						actor: GM,
						id: "ada",
						at: 1000,
						stamina: { ada: 100, rat: 85 },
					})
				),
				as(BOB),
				when(table, new SwAttack({ who: "ada", target: "rat" })),
				refused("You don't play Ada."),
				as(ALICE),
				seeded(seedRolling([1000, 900], [1000, 100])),
				when(table, new SwAttack({ who: "ada", target: "rat" })),
				then(
					table,
					new SwAttacked({
						actor: ALICE,
						id: "ada",
						target: "rat",
						delivery: "melee",
						magic: false,
						raw: 30,
						dodgeChance: 0.5,
						dodgeRoll: 900,
						dodged: false,
						critRoll: 100,
						critical: true,
						landed: 60,
						damage: 40,
						apart: 1,
					}),
					new SwFightEnded({ actor: ALICE, winner: "party" })
				),
				lastLines(
					"The fight begins. Turns follow initiative, on set.world's clock.",
					"0.50 s · Rat's turn: stamina 100, speed 5.",
					"Rat shoots at Ada: 30 damage → 70/100.",
					"Rat's turn ends.",
					"1.00 s · Ada's turn: stamina 100, speed 5.",
					"Ada strikes at Rat: a critical hit, 40 damage → 0/40, down.",
					"The fight is over: the party wins."
				)
			)
	);

	effect("a dodged blow does nothing; out of reach is refused", () =>
		story(
			...setUp,
			given(table, new SwFightStarted({ actor: GM, rules: RULES_STAMP })),
			given(
				table,
				new SwTurnBegan({
					actor: GM,
					id: "rat",
					at: 500,
					stamina: { ada: 100, rat: 100 },
				})
			),
			advance("1 second"),
			seeded(1),
			asGm,
			when(table, new SwEndTurn()),
			then(
				table,
				new SwTurnEnded({ actor: GM, id: "rat", rested: true }),
				new SwTurnBegan({
					actor: GM,
					id: "ada",
					at: 1000,
					stamina: { ada: 100, rat: 100 },
				})
			),
			when(table, new SwMove({ who: "rat", to: { x: 5, y: 0 } })),
			then(
				table,
				new SwMoved({ actor: GM, id: "rat", at: { x: 5, y: 0 }, cost: 4 })
			),
			as(ALICE),
			when(table, new SwAttack({ who: "ada", target: "rat" })),
			refused("Rat is 5 squares away; Ada's sword (melee) reaches 1."),
			when(table, new SwMove({ who: "ada", to: { x: 4, y: 0 } })),
			then(
				table,
				new SwMoved({ actor: ALICE, id: "ada", at: { x: 4, y: 0 }, cost: 4 })
			),
			seeded(seedRolling([1000, 100])),
			when(table, new SwAttack({ who: "ada", target: "rat" })),
			then(
				table,
				new SwAttacked({
					actor: ALICE,
					id: "ada",
					target: "rat",
					delivery: "melee",
					magic: false,
					raw: 30,
					dodgeChance: 0.5,
					dodgeRoll: 100,
					dodged: true,
					critical: false,
					landed: 0,
					damage: 0,
					apart: 1,
				})
			),
			lastLines("Ada strikes at Rat: Rat dodges (a 50% chance)."),
			state(table, (s) => {
				const band = must(bandOf(s, ALICE, "set-world"), "a band");

				expect(band.active).toBe(true);
				expect(band.combatants.map((c) => [c.id, c.mine, c.acting])).toEqual([
					["ada", true, true],
					["rat", false, false],
				]);
				expect(tableLabel(s, "set-world")(ALICE)).toBe("abcdefgh (Ada)");
				expect(actionsOf(s, ALICE, "set-world", "ada")).toEqual([
					{ label: "Move", pick: "square", line: "/move ada" },
					{ label: "Attack", pick: "target", line: "/attack ada" },
					{ label: "Done", pick: "none", line: "/done" },
				]);
				expect(actionsOf(s, ALICE, "set-world", "rat")).toBeUndefined();

				const map = must(mapOf(s, ALICE, "set-world"), "a map");

				expect(map.tokens.map((t) => [t.mark, t.x, t.y])).toEqual([
					["A", 4, 0],
					["r", 5, 0],
				]);
			}),
			asGm,
			when(table, new SwEndFight()),
			then(table, new SwFightEnded({ actor: GM })),
			lastLines("The fight is over.")
		)
	);

	effect(
		"a fight needs someone standing on each side, and a map to place on",
		() =>
			story(
				given(table, adaJoins),
				advance("1 second"),
				seeded(1),
				asGm,
				when(table, new SwStartFight()),
				refused(
					"A fight needs someone standing on each side: /recruit and /foe."
				),
				when(table, new SwLoadMap({ id: "field", grid: FIELD })),
				then(table, new SwMapLoaded({ actor: GM, id: "field", ...FIELD })),
				when(table, new SwPlace({ who: "ada", at: { x: 3, y: 1 } })),
				refused("d2 is a wall."),
				when(table, new SwPlace({ who: "ada", at: { x: 0, y: 0 } })),
				then(table, new SwPlaced({ actor: GM, id: "ada", at: { x: 0, y: 0 } })),
				state(table, (s) => {
					const prep = prepOf(
						s,
						{
							heroes: [],
							monsters: [],
							maps: [{ id: "field", name: "Field" }],
						},
						"set-world"
					);

					expect(prep.steps).toEqual([
						{ label: "map", done: true },
						{ label: "party", done: true },
						{ label: "foes", done: false },
					]);
					expect(sheetOf(s, "ada", "set-world")).toContain(
						"Ada: Tester, of the party (set.world seed 1, power 1000)"
					);
				})
			)
	);
});

const logLine = (seq: number, type: string, payload: Schema.Json) =>
	JSON.stringify({
		actor: GM,
		seq,
		timestamp: `2026-01-01T00:00:0${seq}.000Z`,
		type,
		payload,
	});

const joined = (seq: number, id: string, side: string) =>
	logLine(seq, "sw.fighter-joined", {
		id,
		name: id,
		side,
		character: Schema.encodeSync(Schema.toCodecJson(SetCharacterSchema))(
			character("sword", seq)
		),
	});

describe("the rules stamp", () => {
	test("a fight that follows other rules halts the fold, naming both", () => {
		const read = readLog([
			joined(1, "ada", "party"),
			joined(2, "rat", "foes"),
			logLine(3, "sw.fight-started", { rules: "set-world-0-14-0" }),
		]);

		expect(read.error).toEqual({
			line: 3,
			seq: 3,
			message: `sw.fight-started at seq 3 follows rules 'set-world-0-14-0', not this table's '${RULES_STAMP}'`,
		});
		expect(read.state.sw.fight).toBeUndefined();
	});

	test("this table's stamp starts the fight", () => {
		const read = readLog([
			joined(1, "ada", "party"),
			joined(2, "rat", "foes"),
			logLine(3, "sw.fight-started", { rules: RULES_STAMP }),
		]);

		expect(read.error).toBeUndefined();
		expect(read.state.sw.fight?.clock).toBe(0);
	});

	test("every weapon has a delivery and a reach", () => {
		expect(reachOf("sword")).toEqual({
			delivery: "melee",
			squares: 1,
			magic: false,
		});
		expect(reachOf("bow")).toEqual({
			delivery: "projectile",
			squares: 10,
			magic: false,
		});
		expect(reachOf("no such thing").delivery).toBe("melee");
	});
});
