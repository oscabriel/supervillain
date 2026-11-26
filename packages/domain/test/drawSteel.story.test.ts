import { describe, expect } from "bun:test";

import { Story } from "@alchemy.run/domain/Story";

import {
	DsAddCreatures,
	DsCondition,
	DsDamage,
	DsEndCombat,
	DsEndTurn,
	DsFreeStrike,
	DsHeal,
	DsJoinHero,
	DsLoadMap,
	DsMalice,
	DsMeasure,
	DsMove,
	DsNextRound,
	DsPlace,
	DsPlay,
	DsPowerRoll,
	DsPull,
	DsPush,
	DsRecover,
	DsResource,
	DsRest,
	DsSave,
	DsSetFirst,
	DsSetTemp,
	DsSlide,
	DsStartCombat,
	DsSurge,
	DsTakeTurn,
	DsToken,
	DsUnplay,
	DsVictory,
} from "../src/commands/drawSteel.ts";
import {
	DsAbilityUsed,
	DsBled,
	DsCombatEnded,
	DsCombatStarted,
	DsConditionRemoved,
	DsConditionSet,
	DsCreaturesAdded,
	DsDamaged,
	DsFirstSet,
	DsForceMoved,
	DsHealed,
	DsHeroClaimed,
	DsHeroJoined,
	DsHeroReleased,
	DsMaliceChanged,
	DsMapCleared,
	DsMapLoaded,
	DsMeasured,
	DsMoved,
	DsPlaced,
	DsPowerRolled,
	DsRecovered,
	DsResourceChanged,
	DsRested,
	DsRoundStarted,
	DsSaved,
	DsSurgesChanged,
	DsTempSet,
	DsTokensChanged,
	DsTokensReset,
	DsTurnEnded,
	DsTurnStarted,
	DsVictoriesChanged,
} from "../src/events/drawSteel.ts";
import { Refused } from "../src/Refused.rejection.ts";
import type { HeroSheet, StatBlock } from "../src/rules/drawSteel/sheets.ts";
import type { ConditionName } from "../src/rules/drawSteel/state.ts";
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
	FIELD,
	GM,
	GOBLIN,
	IMP,
	KOR,
	RUNNER,
	seeded,
	seedRolling,
	story,
	table,
	VEX,
	openDoor,
} from "./fixtures.ts";

const { advance, given, rejected, state, then, when } = Story;

const feedOf = (s: TableState): ReadonlyArray<string> =>
	feedLines(s, tableLabel(s, "draw-steel")).map(plainText);

const lastLines = (...lines: ReadonlyArray<string>) =>
	state(table, (s) => {
		expect(feedOf(s).slice(-lines.length)).toEqual([...lines]);
	});

const refused = (message: string) => rejected(new Refused({ message }));

const asGm = as(GM);

const vexJoins = new DsHeroJoined({ actor: GM, sheet: VEX });

const korJoins = new DsHeroJoined({ actor: GM, sheet: KOR });

const aliceTakesVex = new DsHeroClaimed({
	actor: ALICE,
	hero: "vex",
	player: ALICE,
});

const bobTakesKor = new DsHeroClaimed({ actor: BOB, hero: "kor", player: BOB });

const goblins = new DsCreaturesAdded({
	actor: GM,
	block: GOBLIN,
	creatures: [
		{ id: "goblin-warrior-1", name: "Goblin Warrior 1" },
		{ id: "goblin-warrior-2", name: "Goblin Warrior 2" },
	],
});

const runners = new DsCreaturesAdded({
	actor: GM,
	block: RUNNER,
	creatures: [{ id: "goblin-runner-a", name: "Goblin Runner A", squad: 5 }],
});

const party = [
	given(table, vexJoins),
	advance("1 second"),
	given(table, korJoins),
	advance("1 second"),
	given(table, aliceTakesVex),
	advance("1 second"),
	given(table, bobTakesKor),
	advance("1 second"),
] as const;

const combatStartedOn = (roll: number) =>
	new DsCombatStarted({
		actor: GM,
		roll,
		gains: { vex: 2, kor: 2 },
		malice: { victories: 2, heroes: 2, round: 1 },
	});

const combatStarted = combatStartedOn(10);

describe("the party", () => {
	effect(
		"heroes join from the sheets the host loads, and players take them",
		() =>
			story(
				openDoor,
				seeded(1),
				asGm,
				when(table, new DsJoinHero({ hero: "vex" })),
				refused("No hero sheet for 'vex' was loaded."),
				when(table, new DsJoinHero({ hero: "vex", sheet: VEX })),
				then(table, vexJoins),
				when(table, new DsJoinHero({ hero: "kor", sheet: KOR })),
				then(table, korJoins),
				as(ALICE),
				when(table, new DsPlay({ hero: "vex", seated: [ALICE] })),
				then(table, aliceTakesVex),
				as(BOB),
				when(table, new DsPlay({ hero: "vex", seated: [ALICE, BOB] })),
				refused("Vex is played by abcdefgh."),
				when(table, new DsPlay({ hero: "kor", seated: [ALICE, BOB] })),
				then(table, bobTakesKor),
				when(table, new DsUnplay({})),
				then(table, new DsHeroReleased({ actor: BOB, hero: "kor" })),
				lastLines(
					"Vex joins the party: Censor 1, 21 Stamina.",
					"Kor joins the party: Fury 1, 24 Stamina.",
					"abcdefgh takes Vex.",
					"Zyxwvuts takes Kor.",
					"Zyxwvuts stops playing Kor."
				),
				state(table, (s) => {
					expect(tableLabel(s, "draw-steel")(ALICE)).toBe("abcdefgh (Vex)");
					expect(s.ds.heroes.map((h) => [h.id, h.player])).toEqual([
						["vex", ALICE],
						["kor", undefined],
					]);
				})
			)
	);

	effect("a sheet the table can't draw is refused, naming the problem", () =>
		story(
			seeded(1),
			asGm,
			when(
				table,
				new DsJoinHero({ hero: "vex", sheet: { ...VEX, id: "Not An Id" } })
			),
			refused(
				"'Not An Id' can't be used: id must be lowercase letters, digits and dashes."
			),
			when(
				table,
				new DsJoinHero({ hero: "vex", sheet: { ...VEX, stamina: 0 } })
			),
			refused("'vex' can't be used: stamina must be at least 1."),
			then(table)
		)
	);
});

