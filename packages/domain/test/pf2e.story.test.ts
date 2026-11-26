import { describe, expect, test } from "bun:test";

import { Story } from "@alchemy.run/domain/Story";

import { Redo, Undo } from "../src/commands/core.ts";
import {
	PfAddCreatures,
	PfBlock,
	PfCastSpell,
	PfCheck,
	PfCondition,
	PfDamage,
	PfDelay,
	PfEndTurn,
	PfJoin,
	PfJoinPc,
	PfPlace,
	PfPlay,
	PfRaiseShield,
	PfRecover,
	PfReroll,
	PfSave,
	PfStartEncounter,
	PfStep,
	PfStride,
	PfStrike,
	PfTakeTurn,
	PfTrip,
	PfDemoralize,
	PfGrapple,
	PfHeroPoints,
} from "../src/commands/pf2e.ts";
import { Redone, Retracted } from "../src/events/core.ts";
import {
	PfCast,
	PfChecked,
	PfCombatStarted,
	PfConditionSet,
	PfDamaged,
	PfDelayed,
	PfHeroicRecovery,
	PfHeroPointsSet,
	PfManeuvered,
	PfMoved,
	PfRejoined,
	PfRerolled,
	PfSaved,
	PfShieldBlocked,
	PfShieldRaised,
	PfCreaturesAdded,
	PfInitiativeRolled,
	PfMapLoaded,
	PfPcClaimed,
	PfPcJoined,
	PfPersistentSet,
	PfPlaced,
	PfStruck,
	PfTempSet,
	PfTurnEnded,
	PfTurnStarted,
} from "../src/events/pf2e.ts";
import { ifDefined, orEmpty } from "../src/present.ts";
import { Refused } from "../src/Refused.rejection.ts";
import { cheapestPath, reachable } from "../src/rules/board/movement.ts";
import type { Occupants } from "../src/rules/board/movement.ts";
import {
	crossesOpposite,
	feetOf,
	inReach,
	pfWalk,
} from "../src/rules/pf2e/board.ts";
import {
	adjusted,
	basicDamage,
	budgetFor,
	creatureXp,
	degree,
	mapPenalty,
	modifiers,
	parseDamage,
	resolveDamage,
	rollDamage,
	threatOf,
} from "../src/rules/pf2e/math.ts";
import type { DamageExpression } from "../src/rules/pf2e/math.ts";
import { reachOfStrike } from "../src/rules/pf2e/sheets.ts";
import type { PfSheet } from "../src/rules/pf2e/sheets.ts";
import { occupantsOf } from "../src/rules/pf2e/state.ts";
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
	ARI,
	as,
	BOB,
	BOG,
	BRYN,
	GM,
	GNASHER,
	LUMBERER,
	OPEN,
	seeded,
	seedRolling,
	SPRITE,
	story,
	table,
	openDoor,
} from "./fixtures.ts";

const { advance, given, rejected, state, then, when } = Story;

const feedOf = (s: TableState): ReadonlyArray<string> =>
	feedLines(s, tableLabel(s, "pf2e")).map(plainText);

const lastLineIs = (line: string) =>
	state(table, (s) => {
		expect(feedOf(s).at(-1)).toBe(line);
	});

const lastLineHas = (part: string) =>
	state(table, (s) => {
		expect(feedOf(s).at(-1) ?? "").toContain(part);
	});

const refused = (message: string) => rejected(new Refused({ message }));

const asGm = as(GM);

const creatureOf = (s: TableState, id: string) =>
	must(
		s.pf.creatures.find((c) => c.id === id),
		`${id} at the table`
	);

const ariJoins = new PfPcJoined({ actor: GM, sheet: ARI });

const brynJoins = new PfPcJoined({ actor: GM, sheet: BRYN });

const gnashers = new PfCreaturesAdded({
	actor: GM,
	block: GNASHER,
	creatures: [
		{ id: "gnasher-1", name: "Bog Gnasher 1" },
		{ id: "gnasher-2", name: "Bog Gnasher 2" },
	],
});

const aliceTakesAri = new PfPcClaimed({
	actor: ALICE,
	id: "ari",
	player: ALICE,
});

const bobTakesBryn = new PfPcClaimed({ actor: BOB, id: "bryn", player: BOB });

const openMap = new PfMapLoaded({ actor: GM, id: "open", ...OPEN });

const placed = (id: string, x: number, y: number) =>
	new PfPlaced({ actor: GM, id, at: { x, y } });

const rolledInit = (id: string, total: number) =>
	new PfInitiativeRolled({
		actor: GM,
		id,
		skill: "perception",
		natural: 10,
		bonus: total - 10,
		total,
	});

const ORDER = ["gnasher-2", "gnasher-1", "ari", "bryn"];

const turnOf = (id: string, actions = 3, round = 1) =>
	new PfTurnStarted({ actor: GM, id, round, actions });

const party = [
	given(table, ariJoins, brynJoins, gnashers),
	advance("1 second"),
	given(table, aliceTakesAri, bobTakesBryn),
	advance("1 second"),
	given(
		table,
		openMap,
		placed("ari", 1, 2),
		placed("gnasher-1", 2, 2),
		placed("bryn", 4, 2),
		placed("gnasher-2", 7, 4)
	),
	advance("1 second"),
] as const;

const encounter = [
	...party,
	given(
		table,
		rolledInit("ari", 15),
		rolledInit("gnasher-1", 15),
		rolledInit("bryn", 12),
		rolledInit("gnasher-2", 20),
		new PfCombatStarted({ actor: GM, order: ORDER })
	),
	advance("1 second"),
] as const;

const onTurn = (id: string, actions = 3) =>
	[given(table, turnOf(id, actions)), advance("1 second")] as const;

describe("degrees of success", () => {
	test("four degrees, ten either side, and the natural 20 and 1 shift them", () => {
		expect(degree(25, 15, 10)).toBe("crit-success");
		expect(degree(15, 15, 10)).toBe("success");
		expect(degree(14, 15, 10)).toBe("failure");
		expect(degree(5, 15, 4)).toBe("crit-failure");
		expect(degree(14, 15, 20)).toBe("success");
		expect(degree(24, 15, 20)).toBe("crit-success");
		expect(degree(25, 15, 20)).toBe("crit-success");
		expect(degree(16, 15, 1)).toBe("failure");
		expect(degree(5, 15, 1)).toBe("crit-failure");
		expect(degree(4, 15, 20)).toBe("failure");
	});

	test("typed bonuses and penalties: the best and the worst of each type, untyped penalties stack", () => {
		const { bonus, parts } = modifiers([
			{ type: "circumstance", value: 1, label: "aid" },
			{ type: "circumstance", value: 2, label: "cover" },
			{ type: "status", value: -1, label: "frightened" },
			{ type: "status", value: -2, label: "sickened" },
			{ type: "circumstance", value: -2, label: "prone" },
			{ type: "untyped", value: -5, label: "MAP" },
			{ type: "untyped", value: -2, label: "range" },
			{ type: "item", value: 1, label: "potency" },
			{ type: "item", value: 2, label: "greater potency" },
		]);

		expect(bonus).toBe(2 - 2 - 2 + 2 - 5 - 2);
		expect(parts.map((p) => p.label)).toEqual([
			"cover",
			"prone",
			"sickened",
			"greater potency",
			"MAP",
			"range",
		]);
	});

	test("basic saves take none, half, all or double", () => {
		expect(basicDamage("crit-success", 9)).toBe(0);
		expect(basicDamage("success", 9)).toBe(4);
		expect(basicDamage("failure", 9)).toBe(9);
		expect(basicDamage("crit-failure", 9)).toBe(18);
	});
});

describe("the multiple attack penalty", () => {
	test("0, -5, -10; agile 0, -4, -8; flurry 0, -3, -6 and agile 0, -2, -4", () => {
		expect([0, 1, 2, 3].map((n) => mapPenalty(n, false, false))).toEqual([
			0, -5, -10, -10,
		]);
		expect([0, 1, 2].map((n) => mapPenalty(n, true, false))).toEqual([
			0, -4, -8,
		]);
		expect([0, 1, 2].map((n) => mapPenalty(n, false, true))).toEqual([
			0, -3, -6,
		]);
		expect([0, 1, 2].map((n) => mapPenalty(n, true, true))).toEqual([
			0, -2, -4,
		]);
	});
});

const parsed = (text: string): DamageExpression => {
	const e = parseDamage(text);

	if ("refusal" in e) {
		throw new Error(e.refusal);
	}

	return e;
};

const always =
	(...faces: ReadonlyArray<number>) =>
	(sides: number): number =>
		faces.find((f) => f <= sides) ?? 1;

