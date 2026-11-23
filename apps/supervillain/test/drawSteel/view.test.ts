import { describe, expect, test } from "bun:test";

import { combatView, completeWho, sheetText } from "@supervillain/domain";

import {
	ALICE,
	BOB,
	fixedDice,
	GM,
	GOBLIN,
	party,
	RUNNER,
	table,
	Table,
} from "./harness.ts";

describe("combatView", () => {
	test("nothing to show with no party and no combat", () => {
		expect(combatView(new Table().ds, GM)).toBeUndefined();
	});

	test("outside combat the band shows the party", () => {
		const t = party();
		t.run(GM, { type: "dmg", who: "vex", amount: 11 });
		t.run(GM, { type: "token", change: "reset" });
		expect(combatView(t.ds, ALICE)).toEqual({
			round: 0,
			active: false,
			malice: 0,
			heroTokens: 2,
			victories: 2,
			combatants: [
				{
					id: "vex",
					name: "Vex",
					side: "heroes",
					stamina: 10,
					max: 21,
					temp: 0,
					health: "winded",
					conditions: [],
					resource: "Wrath 0",
					recoveries: { left: 8, max: 8 },
					surges: 0,
					acted: false,
					acting: false,
					mine: true,
				},
				{
					id: "kor",
					name: "Kor",
					side: "heroes",
					stamina: 24,
					max: 24,
					temp: 0,
					conditions: [],
					resource: "Ferocity 0",
					recoveries: { left: 10, max: 10 },
					surges: 0,
					acted: false,
					acting: false,
					mine: false,
					free: true,
				},
			],
		});
	});

	test("a living hero nobody plays is free to take, for a player without one", () => {
		const t = party();

		const free = () =>
			combatView(t.ds, BOB)?.combatants.map((c) => [c.id, c.free ?? false]);

		expect(free()).toEqual([
			["vex", false],
			["kor", true],
		]);
		t.run(GM, { type: "dmg", who: "kor", amount: 60 });
		expect(combatView(t.ds, BOB)?.combatants[1]?.health).toBe("dead");
		expect(free()).toEqual([
			["vex", false],
			["kor", false],
		]);
	});

	test("a dying hero is bleeding and shows where death is (Combat, 'Dying and Death')", () => {
		const t = party();
		t.run(GM, { type: "dmg", who: "vex", amount: 22 });
		t.run(GM, {
			type: "cond",
			who: "vex",
			condition: "dazed",
			duration: "save",
		});
		expect(combatView(t.ds, GM)?.combatants[0]).toMatchObject({
			stamina: -1,
			health: "dying",
			deadAt: -10,
			conditions: ["bleeding", "dazed (save)"],
		});
		expect(t.hero("vex").conditions).toEqual([
			{ name: "dazed", duration: "save" },
		]);
		expect(sheetText(t.ds, "vex")).toContain(
			"Stamina -1/21 · dying and bleeding (winded at 10, dead at -10)"
		);
		t.run(GM, { type: "heal", who: "vex", amount: 5 });
		expect(combatView(t.ds, GM)?.combatants[0]).toMatchObject({
			conditions: ["dazed (save)"],
		});
		expect(combatView(t.ds, GM)?.combatants[0]?.deadAt).toBeUndefined();
	});

	test("in combat: the side that goes first leads, with who acted, who is acting and squads", () => {
		const t = party();
		t.run(GM, {
			type: "add",
			monster: "goblin-warrior",
			count: 1,
			sheet: GOBLIN,
		});
		t.run(GM, {
			type: "add",
			monster: "goblin-runner",
			count: 4,
			sheet: RUNNER,
		});
		t.run(GM, { type: "start" }, fixedDice(2));
		t.run(GM, { type: "first", side: "director" });
		t.run(GM, { type: "turn", who: "goblin-runner-a" });
		t.run(GM, { type: "done" });
		t.run(GM, { type: "dmg", who: "goblin-runner-a", amount: 7 });
		t.run(GM, {
			type: "cond",
			who: "goblin-warrior",
			condition: "slowed",
			duration: "eot",
		});
		t.run(GM, {
			type: "cond",
			who: "goblin-warrior",
			condition: "bleeding",
			duration: "save",
		});
		t.run(GM, { type: "cond", who: "goblin-warrior", condition: "prone" });
		t.run(GM, { type: "temp", who: "goblin-warrior", amount: 3 });
		t.run(ALICE, { type: "turn" });

		const view = combatView(t.ds, BOB, (actor) =>
			actor === ALICE ? "Alice" : actor
		);

		expect(view).toMatchObject({
			round: 1,
			active: true,
			next: "director",
			malice: 5,
		});
		expect(
			view?.combatants.map((c) => [c.id, c.name, c.acted, c.acting])
		).toEqual([
			["goblin-warrior", "Goblin Warrior", false, false],
			["goblin-runner-a", "Goblin Runner A", true, false],
			["vex", "Vex (Alice)", false, true],
			["kor", "Kor", false, false],
		]);
		expect(view?.combatants[0]).toMatchObject({
			side: "director",
			stamina: 15,
			max: 15,
			temp: 3,
			conditions: ["slowed (EoT)", "bleeding (save)", "prone"],
			mine: false,
		});
		expect(view?.combatants[0]?.resource).toBeUndefined();
		expect(view?.combatants[1]).toMatchObject({
			stamina: 13,
			max: 20,
			count: 3,
		});
		expect(view?.combatants[1]?.health).toBeUndefined();
		expect(view?.combatants[2]).toMatchObject({
			resource: "Wrath 4",
			mine: false,
		});
	});
});

