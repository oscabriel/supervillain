import { describe, expect, test } from "bun:test";

import {
	bandOf,
	completeLine,
	GM,
	helpText,
	mapOf,
	parseInputLine,
	rules,
	sheetOf,
	tableLabel,
	unknownHelpTopic,
} from "@supervillain/domain";
import { Predicate } from "effect";

import { VEX } from "../drawSteel/harness.ts";
import { must } from "../game/must.ts";
import { ALICE, Table } from "../game/table.ts";
import { character, recorded } from "./harness.ts";

const parsed = (line: string, ruleset: "draw-steel" | "set-world") => {
	const p = parseInputLine(line, "chat", ruleset);

	if (p.kind === "command") {
		return p.command;
	}

	return p.kind === "refusal" ? p.message : p.kind;
};

describe("the campaign's ruleset gates the commands", () => {
	test("a Draw Steel table doesn't know set.world's commands, nor a set.world table Draw Steel's", () => {
		expect(parsed("/recruit Ada 101", "draw-steel")).toStartWith(
			"Unknown command /recruit."
		);
		expect(parsed("/attack ada grub", "draw-steel")).toStartWith(
			"Unknown command /attack."
		);
		expect(parsed("/hero brann", "set-world")).toStartWith(
			"Unknown command /hero."
		);
		expect(parsed("/pr ada +2", "set-world")).toStartWith(
			"Unknown command /pr."
		);
		expect(parsed("/roll d6", "set-world")).toEqual({
			type: "roll",
			notation: "1d6",
		});
	});

	test("a shared word means each ruleset's own command", () => {
		expect(parsed("/map ford-road", "draw-steel")).toEqual({
			type: "map",
			id: "ford-road",
		});
		expect(parsed("/map ford-road", "set-world")).toEqual({
			type: "set-map",
			id: "ford-road",
		});
		expect(parsed("/move ada c5", "set-world")).toEqual({
			type: "set-move",
			who: "ada",
			to: { x: 2, y: 4 },
		});
		expect(parsed("/done", "set-world")).toEqual({ type: "set-done" });
		expect(parsed("/recruit Old Grub 4294967295", "set-world")).toEqual({
			type: "set-recruit",
			name: "Old Grub",
			seed: 4_294_967_295,
		});
		expect(parsed("/foe Grub 4294967296", "set-world")).toBe(
			"A set.world seed is a whole number from 0 to 4294967295."
		);
		expect(parsed("/recruit 7", "set-world")).toEqual({
			type: "set-recruit",
			name: "7",
		});
	});

	test("/help and Tab offer the table's own commands", () => {
		const steel = helpText(GM, undefined, "seat", "draw-steel");
		const set = helpText(GM, undefined, "seat", "set-world");
		expect(steel).toContain("/hero <hero id>");
		expect(steel).not.toContain("/recruit");
		expect(set).toContain("/recruit <name> [seed]");
		expect(set).toContain("/attack <who> <target>");
		expect(set).toContain("/map <map id>|off");
		expect(set).not.toContain("/hero");
		expect(set).toContain("Show a fighter's sheet, to you alone.");
		expect(helpText(GM, "attack", "seat", "set-world")).toBe(
			"/attack <who> <target>  Attack once on its turn, for 20 stamina, if its weapon reaches."
		);
		expect(unknownHelpTopic("attack", "draw-steel")).toStartWith(
			"Unknown command /attack."
		);
		expect(completeLine(rules.initial, GM, "/a", "set-world")).toEqual([
			"/attack ",
			"/auto ",
		]);
		expect(completeLine(rules.initial, GM, "/a", "draw-steel")).toEqual([
			"/add ",
		]);
	});

	test("Tab after a set.world command offers fighters, the player's own first", () => {
		const table = new Table();
		table.run(GM, { type: "set-recruit", name: "Ada", character: character() });
		table.run(GM, { type: "set-recruit", name: "Abe", character: character() });
		table.run(GM, { type: "set-foe", name: "Grub", character: character() });
		table.run(ALICE, { type: "set-play", who: "abe" });
		const { state } = table;
		expect(completeLine(state, ALICE, "/sheet a", "set-world")).toEqual([
			"/sheet abe",
			"/sheet ada",
		]);
		expect(completeLine(state, ALICE, "/attack abe g", "set-world")).toEqual([
			"/attack abe grub",
		]);
		expect(completeLine(state, ALICE, "/play ", "set-world")).toEqual([
			"/play ada",
		]);
		expect(completeLine(state, ALICE, "/sheet a", "draw-steel")).toEqual([]);
	});
});