describe("creatures", () => {
	effect("come numbered from one stat block, and minions in squads", () =>
		story(
			openDoor,
			seeded(1),
			asGm,
			when(
				table,
				new DsAddCreatures({
					monster: "goblin-warrior",
					count: 2,
					sheet: GOBLIN,
				})
			),
			then(table, goblins),
			when(
				table,
				new DsAddCreatures({
					monster: "goblin-runner",
					count: 5,
					sheet: RUNNER,
				})
			),
			then(table, runners),
			when(table, new DsAddCreatures({ monster: "ember-imp", count: 1 })),
			refused("No stat block for 'ember-imp' was loaded."),
			lastLines(
				"Goblin Warrior 1 and Goblin Warrior 2 join the fight.",
				"Goblin Runner A (5 minions) joins the fight."
			),
			state(table, (s) => {
				expect(s.ds.creatures.map((c) => [c.id, c.stamina, c.squad])).toEqual([
					["goblin-warrior-1", 15, undefined],
					["goblin-warrior-2", 15, undefined],
					["goblin-runner-a", 25, 5],
				]);
			}),
			as(ALICE),
			when(
				table,
				new DsAddCreatures({
					monster: "goblin-warrior",
					count: 1,
					sheet: GOBLIN,
				})
			),
			refused("Only the GM can use /add.")
		)
	);
});

describe("combat", () => {
	effect("sides alternate; turns gain resources; rounds add Malice", () =>
		story(
			...party,
			given(table, goblins),
			advance("1 second"),
			given(table, runners),
			advance("1 second"),
			asGm,
			seeded(seedRolling([10, 10])),
			when(table, new DsStartCombat()),
			then(table, combatStarted),
			when(table, new DsSetFirst({ side: "heroes" })),
			then(table, new DsFirstSet({ actor: GM, side: "heroes" })),
			as(ALICE),
			when(table, new DsTakeTurn({ who: "vex" })),
			then(table, new DsTurnStarted({ actor: ALICE, id: "vex", gain: 2 })),
			seeded(seedRolling([10, 6], [10, 1])),
			when(
				table,
				new DsPowerRoll({
					who: "vex",
					ability: "Spinning Strike edge",
					edges: 0,
					banes: 0,
					targets: ["goblin-warrior-1"],
				})
			),
			then(
				table,
				new DsPowerRolled({
					actor: ALICE,
					id: "vex",
					ability: "Spinning Strike",
					dice: [6, 1],
					bonus: 2,
					edges: 1,
					banes: 0,
					total: 11,
					tier: 1,
					targets: [{ id: "goblin-warrior-1" }],
					action: "main",
				}),
				new DsDamaged({
					actor: ALICE,
					id: "goblin-warrior-1",
					amount: 3,
					dealt: 3,
				})
			),
			when(table, new DsEndTurn()),
			then(
				table,
				new DsTurnEnded({ actor: ALICE, id: "vex", ended: [], saves: [] })
			),
			asGm,
			when(table, new DsTakeTurn({ who: "goblin-warrior-1" })),
			then(table, new DsTurnStarted({ actor: GM, id: "goblin-warrior-1" })),
			when(table, new DsFreeStrike({ who: "goblin-warrior-1", target: "kor" })),
			then(
				table,
				new DsDamaged({
					actor: GM,
					id: "kor",
					amount: 2,
					dealt: 2,
					source: "goblin-warrior-1",
				})
			),
			when(table, new DsEndTurn()),
			then(
				table,
				new DsTurnEnded({
					actor: GM,
					id: "goblin-warrior-1",
					ended: [],
					saves: [],
				})
			),
			as(BOB),
			seeded(seedRolling([3, 2])),
			when(table, new DsTakeTurn({ who: "kor" })),
			then(
				table,
				new DsTurnStarted({ actor: BOB, id: "kor", gain: 2, rolls: [2] })
			),
			when(table, new DsEndTurn()),
			then(
				table,
				new DsTurnEnded({ actor: BOB, id: "kor", ended: [], saves: [] })
			),
			asGm,
			when(table, new DsNextRound()),
			then(
				table,
				new DsRoundStarted({ actor: GM, round: 2, heroes: 2, malice: 4 })
			),
			when(table, new DsMalice({ by: -1, reason: "a trap" })),
			then(table, new DsMaliceChanged({ actor: GM, by: -1, reason: "a trap" })),
			state(table, (s) => {
				expect(feedOf(s).slice(6, 8)).toEqual([
					"Combat begins, round 1. d10: 10, so the players pick who goes first, and the GM types /first heroes or /first director. Malice +5 (2 for Victories, 2 heroes, round 1) → 5. Vex +2 Wrath, Kor +2 Ferocity. The party has no hero tokens; /token reset gives one per hero.",
					"The heroes go first each round.",
				]);
				expect(s.ds.malice).toBe(8);
				expect(s.ds.heroes.map((h) => h.resource)).toEqual([4, 4]);
				const band = must(bandOf(s, ALICE, "draw-steel"), "a band");
				expect(band).toMatchObject({ round: 2, active: true, malice: 8 });
				expect(band.combatants.find((c) => c.id === "vex")).toMatchObject({
					mine: true,
					name: "Vex",
					stamina: 21,
				});
			}),
			lastLines(
				"Round 2. Malice +4 (2 heroes, round 2) → 9.",
				"Malice -1 (a trap) → 8."
			),
			when(table, new DsEndCombat()),
			then(table, new DsCombatEnded({ actor: GM })),
			when(table, new DsRest()),
			then(table, new DsRested({ actor: GM })),
			lastLines(
				"Combat ends. Heroic resources, surges and Malice are lost; temporary Stamina and conditions end.",
				"The party rests: Stamina and Recoveries are back to full. Victories become XP: Vex 2, Kor 2."
			)
		)
	);

	effect("a player can't act out of turn, or rest a party mid-combat", () =>
		story(
			...party,
			seeded(1),
			asGm,
			when(table, new DsEndTurn()),
			refused("No combat is running; /start one."),
			seeded(seedRolling([10, 4])),
			when(table, new DsStartCombat()),
			then(table, combatStartedOn(4)),
			when(table, new DsRest()),
			refused("Finish the combat first (/end)."),
			as(BOB),
			when(table, new DsTakeTurn({ who: "vex" })),
			refused("You can only start your own hero's turn.")
		)
	);
});