describe("damage", () => {
	test("a critical doubles; deadly adds its die after; fatal upsizes, doubles and adds one", () => {
		expect(rollDamage(parsed("1d8+4"), always(5), { critical: false })).toEqual(
			{ expression: "1d8+4", rolls: [5], total: 9 }
		);
		expect(rollDamage(parsed("1d8+4"), always(5), { critical: true })).toEqual({
			expression: "2×(1d8+4)",
			rolls: [5],
			total: 18,
		});
		expect(
			rollDamage(parsed("1d6"), always(6), { critical: true, deadly: 10 })
		).toEqual({ expression: "2×(1d6)+1d10", rolls: [6, 6], total: 18 });
		expect(
			rollDamage(parsed("1d8+2"), always(12), { critical: true, fatal: 12 })
		).toEqual({ expression: "2×(1d12+2)+1d12", rolls: [12, 12], total: 40 });
		expect(
			rollDamage(parsed("1d8+2"), always(8), { critical: false, fatal: 12 })
		).toEqual({ expression: "1d8+2", rolls: [8], total: 10 });
		expect("refusal" in parseDamage("lots")).toBe(true);
		expect(parsed("2d6+1d4-1")).toEqual({
			terms: [
				{ count: 2, sides: 6 },
				{ count: 1, sides: 4 },
			],
			flat: -1,
		});
	});

	test("immunity, then the highest weakness, then the highest resistance, by type", () => {
		const sheet = {
			immunities: ["fire"],
			weaknesses: [
				{ type: "cold", value: 3 },
				{ type: "cold", value: 5 },
			],
			resistances: [
				{ type: "physical", value: 2 },
				{ type: "slashing", value: 4 },
			],
		};

		expect(resolveDamage(10, "fire", sheet)).toEqual({
			applied: 0,
			notes: ["immune to fire"],
		});
		expect(resolveDamage(10, "cold", sheet).applied).toBe(15);
		expect(resolveDamage(10, "slashing", sheet).applied).toBe(6);
		expect(resolveDamage(10, "piercing", sheet).applied).toBe(8);
		expect(resolveDamage(1, "slashing", sheet).applied).toBe(0);
		expect(resolveDamage(10, undefined, sheet).applied).toBe(10);
	});
});

describe("elite and weak", () => {
	test("±2 to AC, attacks, damage, saves, Perception and skills, and HP by level", () => {
		const elite = adjusted(GNASHER, "elite");
		const weak = adjusted(GNASHER, "weak");

		expect([elite.ac, elite.perception, elite.saves.fort, elite.hp]).toEqual([
			18, 8, 9, 30,
		]);
		expect(elite.strikes[0]).toMatchObject({ bonus: 11, damage: "1d10+5" });
		expect(elite.skills).toEqual([{ name: "athletics", bonus: 9 }]);
		expect([weak.ac, weak.hp, weak.level]).toEqual([14, 10, -1]);
		expect(weak.strikes[0]?.damage).toBe("1d10+1");
		expect(adjusted(LUMBERER, "elite").hp).toBe(65);
		expect(adjusted({ ...LUMBERER, level: 12 }, "weak").hp).toBe(30);
		expect(adjusted({ ...LUMBERER, level: 20, hp: 400 }, "elite").hp).toBe(430);
	});
});

describe("the encounter's threat", () => {
	test("each creature's XP by level against the party, and the budget for the party's size", () => {
		expect(
			[-5, -4, -2, 0, 1, 2, 4, 6].map((d) => creatureXp(3 + d, 3))
		).toEqual([0, 10, 20, 40, 60, 80, 160, 160]);
		expect(budgetFor("moderate", 4)).toBe(80);
		expect(budgetFor("moderate", 5)).toBe(100);
		expect(budgetFor("extreme", 3)).toBe(120);
		expect(threatOf(30, 4)).toBe("trivial");
		expect(threatOf(80, 4)).toBe("moderate");
		expect(threatOf(119, 4)).toBe("moderate");
		expect(threatOf(160, 4)).toBe("extreme");
		expect(threatOf(40, 2)).toBe("moderate");
	});
});

const PLAIN_TEN = ["..........", "..........", "..........", ".........."];

const walker = { side: "heroes" as const, footprint: 1 as const, tiny: false };

const nobody: Occupants = occupantsOf({ creatures: [] });

interface At {
	readonly x: number;
	readonly y: number;
}

const foe = (square: At) =>
	square.x === 1
		? { id: "foe", side: "director", footprint: 1 as const }
		: undefined;

const friend = (square: At) =>
	square.x === 1 && square.y === 0
		? { id: "friend", side: "heroes", footprint: 1 as const }
		: undefined;

describe("the 5-ft grid", () => {
	test("diagonals cost 5 then 10, and the count carries over", () => {
		const fresh = pfWalk(PLAIN_TEN, walker, nobody, 0, false);
		const after = pfWalk(PLAIN_TEN, walker, nobody, 1, false);

		expect(
			cheapestPath(PLAIN_TEN, { x: 0, y: 0 }, { x: 1, y: 1 }, fresh)?.cost
		).toBe(5);
		expect(
			cheapestPath(PLAIN_TEN, { x: 0, y: 0 }, { x: 1, y: 1 }, after)?.cost
		).toBe(10);
		expect(
			cheapestPath(PLAIN_TEN, { x: 0, y: 0 }, { x: 3, y: 3 }, fresh)?.cost
		).toBe(20);
		expect(
			cheapestPath(PLAIN_TEN, { x: 0, y: 0 }, { x: 4, y: 2 }, fresh)?.cost
		).toBe(25);
		expect(reachable(PLAIN_TEN, { x: 0, y: 0 }, 5, fresh, nobody).length).toBe(
			3
		);
	});

	test("difficult terrain costs 5 more, and a Step never enters it", () => {
		const terrain = ["..~.", "....", "...."];
		const stride = pfWalk(terrain, walker, nobody, 0, false);
		const step = pfWalk(terrain, walker, nobody, 0, true);

		expect(
			cheapestPath(terrain, { x: 1, y: 0 }, { x: 2, y: 0 }, stride)?.cost
		).toBe(10);
		expect(
			cheapestPath(terrain, { x: 1, y: 0 }, { x: 2, y: 0 }, step)
		).toBeUndefined();
	});

	test("enemies block, allies let you through", () => {
		const terrain = ["...", "...", "..."];

		expect(
			cheapestPath(
				terrain,
				{ x: 0, y: 0 },
				{ x: 2, y: 0 },
				pfWalk(terrain, walker, foe, 0, false)
			)
		).toBeUndefined();
		expect(
			cheapestPath(
				terrain,
				{ x: 0, y: 0 },
				{ x: 2, y: 0 },
				pfWalk(terrain, walker, friend, 0, false)
			)?.cost
		).toBe(10);
	});

	test("reach: 5 ft is adjacent, and 10-ft reach takes two squares diagonally too", () => {
		expect(feetOf({ dx: 1, dy: 1 })).toBe(5);
		expect(feetOf({ dx: 2, dy: 2 })).toBe(15);
		expect(feetOf({ dx: 3, dy: 1 })).toBe(15);
		expect(inReach({ dx: 1, dy: 1 }, 5)).toBe(true);
		expect(inReach({ dx: 2, dy: 0 }, 5)).toBe(false);
		expect(inReach({ dx: 2, dy: 2 }, 10)).toBe(true);
		expect(inReach({ dx: 2, dy: 2 }, 15)).toBe(true);
		expect(inReach({ dx: 3, dy: 0 }, 10)).toBe(false);
	});

	test("flanking: the line between the two crosses opposite sides or corners", () => {
		const box = { x0: 2, y0: 2, size: 1 };

		expect(crossesOpposite({ x: 1.5, y: 2.5 }, { x: 3.5, y: 2.5 }, box)).toBe(
			true
		);
		expect(crossesOpposite({ x: 1.5, y: 1.5 }, { x: 3.5, y: 3.5 }, box)).toBe(
			true
		);
		expect(crossesOpposite({ x: 1.5, y: 2.5 }, { x: 3.5, y: 1.5 }, box)).toBe(
			false
		);
		expect(crossesOpposite({ x: 2.5, y: 1.5 }, { x: 3.5, y: 2.5 }, box)).toBe(
			false
		);
		expect(
			crossesOpposite(
				{ x: 1.5, y: 3 },
				{ x: 5.5, y: 3 },
				{ x0: 2, y0: 2, size: 2 }
			)
		).toBe(true);
	});
});

describe("the party and its foes", () => {
	effect(
		"PCs join from their sheets, creatures come numbered, elite or weak",
		() =>
			story(
				openDoor,
				seeded(1),
				asGm,
				when(table, new PfJoinPc({ id: "ari", sheet: ARI })),
				then(table, ariJoins),
				when(
					table,
					new PfAddCreatures({
						monster: "gnasher",
						count: 2,
						adjustment: "elite",
						sheet: GNASHER,
					})
				),
				then(
					table,
					new PfCreaturesAdded({
						actor: GM,
						block: GNASHER,
						adjustment: "elite",
						creatures: [
							{ id: "gnasher-1", name: "Bog Gnasher 1" },
							{ id: "gnasher-2", name: "Bog Gnasher 2" },
						],
					})
				),
				when(
					table,
					new PfAddCreatures({ monster: "gnasher", count: 1, sheet: GNASHER })
				),
				then(
					table,
					new PfCreaturesAdded({
						actor: GM,
						block: GNASHER,
						creatures: [{ id: "gnasher-3", name: "Bog Gnasher 3" }],
					})
				),
				as(ALICE),
				when(table, new PfPlay({ who: "ari", seated: [ALICE] })),
				then(table, aliceTakesAri),
				when(table, new PfPlay({ who: "gnasher-1", seated: [ALICE] })),
				refused("Bog Gnasher 1 isn't a PC."),
				state(table, (s) => {
					expect(feedOf(s)).toEqual([
						"The door is open: anyone who connects sits down.",
						"Ari joins the party: level 1 human fighter, 20 HP, AC 18, Speed 25 ft.",
						"2 × elite Bog Gnasher come: level 2, 30 HP, AC 18.",
						"A Bog Gnasher comes: level 1, 20 HP, AC 16.",
						"abcdefgh plays Ari.",
					]);
					expect(creatureOf(s, "gnasher-1").sheet.strikes[0]?.bonus).toBe(11);
					expect(tableLabel(s, "pf2e")(ALICE)).toBe("abcdefgh (Ari)");
				})
			)
	);
});

