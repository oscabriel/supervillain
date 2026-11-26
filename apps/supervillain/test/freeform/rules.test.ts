import { describe, expect, test } from "bun:test";

import {
	bandOf,
	completeLine,
	feedLines,
	fightLinesOf,
	inCombatOf,
	mapOf,
	parseInputLine,
	partyOf,
	plainText,
	prepOf,
	readLog,
	resyncLinesOf,
	sheetOf,
	tableLabel,
} from "@supervillain/domain";
import type { FfSheet, MapGrid } from "@supervillain/domain";
import { Schema } from "effect";

import { fold, throughJson } from "../game/fold.ts";
import { ALICE, BOB, fixedDice, GM, Table } from "../game/table.ts";

const ROOK: FfSheet = {
	id: "rook",
	name: "Rook",
	concept: "Disgraced duelist",
	dice: "d20",
	stats: { might: 1, wits: 2 },
	resources: { hp: 10 },
	tags: ["brave"],
	notes: [{ kind: "para", text: "Owes a debt." }],
};

const WREN: FfSheet = {
	id: "wren",
	name: "Wren",
	stats: { might: 0 },
	resources: { luck: 3 },
};

const THUG: FfSheet = {
	id: "thug",
	name: "Dock Thug",
	stats: { might: 2 },
	resources: { hp: 6 },
};

const FIELD: MapGrid = {
	name: "The Wharf",
	terrain: ["......", "..#...", "......", "......"],
};

const feed = (table: Table) =>
	feedLines(table.state, tableLabel(table.state, "freeform")).map(plainText);

const last = (table: Table) => feed(table).at(-1);

const party = (): Table => {
	const table = new Table();
	table.run(GM, { type: "ff-pc", id: "rook", sheet: ROOK });
	table.run(GM, { type: "ff-pc", id: "wren", sheet: WREN });
	table.run(ALICE, { type: "name", name: "Alice" });
	table.run(ALICE, { type: "ff-play", who: "rook", seated: [ALICE] });

	return table;
};