describe("power rolls", () => {
	effect("a natural 19 or 20 is tier 3 whatever the edges and banes", () =>
		story(
			...party,
			given(table, goblins),
			advance("1 second"),
			seeded(seedRolling([10, 9], [10, 10])),
			as(ALICE),
			when(
				table,
				new DsPowerRoll({
					who: "vex",
					ability: "Spirit Lash bane2",
					edges: 0,
					banes: 0,
					targets: ["goblin-warrior-2"],
				})
			),
			then(
				table,
				new DsPowerRolled({
					actor: ALICE,
					id: "vex",
					ability: "Spirit Lash",
					dice: [9, 10],
					bonus: 2,
					edges: 0,
					banes: 2,
					total: 21,
					tier: 3,
					targets: [{ id: "goblin-warrior-2" }],
				}),
				new DsDamaged({
					actor: ALICE,
					id: "goblin-warrior-2",
					amount: 6,
					type: "holy",
					dealt: 6,
				})
			),
			state(table, (s) => {
				expect(feedOf(s).at(-2)).toContain("natural 19");
			})
		)
	);

	effect("a characteristic roll adds the score; edges add 2", () =>
		story(
			...party,
			seeded(seedRolling([10, 5], [10, 5])),
			as(BOB),
			when(
				table,
				new DsPowerRoll({ who: "kor", ability: "agility", edges: 1, banes: 0 })
			),
			then(
				table,
				new DsPowerRolled({
					actor: BOB,
					id: "kor",
					characteristic: "agility",
					dice: [5, 5],
					bonus: 2,
					edges: 1,
					banes: 0,
					total: 14,
					tier: 2,
				})
			),
			when(table, new DsPowerRoll({ who: "vex", edges: 0, banes: 0 })),
			refused("You can only roll for your own hero.")
		)
	);
});

describe("stamina", () => {
	effect("weakness, immunity, temporary Stamina, recoveries and healing", () =>
		story(
			...party,
			given(
				table,
				new DsCreaturesAdded({
					actor: GM,
					block: IMP,
					creatures: [{ id: "ember-imp", name: "Ember Imp" }],
				})
			),
			advance("1 second"),
			seeded(1),
			asGm,
			when(table, new DsDamage({ who: "kor", amount: 4, damageType: "holy" })),
			then(
				table,
				new DsDamaged({
					actor: GM,
					id: "kor",
					amount: 4,
					type: "holy",
					weakness: 3,
					dealt: 7,
				})
			),
			when(
				table,
				new DsDamage({ who: "ember-imp", amount: 10, damageType: "fire" })
			),
			then(
				table,
				new DsDamaged({
					actor: GM,
					id: "ember-imp",
					amount: 10,
					type: "fire",
					weakness: 1,
					immunity: 5,
					dealt: 6,
				})
			),
			when(table, new DsSetTemp({ who: "vex", amount: 4 })),
			then(table, new DsTempSet({ actor: GM, id: "vex", temp: 4 })),
			when(table, new DsDamage({ who: "vex", amount: 6 })),
			then(table, new DsDamaged({ actor: GM, id: "vex", amount: 6, dealt: 6 })),
			when(table, new DsHeal({ who: "vex", amount: 3 })),
			then(table, new DsHealed({ actor: GM, id: "vex", amount: 2 })),
			as(BOB),
			when(table, new DsRecover({ who: "kor", ally: false })),
			then(
				table,
				new DsRecovered({ actor: BOB, id: "kor", amount: 7, ally: false })
			),
			lastLines(
				"Kor takes 7 holy damage (4 +3 weakness) → 17/24",
				"Ember Imp takes 6 fire damage (10 +1 weakness -5 immunity) → 34/40",
				"Vex has 4 temporary Stamina.",
				"Vex takes 6 damage (4 to temporary Stamina) → 19/21",
				"Vex regains 2 Stamina → 21/21",
				"Kor spends a Recovery and regains 7 Stamina → 24/24 (9/10 left)"
			)
		)
	);

	effect("resources, surges, hero tokens and Victories move by steps", () =>
		story(
			...party,
			seeded(1),
			as(ALICE),
			when(table, new DsResource({ who: "vex", by: 3 })),
			then(table, new DsResourceChanged({ actor: ALICE, id: "vex", by: 3 })),
			when(table, new DsSurge({ who: "vex", by: 2 })),
			then(table, new DsSurgesChanged({ actor: ALICE, id: "vex", by: 2 })),
			when(table, new DsToken({ change: -1 })),
			refused("The party has only 0 hero tokens."),
			asGm,
			when(table, new DsToken({ change: "reset" })),
			then(table, new DsTokensReset({ actor: GM, tokens: 2 })),
			as(ALICE),
			when(table, new DsToken({ change: -1 })),
			then(table, new DsTokensChanged({ actor: ALICE, by: -1 })),
			asGm,
			when(table, new DsVictory({ by: 1 })),
			then(
				table,
				new DsVictoriesChanged({ actor: GM, ids: ["vex", "kor"], by: 1 })
			),
			lastLines(
				"Vex gains 3 Wrath → 3.",
				"Vex gains 2 surges → 2.",
				"Hero tokens reset to 2, one per hero.",
				"abcdefgh (Vex) spends 1 hero token → 1.",
				"Victories +1: Vex 3, Kor 3."
			)
		)
	);
});