describe("initiative", () => {
	effect(
		"high to low; a foe wins a tie with a PC; the first turn begins with three actions",
		() =>
			story(
				...party,
				given(
					table,
					rolledInit("ari", 15),
					rolledInit("gnasher-1", 15),
					rolledInit("bryn", 12)
				),
				seeded(seedRolling([20, 14])),
				asGm,
				when(table, new PfStartEncounter()),
				then(
					table,
					new PfInitiativeRolled({
						actor: GM,
						id: "gnasher-2",
						skill: "perception",
						natural: 14,
						bonus: 6,
						total: 20,
					}),
					new PfCombatStarted({ actor: GM, order: ORDER }),
					turnOf("gnasher-2")
				),
				lastLineIs("Round 1 · Bog Gnasher 2's turn: ◆◆◆ ↺."),
				state(table, (s) => {
					expect(feedOf(s).at(-2)).toBe(
						"The encounter begins. Initiative: Bog Gnasher 2, Bog Gnasher 1, Ari, Bryn."
					);
				}),
				seeded(1),
				when(table, new PfEndTurn()),
				then(
					table,
					new PfTurnEnded({ actor: GM, id: "gnasher-2", persistent: [] }),
					turnOf("gnasher-1")
				)
			)
	);

	effect(
		"a delaying creature leaves the order, and joins it again after the one acting",
		() =>
			story(
				...encounter,
				...onTurn("ari"),
				seeded(1),
				as(ALICE),
				when(table, new PfDelay()),
				then(
					table,
					new PfDelayed({ actor: ALICE, id: "ari" }),
					new PfTurnStarted({ actor: ALICE, id: "bryn", round: 1, actions: 3 })
				),
				state(table, (s) => {
					expect(s.pf.combat?.order).toEqual([
						"gnasher-2",
						"gnasher-1",
						"bryn",
					]);
					expect(s.pf.combat?.delayed).toEqual(["ari"]);
					expect(s.pf.combat?.turn?.id).toBe("bryn");
				}),
				when(table, new PfJoin({ who: "ari" })),
				then(table, new PfRejoined({ actor: ALICE, id: "ari", after: "bryn" })),
				state(table, (s) => {
					expect(s.pf.combat?.order).toEqual([
						"gnasher-2",
						"gnasher-1",
						"bryn",
						"ari",
					]);
					expect(s.pf.combat?.delayed).toEqual([]);
				}),
				as(BOB),
				when(table, new PfEndTurn()),
				then(
					table,
					new PfTurnEnded({ actor: BOB, id: "bryn", persistent: [] }),
					new PfTurnStarted({ actor: BOB, id: "ari", round: 1, actions: 3 })
				)
			)
	);
});

const damaged = (id: string, expression: string, total: number) =>
	new PfDamaged({
		actor: GM,
		id,
		damage: { expression, rolls: [], total, applied: total, critical: false },
	});

const strikeOn = (
	weapon: string,
	natural: number,
	bonus: number,
	ac: number,
	extra: {
		readonly map?: number;
		readonly notes?: ReadonlyArray<string>;
		readonly degree: "success" | "crit-success" | "failure" | "crit-failure";
		readonly damage?: PfStruck["damage"];
		readonly target?: string;
		readonly reaction?: boolean;
		readonly actor?: typeof ALICE;
		readonly id?: string;
	}
) =>
	new PfStruck({
		actor: extra.actor ?? ALICE,
		id: extra.id ?? "ari",
		target: extra.target ?? "gnasher-1",
		weapon,
		natural,
		bonus,
		total: natural + bonus,
		ac,
		degree: extra.degree,
		map: extra.map ?? 0,
		reaction: extra.reaction ?? false,
		notes: [...orEmpty(extra.notes)],
		...ifDefined(extra.damage, (damage) => ({ damage })),
	});

describe("a turn's three actions", () => {
	effect(
		"Strikes take the multiple attack penalty, agile less; flanking makes the target off-guard",
		() =>
			story(
				...encounter,
				...onTurn("ari"),
				as(ALICE),
				seeded(seedRolling([20, 10], [8, 4])),
				when(
					table,
					new PfStrike({ who: "ari", weapon: "long", target: "gnasher-1" })
				),
				then(
					table,
					strikeOn("Longsword", 10, 9, 14, {
						degree: "success",
						notes: ["off-guard (flanked with Bryn) -2"],
						damage: {
							expression: "1d8+4",
							rolls: [4],
							total: 8,
							damageType: "slashing",
							applied: 8,
							critical: false,
						},
					})
				),
				lastLineIs(
					"Ari Strikes Bog Gnasher 1 with Longsword: 10+9 = 19 vs AC 14 (off-guard (flanked with Bryn) -2): success. 1d8+4 [4] = 8 slashing → Bog Gnasher 1 12/20 HP."
				),
				state(table, (s) => {
					const band = must(bandOf(s, ALICE, "pf2e"), "a band");

					const ari = must(
						band.combatants.find((c) => c.id === "ari"),
						"Ari's row"
					);

					expect(band.meterLabel).toBe("HP");
					expect(ari.actions).toEqual({ left: 2, max: 3, reaction: true });
					expect(ari.penalty).toBe("MAP -5");
				}),
				seeded(seedRolling([20, 10], [8, 4])),
				when(
					table,
					new PfStrike({ who: "ari", weapon: "long", target: "gnasher-1" })
				),
				then(
					table,
					strikeOn("Longsword", 10, 4, 14, {
						degree: "success",
						map: -5,
						notes: ["MAP -5", "off-guard (flanked with Bryn) -2"],
						damage: {
							expression: "1d8+4",
							rolls: [4],
							total: 8,
							damageType: "slashing",
							applied: 8,
							critical: false,
						},
					})
				),
				lastLineHas("10+4 = 14 vs AC 14 (MAP -5; off-guard"),
				seeded(seedRolling([20, 20], [4, 3])),
				when(
					table,
					new PfStrike({ who: "ari", weapon: "dagger", target: "gnasher-1" })
				),
				then(
					table,
					strikeOn("Dagger", 20, 1, 14, {
						degree: "crit-success",
						map: -8,
						notes: ["MAP -8", "off-guard (flanked with Bryn) -2"],
						damage: {
							expression: "2×(1d4+4)",
							rolls: [3],
							total: 14,
							damageType: "piercing",
							applied: 12,
							critical: true,
						},
					})
				),
				state(table, (s) => {
					expect(creatureOf(s, "gnasher-1").hp).toBe(0);
					expect(s.pf.combat?.turn).toMatchObject({ actions: 0, attacks: 3 });
				}),
				lastLineHas("Bog Gnasher 1 0/20 HP, dead"),
				when(
					table,
					new PfStrike({ who: "ari", weapon: "long", target: "gnasher-2" })
				),
				refused("Ari has 0 actions left; that takes 1 action."),
				as(BOB),
				when(
					table,
					new PfStrike({ who: "bryn", weapon: "short", target: "gnasher-2" })
				),
				refused("It isn't Bryn's turn."),
				seeded(seedRolling([20, 2])),
				when(
					table,
					new PfStrike({
						who: "bryn",
						weapon: "short",
						target: "gnasher-2",
						reaction: true,
					})
				),
				then(
					table,
					strikeOn("Shortbow", 2, 7, 16, {
						actor: BOB,
						id: "bryn",
						target: "gnasher-2",
						degree: "failure",
						reaction: true,
					})
				),
				when(
					table,
					new PfStrike({
						who: "bryn",
						weapon: "short",
						target: "gnasher-2",
						reaction: true,
					})
				),
				refused("Bryn has used ↺ this round.")
			)
	);

	effect(
		"Strides count diagonals 5 then 10 across the whole turn; a Step goes 5 ft and never into difficult ground",
		() =>
			story(
				given(table, ariJoins, gnashers),
				given(table, aliceTakesAri),
				given(
					table,
					new PfMapLoaded({ actor: GM, id: "bog", ...BOG }),
					placed("ari", 0, 1),
					placed("gnasher-1", 9, 0),
					placed("gnasher-2", 9, 2),
					rolledInit("ari", 20),
					rolledInit("gnasher-1", 2),
					rolledInit("gnasher-2", 1),
					new PfCombatStarted({
						actor: GM,
						order: ["ari", "gnasher-1", "gnasher-2"],
					})
				),
				...onTurn("ari"),
				seeded(1),
				as(ALICE),
				when(table, new PfStride({ who: "ari", to: { x: 1, y: 2 } })),
				then(
					table,
					new PfMoved({
						actor: ALICE,
						id: "ari",
						to: { x: 1, y: 2 },
						feet: 5,
						kind: "stride",
						parity: 1,
					})
				),
				lastLineIs("Ari Strides to b3 (5 ft)."),
				state(table, (s) => {
					expect(s.pf.combat?.turn?.diagonalParity).toBe(1);
				}),
				when(table, new PfStep({ who: "ari", to: { x: 2, y: 1 } })),
				refused("Ari can't step to c2: it isn't 5 ft of plain ground away."),
				when(table, new PfStride({ who: "ari", to: { x: 2, y: 3 } })),
				then(
					table,
					new PfMoved({
						actor: ALICE,
						id: "ari",
						to: { x: 2, y: 3 },
						feet: 10,
						kind: "stride",
						parity: 0,
					})
				),
				lastLineIs("Ari Strides to c4 (10 ft)."),
				state(table, (s) => {
					expect(s.pf.combat?.turn).toMatchObject({
						diagonalParity: 0,
						actions: 1,
					});
				}),
				when(table, new PfStride({ who: "ari", to: { x: 8, y: 3 } })),
				refused("i4 is 35 ft away; Ari's Speed is 25 ft."),
				when(table, new PfStride({ who: "ari", to: { x: 3, y: 1 } })),
				then(
					table,
					new PfMoved({
						actor: ALICE,
						id: "ari",
						to: { x: 3, y: 1 },
						feet: 15,
						kind: "stride",
						parity: 1,
					})
				),
				lastLineIs("Ari Strides to d2 (15 ft)."),
				state(table, (s) => {
					const map = must(mapOf(s, ALICE, "pf2e"), "a map");

					expect(map.reach).toEqual([]);
					expect(map.reachLabel).toBe(
						"Ari can Stride 25 ft, next diagonal 10 ft"
					);
				})
			)
	);

	effect(
		"slowed takes actions, stunned takes them first and counts down, quickened adds one",
		() =>
			story(
				...encounter,
				given(
					table,
					new PfConditionSet({
						actor: GM,
						id: "ari",
						name: "slowed",
						value: 1,
					}),
					new PfConditionSet({
						actor: GM,
						id: "ari",
						name: "stunned",
						value: 2,
					}),
					new PfConditionSet({ actor: GM, id: "bryn", name: "quickened" })
				),
				...onTurn("gnasher-1"),
				seeded(1),
				asGm,
				when(table, new PfTakeTurn({ who: "ari" })),
				then(
					table,
					new PfTurnEnded({ actor: GM, id: "gnasher-1", persistent: [] }),
					new PfTurnStarted({
						actor: GM,
						id: "ari",
						round: 1,
						actions: 1,
						stunned: 0,
					})
				),
				when(table, new PfEndTurn()),
				then(
					table,
					new PfTurnEnded({ actor: GM, id: "ari", persistent: [] }),
					turnOf("bryn", 4)
				),
				state(table, (s) => {
					expect(creatureOf(s, "ari").conditions.map((c) => c.name)).toEqual([
						"slowed",
					]);
				}),
				when(table, new PfTakeTurn({ who: "ari" })),
				then(
					table,
					new PfTurnEnded({ actor: GM, id: "bryn", persistent: [] }),
					turnOf("ari", 2)
				)
			)
	);
});