const midFight = (): Table => {
	const table = new Table();
	table.run(ALICE, { type: "name", name: "Alice" });
	table.run(GM, {
		type: "set-recruit",
		name: "Ada",
		character: recorded(101),
	});
	table.run(GM, { type: "set-foe", name: "Grub", character: recorded(501) });
	table.run(GM, {
		type: "set-map",
		id: "field",
		grid: { name: "Field", terrain: ["........", "........"] },
	});
	table.run(ALICE, { type: "set-play", who: "ada" });
	table.run(GM, { type: "set-place", who: "ada", at: { x: 0, y: 0 } });
	table.run(GM, { type: "set-place", who: "grub", at: { x: 7, y: 1 } });
	table.run(GM, { type: "set-start" });

	return table;
};

describe("what a set.world seat sees", () => {
	test("the band: every fighter by turn, health as the meter, the clock in the title", () => {
		const { state } = midFight();
		expect(bandOf(state, ALICE, "draw-steel")).toBeUndefined();
		const band = must(bandOf(state, ALICE, "set-world"));
		expect(band.title).toBe(" set.world · 0.93 s · turn 1: Ada ");
		expect(
			band.combatants.map((c) => [
				c.name,
				c.side,
				c.stamina,
				c.max,
				c.acting,
				c.mine,
				c.mark,
			])
		).toEqual([
			["Ada", "heroes", 191, 191, true, true, "A"],
			["Grub", "director", 150, 150, false, false, "g"],
		]);
		expect(must(band.combatants[0]).resource).toBe(
			"stamina 102/102 · Wayguard, targe"
		);
		expect(must(must(bandOf(state, GM, "set-world")).combatants[0]).name).toBe(
			"Ada (Alice)"
		);
		expect(tableLabel(state, "set-world")(ALICE)).toBe("Alice (Ada)");
	});

	test("a standing party member nobody plays is free to take; a foe never is", () => {
		const table = new Table();
		table.run(GM, {
			type: "set-recruit",
			name: "Ada",
			character: recorded(101),
		});
		table.run(GM, { type: "set-foe", name: "Grub", character: recorded(501) });

		const free = () =>
			must(bandOf(table.state, ALICE, "set-world")).combatants.map(
				(c) => c.free
			);

		expect(free()).toEqual([true]);
		table.run(GM, { type: "set-start" });
		expect(free()).toEqual([true, undefined]);
		table.run(ALICE, { type: "set-play", who: "ada" });
		expect(free()).toEqual([undefined, undefined]);
	});

	test("a player is labelled by what they play in the table's ruleset, never the other's", () => {
		const table = new Table();
		table.run(ALICE, { type: "name", name: "Alice" });
		table.run(GM, { type: "hero", hero: "vex", sheet: VEX });
		table.run(ALICE, { type: "play", hero: "vex" });
		expect(tableLabel(table.state, "set-world")(ALICE)).toBe("Alice");
		table.run(GM, { type: "set-recruit", name: "Ada", character: character() });
		table.run(ALICE, { type: "set-play", who: "ada" });
		expect(tableLabel(table.state, "draw-steel")(ALICE)).toBe("Alice (Vex)");
		expect(tableLabel(table.state, "set-world")(ALICE)).toBe("Alice (Ada)");
	});

	test("the map: tokens with their marks, and where the fighter whose turn it is can go", () => {
		const { state } = midFight();
		expect(mapOf(state, ALICE, "draw-steel")).toBeUndefined();
		const map = must(mapOf(state, ALICE, "set-world"));
		expect(map.name).toBe("Field");
		expect(
			map.tokens.map((t) => [t.mark, t.x, t.y, t.side, t.mine, t.acting])
		).toEqual([
			["A", 0, 0, "heroes", true, true],
			["g", 7, 1, "director", false, false],
		]);
		expect(map.reachLabel).toBe("Ada can reach: speed 5");
		expect(map.reach).toContainEqual({ x: 5, y: 1 });
		expect(map.reach).not.toContainEqual({ x: 6, y: 0 });
	});

	test("/sheet: class, flavor, numbers, weapon, stats and every piece of gear", () => {
		const { state } = midFight();
		const sheet = sheetOf(state, "ada", "set-world");

		const lines = must(
			Predicate.isString(sheet) ? sheet : undefined,
			"the sheet as text"
		).split("\n");

		expect(lines[0]).toBe(
			"Ada: Wayguard, of the party (set.world seed 101, power 1271)"
		);
		expect(lines[1]).toStartWith("The Wayguard walks the trade roads");
		expect(lines[2]).toBe(
			"Health 191/191 · stamina 102/102 · speed 5 · initiative 1.08, a turn every 928 ms"
		);
		expect(lines[3]).toBe(
			"Weapon: targe (melee, reaches 1) · physical 35.5 damage"
		);
		expect(lines.at(-1)).toContain("fine copper grips; cotton wraps");
		expect(lines.at(-1)).toContain("silk ring; brittle brutal velvet claw");
		expect(sheetOf(state, "ada", "draw-steel")).toEqual({
			refusal: "Nobody at the table is called 'ada'.",
		});
	});
});