describe("conditions", () => {
	effect("bleeding costs Stamina after an action; a save on 6+ ends it", () =>
		story(
			...party,
			given(table, goblins),
			advance("1 second"),
			given(table, combatStarted),
			advance("1 second"),
			given(
				table,
				new DsTurnStarted({ actor: BOB, id: "kor", gain: 2, rolls: [2] })
			),
			advance("1 second"),
			seeded(1),
			asGm,
			when(
				table,
				new DsCondition({ who: "kor", condition: "bleeding", duration: "save" })
			),
			then(
				table,
				new DsConditionSet({
					actor: GM,
					id: "kor",
					condition: "bleeding",
					duration: "save",
				})
			),
			when(
				table,
				new DsCondition({ who: "kor", condition: "slowed", duration: "eot" })
			),
			then(
				table,
				new DsConditionSet({
					actor: GM,
					id: "kor",
					condition: "slowed",
					duration: "eot",
				})
			),
			as(BOB),
			seeded(seedRolling([10, 10], [10, 1], [6, 6])),
			when(
				table,
				new DsPowerRoll({
					who: "kor",
					ability: "Brutal Slam",
					edges: 0,
					banes: 0,
					targets: ["goblin-warrior-1"],
				})
			),
			then(
				table,
				new DsPowerRolled({
					actor: BOB,
					id: "kor",
					ability: "Brutal Slam",
					dice: [10, 1],
					bonus: 2,
					edges: 0,
					banes: 0,
					total: 13,
					tier: 2,
					targets: [{ id: "goblin-warrior-1" }],
				}),
				new DsDamaged({
					actor: BOB,
					id: "goblin-warrior-1",
					amount: 6,
					dealt: 6,
				}),
				new DsBled({ actor: BOB, id: "kor", roll: 6, level: 1 })
			),
			seeded(seedRolling([10, 3])),
			when(table, new DsEndTurn()),
			then(
				table,
				new DsTurnEnded({
					actor: BOB,
					id: "kor",
					ended: ["slowed"],
					saves: [{ condition: "bleeding", roll: 3, ends: false }],
				})
			),
			seeded(seedRolling([10, 8])),
			when(table, new DsSave({ who: "kor" })),
			then(
				table,
				new DsSaved({
					actor: BOB,
					id: "kor",
					condition: "bleeding",
					roll: 8,
					ends: true,
				})
			),
			state(table, (s) => {
				expect(s.ds.heroes.find((h) => h.id === "kor")).toMatchObject({
					stamina: 17,
					conditions: [],
				});
			}),
			asGm,
			when(table, new DsCondition({ who: "vex", condition: "prone" })),
			then(
				table,
				new DsConditionSet({
					actor: GM,
					id: "vex",
					condition: "prone",
					duration: "end",
				})
			),
			when(table, new DsSave({ who: "vex", condition: "prone" })),
			refused("Vex has nothing a save ends."),
			when(
				table,
				new DsCondition({ who: "vex", condition: "prone", remove: true })
			),
			then(
				table,
				new DsConditionRemoved({ actor: GM, id: "vex", condition: "prone" })
			)
		)
	);
});

describe("the map", () => {
	const imp = new DsCreaturesAdded({
		actor: GM,
		block: IMP,
		creatures: [{ id: "ember-imp", name: "Ember Imp" }],
	});

	const goblin = new DsCreaturesAdded({
		actor: GM,
		block: GOBLIN,
		creatures: [{ id: "goblin-warrior", name: "Goblin Warrior" }],
	});

	effect("tokens are placed, move by their cheapest path, and are forced", () =>
		story(
			given(table, vexJoins),
			advance("1 second"),
			given(table, aliceTakesVex),
			advance("1 second"),
			given(table, goblin),
			advance("1 second"),
			given(table, imp),
			advance("1 second"),
			seeded(1),
			asGm,
			when(table, new DsLoadMap({ id: "field" })),
			refused("No map for 'field' was loaded."),
			when(table, new DsLoadMap({ id: "field", grid: FIELD })),
			then(table, new DsMapLoaded({ actor: GM, id: "field", ...FIELD })),
			when(table, new DsPlace({ who: "vex", at: { x: 2, y: 0 } })),
			then(table, new DsPlaced({ actor: GM, id: "vex", at: { x: 2, y: 0 } })),
			when(table, new DsPlace({ who: "goblin-warrior", at: { x: 4, y: 0 } })),
			then(
				table,
				new DsPlaced({ actor: GM, id: "goblin-warrior", at: { x: 4, y: 0 } })
			),
			when(table, new DsPlace({ who: "ember-imp", at: { x: 0, y: 3 } })),
			then(
				table,
				new DsPlaced({ actor: GM, id: "ember-imp", at: { x: 0, y: 3 } })
			),
			when(table, new DsPlace({ who: "vex", at: { x: 3, y: 1 } })),
			refused("d2 is a wall."),
			as(ALICE),
			when(table, new DsMove({ who: "vex", to: { x: 2, y: 3 } })),
			then(
				table,
				new DsMoved({
					actor: ALICE,
					id: "vex",
					path: [
						{ x: 2, y: 1 },
						{ x: 1, y: 2 },
						{ x: 2, y: 3 },
					],
					cost: 3,
					speed: 5,
				})
			),
			when(table, new DsMove({ who: "vex", to: { x: 3, y: 0 } })),
			then(
				table,
				new DsMoved({
					actor: ALICE,
					id: "vex",
					path: [
						{ x: 1, y: 2 },
						{ x: 1, y: 1 },
						{ x: 2, y: 0 },
						{ x: 3, y: 0 },
					],
					cost: 4,
					speed: 5,
				})
			),
			when(table, new DsMove({ who: "goblin-warrior", to: { x: 5, y: 0 } })),
			refused("You can only move your own hero."),
			asGm,
			when(
				table,
				new DsPush({ who: "goblin-warrior", distance: 3, from: "vex" })
			),
			then(
				table,
				new DsForceMoved({
					actor: GM,
					id: "goblin-warrior",
					kind: "push",
					source: "vex",
					from: { x: 4, y: 0 },
					distance: 3,
					stability: 0,
					path: [
						{ x: 5, y: 0 },
						{ x: 6, y: 0 },
						{ x: 7, y: 0 },
					],
					apart: 1,
				})
			),
			when(
				table,
				new DsPull({ who: "goblin-warrior", distance: 2, from: "vex" })
			),
			then(
				table,
				new DsForceMoved({
					actor: GM,
					id: "goblin-warrior",
					kind: "pull",
					source: "vex",
					from: { x: 7, y: 0 },
					distance: 2,
					stability: 0,
					path: [
						{ x: 6, y: 0 },
						{ x: 5, y: 0 },
					],
					apart: 4,
				})
			),
			when(
				table,
				new DsSlide({ who: "goblin-warrior", distance: 2, to: { x: 3, y: 1 } })
			),
			refused("d2 is 5 squares away, and the slide is 2."),
			when(table, new DsMeasure({ from: "vex", to: "a4" })),
			then(
				table,
				new DsMeasured({
					actor: GM,
					from: { id: "vex", at: { x: 3, y: 0 } },
					to: { at: { x: 0, y: 3 } },
					distance: 3,
				})
			),
			lastLines(
				"Vex moves to c4 (3 squares of movement).",
				"Vex moves to d1 (4 squares of movement).",
				"Goblin Warrior is pushed 3 squares by Vex to h1.",
				"Goblin Warrior is pulled 2 squares by Vex to f1 (4 squares away).",
				"GM measures Vex (d1) to a4: 3 squares."
			),
			state(table, (s) => {
				const map = must(mapOf(s, ALICE, "draw-steel"), "a map");

				expect(map).toMatchObject({ name: "Field", width: 8, height: 4 });
				expect(map.tokens.map((t) => [t.mark, t.x, t.y, t.mine])).toEqual([
					["V", 3, 0, true],
					["w", 5, 0, false],
					["i", 0, 3, false],
				]);
				expect(map.reachLabel).toBe("Vex can reach: speed 5");
				expect(actionsOf(s, ALICE, "draw-steel", "vex")).toEqual([
					{ label: "Move", pick: "square", line: "/move vex" },
					{
						label: "Spinning Strike",
						pick: "targets",
						line: "/pr vex Spinning Strike",
					},
					{
						label: "Spirit Lash",
						pick: "targets",
						line: "/pr vex Spirit Lash",
					},
				]);
				expect(
					actionsOf(s, ALICE, "draw-steel", "goblin-warrior")
				).toBeUndefined();
			}),
			when(table, new DsLoadMap({})),
			then(table, new DsMapCleared({ actor: GM }))
		)
	);

	effect("a push into a wall slams for the squares left", () =>
		story(
			given(table, vexJoins),
			advance("1 second"),
			given(table, goblin),
			advance("1 second"),
			given(table, new DsMapLoaded({ actor: GM, id: "field", ...FIELD })),
			advance("1 second"),
			given(table, new DsPlaced({ actor: GM, id: "vex", at: { x: 3, y: 3 } })),
			advance("1 second"),
			given(
				table,
				new DsPlaced({ actor: GM, id: "goblin-warrior", at: { x: 3, y: 2 } })
			),
			advance("1 second"),
			seeded(1),
			asGm,
			when(
				table,
				new DsPush({ who: "goblin-warrior", distance: 3, from: "vex" })
			),
			then(
				table,
				new DsForceMoved({
					actor: GM,
					id: "goblin-warrior",
					kind: "push",
					source: "vex",
					from: { x: 3, y: 2 },
					distance: 3,
					stability: 0,
					path: [],
					slam: { into: "wall", remaining: 3 },
					apart: 1,
				}),
				new DsDamaged({ actor: GM, id: "goblin-warrior", amount: 5, dealt: 5 })
			),
			state(table, (s) => {
				expect(s.ds.creatures[0]?.stamina).toBe(10);
			})
		)
	);
});