describe("dying", () => {
	effect(
		"a PC at 0 HP is dying 1 + wounded, and its initiative moves before the turn that dropped it",
		() =>
			story(
				...encounter,
				given(
					table,
					new PfConditionSet({
						actor: GM,
						id: "bryn",
						name: "wounded",
						value: 1,
					})
				),
				...onTurn("gnasher-1"),
				seeded(1),
				asGm,
				when(table, new PfDamage({ who: "bryn", amount: "20" })),
				then(table, damaged("bryn", "20", 20)),
				state(table, (s) => {
					const bryn = creatureOf(s, "bryn");

					expect([bryn.hp, bryn.dying, bryn.wounded]).toEqual([0, 2, 1]);
					expect(bryn.conditions.map((c) => c.name)).toContain("unconscious");
					expect(s.pf.combat?.order).toEqual([
						"gnasher-2",
						"bryn",
						"gnasher-1",
						"ari",
					]);
				}),
				lastLineIs(
					"Damage: 20 = 20 → Bryn 0 HP, dying 2, initiative moves before this turn."
				),
				when(table, new PfDamage({ who: "bryn", amount: "1", critical: true })),
				then(
					table,
					new PfDamaged({
						actor: GM,
						id: "bryn",
						damage: {
							expression: "2×(1)",
							rolls: [],
							total: 2,
							applied: 2,
							critical: true,
						},
					})
				),
				state(table, (s) => {
					const bryn = creatureOf(s, "bryn");

					expect([bryn.dying, bryn.dead]).toEqual([4, true]);
				})
			)
	);

	effect(
		"the recovery check at the start of the turn: flat DC 10 + dying; Heroic Recovery; dead at 4 less doomed",
		() =>
			story(
				...party,
				given(
					table,
					new PfConditionSet({
						actor: GM,
						id: "bryn",
						name: "doomed",
						value: 1,
					}),
					damaged("bryn", "15", 15)
				),
				given(
					table,
					rolledInit("ari", 15),
					rolledInit("gnasher-1", 15),
					rolledInit("bryn", 12),
					rolledInit("gnasher-2", 20),
					new PfCombatStarted({ actor: GM, order: ORDER })
				),
				...onTurn("ari"),
				asGm,
				seeded(seedRolling([20, 15])),
				when(table, new PfEndTurn()),
				then(
					table,
					new PfTurnEnded({ actor: GM, id: "ari", persistent: [] }),
					new PfTurnStarted({
						actor: GM,
						id: "bryn",
						round: 1,
						actions: 0,
						recovery: { natural: 15, dc: 11, degree: "success" },
					})
				),
				lastLineIs(
					"Round 1 · Bryn's turn: ◇◇◇ ↺. Recovery check DC 11: 15, success → stable, wounded 1."
				),
				seeded(1),
				when(table, new PfDamage({ who: "bryn", amount: "3" })),
				then(table, damaged("bryn", "3", 3)),
				state(table, (s) => {
					expect(creatureOf(s, "bryn").dying).toBe(2);
				}),
				as(BOB),
				when(table, new PfRecover({ who: "bryn" })),
				then(table, new PfHeroicRecovery({ actor: BOB, id: "bryn", spent: 1 })),
				state(table, (s) => {
					const bryn = creatureOf(s, "bryn");

					expect([bryn.dying, bryn.wounded, bryn.heroPoints, bryn.hp]).toEqual([
						0, 1, 0, 0,
					]);
				}),
				when(table, new PfRecover({ who: "bryn" })),
				refused("Bryn isn't dying."),
				asGm,
				when(table, new PfDamage({ who: "bryn", amount: "1" })),
				then(table, damaged("bryn", "1", 1)),
				when(table, new PfEndTurn()),
				then(
					table,
					new PfTurnEnded({ actor: GM, id: "bryn", persistent: [] }),
					turnOf("gnasher-2", 3, 2)
				),
				seeded(seedRolling([20, 1])),
				when(table, new PfTakeTurn({ who: "bryn" })),
				then(
					table,
					new PfTurnEnded({ actor: GM, id: "gnasher-2", persistent: [] }),
					new PfTurnStarted({
						actor: GM,
						id: "bryn",
						round: 2,
						actions: 0,
						recovery: { natural: 1, dc: 12, degree: "crit-failure" },
					})
				),
				state(table, (s) => {
					expect(feedOf(s).at(-1)).toContain("critical failure → dead");
					expect(creatureOf(s, "bryn").dead).toBe(true);
					expect(
						bandOf(s, BOB, "pf2e")?.combatants.find((c) => c.id === "bryn")
							?.health
					).toBe("dead");
				})
			)
	);
});

const checkedEvent = (
	skill: string,
	natural: number,
	bonus: number,
	dc: number,
	result: "success" | "failure"
) =>
	new PfChecked({
		actor: ALICE,
		id: "ari",
		skill,
		natural,
		bonus,
		total: natural + bonus,
		dc,
		degree: result,
	});