describe("freeform: the party and its foes", () => {
	test("/pc brings a character from its sheet; again, it reloads the sheet and keeps its state", () => {
		const table = party();

		expect(table.state.ff.figures.map((f) => [f.id, f.side, f.player])).toEqual(
			[
				["rook", "party", ALICE],
				["wren", "party", undefined],
			]
		);
		table.run(GM, {
			type: "ff-stat",
			who: "rook",
			key: "hp",
			op: "add",
			amount: -4,
		});
		table.run(GM, {
			type: "ff-pc",
			id: "rook",
			sheet: { ...ROOK, resources: { hp: 5 }, stats: { might: 3 } },
		});

		const [rook] = table.state.ff.figures;

		expect(rook?.values).toEqual({ might: 3, hp: 5 });
		expect(rook?.player).toBe(ALICE);
		expect(last(table)).toBe("Rook's sheet is loaded again.");
	});

	test("/pc again keeps a stat changed in play while its base is the same, and takes a new base", () => {
		const table = party();

		table.run(GM, {
			type: "ff-stat",
			who: "rook",
			key: "might",
			op: "set",
			amount: 4,
		});
		table.run(GM, { type: "ff-pc", id: "rook", sheet: ROOK });

		expect(table.state.ff.figures[0]?.values).toEqual({
			might: 4,
			wits: 2,
			hp: 10,
		});

		table.run(GM, {
			type: "ff-pc",
			id: "rook",
			sheet: { ...ROOK, stats: { might: 1, wits: 5 } },
		});

		expect(table.state.ff.figures[0]?.values).toEqual({
			might: 4,
			wits: 5,
			hp: 10,
		});

		table.run(GM, {
			type: "ff-pc",
			id: "rook",
			sheet: { ...ROOK, stats: { might: 2, wits: 5 } },
		});

		expect(table.state.ff.figures[0]?.values).toEqual({
			might: 2,
			wits: 5,
			hp: 10,
		});
	});

	test("decide refuses what apply would halt on: a foe's id for /pc, too many foes, a bad tag", () => {
		const table = party();
		table.run(GM, { type: "ff-add", monster: "thug", count: 1, sheet: THUG });
		const before = table.envelopes.length;

		expect(
			table.submit(GM, {
				type: "ff-pc",
				id: "thug",
				sheet: { ...ROOK, id: "thug", name: "Thug" },
			})
		).toBe(
			"Dock Thug is one of the foes, and a party member needs an id of their own."
		);
		expect(
			table.submit(GM, {
				type: "ff-add",
				monster: "thug",
				count: 13,
				sheet: THUG,
			})
		).toBe("Add 1 to 12 at a time.");
		expect(
			table.submit(GM, {
				type: "ff-tag",
				who: "rook",
				tag: "Not A Tag",
				on: true,
			})
		).toBe(
			"'Not A Tag' isn't a tag: lower-case letters, digits and hyphens, at most 24."
		);
		expect(table.envelopes.length).toBe(before);
	});

	test("/add numbers several figures from one sheet, and players can't add", () => {
		const table = party();
		table.run(GM, { type: "ff-add", monster: "thug", count: 3, sheet: THUG });

		expect(
			table.state.ff.figures.slice(2).map((f) => [f.id, f.name, f.side])
		).toEqual([
			["thug-1", "Dock Thug 1", "foes"],
			["thug-2", "Dock Thug 2", "foes"],
			["thug-3", "Dock Thug 3", "foes"],
		]);
		expect(last(table)).toBe(
			"3 of Dock Thug come to the table: Dock Thug 1, Dock Thug 2, Dock Thug 3."
		);
		expect(
			table.submit(ALICE, {
				type: "ff-add",
				monster: "thug",
				count: 1,
				sheet: THUG,
			})
		).toBe("Only the GM can use /add.");
	});

	test("a sheet the table can't show is refused at the door", () => {
		const table = new Table();

		expect(
			table.submit(GM, {
				type: "ff-pc",
				id: "x",
				sheet: { id: "x", name: "Bad\u001B[31m" },
			})
		).toContain("the name must be text");
		expect(
			table.submit(GM, {
				type: "ff-pc",
				id: "x",
				sheet: {
					id: "x",
					name: "Twice",
					stats: { hp: 1 },
					resources: { hp: 2 },
				},
			})
		).toBe("party/x.md: hp can't be both a stat and a resource.");
		expect(table.submit(GM, { type: "ff-pc", id: "x" })).toBe(
			"No sheet for 'x' was loaded."
		);
	});

	test("/play and /unplay hand characters round; foes and taken ones are refused", () => {
		const table = party();
		table.run(GM, { type: "ff-add", monster: "thug", count: 1, sheet: THUG });

		expect(
			table.submit(BOB, { type: "ff-play", who: "rook", seated: [ALICE, BOB] })
		).toBe("Someone else plays Rook.");
		expect(
			table.submit(BOB, { type: "ff-play", who: "thug", seated: [BOB] })
		).toBe("Dock Thug is one of the foes.");
		expect(
			table.submit(ALICE, { type: "ff-play", who: "wren", seated: [ALICE] })
		).toBe("You play Rook; /unplay first.");
		table.run(ALICE, { type: "ff-unplay" });
		table.run(BOB, { type: "ff-play", who: "rook", seated: [BOB] });
		expect(table.state.ff.figures[0]?.player).toBe(BOB);
		expect(tableLabel(table.state, "freeform")(BOB)).toBe("Zyxwvuts (Rook)");
	});
});