describe("sheetText", () => {
	test("a hero's sheet: Stamina, resource, characteristics and every ability's tiers", () => {
		const t = party();
		t.run(GM, { type: "dmg", who: "vex", amount: 11 });
		t.run(GM, {
			type: "cond",
			who: "vex",
			condition: "slowed",
			duration: "eot",
		});
		expect(sheetText(t.ds, "vex")).toBe(
			[
				"Vex: Censor 1",
				"Stamina 10/21 · winded (winded at 10, dead at -10) · Recoveries 8/8, 7 each",
				"Wrath 0 (+2 a turn) · surges 0 · Victories 2 · XP 0",
				"Might +2 · Agility +0 · Reason -1 · Intuition +1 · Presence +2",
				"Speed 5 · Stability 1",
				"Conditions: slowed (EoT)",
				"",
				"Spinning Strike (Main action; Melee, Strike, Weapon; Melee 1; One creature): 2d10 + Might or Agility",
				"  ≤11: 3 damage",
				"  12-16: 5 damage; push 1",
				"  17+: 7 damage; push 2",
				"Spirit Lash (Main action): 2d10 + Presence",
				"  ≤11: 2 holy damage",
				"  12-16: 4 holy damage",
				"  17+: 6 holy damage; taunted (EoT)",
			].join("\n")
		);
	});

	test("a squad's sheet shows the pool and the minions left", () => {
		const t = new Table();
		t.run(GM, {
			type: "add",
			monster: "goblin-runner",
			count: 4,
			sheet: RUNNER,
		});
		t.run(GM, { type: "dmg", who: "goblin-runner-a", amount: 6 });
		expect(sheetText(t.ds, "goblin-r")).toBe(
			[
				"Goblin Runner A: Goblin Runner, level 1 minion harrier",
				"Stamina 14/20 · 3 of 4 minions, 5 each · Free strike 1",
				"Might -2 · Agility +2 · Reason +0 · Intuition +0 · Presence -2",
				"Speed 7 · Stability 0",
				"With a captain: Edge on strikes",
				"",
				"Dagger: 2d10 + 2",
				"  ≤11: 1 damage",
				"  12-16: 2 damage",
				"  17+: 3 damage",
			].join("\n")
		);
	});

	test("an unknown or ambiguous name is refused like a command's target", () => {
		const t = party();
		expect(sheetText(t.ds, "zed")).toEqual({
			refusal: "Nobody at the table is called 'zed'.",
		});
	});
});