describe("Hero Points", () => {
	effect(
		"a reroll is a fortune effect: one Hero Point, the latest check, and the new roll stands",
		() =>
			story(
				...party,
				as(ALICE),
				seeded(seedRolling([20, 5])),
				when(table, new PfCheck({ who: "ari", skill: "athletics", dc: 20 })),
				then(table, checkedEvent("athletics", 5, 9, 20, "failure")),
				lastLineIs("Ari rolls athletics: 5+9 = 14 vs DC 20: failure."),
				seeded(seedRolling([20, 12])),
				when(table, new PfReroll({ who: "ari" })),
				then(
					table,
					new PfRerolled({
						actor: ALICE,
						id: "ari",
						natural: 12,
						total: 21,
						degree: "success",
					})
				),
				lastLineIs(
					"Ari spends a Hero Point to reroll athletics: 12+9 = 21 vs DC 20: success, and keeps it."
				),
				when(table, new PfReroll({ who: "ari" })),
				refused("Ari has no Hero Points."),
				asGm,
				when(table, new PfHeroPoints({ who: "ari", by: 2 })),
				then(table, new PfHeroPointsSet({ actor: GM, id: "ari", points: 2 })),
				as(ALICE),
				when(table, new PfReroll({ who: "ari" })),
				refused(
					"That check was rerolled already: one fortune effect per check."
				),
				when(table, new PfHeroPoints({ who: "ari", by: 1 })),
				refused("Only the GM gives Hero Points; you can spend your own."),
				asGm,
				when(
					table,
					new PfCondition({ who: "ari", name: "frightened", value: 1 })
				),
				then(
					table,
					new PfConditionSet({
						actor: GM,
						id: "ari",
						name: "frightened",
						value: 1,
					})
				),
				as(ALICE),
				seeded(seedRolling([20, 3])),
				when(table, new PfSave({ who: "ari", save: "will", dc: 15 })),
				then(
					table,
					new PfSaved({
						actor: ALICE,
						id: "ari",
						save: "will",
						natural: 3,
						bonus: 4,
						total: 7,
						dc: 15,
						degree: "failure",
					})
				),
				lastLineIs("Ari saves (will): 3+4 = 7 vs DC 15: failure."),
				seeded(seedRolling([20, 11])),
				when(table, new PfReroll({ who: "ari" })),
				then(
					table,
					new PfRerolled({
						actor: ALICE,
						id: "ari",
						natural: 11,
						total: 15,
						degree: "success",
					})
				),
				state(table, (s) => {
					expect(creatureOf(s, "ari").heroPoints).toBe(1);
					expect(creatureOf(s, "ari").lastCheck).toMatchObject({
						label: "will",
						fortune: true,
						degree: "success",
					});
				})
			)
	);
});

describe("shields", () => {
	effect(
		"Raise a Shield adds its bonus to AC; Shield Block takes Hardness off and splits the rest",
		() =>
			story(
				...encounter,
				...onTurn("ari"),
				as(ALICE),
				seeded(1),
				when(table, new PfRaiseShield({ who: "ari" })),
				then(table, new PfShieldRaised({ actor: ALICE, id: "ari" })),
				lastLineIs("Ari Raises a Shield: +2 AC until their next turn."),
				asGm,
				seeded(seedRolling([20, 9])),
				when(
					table,
					new PfStrike({ who: "gnasher-1", weapon: "jaws", target: "ari" })
				),
				then(
					table,
					strikeOn("Jaws", 9, 9, 20, {
						actor: GM,
						id: "gnasher-1",
						target: "ari",
						degree: "failure",
						notes: ["shield +2"],
					})
				),
				seeded(1),
				when(table, new PfDamage({ who: "ari", amount: "8" })),
				then(table, damaged("ari", "8", 8)),
				as(ALICE),
				when(table, new PfBlock({ who: "ari", damage: 8 })),
				then(
					table,
					new PfShieldBlocked({
						actor: ALICE,
						id: "ari",
						damage: 8,
						prevented: 5,
						shieldTaken: 3,
					})
				),
				lastLineIs(
					"Ari Shield Blocks ↺: Hardness 5 stops 5 of 8; the shield takes 3 (17/20) and so does Ari → 17/20 HP."
				),
				when(table, new PfBlock({ who: "ari", damage: 8 })),
				refused("Ari has used ↺ this round."),
				state(table, (s) => {
					expect(creatureOf(s, "ari").shield).toEqual({ hp: 17, raised: true });
				})
			)
	);

	effect("a shield at its Broken Threshold is broken and lowered", () =>
		story(
			...encounter,
			...onTurn("ari"),
			as(ALICE),
			seeded(1),
			when(table, new PfRaiseShield({ who: "ari" })),
			then(table, new PfShieldRaised({ actor: ALICE, id: "ari" })),
			asGm,
			when(table, new PfDamage({ who: "ari", amount: "15" })),
			then(table, damaged("ari", "15", 15)),
			as(ALICE),
			when(table, new PfBlock({ who: "ari" })),
			then(
				table,
				new PfShieldBlocked({
					actor: ALICE,
					id: "ari",
					damage: 15,
					prevented: 5,
					shieldTaken: 10,
				})
			),
			lastLineHas("the shield takes 10 (10/20, broken)"),
			when(table, new PfRaiseShield({ who: "ari" })),
			refused("Ari's shield is broken.")
		)
	);
});

describe("the end of a turn", () => {
	effect(
		"persistent damage, its DC 15 flat check, then frightened drops by one and end-of-turn conditions go",
		() =>
			story(
				...encounter,
				given(
					table,
					new PfConditionSet({
						actor: GM,
						id: "ari",
						name: "frightened",
						value: 2,
					}),
					new PfConditionSet({
						actor: GM,
						id: "ari",
						name: "off-guard",
						expires: { at: "eot", of: "ari" },
					}),
					new PfPersistentSet({
						actor: GM,
						id: "ari",
						damageType: "fire",
						dice: "1d6",
					})
				),
				...onTurn("ari"),
				as(ALICE),
				seeded(seedRolling([6, 4], [20, 16])),
				when(table, new PfEndTurn()),
				then(
					table,
					new PfTurnEnded({
						actor: ALICE,
						id: "ari",
						persistent: [
							{
								damageType: "fire",
								dice: "1d6",
								rolls: [4],
								total: 4,
								applied: 4,
								natural: 16,
								ended: true,
							},
						],
					}),
					new PfTurnStarted({ actor: ALICE, id: "bryn", round: 1, actions: 3 })
				),
				state(table, (s) => {
					const ari = creatureOf(s, "ari");

					expect(ari.hp).toBe(16);
					expect(ari.persistent).toEqual([]);
					expect(ari.conditions).toEqual([{ name: "frightened", value: 1 }]);
					expect(feedOf(s).at(-2)).toBe(
						"Ari's turn ends. persistent fire 1d6 [4] = 4 → Ari 16/20 HP; flat check 16, it ends."
					);
				})
			)
	);
});

describe("maneuvers", () => {
	effect(
		"Trip and Grapple roll Athletics against a DC, take MAP, and set conditions",
		() =>
			story(
				...encounter,
				...onTurn("ari"),
				as(ALICE),
				seeded(seedRolling([20, 10])),
				when(table, new PfTrip({ who: "ari", target: "gnasher-1" })),
				then(
					table,
					new PfManeuvered({
						actor: ALICE,
						id: "ari",
						target: "gnasher-1",
						maneuver: "trip",
						skill: "athletics",
						natural: 10,
						bonus: 9,
						total: 19,
						dc: 15,
						degree: "success",
						map: 0,
					})
				),
				lastLineIs(
					"Ari Trips Bog Gnasher 1: athletics 10+9 = 19 vs DC 15: success. Bog Gnasher 1 falls prone."
				),
				seeded(seedRolling([20, 12])),
				when(table, new PfGrapple({ who: "ari", target: "gnasher-1" })),
				then(
					table,
					new PfManeuvered({
						actor: ALICE,
						id: "ari",
						target: "gnasher-1",
						maneuver: "grapple",
						skill: "athletics",
						natural: 12,
						bonus: 4,
						total: 16,
						dc: 17,
						degree: "failure",
						map: -5,
					})
				),
				lastLineIs(
					"Ari Grapples Bog Gnasher 1: athletics 12+4 = 16 vs DC 17 (MAP -5): failure."
				),
				seeded(seedRolling([20, 19])),
				when(table, new PfDemoralize({ who: "ari", target: "gnasher-1" })),
				then(
					table,
					new PfManeuvered({
						actor: ALICE,
						id: "ari",
						target: "gnasher-1",
						maneuver: "demoralize",
						skill: "intimidation",
						natural: 19,
						bonus: 5,
						total: 24,
						dc: 14,
						degree: "crit-success",
						map: 0,
					})
				),
				lastLineIs(
					"Ari Demoralizes Bog Gnasher 1: intimidation 19+5 = 24 vs DC 14: critical success. Bog Gnasher 1 is frightened 2."
				),
				state(table, (s) => {
					expect(
						creatureOf(s, "gnasher-1").conditions.map((c) => [c.name, c.value])
					).toEqual([
						["prone", undefined],
						["frightened", 2],
					]);
				})
			)
	);
});

const sparked = (
	target: string,
	natural: number,
	result: "success" | "failure",
	total: number
) => ({
	target,
	natural,
	bonus: 5,
	total: natural + 5,
	dc: 17,
	degree: result,
	damage: {
		expression: `2d4 (basic, ${result})`,
		rolls: [3, 2],
		total,
		damageType: "electricity",
		applied: total,
		critical: false,
	},
});