describe("freeform: stats, tags and checks", () => {
	test("/stat adjusts or sets a stat; resources stay within 0 and their maximum", () => {
		const table = party();
		table.run(ALICE, {
			type: "ff-stat",
			who: "rook",
			key: "hp",
			op: "add",
			amount: -15,
		});

		expect(table.state.ff.figures[0]?.values.hp).toBe(0);
		expect(last(table)).toBe("Rook's hp: 10 → 0/10.");
		table.run(ALICE, {
			type: "ff-stat",
			who: "rook",
			key: "might",
			op: "set",
			amount: 4,
		});
		expect(table.state.ff.figures[0]?.values.might).toBe(4);
		expect(
			table.submit(ALICE, {
				type: "ff-stat",
				who: "wren",
				key: "luck",
				op: "add",
				amount: 1,
			})
		).toBe("You don't play Wren.");
		expect(
			table.submit(ALICE, {
				type: "ff-stat",
				who: "rook",
				key: "grit",
				op: "add",
				amount: 1,
			})
		).toBe("Rook has no grit; there are: might, wits, hp.");
		expect(
			table.submit(ALICE, {
				type: "ff-stat",
				who: "rook",
				key: "hp",
				op: "set",
				amount: 0,
			})
		).toBe("Rook's hp is 0 already.");
	});

	test("/tag puts tags on and takes them off", () => {
		const table = party();
		table.run(ALICE, { type: "ff-tag", who: "rook", tag: "hidden", on: true });

		expect(table.state.ff.figures[0]?.tags).toEqual(["brave", "hidden"]);
		expect(last(table)).toBe("Rook is hidden.");
		table.run(ALICE, { type: "ff-tag", who: "rook", tag: "brave", on: false });
		expect(table.state.ff.figures[0]?.tags).toEqual(["hidden"]);
		expect(
			table.submit(ALICE, {
				type: "ff-tag",
				who: "rook",
				tag: "brave",
				on: false,
			})
		).toBe("Rook isn't tagged brave already.");
	});

	test("/check rolls the sheet's dice plus the stat, for your own character", () => {
		const table = party();
		table.run(ALICE, { type: "ff-check", stat: "wits" }, fixedDice(13));

		expect(table.last?.payload).toEqual({
			id: "rook",
			stat: "wits",
			value: 2,
			notation: "1d20",
			rolls: [13],
			total: 15,
		});
		expect(last(table)).toBe("Rook checks wits: 1d20 [13] +2 = 15.");
		table.run(
			GM,
			{ type: "ff-check", who: "wren", stat: "might", dice: "2d6+1" },
			fixedDice(3, 4)
		);
		expect(last(table)).toBe("Wren checks might: 2d6+1 [3, 4] +0 = 8.");
		expect(table.submit(GM, { type: "ff-check", stat: "might" })).toBe(
			"Usage: /check <who> <stat> [dice]"
		);
	});
});

describe("freeform: the map and turns", () => {
	test("/map, /place and /move put figures on the board; walls and others are in the way", () => {
		const table = party();
		table.run(GM, { type: "ff-map", id: "wharf", grid: FIELD });
		table.run(ALICE, { type: "ff-place", who: "rook", at: { x: 0, y: 0 } });

		expect(
			table.submit(GM, { type: "ff-place", who: "wren", at: { x: 2, y: 1 } })
		).toBe("c2 is a wall.");
		expect(
			table.submit(GM, { type: "ff-place", who: "wren", at: { x: 0, y: 0 } })
		).toBe("a1 is taken by Rook.");
		table.run(ALICE, { type: "ff-move", who: "rook", to: { x: 4, y: 3 } });
		expect(table.state.ff.figures[0]?.at).toEqual({ x: 4, y: 3 });

		const view = mapOf(table.state, ALICE, "freeform");

		expect(view?.tokens.map((t) => [t.id, t.mine])).toEqual([["rook", true]]);
		table.run(GM, { type: "ff-map" });
		expect(table.state.ff.figures[0]?.at).toBeUndefined();
	});

	test("/start, /next and /end run rounds; only the GM or the acting player moves turns on", () => {
		const table = party();
		table.run(GM, { type: "ff-add", monster: "thug", count: 1, sheet: THUG });
		table.run(GM, { type: "ff-start", who: [] });

		expect(table.state.ff.order).toEqual({
			ids: ["rook", "wren", "thug"],
			turn: 0,
			round: 1,
		});
		expect(inCombatOf(table.state, "freeform")).toBe(true);
		table.run(ALICE, { type: "ff-next" });
		expect(table.submit(ALICE, { type: "ff-next" })).toBe(
			"It's Wren's turn, not yours to end."
		);
		table.run(GM, { type: "ff-next" });
		table.run(GM, { type: "ff-next" });
		expect(table.state.ff.order).toEqual({
			ids: ["rook", "wren", "thug"],
			turn: 0,
			round: 2,
		});
		expect(last(table)).toBe("Round 2: Rook's turn.");
		expect(bandOf(table.state, ALICE, "freeform")?.title).toBe(
			" round 2: Rook "
		);
		table.run(GM, { type: "ff-end" });
		expect(table.state.ff.order).toBeUndefined();
		expect(last(table)).toBe("Turns end after round 2.");
	});

	test("/start in a named order, and /remove takes a figure out of it", () => {
		const table = party();
		table.run(GM, { type: "ff-start", who: ["wren", "rook"] });
		table.run(GM, { type: "ff-remove", who: "wren" });

		expect(table.state.ff.order).toEqual({ ids: ["rook"], turn: -1, round: 1 });
		table.run(GM, { type: "ff-next" });
		expect(table.state.ff.order?.turn).toBe(0);
		expect(table.submit(GM, { type: "ff-start", who: [] })).toBe(
			"Turns are going already; /end ends them."
		);
	});
});