describe("what a seat sees", () => {
	effect("the GM's prep panel, and a hero's sheet", () =>
		story(
			given(table, vexJoins),
			advance("1 second"),
			given(table, aliceTakesVex),
			state(table, (s) => {
				const prep = prepOf(
					s,
					{
						heroes: [
							{ id: "vex", name: "Vex" },
							{ id: "kor", name: "Kor" },
						],
						monsters: [{ id: "goblin-warrior", name: "Goblin Warrior" }],
						maps: [{ id: "field", name: "Field" }],
					},
					"draw-steel"
				);

				expect(prep.steps).toEqual([
					{ label: "map", done: false },
					{ label: "party", done: false },
					{ label: "foes", done: false },
				]);
				expect(prep.sections[0]).toEqual({
					title: "heroes",
					items: [
						{
							kind: "send",
							label: "Kor",
							line: "/hero kor",
							figure: { id: "kor", side: "heroes" },
						},
					],
				});
				expect(prep.maps.items[0]).toEqual({
					kind: "send",
					label: "Field",
					line: "/map field",
				});

				const sheet = sheetOf(s, "vex", "draw-steel");

				expect(sheet).toContain("Vex: Censor 1");
				expect(sheet).toContain("Spinning Strike (Main action;");
				expect(sheetOf(s, "nobody", "draw-steel")).toEqual({
					refusal: "Nobody at the table is called 'nobody'.",
				});
			})
		)
	);
});

const WARDEN: HeroSheet = {
	...VEX,
	abilities: [
		...VEX.abilities,
		{
			name: "Shield Bash",
			kind: "Maneuver",
			characteristics: ["might"],
			tier1: "1 damage",
			tier2: "2 damage",
			tier3: "3 damage",
		},
		{ name: "Riposte", kind: "Triggered action", effect: "Strike back." },
	],
};

const wardenJoins = new DsHeroJoined({ actor: GM, sheet: WARDEN });

const wardenFights = new DsCombatStarted({
	actor: GM,
	roll: 10,
	gains: { vex: 2 },
	malice: { victories: 2, heroes: 1, round: 1 },
});

const OGRE: StatBlock = {
	...GOBLIN,
	id: "ogre",
	name: "Ogre",
	size: "2",
	stamina: 40,
	speed: 5,
	abilities: [],
};

const OPEN = {
	name: "Open",
	terrain: [
		"........",
		"........",
		"....#...",
		"........",
		"........",
		"........",
	],
};

const rolled = (
	dice: readonly [number, number],
	over: Partial<ConstructorParameters<typeof DsPowerRolled>[0]>
) =>
	new DsPowerRolled({
		actor: ALICE,
		id: "vex",
		ability: "Spirit Lash",
		dice: [dice[0], dice[1]],
		bonus: 2,
		edges: 0,
		banes: 0,
		total: dice[0] + dice[1] + 2,
		tier: 2,
		...over,
	});

const lash = (...targets: ReadonlyArray<string>) =>
	new DsPowerRoll({
		who: "vex",
		ability: "Spirit Lash",
		edges: 0,
		banes: 0,
		targets: [...targets],
	});

const holy = (id: string, amount: number) =>
	new DsDamaged({ actor: ALICE, id, amount, type: "holy", dealt: amount });