describe("spells", () => {
	effect("a cantrip's basic save, one damage roll for every target", () =>
		story(
			...encounter,
			...onTurn("bryn"),
			as(BOB),
			seeded(seedRolling([4, 3], [4, 2], [20, 10], [20, 18])),
			when(
				table,
				new PfCastSpell({
					who: "bryn",
					spell: "spark",
					targets: ["gnasher-1", "gnasher-2"],
				})
			),
			then(
				table,
				new PfCast({
					actor: BOB,
					id: "bryn",
					spell: "Spark Arc",
					rank: 0,
					actions: 2,
					slot: false,
					attack: false,
					map: 0,
					results: [
						sparked("gnasher-1", 10, "failure", 5),
						sparked("gnasher-2", 18, "success", 2),
					],
				})
			),
			lastLineIs(
				"Bryn casts Spark Arc, ◆◆: Bog Gnasher 1 10+5 = 15 vs DC 17: failure, 2d4 (basic, failure) [3, 2] = 5 electricity → Bog Gnasher 1 15/20 HP; Bog Gnasher 2 18+5 = 23 vs DC 17: success, 2d4 (basic, success) [3, 2] = 2 electricity → Bog Gnasher 2 18/20 HP."
			),
			when(
				table,
				new PfCastSpell({
					who: "bryn",
					spell: "searing",
					targets: ["gnasher-1"],
				})
			),
			refused("Bryn has 1 action left; that takes 2 actions.")
		)
	);

	effect(
		"a spell attack against AC spends a slot, and weakness adds to the damage",
		() =>
			story(
				...encounter,
				...onTurn("bryn"),
				as(BOB),
				seeded(seedRolling([20, 11], [6, 6], [6, 1])),
				when(
					table,
					new PfCastSpell({
						who: "bryn",
						spell: "searing",
						targets: ["gnasher-1"],
					})
				),
				then(
					table,
					new PfCast({
						actor: BOB,
						id: "bryn",
						spell: "Searing Bolt",
						rank: 1,
						actions: 2,
						slot: true,
						attack: true,
						map: 0,
						results: [
							{
								target: "gnasher-1",
								natural: 11,
								bonus: 7,
								total: 18,
								dc: 16,
								degree: "success",
								damage: {
									expression: "2d6",
									rolls: [6, 1],
									total: 7,
									damageType: "fire",
									applied: 10,
									critical: false,
								},
							},
						],
					})
				),
				state(table, (s) => {
					expect(creatureOf(s, "bryn").slotsUsed).toEqual([
						{ rank: 1, used: 1 },
					]);
					expect(creatureOf(s, "gnasher-1").hp).toBe(10);
					expect(s.pf.combat?.turn).toMatchObject({ actions: 1, attacks: 1 });
				}),
				asGm,
				when(
					table,
					new PfCastSpell({ who: "bryn", spell: "mending", targets: [] })
				),
				refused("Bryn has no rank 1 spell slots left.")
			)
	);
});

describe("size on the grid", () => {
	effect("a Large creature fills 2×2; a Tiny one shares a square", () =>
		story(
			...party,
			asGm,
			seeded(1),
			when(
				table,
				new PfAddCreatures({ monster: "lumberer", count: 1, sheet: LUMBERER })
			),
			then(
				table,
				new PfCreaturesAdded({
					actor: GM,
					block: LUMBERER,
					creatures: [{ id: "lumberer", name: "Hill Lumberer" }],
				})
			),
			when(
				table,
				new PfAddCreatures({ monster: "sprite", count: 1, sheet: SPRITE })
			),
			then(
				table,
				new PfCreaturesAdded({
					actor: GM,
					block: SPRITE,
					creatures: [{ id: "sprite", name: "Ash Sprite" }],
				})
			),
			when(table, new PfPlace({ who: "lumberer", to: { x: 1, y: 1 } })),
			refused("b2 is taken by Ari."),
			when(table, new PfPlace({ who: "lumberer", to: { x: 5, y: 0 } })),
			then(table, placed("lumberer", 5, 0)),
			when(table, new PfPlace({ who: "ari", to: { x: 6, y: 1 } })),
			refused("g2 is taken by Hill Lumberer."),
			when(table, new PfPlace({ who: "sprite", to: { x: 6, y: 1 } })),
			then(table, placed("sprite", 6, 1)),
			state(table, (s) => {
				const map = must(mapOf(s, GM, "pf2e"), "a map");

				expect(
					map.tokens
						.filter((t) => t.id === "lumberer" || t.id === "sprite")
						.map((t) => [t.id, t.x, t.y, t.footprint, t.tiny])
				).toEqual([
					["lumberer", 5, 0, 2, undefined],
					["sprite", 6, 1, undefined, true],
				]);
				expect(sheetOf(s, "lumberer", "pf2e")).toContain(
					"Melee ◆ Club +11 (reach 10), 1d10+7 bludgeoning"
				);
			})
		)
	);
});

describe("what a seat sees", () => {
	effect("the band, the mouse's menu, the prep panel and the sheet", () =>
		story(
			...encounter,
			...onTurn("ari"),
			state(table, (s) => {
				const band = must(bandOf(s, ALICE, "pf2e"), "a band");

				expect(band.title).toBe(" round 1 · Ari's turn ");
				expect(band.combatants.map((c) => c.id)).toEqual(ORDER);
				expect(band.combatants.find((c) => c.id === "ari")).toMatchObject({
					stamina: 20,
					max: 20,
					mine: true,
					resource: "hero points 1",
					actions: { left: 3, max: 3, reaction: true },
				});
				expect(
					band.combatants.find((c) => c.id === "ari")?.penalty
				).toBeUndefined();

				expect(actionsOf(s, ALICE, "pf2e", "ari")?.map((a) => a.line)).toEqual([
					"/strike ari longsword",
					"/strike ari dagger",
					"/stride ari",
					"/step ari",
					"/shield ari",
					"/demoralize ari",
					"/grapple ari",
					"/trip ari",
					"/shove ari",
					"/delay",
					"/done",
				]);
				expect(actionsOf(s, ALICE, "pf2e", "gnasher-1")).toBeUndefined();
				expect(
					actionsOf(s, BOB, "pf2e", "bryn")?.filter((a) =>
						a.label.startsWith("Cast")
					)
				).toEqual([
					{
						label: "Cast Spark Arc",
						pick: "targets",
						line: "/cast bryn spark arc",
					},
					{
						label: "Cast Searing Bolt",
						pick: "targets",
						line: "/cast bryn searing bolt",
					},
					{
						label: "Cast Mending Light",
						pick: "none",
						line: "/cast bryn mending light",
					},
				]);

				const prep = prepOf(
					s,
					{
						heroes: [
							{ id: "ari", name: "Ari" },
							{ id: "cade", name: "Cade" },
						],
						monsters: [{ id: "gnasher", name: "Bog Gnasher" }],
						maps: [],
					},
					"pf2e"
				);

				expect(prep.steps).toEqual([
					{ label: "map", done: true },
					{ label: "party", done: true },
					{ label: "foes", done: true },
					{ label: "extreme 80 XP", done: true },
				]);
				expect(prep.sections.map((x) => x.title)).toEqual([
					"party",
					"foes",
					"encounter",
				]);
				expect(prep.sections[0]?.items.map((i) => i.line)).toEqual([
					"/pc cade",
				]);
				expect(prep.sections[1]?.items.map((i) => i.line)).toEqual([
					"/add gnasher",
					"/add gnasher elite",
					"/add gnasher weak",
				]);
				expect(prep.sections[2]?.note).toBe(
					"extreme: 80 XP for 2 PCs at level 1 (trivial 20, low 20, moderate 40, severe 60, extreme 80)"
				);
				expect(prep.start).toEqual({ note: "round 1" });

				expect(sheetOf(s, "ari", "pf2e")).toBe(
					[
						"Ari · human fighter 1 · medium",
						"Perception +7; Skills athletics +9, intimidation +5, acrobatics +7",
						"Str +4, Dex +2, Con +2, Int +0, Wis +1, Cha +0",
						"AC 18; Fort +7, Ref +7, Will +5; class DC 19",
						"HP 20/20",
						"Shield +2 (Hardness 5, HP 20/20, BT 10)",
						"Speed 25 ft",
						"Melee ◆ Longsword +9 (versatile p), 1d8+4 slashing",
						"Melee ◆ Dagger +9 (agile, finesse), 1d4+4 piercing",
						"Hero Points 1",
					].join("\n")
				);
			})
		)
	);
});

const shieldUp = [
	as(ALICE),
	seeded(1),
	when(table, new PfRaiseShield({ who: "ari" })),
	then(table, new PfShieldRaised({ actor: ALICE, id: "ari" })),
] as const;

const blocked = (damage: number, prevented: number) =>
	new PfShieldBlocked({
		actor: ALICE,
		id: "ari",
		damage,
		prevented,
		shieldTaken: damage - prevented,
	});