describe("freeform: undo, replay and views", () => {
	test("a player takes back their own change; a check rolled stays the GM's to undo", () => {
		const table = party();
		table.run(ALICE, {
			type: "ff-stat",
			who: "rook",
			key: "hp",
			op: "add",
			amount: -3,
		});
		table.run(ALICE, { type: "undo" });

		expect(table.state.ff.figures[0]?.values.hp).toBe(10);
		table.run(ALICE, { type: "ff-check", stat: "might" }, fixedDice(5));
		expect(table.submit(ALICE, { type: "undo" })).toBe(
			"That change rolled dice, so only the GM can take it back."
		);
		table.run(GM, { type: "undo" });
	});

	test("the log replays through JSON, and readLog folds it the same", () => {
		const table = party();
		table.run(GM, { type: "ff-add", monster: "thug", count: 2, sheet: THUG });
		table.run(GM, { type: "ff-start", who: [] });
		table.run(ALICE, { type: "ff-check", stat: "wits" }, fixedDice(7));

		const folded = fold(table.rules, throughJson(table.envelopes), {
			strict: true,
		});

		expect(folded.error).toBeUndefined();
		expect(folded.state.ff).toEqual(table.state.ff);

		const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

		const read = readLog(
			table.envelopes.map((e) => encode(e)),
			"freeform"
		);

		expect(read.skipped).toEqual([]);
		expect(read.state.ff).toEqual(table.state.ff);
	});

	test("the sheet, the party and the band show what the table plays", () => {
		const table = party();

		expect(sheetOf(table.state, "rook", "freeform")).toBe(
			[
				"Rook — Disgraced duelist · of the party",
				"Stats: might 1, wits 2",
				"Resources: hp 10/10",
				"Checks roll d20 plus the stat.",
				"Tags: brave",
				"",
				"Owes a debt.",
			].join("\n")
		);
		expect(partyOf(table.state, BOB, "freeform")).toEqual([
			{
				id: "rook",
				name: "Rook",
				player: "Alice",
				mine: false,
				free: false,
				down: false,
				health: { label: "hp", value: 10, max: 10 },
				summary: "Disgraced duelist · might 1 · wits 2",
				tags: ["brave"],
			},
			{
				id: "wren",
				name: "Wren",
				mine: false,
				free: true,
				down: false,
				health: { label: "luck", value: 3, max: 3 },
				summary: "might 0",
				tags: [],
			},
		]);
		expect(
			bandOf(table.state, ALICE, "freeform")?.combatants.map((c) => [
				c.name,
				c.mine,
			])
		).toEqual([
			["Rook", true],
			["Wren", false],
		]);
	});

	test("prep offers the party and the foes, and fight and resync lines speak freeform", () => {
		const table = party();

		const catalog = {
			heroes: [
				{ id: "rook", name: "Rook" },
				{ id: "ash", name: "Ash" },
			],
			monsters: [{ id: "thug", name: "Dock Thug" }],
			maps: [],
		};

		const prep = prepOf(table.state, catalog, "freeform");

		expect(
			prep.sections.map((s) => [s.title, s.items.map((i) => i.line)])
		).toEqual([
			["party", ["/pc ash"]],
			["foes", ["/add thug"]],
		]);
		expect(prep.start).toEqual({ line: "/start" });
		expect(
			fightLinesOf(
				{ map: "wharf", monsters: [{ id: "thug", count: 3 }, { id: "boss" }] },
				"freeform"
			)
		).toEqual(["/map wharf", "/add 3 thug", "/add boss"]);
		expect(resyncLinesOf(table.state, ["rook", "thug"], "freeform")).toEqual([
			"/pc rook",
		]);
	});

	test("every ruleset answers party, combat, fight and resync", () => {
		const table = new Table();
		const encounter = { map: "m", monsters: [{ id: "rat", count: 2 }] };

		expect(fightLinesOf(encounter, "draw-steel")).toEqual([
			"/map m",
			"/add rat x2",
		]);
		expect(fightLinesOf(encounter, "pf2e")).toEqual(["/map m", "/add rat x2"]);
		expect(fightLinesOf(encounter, "set-world")).toEqual([
			"/map m",
			"/foe rat",
			"/foe rat-2",
		]);

		for (const ruleset of [
			"draw-steel",
			"set-world",
			"pf2e",
			"freeform",
		] as const) {
			expect(partyOf(table.state, ALICE, ruleset)).toEqual([]);
			expect(inCombatOf(table.state, ruleset)).toBe(false);
			expect(resyncLinesOf(table.state, ["x"], ruleset)).toEqual([]);
		}
	});
});