const complete = (t: Table, name: string, partial: string, actor = GM) =>
	table.commands
		.find((c) => c.name === name)
		?.complete?.(t.state, partial, actor);

describe("completion", () => {
	test("targets complete by id, your own hero first", () => {
		const t = party();
		t.run(GM, {
			type: "add",
			monster: "goblin-warrior",
			count: 2,
			sheet: GOBLIN,
		});
		expect(complete(t, "dmg", "")).toEqual([
			"vex",
			"kor",
			"goblin-warrior-1",
			"goblin-warrior-2",
		]);
		expect(complete(t, "dmg", "g")).toEqual([
			"goblin-warrior-1",
			"goblin-warrior-2",
		]);
		expect(complete(t, "heal", "", ALICE)).toEqual([
			"vex",
			"kor",
			"goblin-warrior-1",
			"goblin-warrior-2",
		]);
		expect(completeWho(t.ds, "k", ALICE)).toEqual(["kor"]);
	});

	test("power rolls complete ability names after the target; conditions complete too", () => {
		const t = party();
		expect(complete(t, "pr", "vex s", ALICE)).toEqual([
			"vex Spinning Strike",
			"vex Spirit Lash",
		]);
		expect(complete(t, "cond", "kor sl")).toEqual(["kor slowed"]);
		expect(complete(t, "cond", "kor slowed ")).toEqual([
			"kor slowed eot",
			"kor slowed save",
			"kor slowed end",
			"kor slowed by",
		]);
		expect(complete(t, "cond", "kor grabbed eot by v", ALICE)).toEqual([
			"kor grabbed eot by vex",
		]);
		expect(complete(t, "first", "d")).toEqual(["director"]);
	});
});

const parse = (name: string, args: string) =>
	table.commands.find((c) => c.name === name)?.parse(args);

describe("parsing", () => {
	test("each command reads its arguments, or refuses with its usage", () => {
		expect(parse("pr", "vex spinning strike edge bane2")).toEqual({
			type: "pr",
			who: "vex",
			ability: "spinning strike edge bane2",
			edges: 0,
			banes: 0,
		});
		expect(parse("pr", "vex +3 edge2")).toEqual({
			type: "pr",
			who: "vex",
			bonus: 3,
			edges: 2,
			banes: 0,
		});
		expect(parse("pr", "vex")).toEqual({
			refusal:
				"Usage: /pr <who> <ability|+N> [edge|bane|edge2|bane2] [on <target>…]",
		});
		expect(parse("dmg", "goblin-1 7 fire")).toEqual({
			type: "dmg",
			who: "goblin-1",
			amount: 7,
			damageType: "fire",
		});
		expect(parse("dmg", "goblin-1 lots")).toEqual({
			refusal: "Usage: /dmg <who> <n> [type]",
		});
		expect(parse("cond", "vex -slowed")).toEqual({
			type: "cond",
			who: "vex",
			condition: "slowed",
			remove: true,
		});
		expect(parse("cond", "vex sleepy")).toEqual({
			refusal:
				"'sleepy' isn't a condition: bleeding, dazed, frightened, grabbed, prone, restrained, slowed, taunted or weakened.",
		});
		expect(parse("add", "goblin-runner x6 as Raiders")).toEqual({
			type: "add",
			monster: "goblin-runner",
			count: 6,
			as: "Raiders",
		});
		expect(parse("res", "vex 2")).toEqual({
			refusal: "Usage: /res <hero> <+N|-N>",
		});
		expect(parse("res", "vex +2")).toEqual({ type: "res", who: "vex", by: 2 });
		expect(parse("victory", "+1")).toEqual({ type: "victory", by: 1 });
		expect(parse("token", "reset")).toEqual({ type: "token", change: "reset" });
		expect(parse("recover", "vex ally")).toEqual({
			type: "recover",
			who: "vex",
			ally: true,
		});
		expect(parse("play", "kor Bob Smith")).toEqual({
			type: "play",
			hero: "kor",
			player: "Bob Smith",
		});
		expect(parse("turn", "")).toEqual({ type: "turn" });
	});
});