describe("Shield Block needs a hit", () => {
	effect(
		"out of an encounter: nothing to block until a hit lands, and one block per hit",
		() =>
			story(
				...party,
				...shieldUp,
				when(table, new PfBlock({ who: "ari" })),
				refused("Ari hasn't taken a hit to block."),
				asGm,
				when(table, new PfDamage({ who: "ari", amount: "8" })),
				then(table, damaged("ari", "8", 8)),
				as(ALICE),
				when(table, new PfBlock({ who: "ari", damage: 20 })),
				refused("Ari took 8 from that hit; block up to 8."),
				when(table, new PfBlock({ who: "ari" })),
				then(table, blocked(8, 5)),
				state(table, (s) => {
					expect(creatureOf(s, "ari").hp).toBe(17);
				}),
				when(table, new PfBlock({ who: "ari" })),
				refused("Ari has blocked that hit already."),
				state(table, (s) => {
					expect(creatureOf(s, "ari")).toMatchObject({
						hp: 17,
						shield: { hp: 17, raised: true },
					});
				})
			)
	);

	effect(
		"in an encounter: refused with no hit; 3 HP taking 10 behind Hardness 5 still falls, dying",
		() =>
			story(
				...encounter,
				...onTurn("ari"),
				...shieldUp,
				when(table, new PfBlock({ who: "ari" })),
				refused("Ari hasn't taken a hit to block."),
				asGm,
				when(table, new PfDamage({ who: "ari", amount: "17" })),
				then(table, damaged("ari", "17", 17)),
				when(table, new PfDamage({ who: "ari", amount: "10" })),
				then(table, damaged("ari", "10", 10)),
				as(ALICE),
				when(table, new PfBlock({ who: "ari" })),
				then(table, blocked(10, 5)),
				state(table, (s) => {
					const ari = creatureOf(s, "ari");

					expect([ari.hp, ari.temp, ari.dying, ari.wounded]).toEqual([
						0, 0, 1, 0,
					]);
					expect(ari.conditions.map((c) => c.name)).toContain("unconscious");
					expect(ari.shield).toEqual({ hp: 15, raised: true });
					expect(ari.lastHit?.blocked).toBe(true);
					expect(
						bandOf(s, ALICE, "pf2e")?.combatants.find((c) => c.id === "ari")
							?.health
					).toBe("dying");
				}),
				lastLineIs(
					"Ari Shield Blocks ↺: Hardness 5 stops 5 of 10; the shield takes 5 (15/20) and so does Ari → 0/20 HP, dying 1."
				)
			)
	);

	effect(
		"3 HP taking 7 behind Hardness 5 stays standing at 1 HP, and gains no wounded",
		() =>
			story(
				...encounter,
				...onTurn("ari"),
				...shieldUp,
				asGm,
				when(table, new PfDamage({ who: "ari", amount: "17" })),
				then(table, damaged("ari", "17", 17)),
				when(table, new PfDamage({ who: "ari", amount: "7" })),
				then(table, damaged("ari", "7", 7)),
				state(table, (s) => {
					expect(creatureOf(s, "ari").dying).toBe(1);
				}),
				as(ALICE),
				when(table, new PfBlock({ who: "ari" })),
				then(table, blocked(7, 5)),
				state(table, (s) => {
					const ari = creatureOf(s, "ari");

					expect([ari.hp, ari.dying, ari.wounded, ari.dead]).toEqual([
						1,
						0,
						0,
						false,
					]);
					expect(ari.conditions.map((c) => c.name)).not.toContain(
						"unconscious"
					);
				})
			)
	);

	effect("spent temporary HP never comes back as real HP", () =>
		story(
			...encounter,
			given(
				table,
				damaged("ari", "5", 5),
				new PfTempSet({ actor: GM, id: "ari", temp: 4 })
			),
			...onTurn("ari"),
			...shieldUp,
			asGm,
			when(table, new PfDamage({ who: "ari", amount: "6" })),
			then(table, damaged("ari", "6", 6)),
			state(table, (s) => {
				expect(creatureOf(s, "ari")).toMatchObject({ hp: 13, temp: 0 });
			}),
			as(ALICE),
			when(table, new PfBlock({ who: "ari" })),
			then(table, blocked(6, 5)),
			state(table, (s) => {
				expect(creatureOf(s, "ari")).toMatchObject({ hp: 15, temp: 3 });
			})
		)
	);
});

describe("Delay", () => {
	effect("is refused once the turn has been used", () =>
		story(
			...encounter,
			...onTurn("ari"),
			...shieldUp,
			when(table, new PfDelay()),
			refused(
				"Ari has acted this turn; Delay comes at the start of a turn, before anything else."
			)
		)
	);

	effect(
		"runs the end of the delayed turn once, after the creature joins",
		() =>
			story(
				...encounter,
				given(
					table,
					new PfConditionSet({
						actor: GM,
						id: "ari",
						name: "frightened",
						value: 2,
					})
				),
				...onTurn("ari"),
				seeded(1),
				as(ALICE),
				when(table, new PfDelay()),
				then(
					table,
					new PfDelayed({ actor: ALICE, id: "ari" }),
					new PfTurnStarted({ actor: ALICE, id: "bryn", round: 1, actions: 3 })
				),
				state(table, (s) => {
					expect(creatureOf(s, "ari").conditions).toEqual([
						{ name: "frightened", value: 2 },
					]);
				}),
				when(table, new PfJoin({ who: "ari" })),
				then(table, new PfRejoined({ actor: ALICE, id: "ari", after: "bryn" })),
				as(BOB),
				when(table, new PfEndTurn()),
				then(
					table,
					new PfTurnEnded({ actor: BOB, id: "bryn", persistent: [] }),
					new PfTurnStarted({ actor: BOB, id: "ari", round: 1, actions: 3 })
				),
				as(ALICE),
				when(table, new PfEndTurn()),
				then(
					table,
					new PfTurnEnded({ actor: ALICE, id: "ari", persistent: [] }),
					new PfTurnStarted({
						actor: ALICE,
						id: "gnasher-2",
						round: 2,
						actions: 3,
					})
				),
				state(table, (s) => {
					expect(creatureOf(s, "ari").conditions).toEqual([
						{ name: "frightened", value: 1 },
					]);
				})
			)
	);

	effect(
		"a delaying PC knocked out goes back into the order before the turn, once",
		() =>
			story(
				...encounter,
				...onTurn("ari"),
				seeded(1),
				as(ALICE),
				when(table, new PfDelay()),
				then(
					table,
					new PfDelayed({ actor: ALICE, id: "ari" }),
					new PfTurnStarted({ actor: ALICE, id: "bryn", round: 1, actions: 3 })
				),
				asGm,
				when(table, new PfDamage({ who: "ari", amount: "20" })),
				then(table, damaged("ari", "20", 20)),
				lastLineIs(
					"Damage: 20 = 20 → Ari 0 HP, dying 1, initiative moves before this turn."
				),
				state(table, (s) => {
					const order = s.pf.combat?.order ?? [];

					expect(order).toEqual(["gnasher-2", "gnasher-1", "ari", "bryn"]);
					expect(new Set(order).size).toBe(order.length);
					expect(s.pf.combat?.delayed).toEqual([]);
				}),
				as(ALICE),
				when(table, new PfJoin({ who: "ari" })),
				refused("Ari isn't delaying.")
			)
	);
});

const loneGnasher = new PfCreaturesAdded({
	actor: GM,
	block: GNASHER,
	creatures: [{ id: "gnasher-1", name: "Bog Gnasher 1" }],
});

describe("a lone survivor", () => {
	effect("takes every round's turn, and has nobody to Delay behind", () =>
		story(
			given(table, ariJoins, loneGnasher),
			given(table, aliceTakesAri),
			given(
				table,
				rolledInit("ari", 20),
				rolledInit("gnasher-1", 5),
				new PfCombatStarted({ actor: GM, order: ["ari", "gnasher-1"] }),
				turnOf("ari"),
				damaged("gnasher-1", "20", 20)
			),
			advance("1 second"),
			seeded(1),
			as(ALICE),
			when(table, new PfDelay()),
			refused("Nobody else is in the initiative order to go before Ari."),
			when(table, new PfEndTurn()),
			then(
				table,
				new PfTurnEnded({ actor: ALICE, id: "ari", persistent: [] }),
				new PfTurnStarted({ actor: ALICE, id: "ari", round: 2, actions: 3 })
			),
			when(table, new PfEndTurn()),
			then(
				table,
				new PfTurnEnded({ actor: ALICE, id: "ari", persistent: [] }),
				new PfTurnStarted({ actor: ALICE, id: "ari", round: 3, actions: 3 })
			),
			state(table, (s) => {
				expect(s.pf.combat).toMatchObject({ round: 3, turn: { id: "ari" } });
			})
		)
	);
});

const SWEEPER: PfSheet = {
	...ARI,
	strikes: [
		...ARI.strikes,
		{
			name: "Scythe",
			bonus: 9,
			damage: "1d10+4",
			damageType: "slashing",
			traits: ["sweep", "reach"],
		},
	],
};

const sweeperJoins = new PfPcJoined({ actor: GM, sheet: SWEEPER });

