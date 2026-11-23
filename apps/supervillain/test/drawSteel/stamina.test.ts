import { describe, expect, test } from "bun:test";

import {
	ALICE,
	fixedDice,
	GM,
	GOBLIN,
	IMP,
	KOR,
	party,
	RUNNER,
	Table,
	VEX,
} from "./harness.ts";

describe("damage to a hero", () => {
	test("max 21: winded at 10, dying at 0, dead at -10", () => {
		const t = party();
		t.run(GM, { type: "dmg", who: "vex", amount: 10 });
		expect(t.hero("vex").stamina).toBe(11);
		expect(t.lastFeed()).toEqual(["Vex takes 10 damage → 11/21"]);
		t.run(GM, { type: "dmg", who: "vex", amount: 1 });
		expect(t.lastFeed()).toEqual(["Vex takes 1 damage → 10/21 · winded"]);
		t.run(GM, { type: "dmg", who: "vex", amount: 9 });
		expect(t.lastFeed()).toEqual(["Vex takes 9 damage → 1/21 · winded"]);
		t.run(GM, { type: "dmg", who: "vex", amount: 1 });
		expect(t.lastFeed()).toEqual(["Vex takes 1 damage → 0/21 · dying"]);
		t.run(GM, { type: "dmg", who: "vex", amount: 9 });
		expect(t.lastFeed()).toEqual(["Vex takes 9 damage → -9/21 · dying"]);
		t.run(GM, { type: "dmg", who: "vex", amount: 1 });
		expect(t.hero("vex").stamina).toBe(-10);
		expect(t.lastFeed()).toEqual(["Vex takes 1 damage → -10/21 · dead"]);
		expect(t.submit(GM, { type: "dmg", who: "vex", amount: 1 })).toBe(
			"Vex is dead."
		);
	});

	test("temporary Stamina absorbs first, and doesn't stack: the larger stays", () => {
		const t = party();
		t.run(GM, { type: "temp", who: "vex", amount: 5 });
		expect(t.lastFeed()).toEqual(["Vex has 5 temporary Stamina."]);
		expect(t.submit(GM, { type: "temp", who: "vex", amount: 3 })).toBe(
			"Vex already has 5 temporary Stamina, and it doesn't stack."
		);
		t.run(GM, { type: "dmg", who: "vex", amount: 7 });
		expect(t.hero("vex")).toMatchObject({ stamina: 19, temp: 0 });
		expect(t.lastFeed()).toEqual([
			"Vex takes 7 damage (5 to temporary Stamina) → 19/21",
		]);
		t.run(GM, { type: "temp", who: "vex", amount: 3 });
		t.run(GM, { type: "temp", who: "vex", amount: 8 });
		t.run(GM, { type: "dmg", who: "vex", amount: 2 });
		expect(t.hero("vex")).toMatchObject({ stamina: 19, temp: 6 });
	});

	test("a hero's weakness adds to typed damage", () => {
		const t = party();
		t.run(GM, { type: "dmg", who: "kor", amount: 5, damageType: "holy" });
		expect(t.hero("kor").stamina).toBe(16);
		expect(t.lastFeed()).toEqual([
			"Kor takes 8 holy damage (5 +3 weakness) → 16/24",
		]);
		t.run(GM, { type: "dmg", who: "kor", amount: 5, damageType: "fire" });
		expect(t.hero("kor").stamina).toBe(11);
	});
});

const imp = () => {
	const t = new Table();
	t.run(GM, { type: "add", monster: "ember-imp", count: 1, sheet: IMP });

	return t;
};