const parsed = (line: string) => parseInputLine(line, "chat", "freeform");

describe("freeform: parsing", () => {
	test("each command reads its words into an ff- command", () => {
		expect(parsed("/pc Rook")).toEqual({
			kind: "command",
			command: { type: "ff-pc", id: "rook" },
		});
		expect(parsed("/add 3 thug")).toEqual({
			kind: "command",
			command: { type: "ff-add", monster: "thug", count: 3 },
		});
		expect(parsed("/add thug x2")).toEqual({
			kind: "command",
			command: { type: "ff-add", monster: "thug", count: 2 },
		});
		expect(parsed("/stat rook hp -3")).toEqual({
			kind: "command",
			command: {
				type: "ff-stat",
				who: "rook",
				key: "hp",
				op: "add",
				amount: -3,
			},
		});
		expect(parsed("/stat rook hp =7")).toEqual({
			kind: "command",
			command: {
				type: "ff-stat",
				who: "rook",
				key: "hp",
				op: "set",
				amount: 7,
			},
		});
		expect(parsed("/tag rook +hidden")).toEqual({
			kind: "command",
			command: { type: "ff-tag", who: "rook", tag: "hidden", on: true },
		});
		expect(parsed("/check wits")).toEqual({
			kind: "command",
			command: { type: "ff-check", stat: "wits" },
		});
		expect(parsed("/check rook wits 2d6")).toEqual({
			kind: "command",
			command: { type: "ff-check", who: "rook", stat: "wits", dice: "2d6" },
		});
		expect(parsed("/move rook c5")).toEqual({
			kind: "command",
			command: { type: "ff-move", who: "rook", to: { x: 2, y: 4 } },
		});
		expect(parsed("/start wren rook")).toEqual({
			kind: "command",
			command: { type: "ff-start", who: ["wren", "rook"] },
		});
		expect(parsed("/next")).toEqual({
			kind: "command",
			command: { type: "ff-next" },
		});
	});

	test("bad words are refused with the usage", () => {
		expect(parsed("/stat rook hp")).toEqual({
			kind: "refusal",
			message: "Usage: /stat <who> <key> +n|-n|=n",
		});
		expect(parsed("/add 13 thug")).toEqual({
			kind: "refusal",
			message: "Add 1 to 12 figures at a time.",
		});
		expect(parsed("/tag rook hidden")).toEqual({
			kind: "refusal",
			message: "Usage: /tag <who> +tag|-tag",
		});
	});

	test("Tab completes figures, then their stats", () => {
		const table = party();

		expect(completeLine(table.state, ALICE, "/stat r", "freeform")).toEqual([
			"/stat rook",
		]);
		expect(
			completeLine(table.state, ALICE, "/stat rook h", "freeform")
		).toEqual(["/stat rook hp"]);
		expect(completeLine(table.state, BOB, "/play ", "freeform")).toEqual([
			"/play wren",
		]);
	});
});