describe("weapon traits", () => {
	test("a bare reach trait is 10 ft; reach with a number is that many feet", () => {
		const glaive = {
			name: "Glaive",
			bonus: 9,
			damage: "1d8+4",
			damageType: "slashing",
		};

		expect(reachOfStrike({ ...glaive, traits: ["reach"] })).toBe(10);
		expect(reachOfStrike({ ...glaive, traits: ["reach 15 ft"] })).toBe(15);
		expect(reachOfStrike(glaive)).toBe(5);
	});

	effect("a bare reach trait takes two squares diagonally", () =>
		story(
			...encounter,
			given(table, sweeperJoins, placed("gnasher-2", 3, 4)),
			...onTurn("ari"),
			as(ALICE),
			seeded(1),
			when(
				table,
				new PfStrike({ who: "ari", weapon: "long", target: "gnasher-2" })
			),
			refused("Bog Gnasher 2 is 15 ft away; Ari's Longsword reaches 5 ft."),
			seeded(seedRolling([20, 1])),
			when(
				table,
				new PfStrike({ who: "ari", weapon: "scythe", target: "gnasher-2" })
			),
			then(
				table,
				strikeOn("Scythe", 1, 9, 16, {
					target: "gnasher-2",
					degree: "crit-failure",
				})
			)
		)
	);

	effect("sweep: +1 against a second target, and back on the first", () =>
		story(
			...encounter,
			given(table, sweeperJoins, placed("gnasher-2", 1, 1)),
			...onTurn("ari"),
			as(ALICE),
			seeded(seedRolling([20, 1])),
			when(
				table,
				new PfStrike({ who: "ari", weapon: "scythe", target: "gnasher-1" })
			),
			then(
				table,
				strikeOn("Scythe", 1, 9, 14, {
					degree: "crit-failure",
					notes: ["off-guard (flanked with Bryn) -2"],
				})
			),
			seeded(seedRolling([20, 1])),
			when(
				table,
				new PfStrike({ who: "ari", weapon: "scythe", target: "gnasher-2" })
			),
			then(
				table,
				strikeOn("Scythe", 1, 5, 16, {
					target: "gnasher-2",
					map: -5,
					degree: "crit-failure",
					notes: ["sweep +1, MAP -5"],
				})
			),
			seeded(seedRolling([20, 1])),
			when(
				table,
				new PfStrike({ who: "ari", weapon: "scythe", target: "gnasher-1" })
			),
			then(
				table,
				strikeOn("Scythe", 1, 0, 14, {
					map: -10,
					degree: "crit-failure",
					notes: ["sweep +1, MAP -10", "off-guard (flanked with Bryn) -2"],
				})
			)
		)
	);
});

describe("Step and Crawl", () => {
	effect(
		"a Step goes one square diagonally even when the next diagonal is 10 ft",
		() =>
			story(
				given(table, ariJoins, gnashers),
				given(table, aliceTakesAri),
				given(
					table,
					new PfMapLoaded({ actor: GM, id: "bog", ...BOG }),
					placed("ari", 0, 1),
					placed("gnasher-1", 9, 0),
					placed("gnasher-2", 9, 2),
					rolledInit("ari", 20),
					rolledInit("gnasher-1", 2),
					rolledInit("gnasher-2", 1),
					new PfCombatStarted({
						actor: GM,
						order: ["ari", "gnasher-1", "gnasher-2"],
					})
				),
				...onTurn("ari"),
				seeded(1),
				as(ALICE),
				when(table, new PfStride({ who: "ari", to: { x: 1, y: 2 } })),
				then(
					table,
					new PfMoved({
						actor: ALICE,
						id: "ari",
						to: { x: 1, y: 2 },
						feet: 5,
						kind: "stride",
						parity: 1,
					})
				),
				when(table, new PfStep({ who: "ari", to: { x: 2, y: 3 } })),
				then(
					table,
					new PfMoved({
						actor: ALICE,
						id: "ari",
						to: { x: 2, y: 3 },
						feet: 5,
						kind: "step",
						parity: 0,
					})
				)
			)
	);
});

const { shield: _shield, ...UNSHIELDED } = ARI;

describe("fatigued and a reloaded sheet", () => {
	effect(
		"fatigued takes 1 from AC; a reloaded sheet with a shield brings it whole",
		() =>
			story(
				given(
					table,
					new PfPcJoined({ actor: GM, sheet: UNSHIELDED }),
					gnashers
				),
				given(
					table,
					new PfConditionSet({ actor: GM, id: "ari", name: "fatigued" })
				),
				advance("1 second"),
				seeded(seedRolling([20, 2])),
				asGm,
				when(
					table,
					new PfStrike({ who: "gnasher-1", weapon: "jaws", target: "ari" })
				),
				then(
					table,
					strikeOn("Jaws", 2, 9, 17, {
						actor: GM,
						id: "gnasher-1",
						target: "ari",
						degree: "failure",
						notes: ["fatigued -1"],
					})
				),
				state(table, (s) => {
					expect(creatureOf(s, "ari").shield).toBeUndefined();
				}),
				given(table, ariJoins),
				state(table, (s) => {
					expect(creatureOf(s, "ari").shield).toEqual({
						hp: 20,
						raised: false,
					});
				})
			)
	);
});

describe("undo and redo", () => {
	effect("over a Strike and its Hero Point reroll", () =>
		story(
			...encounter,
			...onTurn("ari"),
			as(ALICE),
			seeded(seedRolling([20, 2])),
			when(
				table,
				new PfStrike({ who: "ari", weapon: "long", target: "gnasher-1" })
			),
			then(
				table,
				strikeOn("Longsword", 2, 9, 14, {
					degree: "failure",
					notes: ["off-guard (flanked with Bryn) -2"],
				})
			),
			advance("1 second"),
			seeded(seedRolling([20, 10], [8, 4])),
			when(table, new PfReroll({ who: "ari" })),
			then(
				table,
				new PfRerolled({
					actor: ALICE,
					id: "ari",
					natural: 10,
					total: 19,
					degree: "success",
					damage: {
						expression: "1d8+4",
						rolls: [4],
						total: 8,
						damageType: "slashing",
						applied: 8,
						critical: false,
					},
				})
			),
			asGm,
			when(table, new Undo({})),
			then(
				table,
				new Retracted({
					actor: GM,
					seqs: [18],
					undone: [
						"Ari spends a Hero Point to reroll Longsword: 10+9 = 19 vs AC 14: success, and keeps it. 1d8+4 [4] = 8 slashing → Bog Gnasher 1 12/20 HP.",
					],
				})
			),
			when(table, new Undo({})),
			then(
				table,
				new Retracted({
					actor: GM,
					seqs: [17],
					undone: [
						"Ari Strikes Bog Gnasher 1 with Longsword: 2+9 = 11 vs AC 14 (off-guard (flanked with Bryn) -2): failure.",
					],
				})
			),
			state(table, (s) => {
				expect(creatureOf(s, "gnasher-1").hp).toBe(20);
				expect(creatureOf(s, "ari").heroPoints).toBe(1);
				expect(creatureOf(s, "ari").lastCheck).toBeUndefined();
				expect(s.pf.combat?.turn).toMatchObject({ actions: 3, attacks: 0 });
			}),
			when(table, new Redo({})),
			then(table, new Redone({ actor: GM, seqs: [17] })),
			when(table, new Redo({})),
			then(table, new Redone({ actor: GM, seqs: [18] })),
			state(table, (s) => {
				expect(creatureOf(s, "gnasher-1").hp).toBe(12);
				expect(creatureOf(s, "ari").heroPoints).toBe(0);
				expect(s.pf.combat?.turn).toMatchObject({ actions: 2, attacks: 1 });
			})
		)
	);

	effect(
		"over a Shield Block: the hit comes back to block, and only once",
		() =>
			story(
				...encounter,
				...onTurn("ari"),
				...shieldUp,
				asGm,
				when(table, new PfDamage({ who: "ari", amount: "8" })),
				then(table, damaged("ari", "8", 8)),
				as(ALICE),
				when(table, new PfBlock({ who: "ari" })),
				then(table, blocked(8, 5)),
				asGm,
				when(table, new Undo({})),
				then(
					table,
					new Retracted({
						actor: GM,
						seqs: [19],
						undone: [
							"Ari Shield Blocks ↺: Hardness 5 stops 5 of 8; the shield takes 3 (17/20) and so does Ari → 17/20 HP.",
						],
					})
				),
				state(table, (s) => {
					const ari = creatureOf(s, "ari");

					expect([ari.hp, ari.shield?.hp, ari.lastHit?.blocked]).toEqual([
						12,
						20,
						false,
					]);
					expect(s.pf.combat?.reacted).toEqual([]);
				}),
				when(table, new Redo({})),
				then(table, new Redone({ actor: GM, seqs: [19] })),
				state(table, (s) => {
					const ari = creatureOf(s, "ari");

					expect([ari.hp, ari.shield?.hp, ari.lastHit?.blocked]).toEqual([
						17,
						17,
						true,
					]);
				}),
				as(ALICE),
				when(table, new PfBlock({ who: "ari" })),
				refused("Ari has used ↺ this round.")
			)
	);

	effect("over a Delay: the turn comes back whole", () =>
		story(
			...encounter,
			...onTurn("ari"),
			seeded(1),
			as(ALICE),
			when(table, new PfDelay()),
			then(
				table,
				new PfDelayed({ actor: ALICE, id: "ari" }),
				new PfTurnStarted({ actor: ALICE, id: "bryn", round: 1, actions: 3 })
			),
			asGm,
			when(table, new Undo({})),
			then(
				table,
				new Retracted({
					actor: GM,
					seqs: [17, 18],
					undone: ["Ari delays.", "Round 1 · Bryn's turn: ◆◆◆ ↺."],
				})
			),
			state(table, (s) => {
				expect(s.pf.combat).toMatchObject({
					order: ORDER,
					delayed: [],
					turn: { id: "ari", actions: 3 },
				});
			}),
			when(table, new Redo({})),
			then(table, new Redone({ actor: GM, seqs: [17, 18] })),
			state(table, (s) => {
				expect(s.pf.combat).toMatchObject({
					order: ["gnasher-2", "gnasher-1", "bryn"],
					delayed: ["ari"],
					turn: { id: "bryn" },
				});
			})
		)
	);
});