describe("a turn's actions", () => {
	effect(
		"a main action, a maneuver and a move; a natural 19 or 20 on a main action gives another",
		() =>
			story(
				given(table, wardenJoins),
				advance("1 second"),
				given(table, aliceTakesVex),
				advance("1 second"),
				given(table, goblins),
				advance("1 second"),
				given(table, wardenFights),
				advance("1 second"),
				given(table, new DsFirstSet({ actor: GM, side: "heroes" })),
				advance("1 second"),
				given(table, new DsTurnStarted({ actor: ALICE, id: "vex", gain: 2 })),
				advance("1 second"),
				as(ALICE),
				seeded(seedRolling([10, 9], [10, 10])),
				when(
					table,
					new DsPowerRoll({
						who: "vex",
						ability: "Spinning Strike",
						edges: 0,
						banes: 0,
						targets: ["goblin-warrior-1"],
					})
				),
				then(
					table,
					new DsPowerRolled({
						actor: ALICE,
						id: "vex",
						ability: "Spinning Strike",
						dice: [9, 10],
						bonus: 2,
						edges: 0,
						banes: 0,
						total: 21,
						tier: 3,
						targets: [{ id: "goblin-warrior-1" }],
						action: "main",
					}),
					new DsDamaged({
						actor: ALICE,
						id: "goblin-warrior-1",
						amount: 7,
						dealt: 7,
					})
				),
				state(table, (s) => {
					expect(feedOf(s).at(-2)).toContain(
						"= 21, natural 19, extra main action"
					);
				}),
				seeded(seedRolling([10, 6], [10, 1])),
				when(table, lash("goblin-warrior-2")),
				then(
					table,
					rolled([6, 1], {
						total: 9,
						tier: 1,
						targets: [{ id: "goblin-warrior-2" }],
						action: "main",
					}),
					holy("goblin-warrior-2", 2)
				),
				when(table, lash("goblin-warrior-2")),
				refused("Vex has no main action left this turn."),
				seeded(seedRolling([10, 5], [10, 5])),
				when(
					table,
					new DsPowerRoll({
						who: "vex",
						ability: "Shield Bash",
						edges: 0,
						banes: 0,
					})
				),
				then(
					table,
					rolled([5, 5], {
						ability: "Shield Bash",
						total: 12,
						action: "maneuver",
					})
				),
				when(
					table,
					new DsPowerRoll({
						who: "vex",
						ability: "Shield Bash",
						edges: 0,
						banes: 0,
					})
				),
				refused("Vex has no maneuver left this turn."),
				state(table, (s) => {
					const band = must(bandOf(s, ALICE, "draw-steel"), "a band");

					expect(band.combatants.find((c) => c.id === "vex")).toMatchObject({
						turnActions: "left: move",
					});
				}),
				asGm,
				seeded(seedRolling([10, 5], [10, 5])),
				when(table, lash("goblin-warrior-2")),
				then(
					table,
					rolled([5, 5], {
						actor: GM,
						total: 12,
						targets: [{ id: "goblin-warrior-2" }],
						action: "main",
					}),
					new DsDamaged({
						actor: GM,
						id: "goblin-warrior-2",
						amount: 4,
						type: "holy",
						dealt: 4,
					})
				),
				as(ALICE),
				when(table, new DsEndTurn()),
				then(
					table,
					new DsTurnEnded({ actor: ALICE, id: "vex", ended: [], saves: [] })
				),
				asGm,
				when(table, new DsTakeTurn({ who: "goblin-warrior-1" })),
				then(table, new DsTurnStarted({ actor: GM, id: "goblin-warrior-1" })),
				as(ALICE),
				when(
					table,
					new DsPowerRoll({
						who: "vex",
						ability: "Riposte",
						edges: 0,
						banes: 0,
					})
				),
				then(
					table,
					new DsAbilityUsed({
						actor: ALICE,
						id: "vex",
						ability: "Riposte",
						action: "triggered",
					})
				),
				when(
					table,
					new DsPowerRoll({
						who: "vex",
						ability: "Riposte",
						edges: 0,
						banes: 0,
					})
				),
				refused("Vex has used their triggered action this round."),
				state(table, (s) => {
					const band = must(bandOf(s, ALICE, "draw-steel"), "a band");

					expect(band.combatants.find((c) => c.id === "vex")).toMatchObject({
						turnActions: "triggered action used",
					});
					expect(
						band.combatants.find((c) => c.id === "goblin-warrior-1")
					).toMatchObject({ turnActions: "left: main, maneuver, move" });
				})
			)
	);

	effect("a dazed hero takes one action a turn, and no triggered action", () =>
		story(
			given(table, wardenJoins),
			advance("1 second"),
			given(table, aliceTakesVex),
			advance("1 second"),
			given(table, goblins),
			advance("1 second"),
			given(table, new DsMapLoaded({ actor: GM, id: "open", ...OPEN })),
			advance("1 second"),
			given(table, new DsPlaced({ actor: GM, id: "vex", at: { x: 0, y: 0 } })),
			advance("1 second"),
			given(table, wardenFights),
			advance("1 second"),
			given(table, new DsTurnStarted({ actor: ALICE, id: "vex", gain: 2 })),
			advance("1 second"),
			given(
				table,
				new DsConditionSet({
					actor: GM,
					id: "vex",
					condition: "dazed",
					duration: "eot",
				})
			),
			advance("1 second"),
			seeded(1),
			as(ALICE),
			when(table, new DsMove({ who: "vex", to: { x: 1, y: 0 } })),
			then(
				table,
				new DsMoved({
					actor: ALICE,
					id: "vex",
					path: [{ x: 1, y: 0 }],
					cost: 1,
					speed: 5,
					spent: 1,
					allowance: 5,
				})
			),
			when(
				table,
				new DsPowerRoll({
					who: "vex",
					ability: "Spinning Strike",
					edges: 0,
					banes: 0,
				})
			),
			refused("Vex is dazed and has taken their one action this turn."),
			when(
				table,
				new DsPowerRoll({ who: "vex", ability: "Riposte", edges: 0, banes: 0 })
			),
			refused("Vex is dazed and can't take triggered actions."),
			when(table, new DsMove({ who: "vex", to: { x: 2, y: 0 } })),
			then(
				table,
				new DsMoved({
					actor: ALICE,
					id: "vex",
					path: [{ x: 2, y: 0 }],
					cost: 1,
					speed: 5,
					spent: 2,
					allowance: 5,
				})
			),
			when(table, new DsMove({ who: "vex", to: { x: 7, y: 0 }, main: true })),
			refused("Vex is dazed and has taken their one action this turn."),
			state(table, (s) => {
				const band = must(bandOf(s, ALICE, "draw-steel"), "a band");

				expect(band.combatants.find((c) => c.id === "vex")).toMatchObject({
					turnActions: "dazed: no actions left",
					conditions: ["dazed (EoT)"],
				});
			})
		)
	);
});

