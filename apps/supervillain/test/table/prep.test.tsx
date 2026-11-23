import { afterEach, describe, expect, test } from "bun:test";

import { TextRenderable } from "@opentui/core";
import type { Renderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import {
	actionsOf,
	bandOf,
	GM,
	helpText,
	mapOf,
	prepOf,
	charsOf,
	ifDefined,
	listIfDefined,
	when,
} from "@supervillain/domain";
import type { PrepCatalog, PrepItem, PrepView } from "@supervillain/domain";
import { createSignal } from "solid-js";

import { App } from "../../src/table/App.tsx";
import { DINGS_ATLAS } from "../../src/table/atlas/dings.ts";
import {
	emptyLine,
	fillLine,
	historyUp,
	insert,
	PREP_IS_GMS,
} from "../../src/table/input.ts";
import { kept } from "../../src/table/keep.ts";
import { figureOf } from "../../src/table/picture.ts";
import {
	armedStands,
	countLine,
	figureText,
	placeNear,
	prepCount,
	prepHints,
	prepNext,
	prepWidth,
} from "../../src/table/prep.ts";
import { GOBLIN, KOR, VEX } from "../drawSteel/harness.ts";
import { must } from "../game/must.ts";
import { inOrder, times } from "../game/sequence.ts";
import { ALICE, Table, fixedDice } from "../game/table.ts";
import { character } from "../setWorld/harness.ts";
import { fakeView, line } from "./fakeView.ts";

const CATALOG: PrepCatalog = {
	heroes: [
		{ id: "kor", name: "Kor" },
		{ id: "vex", name: "Vex" },
	],
	monsters: [{ id: "goblin-warrior", name: "Goblin Warrior" }],
	maps: [
		{ id: "cave", name: "Test Cave" },
		{ id: "yard", name: "Yard" },
	],
};

const YARD = {
	name: "Yard",
	terrain: [
		"..........",
		"..........",
		"....##....",
		"..........",
		"..........",
	],
};

const drawSteelTable = () => {
	const t = new Table();
	t.run(ALICE, { type: "name", name: "Alice" });
	t.run(GM, { type: "hero", hero: "vex", sheet: VEX });
	t.run(ALICE, { type: "play", hero: "vex" });
	t.run(GM, {
		type: "add",
		monster: "goblin-warrior",
		count: 2,
		sheet: GOBLIN,
	});
	t.run(GM, { type: "map", id: "yard", grid: YARD });
	t.run(GM, { type: "place", who: "vex", at: { x: 1, y: 1 } });

	return t;
};

const setWorldTable = () => {
	const t = new Table();
	t.run(GM, { type: "set-recruit", name: "Ada", character: character() });
	t.run(GM, {
		type: "set-foe",
		name: "Grub",
		character: character({}, "sword", 2),
	});
	t.run(GM, { type: "set-map", id: "yard", grid: YARD });
	t.run(GM, { type: "set-place", who: "ada", at: { x: 0, y: 0 } });

	return t;
};

const outline = (view: PrepView) => ({
	steps: view.steps.map((s) => `${s.done ? "◆" : "◇"} ${s.label}`).join(" "),
	maps: [
		...listIfDefined(view.maps.loaded, (value) => [
			`${value.name} (loaded${value.again === undefined ? "" : `, ↻ ${value.again}`})`,
		]),
		...view.maps.items.map((i) => `${i.label} → ${i.line}`),
	],
	place: view.place.map(
		(t) => `${t.name} /place ${t.id} (${t.figure.side} ${t.figure.id})`
	),
	sections: view.sections.map((s) => ({
		title: s.title,
		items: s.items.map(
			(i) =>
				`${i.label} → ${i.line}${i.note === undefined ? "" : ` (${i.note})`}`
		),
		...ifDefined(s.note, (note) => ({ note })),
		...ifDefined(s.all, (all) => ({ all })),
	})),
	start: "line" in view.start ? view.start.line : view.start.note,
});

type Setup = Awaited<ReturnType<typeof testRender>>;

let setup: Setup | undefined;

afterEach(() => {
	setup?.renderer.destroy();
	setup = undefined;
});

const rowsOf = (frame: string) => {
	const rows = frame.split("\n").map((r) => r.trimEnd());

	while (rows.length > 0 && rows.at(-1) === "") {
		rows.pop();
	}

	return rows;
};

const where = (t: Setup, text: string, from = 0) => {
	const rows = t.captureCharFrame().split("\n");

	for (let row = from; row < rows.length; row += 1) {
		const col = must(rows[row]).indexOf(text);

		if (col !== -1) {
			return { col, row };
		}
	}

	throw new Error(`'${text}' isn't on screen:\n${t.captureCharFrame()}`);
};

const settle = async (t: Setup) => {
	await Bun.sleep(1);
	await t.renderOnce();

	return t.captureCharFrame();
};

const click = async (t: Setup, col: number, row: number) => {
	await t.mockMouse.click(col, row, undefined, { delayMs: 0 });

	return await settle(t);
};

const panelAt = (t: Setup) => {
	const at = where(t, "┌─ ⁵ GM prep");

	return { row: at.row, col: at.col };
};

interface At {
	readonly col: number;
	readonly row: number;
}

const inPrep = (t: Setup, text: string, after?: string): At => {
	const panel = panelAt(t);
	const rows = t.captureCharFrame().split("\n");

	for (
		let row = after === undefined ? panel.row : inPrep(t, after).row + 1;
		row < rows.length;
		row += 1
	) {
		const col = must(rows[row]).indexOf(text, panel.col);

		if (col !== -1) {
			return { col, row };
		}
	}

	throw new Error(
		`'${text}' isn't in the prep panel:\n${t.captureCharFrame()}`
	);
};

const clickInPrep = async (t: Setup, text: string, after?: string) => {
	const at = inPrep(t, text, after);

	return await click(t, at.col, at.row);
};

const clickSquare = async (t: Setup, square: string) => {
	const letters = where(t, "a b c");
	const x = (square.codePointAt(0) ?? 97) - 97;
	const y = Number(square.slice(1)) - 1;

	return await click(t, letters.col + 2 * x, letters.row + 1 + y);
};

const exactly = (row: string) =>
	new RegExp(`^${row.replaceAll(/[$()*+.?[\\\]^{|}]/gu, "\\$&")}$`, "u");

const panelRows = (t: Setup) => {
	const panel = panelAt(t);

	return rowsOf(t.captureCharFrame())
		.slice(panel.row + 1)
		.map((r) =>
			charsOf(r)
				.slice(panel.col + 1, -1)
				.join("")
				.trimEnd()
		)
		.filter((_, i, all) => i < all.length);
};

const seat = async (
	t: Table,
	actor: string,
	ruleset: "draw-steel" | "set-world",
	height = 24,
	reply?: (line: string) => string | undefined | Promise<string | undefined>,
	width = 80
) => {
	const [version, setVersion] = createSignal(0);

	const fake = fakeView({
		...ifDefined(reply, (value) => ({ reply: value })),
		me: actor,
		myName: actor === GM ? undefined : "Alice",
		feed: [line(1, "Oscar", "welcome to the yard")],
		combat: bandOf(t.state, actor, ruleset) ?? null,
		map: mapOf(t.state, actor, ruleset) ?? null,
		actions: (id) => {
			version();

			return actionsOf(t.state, actor, ruleset, id);
		},
		...when(actor === GM, () => ({ prep: prepOf(t.state, CATALOG, ruleset) })),
	});

	setup = await testRender(() => <App view={fake.view} />, {
		width,
		height,
		exitOnCtrlC: false,
		autoFocus: false,
	});
	await setup.renderOnce();
	const shown = setup;

	const run = async (...args: Parameters<Table["run"]>) => {
		t.run(...args);
		fake.setCombat(bandOf(t.state, actor, ruleset));
		fake.setMap(mapOf(t.state, actor, ruleset));
		fake.setPrep(prepOf(t.state, CATALOG, ruleset));
		setVersion(version() + 1);

		return await settle(shown);
	};

	return { fake, t: shown, run };
};

const escape = async (t: Setup) => {
	t.mockInput.pressEscape();
	await Bun.sleep(40);

	return await settle(t);
};

const scrollPrep = async (t: Setup, notches: number) => {
	const at = panelAt(t);

	await times(notches, async () => {
		await t.mockMouse.scroll(at.col + 4, at.row + 8, "down");
	});

	return await settle(t);
};

const typeLine = async (t: Setup, text: string) => {
	await t.mockInput.typeText(text);
	t.mockInput.pressEnter();

	return await settle(t);
};

describe("what the prep panel lists, by ruleset", () => {
	test("Draw Steel: the steps, the maps, who waits for a square, heroes not in play, monsters", () => {
		expect(
			outline(prepOf(drawSteelTable().state, CATALOG, "draw-steel"))
		).toEqual({
			steps: "◆ map ◆ party ◇ foes",
			maps: [
				"Yard (loaded)",
				"Test Cave → /map cave",
				"Put away → /map off",
				"New crossing → /map new crossing",
				"New keep → /map new keep",
				"New, by seed → /map new ",
			],
			place: [
				"Goblin Warrior 1 /place goblin-warrior-1 (director goblin-warrior)",
				"Goblin Warrior 2 /place goblin-warrior-2 (director goblin-warrior)",
			],
			sections: [
				{ title: "heroes", items: ["Kor → /hero kor"] },
				{
					title: "monsters",
					items: ["Goblin Warrior → /add goblin-warrior (×2)"],
				},
			],
			start: "/start",
		});

		const kinds = prepOf(
			drawSteelTable().state,
			CATALOG,
			"draw-steel"
		).sections.map((s) => s.items.map((i) => i.kind));

		expect(kinds).toEqual([["send"], ["count"]]);
	});

	test("Draw Steel: nothing to place before a map, the party first, + all, a map made again", () => {
		const t = new Table();
		const empty = { heroes: [], monsters: [], maps: [] };
		expect(outline(prepOf(t.state, empty, "draw-steel"))).toEqual({
			steps: "◇ map ◇ party ◇ foes",
			maps: [
				"New crossing → /map new crossing",
				"New keep → /map new keep",
				"New, by seed → /map new ",
			],
			place: [],
			sections: [
				{ title: "heroes", items: [], note: "no sheets in heroes/" },
				{ title: "monsters", items: [], note: "no stat blocks in monsters/" },
			],
			start: "/start",
		});
		expect(
			must(outline(prepOf(t.state, CATALOG, "draw-steel")).sections[0]).all
		).toEqual(["/hero kor", "/hero vex"]);
		t.run(GM, {
			type: "add",
			monster: "goblin-warrior",
			count: 1,
			sheet: GOBLIN,
		});
		t.run(GM, { type: "hero", hero: "kor", sheet: KOR });
		t.run(GM, {
			type: "map",
			id: "keep-42",
			grid: { ...YARD, name: "The Grey Keep" },
		});
		const view = outline(prepOf(t.state, CATALOG, "draw-steel"));
		expect(view.place.map((p) => p.split(" /")[0])).toEqual([
			"Kor",
			"Goblin Warrior",
		]);
		expect(view.maps[0]).toBe("The Grey Keep (loaded, ↻ /map new keep)");
		expect(view.steps).toBe("◆ map ◇ party ◇ foes");
	});

	test("Draw Steel: in combat, every step done and the round instead of a start", () => {
		const fight = drawSteelTable();
		fight.run(GM, {
			type: "place",
			who: "goblin-warrior-1",
			at: { x: 7, y: 1 },
		});
		fight.run(GM, {
			type: "place",
			who: "goblin-warrior-2",
			at: { x: 7, y: 2 },
		});
		expect(outline(prepOf(fight.state, CATALOG, "draw-steel")).steps).toBe(
			"◆ map ◆ party ◆ foes"
		);
		fight.run(GM, { type: "start" }, fixedDice(8));
		const view = outline(prepOf(fight.state, CATALOG, "draw-steel"));
		expect(view.place).toEqual([]);
		expect(view.start).toBe("round 1");
	});

	test("set.world: Recruit and Foe fill the line for a name, then who to place, Start", () => {
		expect(
			outline(prepOf(setWorldTable().state, CATALOG, "set-world"))
		).toEqual({
			steps: "◆ map ◆ party ◇ foes",
			maps: [
				"Yard (loaded)",
				"Test Cave → /map cave",
				"Put away → /map off",
				"New crossing → /map new crossing",
				"New keep → /map new keep",
				"New, by seed → /map new ",
			],
			place: ["Grub /place grub (director grub)"],
			sections: [
				{
					title: "fighters",
					items: ["Recruit → /recruit ", "Foe → /foe "],
					note: "1 in the party, 1 foe",
				},
			],
			start: "/start",
		});
		expect(
			must(
				prepOf(setWorldTable().state, CATALOG, "set-world").sections[0]
			).items.map((i) => i.kind)
		).toEqual(["fill", "fill"]);
	});
});

describe("Place, and /prep in /help", () => {
	test("a token off the loaded map offers Place where it would offer Move, to its player too", () => {
		const t = drawSteelTable();
		expect(
			actionsOf(t.state, GM, "draw-steel", "goblin-warrior-1")?.[0]
		).toEqual({
			label: "Place",
			pick: "square",
			line: "/place goblin-warrior-1",
		});
		expect(actionsOf(t.state, ALICE, "draw-steel", "vex")?.[0]?.label).toBe(
			"Move"
		);
		t.run(GM, { type: "hero", hero: "kor", sheet: KOR });
		t.run(ALICE, { type: "unplay", hero: "vex" });
		t.run(ALICE, { type: "play", hero: "kor" });
		expect(actionsOf(t.state, ALICE, "draw-steel", "kor")?.[0]?.label).toBe(
			"Place"
		);
		const sw = setWorldTable();
		expect(actionsOf(sw.state, GM, "set-world", "grub")?.[0]).toEqual({
			label: "Place",
			pick: "square",
			line: "/place grub",
		});
	});

	test("/help lists /prep for the GM alone, and only a seat has it", () => {
		expect(helpText(GM, undefined, "seat")).toContain("/prep");
		expect(helpText(ALICE, undefined, "seat")).not.toContain("/prep");
		expect(helpText(GM, undefined, "exec")).not.toContain("/prep");
		expect(helpText(GM, "prep", "seat")).toStartWith(
			"/prep  Open the prep panel"
		);
		expect(helpText(GM, undefined, "seat")).toContain(
			"/map <map id>|off|new crossing|keep [seed]"
		);
	});
});

describe("the prep panel, as data", () => {
	const view = prepOf(drawSteelTable().state, CATALOG, "draw-steel");
	const goblins = must(must(view.sections[1]).items[0]);

	test("the next square places the first who waits, or what the GM picked", () => {
		expect(prepNext(view, undefined)).toEqual({
			kind: "place",
			id: "goblin-warrior-1",
			name: "Goblin Warrior 1",
			figure: { id: "goblin-warrior", side: "director" },
		});
		expect(
			prepNext(view, { kind: "token", id: "goblin-warrior-2" })
		).toMatchObject({
			id: "goblin-warrior-2",
		});
		expect(prepNext(view, { kind: "token", id: "kor" })).toEqual({
			kind: "place",
			id: "kor",
			name: "Kor",
			figure: { id: "kor", side: "heroes" },
		});
		expect(
			prepNext(view, { kind: "count", line: "/add goblin-warrior", n: 3 })
		).toEqual({
			kind: "add",
			name: "Goblin Warrior",
			figure: { id: "goblin-warrior", side: "director" },
			n: 3,
			line: "/add goblin-warrior x3",
		});
		expect(armedStands(view, { kind: "token", id: "vex" })).toBe(false);
		expect(prepNext(view, { kind: "token", id: "vex" })).toMatchObject({
			id: "goblin-warrior-1",
		});
		expect(armedStands(view, { kind: "count", line: "/add ogre", n: 1 })).toBe(
			false
		);
		expect(armedStands(view, { kind: "token", id: "kor" })).toBe(true);
		expect([1, 3].map((n) => countLine(goblins, n))).toEqual([
			"/add goblin-warrior",
			"/add goblin-warrior x3",
		]);
	});

	test("a monster's count: each click one more, up to its most; − one fewer, to none", () => {
		const one = prepCount(undefined, goblins, 1);
		expect(one).toEqual({ kind: "count", line: "/add goblin-warrior", n: 1 });
		expect(prepCount(one, goblins, 1)).toMatchObject({ n: 2 });
		expect(
			prepCount(
				{ ...must(one?.kind === "count" ? one : undefined), n: 40 },
				goblins,
				1
			)
		).toMatchObject({ n: 40 });
		expect(prepCount(one, goblins, -1)).toBeUndefined();
		expect(prepCount(one, must(must(view.sections[0]).items[0]), 1)).toBe(one);
		expect(prepCount({ kind: "token", id: "kor" }, goblins, 1)).toMatchObject({
			n: 1,
		});
	});

	test("a count names its monster, wherever a list read again puts it", () => {
		const armed = must(prepCount(prepCount(undefined, goblins, 1), goblins, 1));

		const more = prepOf(
			drawSteelTable().state,
			{
				...CATALOG,
				monsters: [{ id: "ankheg", name: "Ankheg" }, ...CATALOG.monsters],
			},
			"draw-steel"
		);

		expect(prepNext(more, armed)).toMatchObject({
			name: "Goblin Warrior",
			n: 2,
		});

		const fewer = prepOf(
			drawSteelTable().state,
			{ ...CATALOG, monsters: [] },
			"draw-steel"
		);

		expect(armedStands(fewer, armed)).toBe(false);
	});

	test("a group goes to the free squares nearest the one clicked, past walls and tokens", () => {
		const map = must(mapOf(drawSteelTable().state, GM, "draw-steel"));
		expect(placeNear(map, ["a", "b", "c", "d"], { x: 1, y: 2 })).toEqual([
			"/place a b3",
			"/place b a3",
			"/place c c3",
			"/place d b4",
		]);
		expect(placeNear(map, ["a"], { x: 4, y: 2 })).toEqual(["/place a e2"]);
		const full = { ...map, terrain: ["..", "##"], tokens: [] };
		expect(placeNear(full, ["a", "b", "c"], { x: 0, y: 0 })).toEqual([
			"/place a a1",
			"/place b b1",
		]);
	});

	test("its width, a third of the seat between its least and most; its hints, typed", () => {
		expect([80, 90, 120, 200].map(prepWidth)).toEqual([26, 30, 34, 34]);
		expect(prepHints(prepNext(view, undefined), 5)[1]).toBe(
			"a square places Goblin Warrior 1 · /place goblin-warrior-1 <square>"
		);
		expect(
			prepHints(
				prepNext(view, { kind: "count", line: "/add goblin-warrior", n: 2 }),
				5
			)[1]
		).toBe("a square adds them there · /add goblin-warrior x2 then /place");
		expect(prepHints(undefined, 5)[1]).toBe("click to send · Alt+5 hides it");
	});

	test("a figure in blocks, for a terminal without pictures: four columns, two rows", () => {
		const text = figureText(
			DINGS_ATLAS[figureOf({ id: "kor", side: "heroes" })]
		);

		expect(text).toHaveLength(2);
		expect(text.map((r) => charsOf(r).length)).toEqual([4, 4]);
		expect(text.join("").trim()).not.toBe("");
		expect(figureText(undefined)).toEqual(["    ", "    "]);
		expect(figureText("ff".repeat(12))).toEqual(["████", "████"]);
	});

	test("a filled line replaces what was typed, which Up brings back", () => {
		const typed = insert(emptyLine, "hello");
		const filled = fillLine(typed, "/recruit ");
		expect(filled).toMatchObject({ text: "/recruit ", cursor: 9 });
		expect(historyUp(filled).text).toBe("hello");
		expect(fillLine(emptyLine, "/foe ").history).toEqual([]);
	});
});

const bandit = (n: number, note?: string): PrepItem => ({
	kind: "count",
	label: `Bandit ${n}`,
	line: `/add bandit-${n}`,
	figure: { id: `bandit-${n}`, side: "director" },
	...ifDefined(note, (value) => ({ note: value })),
});

const prep = (note?: string): PrepView => ({
	steps: [{ label: "map", done: false }],
	maps: { items: [] },
	place: [],
	sections: [
		{ title: "monsters", items: [bandit(1, note), bandit(2), bandit(3)] },
	],
	start: { line: "/start" },
});

describe("the prep panel at the GM's seat", () => {
	test("Alt+5 and /prep open it, reading the campaign's files each time; it starts hidden", async () => {
		const { fake, t } = await seat(drawSteelTable(), GM, "draw-steel");
		expect(t.captureCharFrame()).not.toContain("⁵ GM prep");
		expect(rowsOf(t.captureCharFrame()).at(-2)).toEndWith("show ⁵ prep");
		t.mockInput.pressKey("5", { meta: true });
		expect(await settle(t)).toContain("─ ⁵ GM prep");
		expect(fake.reloads()).toBe(1);
		t.mockInput.pressKey("5", { meta: true });
		expect(await settle(t)).not.toContain("⁵ GM prep");
		expect(fake.reloads()).toBe(1);
		expect(await typeLine(t, "/prep")).toContain("─ ⁵ GM prep");
		expect(fake.reloads()).toBe(2);
		expect(await typeLine(t, "/prep")).toContain("─ ⁵ GM prep");
		expect(fake.reloads()).toBe(3);
		const title = where(t, "⁵ GM prep");
		expect(await click(t, title.col + 2, title.row)).not.toContain("⁵ GM prep");
		expect(fake.submitted).toEqual([]);
	});

	test("a player's seat has none: Alt+5 and /prep are answered politely, and nothing is sent", async () => {
		const { fake, t } = await seat(drawSteelTable(), ALICE, "draw-steel");
		expect(fake.view.prep).toBeUndefined();
		expect(rowsOf(t.captureCharFrame()).at(-2)).not.toContain("prep");
		t.mockInput.pressKey("5", { meta: true });
		expect(await settle(t)).toContain(PREP_IS_GMS);
		expect(await escape(t)).not.toContain(PREP_IS_GMS);
		expect(await typeLine(t, "/prep")).toContain(PREP_IS_GMS);
		expect(t.captureCharFrame()).not.toContain("⁵ GM prep");
		expect(fake.submitted).toEqual([]);
	});

	test("a monster's count changing draws its row again, and only its row", async () => {
		const fake = fakeView({ me: GM, prep: prep() });
		setup = await testRender(() => <App view={fake.view} />, {
			width: 80,
			height: 24,
			exitOnCtrlC: false,
			autoFocus: false,
		});
		expect(await typeLine(setup, "/prep")).toContain("Bandit 3");

		const texts = (text: string) => {
			const found: Array<Renderable> = [];

			const walk = (r: Renderable) => {
				if (r instanceof TextRenderable && r.plainText === text) {
					found.push(r);
				}

				for (const child of r.getChildren()) {
					walk(child);
				}
			};

			walk(must(setup).renderer.root);

			return found;
		};

		const [two] = texts("Bandit 2");
		expect(two).toBeDefined();
		fake.setPrep(kept(must(fake.view.prep).view(), prep("×2")));
		expect(await settle(setup)).toContain("×2");
		expect(texts("Bandit 2")).toEqual([must(two)]);
		expect(must(two).isDestroyed).toBe(false);
	});

	test("a folder that can't be read says why", async () => {
		const fake = fakeView({
			me: GM,
			prep: null,
			prepProblem: "can't list heroes/: EACCES",
		});

		setup = await testRender(() => <App view={fake.view} />, {
			width: 80,
			height: 24,
			exitOnCtrlC: false,
			autoFocus: false,
		});
		expect(await typeLine(setup, "/prep")).toContain(
			"can't list heroes/: EACCES"
		);
	});

	test("a folder that never read leaves the panel hidden: the hint row and the all-hidden line say so", async () => {
		const fake = fakeView({
			me: GM,
			prep: null,
			prepProblem: "can't list heroes/: EACCES",
		});

		setup = await testRender(() => <App view={fake.view} />, {
			width: 80,
			height: 24,
			exitOnCtrlC: false,
			autoFocus: false,
		});
		const t = setup;
		await typeLine(t, "/prep");
		let hint = rowsOf(await escape(t)).at(-2);
		expect(hint).not.toContain("click to send");
		expect(hint).toEndWith("show ⁵ prep");
		t.mockInput.pressKey("5", { meta: true });
		expect(await settle(t)).toContain("can't list heroes/: EACCES");
		expect(fake.reloads()).toBe(2);

		for (const key of ["1", "3"]) {
			t.mockInput.pressKey(key, { meta: true });
		}

		expect(await settle(t)).toContain("every panel is hidden");
		hint = rowsOf(t.captureCharFrame()).at(-2);
		expect(hint).not.toContain("click to send");
	});

	test("Draw Steel: right of the map, the steps, who's next, who waits and what comes in", async () => {
		const { t } = await seat(
			drawSteelTable(),
			GM,
			"draw-steel",
			40,
			undefined,
			120
		);

		const frame = await typeLine(t, "/prep");
		const rows = rowsOf(frame);
		expect(rows.find((r) => r.includes("² map"))).toMatch(
			/^┌─ ² map · Yard ─+┐┌─ ⁵ GM prep ─+┐$/u
		);
		expect(must(rows.find((r) => r.includes("³ feed"))).indexOf("┐")).toBe(85);
		const shown = panelRows(t).slice(0, 19);

		const wanted = [
			exactly(" ◆ map ◆ party ◈ foes ◇ ▶"),
			exactly(""),
			/^ ▌.{4} Goblin Warrior 1$/u,
			/^ ▌.{4} ⌖$/u,
			exactly(""),
			exactly(""),
			exactly(""),
			exactly(" map ─────────────────────────"),
			exactly(" Yard                        ⇄"),
			exactly(""),
			exactly(" to place 1 ──────────────────"),
			/^ {2}.{4} Goblin Warrior 2$/u,
			/^ {2}.{4} ◌$/u,
			exactly(""),
			exactly(" heroes ──────────────────────"),
			/^ {2}.{4} Kor$/u,
			/^ {2}.{1,4}$/u,
			exactly(""),
			exactly(" monsters ────────────────────"),
		];

		expect(shown).toHaveLength(wanted.length);

		for (const [i, want] of wanted.entries()) {
			expect(must(shown[i])).toMatch(want);
		}

		expect(rows.at(-2)).toContain(
			"a square places Goblin Warrior 1 · /place goblin-warrior-1 <square>"
		);
	});

	test("Draw Steel: a free square places the next; then the next who waits is up", async () => {
		const { fake, t, run } = await seat(drawSteelTable(), GM, "draw-steel", 40);
		await typeLine(t, "/prep");
		await clickSquare(t, "g4");
		expect(fake.submitted).toEqual(["/place goblin-warrior-1 g4"]);
		await run(GM, {
			type: "place",
			who: "goblin-warrior-1",
			at: { x: 6, y: 3 },
		});
		expect(inPrep(t, "Goblin Warri… 2").row).toBe(panelAt(t).row + 3);
		expect(t.captureCharFrame()).not.toContain("to place");
		t.mockInput.pressArrow("up");
		expect(rowsOf(await settle(t)).at(-1)).toContain(
			"/place goblin-warrior-1 g4"
		);
	});

	test("Draw Steel: a token on the map still opens its menu; one waiting is picked to go next", async () => {
		const { fake, t } = await seat(drawSteelTable(), GM, "draw-steel", 40);
		await typeLine(t, "/prep");
		expect(await clickSquare(t, "b2")).toContain("Vex");
		expect(fake.submitted).toEqual([]);
		await escape(t);
		await clickInPrep(t, "Goblin Warri… 2");
		expect(inPrep(t, "Goblin Warri… 2").row).toBe(panelAt(t).row + 3);
		await clickSquare(t, "h1");
		expect(fake.submitted).toEqual(["/place goblin-warrior-2 h1"]);
	});

	test("Draw Steel: a hero sent for goes next, and + all sends every one", async () => {
		const { fake, t, run } = await seat(drawSteelTable(), GM, "draw-steel", 40);
		await typeLine(t, "/prep");
		await clickInPrep(t, "Kor");
		expect(fake.submitted).toEqual(["/hero kor"]);
		expect(inPrep(t, "Kor").row).toBe(panelAt(t).row + 3);
		await run(GM, { type: "hero", hero: "kor", sheet: KOR });
		expect(inPrep(t, "Kor").row).toBe(panelAt(t).row + 3);
		expect(t.captureCharFrame()).not.toContain("heroes ─");
		await clickSquare(t, "c2");
		expect(fake.submitted).toEqual(["/hero kor", "/place kor c2"]);

		const { fake: two, t: other } = await seat(
			new Table(),
			GM,
			"draw-steel",
			40
		);

		await typeLine(other, "/prep");
		await clickInPrep(other, "+ all");
		expect(two.submitted).toEqual(["/hero kor", "/hero vex"]);
	});

	test("Draw Steel: a monster counted, then a square adds them and places them around it", async () => {
		const t0 = drawSteelTable();
		t0.run(GM, { type: "place", who: "goblin-warrior-1", at: { x: 9, y: 0 } });
		t0.run(GM, { type: "place", who: "goblin-warrior-2", at: { x: 9, y: 1 } });
		const { fake, t, run } = await seat(t0, GM, "draw-steel", 40);
		await typeLine(t, "/prep");
		expect(t.captureCharFrame()).toContain("fight");

		await times(3, async () => {
			await clickInPrep(t, "Goblin Warr", "monsters");
		});

		expect(t.captureCharFrame()).not.toContain("fight");
		expect(inPrep(t, "+3", "monsters").row).toBe(
			inPrep(t, "Goblin Warr", "monsters").row + 1
		);
		expect(inPrep(t, "+3").row).toBe(panelAt(t).row + 4);
		await clickInPrep(t, " − ");
		expect(t.captureCharFrame()).toContain("+2");
		expect(rowsOf(t.captureCharFrame()).at(-2)).toContain(
			"/add goblin-warrior x2 then /place"
		);
		await clickSquare(t, "d4");
		expect(fake.submitted).toEqual(["/add goblin-warrior x2"]);
		await run(GM, {
			type: "add",
			monster: "goblin-warrior",
			count: 2,
			sheet: GOBLIN,
		});
		expect(fake.submitted).toEqual([
			"/add goblin-warrior x2",
			"/place goblin-warrior-3 d4",
			"/place goblin-warrior-4 d3",
		]);
		await clickInPrep(t, "Goblin Warr", "monsters");
		expect(t.captureCharFrame()).toContain("+1");
		expect(await escape(t)).not.toContain("+1");
		expect(fake.submitted).toHaveLength(3);
	});

	test("a count is its monster's, though the folder read again lists another before it", async () => {
		const t0 = drawSteelTable();
		const { fake, t } = await seat(t0, GM, "draw-steel", 40);
		await typeLine(t, "/prep");

		await times(2, async () => {
			await clickInPrep(t, "Goblin Warr", "monsters");
		});

		fake.setPrep(
			prepOf(
				t0.state,
				{
					...CATALOG,
					monsters: [{ id: "ankheg", name: "Ankheg" }, ...CATALOG.monsters],
				},
				"draw-steel"
			)
		);
		expect(rowsOf(await settle(t)).at(-2)).toContain(
			"/add goblin-warrior x2 then /place"
		);
		expect(inPrep(t, "+2", "monsters").row).toBe(
			inPrep(t, "Goblin Warr", "monsters").row + 1
		);
		await clickSquare(t, "d4");
		expect(fake.submitted).toEqual(["/add goblin-warrior x2"]);
	});

	test("a count goes with the panel, however it leaves: ▶ starting the fight, or a seat too small", async () => {
		const t0 = drawSteelTable();
		t0.run(GM, { type: "place", who: "goblin-warrior-1", at: { x: 9, y: 0 } });
		t0.run(GM, { type: "place", who: "goblin-warrior-2", at: { x: 9, y: 1 } });
		const { fake, t, run } = await seat(t0, GM, "draw-steel", 40);
		await typeLine(t, "/prep");

		await times(2, async () => {
			await clickInPrep(t, "Goblin Warr", "monsters");
		});

		t.resize(70, 18);
		await settle(t);
		t.resize(80, 40);
		await settle(t);
		expect(await settle(t)).not.toContain("+2");

		await times(2, async () => {
			await clickInPrep(t, "Goblin Warr", "monsters");
		});

		expect(t.captureCharFrame()).toContain("+2");
		await clickInPrep(t, "▶");
		expect(fake.submitted).toEqual(["/start"]);
		await run(GM, { type: "start" }, fixedDice(8));
		expect(t.captureCharFrame()).not.toContain("⁵ GM prep");
		await typeLine(t, "/mouse x");
		expect(await escape(t)).not.toContain("Usage: /mouse");
		expect(await typeLine(t, "/prep")).not.toContain("+2");
		await clickSquare(t, "d4");
		expect(fake.submitted).toEqual(["/start"]);
	});

	test("a hero refused late puts down only itself, not what was put up since", async () => {
		const refusal = Promise.withResolvers<string>();

		const { fake, t } = await seat(
			drawSteelTable(),
			GM,
			"draw-steel",
			40,
			async (typed) =>
				typed === "/hero kor" ? await refusal.promise : undefined
		);

		await typeLine(t, "/prep");
		await clickInPrep(t, "Kor");
		expect(fake.submitted).toEqual(["/hero kor"]);

		await times(2, async () => {
			await clickInPrep(t, "Goblin Warr", "monsters");
		});

		refusal.resolve("heroes/kor.yaml doesn't read.");
		const frame = await settle(t);
		expect(frame).toContain("heroes/kor.yaml doesn't read.");
		expect(frame).toContain("+2");
	});

	test("Draw Steel: once everyone is placed, fight starts combat and the panel steps aside", async () => {
		const t0 = drawSteelTable();
		t0.run(GM, { type: "place", who: "goblin-warrior-1", at: { x: 9, y: 0 } });
		t0.run(GM, { type: "place", who: "goblin-warrior-2", at: { x: 9, y: 1 } });
		const { fake, t } = await seat(t0, GM, "draw-steel", 40);
		await typeLine(t, "/prep");
		expect(panelRows(t)[0]).toBe(" ◆ ◆ ◆ ◈ ▶");
		expect(await clickInPrep(t, "fight")).not.toContain("⁵ GM prep");
		expect(fake.submitted).toEqual(["/start"]);
	});

	test("the maps: the loaded one, others behind ⇄, a new one, or by seed on the input line", async () => {
		const { fake, t } = await seat(drawSteelTable(), GM, "draw-steel", 40);
		await typeLine(t, "/prep");
		expect(t.captureCharFrame()).not.toContain("Test Cave");
		await clickInPrep(t, " ⇄ ");
		await clickInPrep(t, "Test Cave");
		await clickInPrep(t, " ⇄ ");
		await clickInPrep(t, "+ keep");
		await clickInPrep(t, " ⇄ ");
		await clickInPrep(t, "+ by seed");
		expect(rowsOf(t.captureCharFrame()).at(-1)).toBe(" > /map new");
		await typeLine(t, "keep 42");
		expect(fake.submitted).toEqual([
			"/map cave",
			"/map new keep",
			"/map new keep 42",
		]);

		const keep = drawSteelTable();
		keep.run(GM, {
			type: "map",
			id: "keep-7",
			grid: { ...YARD, name: "The Grey Keep" },
		});
		const { fake: again, t: other } = await seat(keep, GM, "draw-steel", 40);
		await typeLine(other, "/prep");
		await clickInPrep(other, " ↻ ");
		expect(again.submitted).toEqual(["/map new keep"]);
	});

	test("a click in the panel, even one that sends nothing, calls off the GM's first Ctrl-C", async () => {
		const { fake, t } = await seat(drawSteelTable(), GM, "draw-steel", 40);
		await typeLine(t, "/prep");
		fake.setPresent([
			{ actor: GM, label: "Oscar", gm: true },
			{ actor: ALICE, label: "Alice", gm: false },
		]);
		t.mockInput.pressCtrlC();
		expect(await settle(t)).toContain("Ctrl-C again");
		expect(await clickInPrep(t, "Goblin Warr", "monsters")).not.toContain(
			"Ctrl-C again"
		);
		t.mockInput.pressCtrlC();
		expect(await settle(t)).toContain("Ctrl-C again");
		expect(fake.left()).toBe(0);
		expect(fake.submitted).toEqual([]);
	});

	test("set.world: Recruit and Foe fill the line for a name; a square places; fight starts", async () => {
		const { fake, t, run } = await seat(setWorldTable(), GM, "set-world");
		await typeLine(t, "/prep");
		await clickInPrep(t, "+ Recruit");
		expect(rowsOf(t.captureCharFrame()).at(-1)).toBe(" > /recruit");
		await typeLine(t, "Bea");
		await clickInPrep(t, "+ Foe");
		expect(rowsOf(t.captureCharFrame()).at(-1)).toBe(" > /foe");
		await typeLine(t, "Old Grub 7");
		await clickSquare(t, "c2");
		await run(GM, { type: "set-place", who: "grub", at: { x: 2, y: 1 } });
		await clickInPrep(t, "fight");
		expect(fake.submitted).toEqual([
			"/recruit Bea",
			"/foe Old Grub 7",
			"/place grub c2",
			"/start",
		]);
	});
});

const hintRow = (t: Setup) => rowsOf(t.captureCharFrame()).at(-2) ?? "";

describe("what an empty table says, by ruleset", () => {
	for (const ruleset of ["draw-steel", "set-world"] as const) {
		test(`${ruleset}: the GM is pointed at the prep panel until there is a party or a map`, async () => {
			const { t, run } = await seat(new Table(), GM, ruleset);
			expect(hintRow(t)).toStartWith(
				" Alt+5 or /prep sets up a game · /help lists the commands"
			);
			expect(await typeLine(t, "/prep")).toContain("─ ⁵ GM prep");
			expect(hintRow(t)).not.toContain("sets up a game");
			t.mockInput.pressKey("5", { meta: true });
			await settle(t);
			expect(hintRow(t)).toContain("sets up a game");
			await run(
				GM,
				ruleset === "draw-steel"
					? { type: "map", id: "yard", grid: YARD }
					: { type: "set-map", id: "yard", grid: YARD }
			);
			expect(hintRow(t)).not.toContain("sets up a game");
			expect(hintRow(t)).toContain("Tab completes");
		});
	}

	test("draw-steel: a player without a hero hears the free ones, and how to take one", async () => {
		const table = new Table();
		table.run(GM, { type: "hero", hero: "vex", sheet: VEX });
		table.run(GM, { type: "hero", hero: "kor", sheet: KOR });
		const { t, run } = await seat(table, ALICE, "draw-steel");
		expect(hintRow(t)).toBe(
			" free to play: Vex, Kor · /play <name> takes one · /help"
		);
		await run(ALICE, { type: "play", hero: "vex" });
		expect(hintRow(t)).toContain("Tab completes");
	});

	test("set-world: a player without a fighter hears the free ones, and how to take one", async () => {
		const { t, run } = await seat(setWorldTable(), ALICE, "set-world");
		expect(hintRow(t)).toBe(
			" free to play: Ada · /play <name> takes one · /help"
		);
		await run(ALICE, { type: "set-play", who: "ada" });
		expect(hintRow(t)).not.toContain("free to play");
	});
});

const mapRows = (rows: ReadonlyArray<string>) =>
	rows.filter((r) => /^│ +\d+ [·█V]/u.test(r)).length;

describe("the prep panel at 80x24", () => {
	test("Draw Steel: the header, the band, the map, the feed, the panel, the hint and the input all show", async () => {
		const { t } = await seat(drawSteelTable(), GM, "draw-steel");
		const frame = await typeLine(t, "/prep");
		const rows = rowsOf(frame);
		expect(rows).toHaveLength(24);
		expect(rows[0]).toContain("supervillain · den");
		expect(frame).toContain("¹ party");
		expect(frame).toContain("² map · Yard");
		expect(frame).toContain("³ feed");
		expect(
			must(rows.find((r) => r.includes("⁵ GM prep"))).indexOf("┌─ ⁵")
		).toBe(54);
		expect(panelRows(t)[0]).toBe(" ◆ ◆ ◈ foes ◇ ▶");
		expect(frame).toContain("Goblin Warrior 1");
		expect(rows.at(-1)).toStartWith(" > ");
		expect(rows.every((r) => charsOf(r).length <= 80)).toBe(true);
		expect(frame).not.toContain("×2");
		expect(await scrollPrep(t, 3)).toContain("×2");
	});

	test("set.world: the same", async () => {
		const { t } = await seat(setWorldTable(), GM, "set-world");
		const frame = await typeLine(t, "/prep");
		expect(rowsOf(frame)).toHaveLength(24);
		expect(frame).toContain("² map · Yard");
		expect(frame).toContain("+ Recruit");
		expect(rowsOf(frame).at(-1)).toStartWith(" > ");
	});

	test("a reply opened beside it (/help), or it beside a reply, leaves every box whole", async () => {
		const help = helpText(GM, undefined, "seat");

		await inOrder(
			[
				["/prep", "/help"],
				["/help", "alt+5"],
			],
			async (order) => {
				const { t } = await seat(drawSteelTable(), GM, "draw-steel", 24, (l) =>
					l === "/help" ? help : undefined
				);

				await inOrder(order, async (step) => {
					if (step === "alt+5") {
						t.mockInput.pressKey("5", { meta: true });
						await settle(t);
					} else {
						await typeLine(t, step);
					}
				});

				const rows = rowsOf(t.captureCharFrame());
				expect(rows).toHaveLength(24);
				expect(rows[0]).toContain("supervillain · den");
				const tops = rows.flatMap((r, i) => (r.startsWith("┌") ? [i] : []));
				const bottoms = rows.flatMap((r, i) => (r.startsWith("└") ? [i] : []));
				expect(tops.map((i) => must(rows[i]).slice(0, 6))).toEqual([
					"┌─ ¹ p",
					"┌─ ³ f",
					"┌─ ⁴ j",
				]);
				expect(bottoms).toHaveLength(3);

				for (const [k, top] of tops.entries()) {
					expect(must(bottoms[k])).toBeGreaterThan(top);
				}

				for (const [k, top] of tops.slice(1).entries()) {
					expect(top).toBeGreaterThan(must(bottoms[k]));
				}

				const prepTop = rows.findIndex((r) => r.includes("┌─ ⁵ GM prep"));
				expect(prepTop).toBe(must(bottoms[0]) + 1);
				expect(rows[must(tops[2]) - 1]).toMatch(/┘└─+┘$/u);
				expect(rows.at(-1)).toStartWith(" > ");
				setup?.renderer.destroy();
				setup = undefined;
			}
		);
	});

	test("in a fight with a full band, the map keeps its rows: the panel takes columns, not rows", async () => {
		const t = drawSteelTable();
		t.run(GM, { type: "hero", hero: "kor", sheet: KOR });
		t.run(GM, {
			type: "add",
			monster: "goblin-warrior",
			count: 6,
			sheet: GOBLIN,
		});
		t.run(GM, { type: "start" }, fixedDice(8));
		const { t: shown } = await seat(t, GM, "draw-steel");

		const before = mapRows(rowsOf(shown.captureCharFrame()));
		const rows = rowsOf(await typeLine(shown, "/prep"));
		expect(rows).toHaveLength(24);
		expect(rows.join("\n")).toContain("─ ⁵ GM prep");
		expect(mapRows(rows)).toBe(before);
	});
});