describe("damage modifiers", () => {
	test("the highest applicable weakness adds, then the highest applicable immunity subtracts", () => {
		const t = imp();
		t.run(GM, {
			type: "dmg",
			who: "ember-imp",
			amount: 10,
			damageType: "holy",
		});
		expect(t.creature("ember-imp").stamina).toBe(28);
		expect(t.lastFeed()).toEqual([
			"Ember Imp takes 12 holy damage (10 +4 weakness -2 immunity) → 28/40",
		]);
		t.run(GM, { type: "dmg", who: "ember-imp", amount: 6 });
		expect(t.creature("ember-imp").stamina).toBe(23);
	});

	test("immunity applies last: 3 fire against fire immunity 5 and weakness 1 is 0", () => {
		const t = imp();
		t.run(GM, { type: "dmg", who: "ember-imp", amount: 3, damageType: "fire" });
		expect(t.creature("ember-imp").stamina).toBe(40);
		expect(t.lastFeed()).toEqual([
			"Ember Imp takes 0 fire damage (3 +1 weakness -5 immunity) → 40/40",
		]);
	});
});

describe("creatures and minion squads", () => {
	test("a creature dies at 0", () => {
		const t = new Table();
		t.run(GM, {
			type: "add",
			monster: "goblin-warrior",
			count: 1,
			sheet: GOBLIN,
		});
		t.run(GM, { type: "dmg", who: "goblin-warrior", amount: 8 });
		expect(t.lastFeed()).toEqual([
			"Goblin Warrior takes 8 damage → 7/15 · winded",
		]);
		t.run(GM, { type: "dmg", who: "goblin-warrior", amount: 20 });
		expect(t.creature("goblin-warrior").stamina).toBe(0);
		expect(t.lastFeed()).toEqual([
			"Goblin Warrior takes 20 damage → 0/15 · dead",
		]);
	});

	test("a squad of 4 minions at 5 Stamina shares 20; 12 damage leaves 2", () => {
		const t = new Table();
		t.run(GM, {
			type: "add",
			monster: "goblin-runner",
			count: 4,
			sheet: RUNNER,
		});
		expect(t.creature("goblin-runner-a")).toMatchObject({
			stamina: 20,
			max: 20,
			squad: 4,
		});
		t.run(GM, { type: "dmg", who: "goblin-runner-a", amount: 12 });
		expect(t.creature("goblin-runner-a").stamina).toBe(8);
		expect(t.lastFeed()).toEqual([
			"Goblin Runner A takes 12 damage → 8/20 · 2 minions die, 2 left",
		]);
		t.run(GM, { type: "dmg", who: "goblin-runner-a", amount: 3 });
		expect(t.lastFeed()).toEqual([
			"Goblin Runner A takes 3 damage → 5/20 · 1 minion dies, 1 left",
		]);
		t.run(GM, { type: "dmg", who: "goblin-runner-a", amount: 9 });
		expect(t.lastFeed()).toEqual([
			"Goblin Runner A takes 9 damage → 0/20 · the squad is dead",
		]);
	});

	test("minions can't regain Stamina or gain temporary Stamina", () => {
		const t = new Table();
		t.run(GM, {
			type: "add",
			monster: "goblin-runner",
			count: 4,
			sheet: RUNNER,
		});
		t.run(GM, { type: "dmg", who: "goblin-runner-a", amount: 4 });
		expect(
			t.submit(GM, { type: "heal", who: "goblin-runner-a", amount: 4 })
		).toBe("Minions can't regain Stamina.");
		expect(
			t.submit(GM, { type: "temp", who: "goblin-runner-a", amount: 4 })
		).toBe("Minions can't gain temporary Stamina.");
	});

	test("a free strike deals the creature's fixed damage, through the target's modifiers", () => {
		const t = party();
		t.run(GM, {
			type: "add",
			monster: "goblin-warrior",
			count: 1,
			sheet: GOBLIN,
		});
		t.run(GM, { type: "fs", who: "goblin-warrior", target: "vex" });
		expect(t.hero("vex").stamina).toBe(19);
		expect(t.lastFeed()).toEqual([
			"Goblin Warrior free strikes: Vex takes 2 damage → 19/21",
		]);
		expect(
			t.submit(GM, { type: "fs", who: "vex", target: "goblin-warrior" })
		).toBe("Only a creature has a free strike to make; Vex is a hero.");
	});
});