const condition = (who: string, name: ConditionName) =>
	[
		when(table, new DsCondition({ who, condition: name })),
		then(
			table,
			new DsConditionSet({
				actor: GM,
				id: who,
				condition: name,
				duration: "end",
			})
		),
	] as const;

const heldCondition = (who: string, name: ConditionName, by: string) =>
	[
		when(table, new DsCondition({ who, condition: name, by })),
		then(
			table,
			new DsConditionSet({
				actor: GM,
				id: who,
				condition: name,
				duration: "end",
				by,
			})
		),
	] as const;

const lifted = (who: string, name: ConditionName) =>
	[
		when(table, new DsCondition({ who, condition: name, remove: true })),
		then(
			table,
			new DsConditionRemoved({ actor: GM, id: who, condition: name })
		),
	] as const;

const mod = (
	id: string,
	name: ConditionName,
	edges: number,
	banes: number
) => ({ id, condition: name, edges, banes });

describe("conditions on power rolls", () => {
	effect(
		"weakened, restrained, taunted, frightened and grabbed give edges and banes by who is aimed at",
		() =>
			story(
				...party,
				given(table, goblins),
				advance("1 second"),
				seeded(seedRolling([10, 5], [10, 5])),
				asGm,
				...condition("vex", "weakened"),
				as(ALICE),
				when(table, lash("goblin-warrior-1")),
				then(
					table,
					rolled([5, 5], {
						edges: 0,
						banes: 1,
						total: 10,
						tier: 1,
						targets: [{ id: "goblin-warrior-1" }],
						conditions: [mod("vex", "weakened", 0, 1)],
					}),
					holy("goblin-warrior-1", 2)
				),
				state(table, (s) => {
					expect(feedOf(s).at(-2)).toContain(
						"[5, 5] +2 -2 bane = 10 (weakened: bane) · tier 1"
					);
				}),
				asGm,
				...condition("goblin-warrior-1", "restrained"),
				as(ALICE),
				when(table, lash("goblin-warrior-1")),
				then(
					table,
					rolled([5, 5], {
						edges: 1,
						banes: 1,
						targets: [{ id: "goblin-warrior-1" }],
						conditions: [
							mod("vex", "weakened", 0, 1),
							mod("goblin-warrior-1", "restrained", 1, 0),
						],
					}),
					holy("goblin-warrior-1", 4)
				),
				state(table, (s) => {
					expect(feedOf(s).at(-2)).toContain(
						"(weakened: bane; Goblin Warrior 1 restrained: edge)"
					);
				}),
				asGm,
				...lifted("vex", "weakened"),
				...heldCondition("vex", "taunted", "goblin-warrior-2"),
				state(table, (s) => {
					expect(feedOf(s).at(-1)).toBe(
						"Vex is taunted by Goblin Warrior 2 until the end of the encounter."
					);
				}),
				as(ALICE),
				when(table, lash("goblin-warrior-1")),
				then(
					table,
					rolled([5, 5], {
						edges: 1,
						banes: 2,
						total: 10,
						tier: 1,
						targets: [{ id: "goblin-warrior-1" }],
						conditions: [
							mod("vex", "taunted", 0, 2),
							mod("goblin-warrior-1", "restrained", 1, 0),
						],
					}),
					holy("goblin-warrior-1", 2)
				),
				when(table, lash("goblin-warrior-2")),
				then(
					table,
					rolled([5, 5], { targets: [{ id: "goblin-warrior-2" }] }),
					holy("goblin-warrior-2", 4)
				),
				asGm,
				...lifted("vex", "taunted"),
				...heldCondition("vex", "frightened", "goblin-warrior-2"),
				as(ALICE),
				when(table, lash("goblin-warrior-2")),
				then(
					table,
					rolled([5, 5], {
						banes: 1,
						total: 10,
						tier: 1,
						targets: [{ id: "goblin-warrior-2" }],
						conditions: [mod("vex", "frightened", 0, 1)],
					}),
					holy("goblin-warrior-2", 2)
				),
				asGm,
				...heldCondition("goblin-warrior-2", "frightened", "vex"),
				...heldCondition("vex", "grabbed", "goblin-warrior-1"),
				as(ALICE),
				when(table, lash("goblin-warrior-2")),
				then(
					table,
					rolled([5, 5], {
						edges: 1,
						banes: 2,
						total: 10,
						tier: 1,
						targets: [{ id: "goblin-warrior-2" }],
						conditions: [
							mod("vex", "frightened", 0, 1),
							mod("vex", "grabbed", 0, 1),
							mod("goblin-warrior-2", "frightened", 1, 0),
						],
					}),
					holy("goblin-warrior-2", 2)
				),
				state(table, (s) => {
					const band = must(bandOf(s, ALICE, "draw-steel"), "a band");

					expect(band.combatants.find((c) => c.id === "vex")).toMatchObject({
						conditions: [
							"frightened by Goblin Warrior 2",
							"grabbed by Goblin Warrior 1",
						],
					});
				}),
				asGm,
				when(
					table,
					new DsCondition({ who: "vex", condition: "slowed", by: "kor" })
				),
				refused(
					"Only frightened, grabbed or taunted name who did it; slowed doesn't."
				),
				when(
					table,
					new DsCondition({ who: "vex", condition: "grabbed", by: "vex" })
				),
				refused("Vex can't be grabbed by themselves.")
			)
	);

	effect(
		"prone banes a strike, aimed or not, but not a characteristic roll; restrained banes them all",
		() =>
			story(
				...party,
				seeded(seedRolling([10, 5], [10, 5])),
				asGm,
				...condition("vex", "prone"),
				as(ALICE),
				when(
					table,
					new DsPowerRoll({
						who: "vex",
						ability: "Spinning Strike",
						edges: 0,
						banes: 0,
					})
				),
				then(
					table,
					rolled([5, 5], {
						ability: "Spinning Strike",
						banes: 1,
						total: 10,
						tier: 1,
						conditions: [mod("vex", "prone", 0, 1)],
					})
				),
				when(
					table,
					new DsPowerRoll({ who: "vex", ability: "might", edges: 0, banes: 0 })
				),
				then(
					table,
					new DsPowerRolled({
						actor: ALICE,
						id: "vex",
						characteristic: "might",
						dice: [5, 5],
						bonus: 2,
						edges: 0,
						banes: 0,
						total: 12,
						tier: 2,
					})
				),
				asGm,
				...condition("vex", "restrained"),
				as(ALICE),
				when(
					table,
					new DsPowerRoll({
						who: "vex",
						ability: "might edge",
						edges: 0,
						banes: 0,
					})
				),
				then(
					table,
					new DsPowerRolled({
						actor: ALICE,
						id: "vex",
						characteristic: "might",
						dice: [5, 5],
						bonus: 2,
						edges: 1,
						banes: 1,
						total: 12,
						tier: 2,
						conditions: [mod("vex", "restrained", 0, 1)],
					})
				)
			)
	);
});

describe("a grab", () => {
	effect("only the one holding a creature, or the GM, force moves it", () =>
		story(
			...party,
			given(table, goblins),
			advance("1 second"),
			given(table, new DsMapLoaded({ actor: GM, id: "open", ...OPEN })),
			advance("1 second"),
			given(table, new DsPlaced({ actor: GM, id: "kor", at: { x: 5, y: 0 } })),
			advance("1 second"),
			given(
				table,
				new DsPlaced({ actor: GM, id: "goblin-warrior-2", at: { x: 6, y: 0 } })
			),
			advance("1 second"),
			given(table, new DsPlaced({ actor: GM, id: "vex", at: { x: 6, y: 1 } })),
			advance("1 second"),
			given(
				table,
				new DsConditionSet({
					actor: GM,
					id: "goblin-warrior-2",
					condition: "grabbed",
					duration: "end",
					by: "kor",
				})
			),
			advance("1 second"),
			given(table, combatStarted),
			advance("1 second"),
			given(table, new DsTurnStarted({ actor: ALICE, id: "vex", gain: 2 })),
			advance("1 second"),
			seeded(1),
			as(ALICE),
			when(table, new DsPush({ who: "goblin-warrior-2", distance: 1 })),
			refused(
				"Goblin Warrior 2 is grabbed by Kor; only Kor or the GM can force move them."
			),
			when(table, new DsEndTurn()),
			then(
				table,
				new DsTurnEnded({ actor: ALICE, id: "vex", ended: [], saves: [] })
			),
			asGm,
			seeded(seedRolling([3, 1])),
			when(table, new DsTakeTurn({ who: "kor" })),
			then(
				table,
				new DsTurnStarted({ actor: GM, id: "kor", gain: 1, rolls: [1] })
			),
			as(BOB),
			when(table, new DsPush({ who: "goblin-warrior-2", distance: 1 })),
			then(
				table,
				new DsForceMoved({
					actor: BOB,
					id: "goblin-warrior-2",
					kind: "push",
					source: "kor",
					from: { x: 6, y: 0 },
					distance: 1,
					stability: 0,
					path: [{ x: 7, y: 0 }],
					apart: 1,
				})
			),
			asGm,
			when(
				table,
				new DsPush({ who: "goblin-warrior-2", distance: 1, from: "vex" })
			),
			then(
				table,
				new DsForceMoved({
					actor: GM,
					id: "goblin-warrior-2",
					kind: "push",
					source: "vex",
					from: { x: 7, y: 0 },
					distance: 1,
					stability: 0,
					path: [],
					edge: true,
					apart: 1,
				})
			)
		)
	);
});

describe("a big creature", () => {
	const ogre = new DsCreaturesAdded({
		actor: GM,
		block: OGRE,
		creatures: [{ id: "ogre", name: "Ogre" }],
	});

	effect(
		"takes up its size in squares: placed, moved, measured and slammed by every square",
		() =>
			story(
				given(table, vexJoins),
				advance("1 second"),
				given(table, aliceTakesVex),
				advance("1 second"),
				given(table, ogre),
				advance("1 second"),
				given(table, new DsMapLoaded({ actor: GM, id: "open", ...OPEN })),
				advance("1 second"),
				seeded(1),
				asGm,
				when(table, new DsPlace({ who: "ogre", at: { x: 0, y: 0 } })),
				then(
					table,
					new DsPlaced({ actor: GM, id: "ogre", at: { x: 0, y: 0 } })
				),
				when(table, new DsPlace({ who: "vex", at: { x: 1, y: 1 } })),
				refused("b2 is taken by Ogre."),
				when(table, new DsPlace({ who: "ogre", at: { x: 3, y: 1 } })),
				refused("e3 is a wall."),
				when(table, new DsPlace({ who: "vex", at: { x: 3, y: 0 } })),
				then(table, new DsPlaced({ actor: GM, id: "vex", at: { x: 3, y: 0 } })),
				when(table, new DsMeasure({ from: "ogre", to: "vex" })),
				then(
					table,
					new DsMeasured({
						actor: GM,
						from: { id: "ogre", at: { x: 0, y: 0 } },
						to: { id: "vex", at: { x: 3, y: 0 } },
						distance: 2,
					})
				),
				when(table, new DsMove({ who: "ogre", to: { x: 3, y: 1 } })),
				refused("e3 is a wall."),
				when(table, new DsMove({ who: "ogre", to: { x: 2, y: 2 } })),
				then(
					table,
					new DsMoved({
						actor: GM,
						id: "ogre",
						path: [
							{ x: 1, y: 1 },
							{ x: 2, y: 2 },
						],
						cost: 2,
						speed: 5,
					})
				),
				when(table, new DsPlace({ who: "vex", at: { x: 1, y: 2 } })),
				then(table, new DsPlaced({ actor: GM, id: "vex", at: { x: 1, y: 2 } })),
				when(
					table,
					new DsPush({
						who: "ogre",
						distance: 2,
						from: "vex",
						to: { x: 4, y: 2 },
					})
				),
				then(
					table,
					new DsForceMoved({
						actor: GM,
						id: "ogre",
						kind: "push",
						source: "vex",
						from: { x: 2, y: 2 },
						distance: 2,
						stability: 0,
						path: [],
						slam: { into: "wall", remaining: 2 },
						apart: 1,
					}),
					new DsDamaged({ actor: GM, id: "ogre", amount: 4, dealt: 4 })
				),
				state(table, (s) => {
					const map = must(mapOf(s, ALICE, "draw-steel"), "a map");

					expect(map.tokens.map((t) => [t.id, t.x, t.y, t.footprint])).toEqual([
						["vex", 1, 2, undefined],
						["ogre", 2, 2, 2],
					]);
					expect(sheetOf(s, "ogre", "draw-steel")).toContain(
						"Speed 5 · Stability 0 · Size 2"
					);
				})
			)
	);
});