describe("healing and Recoveries", () => {
	test("healing caps at max", () => {
		const t = party();
		t.run(GM, { type: "dmg", who: "vex", amount: 11 });
		t.run(ALICE, { type: "heal", who: "vex", amount: 20 });
		expect(t.hero("vex").stamina).toBe(21);
		expect(t.lastFeed()).toEqual(["Vex regains 11 Stamina → 21/21"]);
	});

	test("a Recovery heals a third of max, rounded down, unless the sheet says otherwise", () => {
		const t = party();
		t.run(GM, { type: "dmg", who: "vex", amount: 11 });
		t.run(ALICE, { type: "recover", who: "vex", ally: false });
		expect(t.hero("vex")).toMatchObject({ stamina: 17, recoveries: 7 });
		expect(t.lastFeed()).toEqual([
			"Vex spends a Recovery and regains 7 Stamina → 17/21 (7/8 left)",
		]);
		t.run(GM, { type: "dmg", who: "kor", amount: 12 });
		t.run(GM, { type: "recover", who: "kor", ally: false });
		expect(t.hero("kor").stamina).toBe(21);
	});

	test("a dying hero can't Catch Breath in combat, but an ally's ability can spend one", () => {
		const t = party();
		t.run(GM, { type: "start" }, fixedDice(1));
		t.run(GM, { type: "dmg", who: "vex", amount: 23 });
		expect(t.submit(ALICE, { type: "recover", who: "vex", ally: false })).toBe(
			"Vex is dying and can't Catch Breath; /recover vex ally if an ally's ability lets them spend one."
		);
		t.run(ALICE, { type: "recover", who: "vex", ally: true });
		expect(t.hero("vex").stamina).toBe(5);
		expect(t.lastFeed()).toEqual([
			"Vex spends a Recovery through an ally and regains 7 Stamina → 5/21 · winded (7/8 left)",
		]);
	});

	test("no Recoveries left, no Recovery", () => {
		const t = new Table();
		t.run(GM, { type: "hero", hero: "vex", sheet: { ...VEX, recoveries: 1 } });
		t.run(GM, { type: "dmg", who: "vex", amount: 10 });
		t.run(GM, { type: "recover", who: "vex", ally: false });
		expect(t.submit(GM, { type: "recover", who: "vex", ally: false })).toBe(
			"Vex has no Recoveries left."
		);
	});

	test("a respite restores Stamina and Recoveries, but not during combat", () => {
		const t = party();
		t.run(GM, { type: "dmg", who: "kor", amount: 12 });
		t.run(GM, { type: "recover", who: "kor", ally: false });
		t.run(GM, { type: "start" }, () => 7);
		expect(t.submit(GM, { type: "rest" })).toBe(
			"Finish the combat first (/end)."
		);
		t.run(GM, { type: "end" });
		t.run(GM, { type: "rest" });
		expect(t.hero("kor")).toMatchObject({
			stamina: 24,
			recoveries: 10,
			temp: 0,
		});
		expect(KOR.recoveries).toBe(10);
	});
});

describe("who may change what", () => {
	test("a player changes only their own hero; the GM changes anyone", () => {
		const t = party();
		const own = "You can only change your own hero.";
		expect(t.submit(ALICE, { type: "dmg", who: "kor", amount: 3 })).toBe(own);
		expect(t.submit(ALICE, { type: "heal", who: "kor", amount: 3 })).toBe(own);
		expect(t.submit(ALICE, { type: "temp", who: "kor", amount: 3 })).toBe(own);
		expect(t.submit(ALICE, { type: "recover", who: "kor", ally: false })).toBe(
			own
		);
		expect(t.submit(ALICE, { type: "res", who: "kor", by: 1 })).toBe(own);
		expect(t.submit(ALICE, { type: "surge", who: "kor", by: 1 })).toBe(own);
		expect(
			t.submit(ALICE, { type: "cond", who: "kor", condition: "prone" })
		).toBe(own);
		expect(
			t.submit(ALICE, { type: "dmg", who: "vex", amount: 3 })
		).toBeUndefined();
		expect(
			t.submit(GM, { type: "dmg", who: "kor", amount: 3 })
		).toBeUndefined();
	});
});
