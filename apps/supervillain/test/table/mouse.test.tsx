import { afterEach, describe, expect, test } from "bun:test";

import { testRender } from "@opentui/solid";
import {
	actionLine,
	actionsOf,
	bandOf,
	GM,
	mapOf,
	ifDefined,
} from "@supervillain/domain";
import type { TokenAction } from "@supervillain/domain";
import { createSignal } from "solid-js";

import { App } from "../../src/table/App.tsx";
import { bandLayout, whoAt } from "../../src/table/band.ts";
import { emptyLine, insertWord, remember } from "../../src/table/input.ts";
import { mapLayout, squareAt, tokenAt } from "../../src/table/map.ts";
import type { MapLayout } from "../../src/table/map.ts";
import {
	choose,
	clickOutcome,
	menuOf,
	menuRows,
	menuStands,
	onTitle,
} from "../../src/table/mouse.ts";
import type { Selection } from "../../src/table/mouse.ts";
import {
	allHiddenParts,
	hiddenPanels,
	ALL_SHOWN,
} from "../../src/table/panels.ts";
import {
	GUTTER,
	LABEL_ROWS,
	pictureSquareAt,
	pictureWindow,
	SQUARE,
} from "../../src/table/picture.ts";
import { PictureMap } from "../../src/table/PictureMap.tsx";
import { GOBLIN, KOR, VEX } from "../drawSteel/harness.ts";
import { must } from "../game/must.ts";
import { ALICE, Table, fixedDice } from "../game/table.ts";
import { character } from "../setWorld/harness.ts";
import { fight, sampleFord } from "./combat.ts";
import { fakeView, line } from "./fakeView.ts";
import { ford, hall } from "./maps.ts";

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

const clickOn = async (t: Setup, text: string, from = 0) => {
	const at = where(t, text, from);

	return await click(t, at.col, at.row);
};

const drawnAt = (layout: MapLayout, mark: string) => {
	for (let row = layout.squares.top; row < layout.lines.length; row += 1) {
		const col = must(layout.lines[row])
			.map((s) => s.text)
			.join("")
			.indexOf(mark);

		if (col >= layout.squares.left) {
			return { col, row };
		}
	}

	throw new Error(`${mark} isn't drawn`);
};

describe("which square a click on the text map lands on", () => {
	test("a map that fits: both columns of a square are it; numbers, letters and the blank around are not", () => {
		const layout = mapLayout(ford, 76, 10);
		const grid = layout.squares;

		for (const t of ford.tokens.filter((k) => !k.dead)) {
			const { col, row } = drawnAt(layout, t.mark);
			expect(squareAt(grid, col, row)).toEqual({ x: t.x, y: t.y });
			expect(squareAt(grid, col + 1, row)).toEqual({ x: t.x, y: t.y });
		}

		const text = (row: number) =>
			must(layout.lines[row])
				.map((s) => s.text)
				.join("");

		expect(text(grid.top).slice(grid.left - 2, grid.left)).toBe("1 ");
		expect(text(grid.top - 1).slice(grid.left, grid.left + 3)).toBe("a b");
		expect(squareAt(grid, grid.left, grid.top)).toEqual({ x: 0, y: 0 });
		expect(squareAt(grid, grid.left + 11, grid.top + 3)).toEqual({
			x: 5,
			y: 3,
		});
		expect(squareAt(grid, grid.left - 1, grid.top)).toBeUndefined();
		expect(squareAt(grid, grid.left, grid.top - 1)).toBeUndefined();
		expect(squareAt(grid, grid.left + 12, grid.top)).toBeUndefined();
		expect(squareAt(grid, grid.left, grid.top + 4)).toBeUndefined();
		expect(squareAt(grid, 0, 0)).toBeUndefined();
	});

	test("a cropped view centred elsewhere counts from the squares it shows, never the arrows", () => {
		const layout = mapLayout(hall(), 40, 10, { x: 20, y: 15 });
		const grid = layout.squares;
		expect(grid.x0).toBeGreaterThan(0);
		expect(grid.y0).toBeGreaterThan(0);
		expect(squareAt(grid, grid.left, grid.top)).toEqual({
			x: grid.x0,
			y: grid.y0,
		});

		const last = {
			col: grid.left + 2 * grid.cols - 1,
			row: grid.top + grid.rows - 1,
		};

		expect(squareAt(grid, last.col, last.row)).toEqual({
			x: grid.x0 + grid.cols - 1,
			y: grid.y0 + grid.rows - 1,
		});
		expect(squareAt(grid, last.col + 1, last.row)).toBeUndefined();
		expect(squareAt(grid, last.col, last.row + 1)).toBeUndefined();
		expect(layout.bottomTitle).toContain("↘V");
		const arrow = drawnAt(layout, "↘");
		expect(squareAt(grid, arrow.col, arrow.row)).toBeUndefined();
	});

	test("following the one acting near the map's corner, a token's square is where it is drawn", () => {
		const layout = mapLayout(hall(), 30, 8);
		const { col, row } = drawnAt(layout, "V");
		expect(squareAt(layout.squares, col, row)).toEqual({ x: 35, y: 25 });
		expect(squareAt(layout.squares, col + 1, row)).toEqual({ x: 35, y: 25 });
	});

	test("past z the column letters take two rows, and the squares start below both", () => {
		const layout = mapLayout(hall(), 40, 12, { x: 30, y: 5 });
		const grid = layout.squares;
		const { col, row } = drawnAt(layout, "g");
		expect(squareAt(grid, col, row)).toEqual({ x: 30, y: 5 });

		const letters = (r: number) =>
			must(layout.lines[r])
				.map((s) => s.text)
				.join("");

		expect(letters(grid.top - 2)[col]).toBe("a");
		expect(letters(grid.top - 1)[col]).toBe("e");
		expect(squareAt(grid, col, grid.top - 1)).toBeUndefined();
		expect(squareAt(grid, col, grid.top - 2)).toBeUndefined();
	});

	test("the token on a square is the one drawn there: the living over the dead", () => {
		const map = {
			...ford,
			tokens: [
				...ford.tokens,
				{
					...must(ford.tokens[1]),
					id: "goblin-2",
					mark: "g2",
					x: 5,
					y: 3,
					dead: false,
				},
			],
		};

		expect(tokenAt(map, { x: 5, y: 3 })?.id).toBe("goblin-2");
		expect(tokenAt(map, { x: 1, y: 1 })?.id).toBe("vex");
		expect(tokenAt(map, { x: 0, y: 0 })).toBeUndefined();
	});
});

describe("which square a click on the picture map lands on", () => {
	test("four columns by two rows a square, after the numbers' gutter and under the letters' row", () => {
		const w = pictureWindow(ford, 10, 10);
		expect(pictureSquareAt(w, GUTTER, LABEL_ROWS)).toEqual({ x: 0, y: 0 });
		expect(
			pictureSquareAt(w, GUTTER + SQUARE.cols - 1, LABEL_ROWS + SQUARE.rows - 1)
		).toEqual({
			x: 0,
			y: 0,
		});
		expect(pictureSquareAt(w, GUTTER + SQUARE.cols, LABEL_ROWS)).toEqual({
			x: 1,
			y: 0,
		});
		expect(
			pictureSquareAt(w, GUTTER + 5 * SQUARE.cols, LABEL_ROWS + 3 * SQUARE.rows)
		).toEqual({
			x: 5,
			y: 3,
		});
		expect(pictureSquareAt(w, GUTTER - 1, LABEL_ROWS)).toBeUndefined();
		expect(pictureSquareAt(w, GUTTER, LABEL_ROWS - 1)).toBeUndefined();
		expect(
			pictureSquareAt(w, GUTTER + 6 * SQUARE.cols, LABEL_ROWS)
		).toBeUndefined();
		expect(
			pictureSquareAt(w, GUTTER, LABEL_ROWS + 4 * SQUARE.rows)
		).toBeUndefined();
	});

	test("a window cropped to the one acting counts from its first square", () => {
		const w = pictureWindow(hall(), 10, 6);
		expect(w).toMatchObject({ x0: 30, y0: 23 });
		expect(pictureSquareAt(w, GUTTER, LABEL_ROWS)).toEqual({ x: 30, y: 23 });
		expect(
			pictureSquareAt(
				w,
				GUTTER + 5 * SQUARE.cols + 2,
				LABEL_ROWS + 2 * SQUARE.rows + 1
			)
		).toEqual({ x: 35, y: 25 });
	});

	test("a click on the drawn picture map gives its square", async () => {
		const squares: Array<{ x: number; y: number }> = [];
		const titles: Array<string> = [];
		setup = await testRender(
			() => (
				<PictureMap
					map={ford}
					height={12}
					onSquare={(s) => {
						squares.push(s);
					}}
					onTitle={() => {
						titles.push("title");
					}}
				/>
			),
			{ width: 40, height: 12 }
		);
		await setup.renderOnce();
		await click(setup, 2 + GUTTER + SQUARE.cols, 1 + LABEL_ROWS + SQUARE.rows);
		await click(setup, 2 + GUTTER - 1, 1 + LABEL_ROWS);
		await click(setup, 4, 0);
		expect(squares).toEqual([{ x: 1, y: 1 }]);
		expect(titles).toEqual(["title"]);
	});
});

describe("whose row a click on the band lands on", () => {
	test("every combatant's row, paired or whole, gives its id, and the gap the cell before it", () => {
		const view = fight(sampleFord);
		const { lines } = bandLayout(view, 76, 8);

		for (const c of view.combatants.filter((k) => k.health !== "dead")) {
			const row = lines.findIndex((l) =>
				l.some((s) => s.text === c.mark?.padEnd(3))
			);

			const col = must(lines[row])
				.map((s) => s.text)
				.join("")
				.indexOf(must(c.mark).padEnd(3));

			expect(whoAt(lines[row], col)).toBe(c.id);
		}

		const paired = must(
			lines.find((l) => new Set(l.map((s) => s.who).filter(Boolean)).size === 2)
		);

		const ids = [...new Set(paired.map((s) => s.who).filter(Boolean))];
		const right = paired.findIndex((s) => s.who === ids[1]);

		const gap =
			paired.slice(0, right).reduce((n, s) => n + Bun.stringWidth(s.text), 0) -
			1;

		expect(whoAt(paired, gap)).toBe(ids[0]);
		expect(whoAt(paired, 999)).toBeUndefined();
		expect(whoAt(undefined, 0)).toBeUndefined();
	});
});

const drawSteelTable = () => {
	const t = new Table();
	t.run(ALICE, { type: "name", name: "Alice" });
	t.run(GM, { type: "hero", hero: "vex", sheet: VEX });
	t.run(GM, { type: "hero", hero: "kor", sheet: KOR });
	t.run(ALICE, { type: "play", hero: "vex" });
	t.run(GM, {
		type: "add",
		monster: "goblin-warrior",
		count: 2,
		sheet: GOBLIN,
	});
	t.run(GM, {
		type: "map",
		id: "yard",
		grid: {
			name: "Yard",
			terrain: [
				"..........",
				"..........",
				"....##....",
				"..........",
				"..........",
			],
		},
	});
	t.run(GM, { type: "place", who: "vex", at: { x: 1, y: 1 } });
	t.run(GM, { type: "place", who: "kor", at: { x: 1, y: 3 } });
	t.run(GM, { type: "place", who: "goblin-warrior-1", at: { x: 7, y: 1 } });
	t.run(GM, { type: "place", who: "goblin-warrior-2", at: { x: 7, y: 2 } });

	return t;
};

const setWorldTable = () => {
	const t = new Table();
	t.run(ALICE, { type: "name", name: "Alice" });
	t.run(GM, {
		type: "set-recruit",
		name: "Ada",
		character: character({ initiative: 2 }),
	});
	t.run(GM, {
		type: "set-foe",
		name: "Grub",
		character: character({}, "sword", 2),
	});
	t.run(GM, {
		type: "set-map",
		id: "field",
		grid: { name: "Field", terrain: ["........", "........"] },
	});
	t.run(ALICE, { type: "set-play", who: "ada" });
	t.run(GM, { type: "set-place", who: "ada", at: { x: 0, y: 0 } });
	t.run(GM, { type: "set-place", who: "grub", at: { x: 3, y: 1 } });
	t.run(GM, { type: "set-start" });

	return t;
};

const labels = (actions: ReadonlyArray<TokenAction> | undefined) =>
	actions?.map((a) => a.label);

describe("what a seat may do with a token, by ruleset", () => {
	test("Draw Steel: a player's own hero moves and uses its abilities; anyone else's gets no menu", () => {
		const t = drawSteelTable();
		expect(actionsOf(t.state, ALICE, "draw-steel", "vex")).toEqual([
			{ label: "Move", pick: "square", line: "/move vex" },
			{
				label: "Spinning Strike",
				pick: "targets",
				line: "/pr vex Spinning Strike",
			},
			{ label: "Spirit Lash", pick: "targets", line: "/pr vex Spirit Lash" },
		]);
		expect(actionsOf(t.state, ALICE, "draw-steel", "kor")).toBeUndefined();
		expect(
			actionsOf(t.state, ALICE, "draw-steel", "goblin-warrior-1")
		).toBeUndefined();
		expect(actionsOf(t.state, ALICE, "draw-steel", "nobody")).toBeUndefined();
	});

	test("Draw Steel: the GM acts for anyone, a creature has its free strike, End turn on its turn", () => {
		const t = drawSteelTable();
		expect(labels(actionsOf(t.state, GM, "draw-steel", "kor"))).toEqual([
			"Move",
			"Brutal Slam",
		]);
		expect(actionsOf(t.state, GM, "draw-steel", "goblin-warrior-1")).toEqual([
			{ label: "Move", pick: "square", line: "/move goblin-warrior-1" },
			{
				label: "Spear Charge",
				pick: "targets",
				line: "/pr goblin-warrior-1 Spear Charge",
			},
			{ label: "Free strike", pick: "target", line: "/fs goblin-warrior-1" },
		]);
		t.run(GM, { type: "start" }, fixedDice(8));
		t.run(GM, { type: "first", side: "heroes" });
		t.run(ALICE, { type: "turn" }, fixedDice(1, 1, 1));
		expect(labels(actionsOf(t.state, ALICE, "draw-steel", "vex"))).toEqual([
			"Move",
			"Spinning Strike",
			"Spirit Lash",
			"End turn",
		]);
		expect(actionsOf(t.state, ALICE, "draw-steel", "vex")?.at(-1)).toEqual({
			label: "End turn",
			pick: "none",
			line: "/done",
		});
		expect(labels(actionsOf(t.state, GM, "draw-steel", "kor"))).toEqual([
			"Move",
			"Brutal Slam",
		]);
	});

	test("Draw Steel: off the map there is nothing to move", () => {
		const t = drawSteelTable();
		t.run(GM, { type: "map" });
		expect(labels(actionsOf(t.state, ALICE, "draw-steel", "vex"))).toEqual([
			"Spinning Strike",
			"Spirit Lash",
		]);
	});

	test("set.world: Move, Attack, and Done on the fighter's own turn", () => {
		const t = setWorldTable();
		expect(actionsOf(t.state, ALICE, "set-world", "ada")).toEqual([
			{ label: "Move", pick: "square", line: "/move ada" },
			{ label: "Attack", pick: "target", line: "/attack ada" },
			{ label: "Done", pick: "none", line: "/done" },
		]);
		expect(actionsOf(t.state, ALICE, "set-world", "grub")).toBeUndefined();
		expect(labels(actionsOf(t.state, GM, "set-world", "grub"))).toEqual([
			"Move",
			"Attack",
		]);
	});

	test("a choice's line takes a square or a target after it, and targets after `on`", () => {
		const move: TokenAction = {
			label: "Move",
			pick: "square",
			line: "/move vex",
		};

		const strike: TokenAction = {
			label: "Gouge",
			pick: "targets",
			line: "/pr vex Gouge",
		};

		const attack: TokenAction = {
			label: "Attack",
			pick: "target",
			line: "/attack ada",
		};

		expect(actionLine(move, ["c5"])).toBe("/move vex c5");
		expect(actionLine(attack, ["grub"])).toBe("/attack ada grub");
		expect(actionLine(strike, ["g1", "g2"])).toBe("/pr vex Gouge on g1 g2");
		expect(actionLine(strike, [])).toBe("/pr vex Gouge");
	});
});

const mine = (id: string) => id === "vex" || id === "kor";

const name = (id: string) => ({ vex: "Vex", "goblin-1": "Goblin 1" })[id] ?? id;

const mark = (id: string) => ({ "goblin-1": "g1", kor: "K" })[id] ?? id;

describe("what a click does, as data", () => {
	const actions: ReadonlyArray<TokenAction> = [
		{ label: "Move", pick: "square", line: "/move vex" },
		{ label: "Gouge", pick: "targets", line: "/pr vex Gouge" },
		{ label: "Free strike", pick: "target", line: "/fs vex" },
		{ label: "End turn", pick: "none", line: "/done" },
	];

	const selected: Selection = { id: "vex", picked: [] };
	const goblin = { token: { id: "goblin-1", mark: "g1" }, square: "h2" };
	const vex = { token: { id: "vex", mark: "V" }, square: "b2" };
	const kor = { token: { id: "kor", mark: "K" }, square: "b4" };

	test("with nothing selected: your token opens its menu, anything else types its name", () => {
		expect(clickOutcome(undefined, vex, mine)).toEqual({
			kind: "select",
			id: "vex",
		});
		expect(clickOutcome(undefined, goblin, mine)).toEqual({
			kind: "insert",
			text: "g1",
		});
		expect(clickOutcome(undefined, { square: "c5" }, mine)).toEqual({
			kind: "insert",
			text: "c5",
		});
		expect(
			clickOutcome(undefined, { token: { id: "ogre", mark: undefined } }, mine)
		).toEqual({
			kind: "insert",
			text: "ogre",
		});
		expect(clickOutcome(undefined, {}, mine)).toEqual({ kind: "none" });
	});

	test("with a menu open: another of yours switches, the same one or anything else closes it", () => {
		expect(clickOutcome(selected, kor, mine)).toEqual({
			kind: "select",
			id: "kor",
		});
		expect(clickOutcome(selected, vex, mine)).toEqual({ kind: "clear" });
		expect(clickOutcome(selected, goblin, mine)).toEqual({ kind: "clear" });
		expect(clickOutcome(selected, { square: "c5" }, mine)).toEqual({
			kind: "clear",
		});
	});

	test("a choice under way takes what it waits for, and nothing else", () => {
		const moving = { ...selected, chosen: must(actions[0]) };
		expect(clickOutcome(moving, { square: "c5" }, mine)).toEqual({
			kind: "send",
			line: "/move vex c5",
		});
		expect(
			clickOutcome(moving, { token: { id: "kor", mark: "K" } }, mine)
		).toEqual({
			kind: "none",
		});
		const striking = { ...selected, chosen: must(actions[2]) };
		expect(clickOutcome(striking, goblin, mine)).toEqual({
			kind: "send",
			line: "/fs vex goblin-1",
		});
		expect(clickOutcome(striking, { square: "c5" }, mine)).toEqual({
			kind: "none",
		});
		const gouging = { ...selected, chosen: must(actions[1]) };
		expect(clickOutcome(gouging, goblin, mine)).toEqual({
			kind: "picked",
			picked: ["goblin-1"],
		});
		expect(
			clickOutcome({ ...gouging, picked: ["goblin-1"] }, kor, mine)
		).toEqual({
			kind: "picked",
			picked: ["goblin-1", "kor"],
		});
		expect(
			clickOutcome({ ...gouging, picked: ["goblin-1", "kor"] }, goblin, mine)
		).toEqual({
			kind: "picked",
			picked: ["kor"],
		});
	});

	test("a menu stands while its token's choices do, and the choice under way is among them", () => {
		expect(menuStands(selected, actions)).toBe(true);
		expect(menuStands(selected, undefined)).toBe(false);
		const moving = { ...selected, chosen: must(actions[0]) };
		expect(menuStands(moving, actions)).toBe(true);
		expect(menuStands(moving, actions.slice(1))).toBe(false);
		expect(menuStands(selected, actions.slice(1))).toBe(true);
	});

	test("choosing sends what needs nothing clicked, and waits for the rest", () => {
		expect(choose(selected, must(actions[3]))).toEqual({
			kind: "send",
			line: "/done",
		});
		expect(choose(selected, must(actions[0]))).toEqual({
			kind: "chosen",
			selection: { id: "vex", chosen: must(actions[0]), picked: [] },
		});
	});

	test("the menu says what is going on, and Roll sends the targets clicked", () => {
		const open = menuOf(selected, actions, name, mark);
		expect(open.lead).toBe("Vex:");
		expect(open.items.map((i) => i.label)).toEqual([
			"Move",
			"Gouge",
			"Free strike",
			"End turn",
			"Cancel",
		]);
		expect(
			menuOf({ ...selected, chosen: must(actions[0]) }, actions, name, mark)
		).toEqual({
			lead: "Vex · Move: click a square",
			items: [{ kind: "cancel", label: "Cancel" }],
		});
		const gouge = { ...selected, chosen: must(actions[1]) };
		expect(menuOf(gouge, actions, name, mark).lead).toBe(
			"Vex · Gouge: click targets, then Roll"
		);
		expect(
			menuOf({ ...gouge, picked: ["goblin-1", "kor"] }, actions, name, mark)
		).toEqual({
			lead: "Vex · Gouge: on g1 K",
			items: [
				{ kind: "roll", label: "Roll", line: "/pr vex Gouge on goblin-1 kor" },
				{ kind: "cancel", label: "Cancel" },
			],
		});
	});

	test("menu rows wrap whole items to the next row", () => {
		const menu = {
			lead: "Bandit Chief:",
			items: ["Move", "Hooked Blade", "Get Them!", "Free strike", "Cancel"].map(
				(label) => ({ kind: "cancel", label }) as const
			),
		};

		const rows = menuRows(menu, 40);
		const text = rows.map((r) => r.map((p) => p.text).join(""));
		expect(text).toEqual([
			"Bandit Chief:  Move   Hooked Blade ",
			" Get Them!   Free strike   Cancel ",
		]);
		expect(
			rows.every((r) => Bun.stringWidth(r.map((p) => p.text).join("")) <= 40)
		).toBe(true);
		expect(
			rows
				.flat()
				.filter((p) => p.item !== undefined)
				.map((p) => p.item)
		).toEqual([0, 1, 2, 3, 4]);
	});

	test("a title is clickable where OpenTUI draws it, and only when it does", () => {
		expect(onTitle(" ³ feed ", 80, 1)).toBe(false);
		expect(onTitle(" ³ feed ", 80, 2)).toBe(true);
		expect(onTitle(" ³ feed ", 80, 9)).toBe(true);
		expect(onTitle(" ³ feed ", 80, 10)).toBe(false);
		expect(onTitle(" ³ feed ", 11, 2)).toBe(false);
	});

	test("a clicked word is typed as its own word, and a clicked line is kept in history", () => {
		const typed = insertWord({ ...emptyLine, text: "/dist", cursor: 5 }, "V");
		expect(typed.text).toBe("/dist V ");
		expect(insertWord(typed, "c5").text).toBe("/dist V c5 ");
		expect(insertWord(emptyLine, "g1").text).toBe("g1 ");

		const kept = remember(
			{ ...emptyLine, text: "hel", cursor: 3 },
			"/move vex c5"
		);

		expect(kept.history).toEqual(["/move vex c5"]);
		expect(kept.text).toBe("hel");
		expect(remember(kept, "/move vex c5").history).toEqual(["/move vex c5"]);
	});

	test("the hidden panels a click would show again, and the all-hidden line in pieces", () => {
		expect(hiddenPanels(ALL_SHOWN, ["band", "map", "feed"])).toEqual([]);
		expect(
			hiddenPanels({ ...ALL_SHOWN, band: false, map: false }, ["band", "feed"])
		).toEqual(["band"]);
		const parts = allHiddenParts(["band", "feed"], 100);
		expect(parts.map((p) => p.text).join("")).toBe(
			"every panel is hidden · Alt+1 band · Alt+3 feed · /view both shows them all"
		);
		expect(parts.filter((p) => p.panel !== undefined)).toEqual([
			{ text: "Alt+1 band", panel: "band" },
			{ text: "Alt+3 feed", panel: "feed" },
		]);
	});
});

const seat = async (
	t: Table,
	actor: string,
	ruleset: "draw-steel" | "set-world",
	replies?: (line: string) => string | undefined
) => {
	const [version, setVersion] = createSignal(0);

	const fake = fakeView({
		me: actor,
		myName: actor === GM ? undefined : "Alice",
		feed: [line(1, "Oscar", "welcome to the yard")],
		combat: bandOf(t.state, actor, ruleset) ?? null,
		map: mapOf(t.state, actor, ruleset) ?? null,
		actions: (id) => {
			version();

			return actionsOf(t.state, actor, ruleset, id);
		},
		...ifDefined(replies, (value) => ({ reply: value })),
	});

	setup = await testRender(() => <App view={fake.view} />, {
		width: 80,
		height: 24,
		exitOnCtrlC: false,
		autoFocus: false,
	});
	await setup.renderOnce();
	const shown = setup;

	const run = async (...args: Parameters<Table["run"]>) => {
		t.run(...args);
		fake.setCombat(bandOf(t.state, actor, ruleset));
		fake.setMap(mapOf(t.state, actor, ruleset));
		setVersion(version() + 1);

		return await settle(shown);
	};

	return { fake, t: setup, run };
};

const mapTop = (t: Setup) => where(t, "² map").row + 2;

describe("clicking at the table", () => {
	test("Draw Steel: your hero, Move, a square: /move", async () => {
		const { fake, t } = await seat(drawSteelTable(), ALICE, "draw-steel");
		await clickOn(t, "V", mapTop(t));
		const menu = rowsOf(t.captureCharFrame()).at(-3);
		expect(menu).toBe(" Vex:  Move   Spinning Strike   Spirit Lash   Cancel");
		await clickOn(t, " Move ", 20);
		expect(rowsOf(t.captureCharFrame()).at(-3)).toBe(
			" Vex · Move: click a square  Cancel"
		);
		const v = where(t, "V", mapTop(t));
		await click(t, v.col + 4, v.row);
		expect(fake.submitted).toEqual(["/move vex d2"]);
		expect(rowsOf(t.captureCharFrame()).at(-3)).not.toContain("Cancel");
		t.mockInput.pressArrow("up");
		await t.renderOnce();
		expect(rowsOf(t.captureCharFrame()).at(-1)).toContain("/move vex d2");
	});

	test("Draw Steel: an ability, targets on the map and in the band, then Roll: /pr … on …", async () => {
		const { fake, t } = await seat(drawSteelTable(), ALICE, "draw-steel");
		await clickOn(t, "V", mapTop(t));
		await clickOn(t, " Spinning Strike ", 20);
		expect(rowsOf(t.captureCharFrame()).at(-3)).toBe(
			" Vex · Spinning Strike: click targets, then Roll  Roll   Cancel"
		);
		await clickOn(t, "w1", mapTop(t));
		await clickOn(t, "Kor  ▐");
		expect(rowsOf(t.captureCharFrame()).at(-3)).toBe(
			" Vex · Spinning Strike: on w1 K  Roll   Cancel"
		);
		await clickOn(t, "Roll   Cancel", 20);
		expect(fake.submitted).toEqual([
			"/pr vex Spinning Strike on goblin-warrior-1 kor",
		]);
	});

	test("Draw Steel: the GM's creature strikes freely, and on your turn End turn ends it", async () => {
		const table = drawSteelTable();
		const gm = await seat(table, GM, "draw-steel");
		await clickOn(gm.t, "w2", mapTop(gm.t));
		expect(rowsOf(gm.t.captureCharFrame()).at(-3)).toBe(
			" Goblin Warrior 2:  Move   Spear Charge   Free strike   Cancel"
		);
		await clickOn(gm.t, " Free strike ", 20);
		await clickOn(gm.t, "K", mapTop(gm.t));
		expect(gm.fake.submitted).toEqual(["/fs goblin-warrior-2 kor"]);
		setup?.renderer.destroy();

		table.run(GM, { type: "start" }, fixedDice(8));
		table.run(GM, { type: "first", side: "heroes" });
		table.run(ALICE, { type: "turn" }, fixedDice(1, 1, 1));
		const alice = await seat(table, ALICE, "draw-steel");
		await clickOn(alice.t, "V", mapTop(alice.t));
		await clickOn(alice.t, " End turn ", 20);
		expect(alice.fake.submitted).toEqual(["/done"]);
	});

	test("Draw Steel: a creature two squares across opens its menu from any of its squares", async () => {
		const table = drawSteelTable();
		table.run(GM, {
			type: "add",
			monster: "ogre",
			count: 1,
			sheet: { ...GOBLIN, id: "ogre", name: "Ogre", size: "2", abilities: [] },
		});
		table.run(GM, { type: "place", who: "ogre", at: { x: 4, y: 3 } });
		const gm = await seat(table, GM, "draw-steel");
		const body = where(gm.t, "░░", mapTop(gm.t));
		await click(gm.t, body.col + 1, body.row + 1);
		expect(rowsOf(gm.t.captureCharFrame()).at(-3)).toBe(
			" Ogre:  Move   Free strike   Cancel"
		);
		await clickOn(gm.t, " Move ", 20);
		const anchor = where(gm.t, "o", mapTop(gm.t));
		await click(gm.t, anchor.col + 4, anchor.row);
		expect(gm.fake.submitted).toEqual(["/move ogre g4"]);
	});

	test("set.world: your fighter, Attack, a foe: /attack; on its turn, Done: /done", async () => {
		const { fake, t } = await seat(setWorldTable(), ALICE, "set-world");
		await clickOn(t, "A", mapTop(t));
		expect(rowsOf(t.captureCharFrame()).at(-3)).toBe(
			" Ada:  Move   Attack   Done   Cancel"
		);
		await clickOn(t, " Attack ", 20);
		expect(rowsOf(t.captureCharFrame()).at(-3)).toBe(
			" Ada · Attack: click a target  Cancel"
		);
		await clickOn(t, "g", mapTop(t));
		await clickOn(t, "A", mapTop(t));
		await clickOn(t, " Done ", 20);
		expect(fake.submitted).toEqual(["/attack ada grub", "/done"]);
	});

	test("with nothing selected, a token you can't act for or a square is typed at the cursor", async () => {
		const { fake, t } = await seat(drawSteelTable(), ALICE, "draw-steel");
		await t.mockInput.typeText("/dist");
		await clickOn(t, "w1", mapTop(t));
		const k = where(t, "K", mapTop(t));
		await click(t, k.col + 2, k.row);
		expect(rowsOf(t.captureCharFrame()).at(-1)).toBe(" > /dist w1 c4");
		expect(fake.submitted).toEqual([]);
	});

	test("Escape or Cancel closes the menu and sends nothing", async () => {
		const { fake, t } = await seat(drawSteelTable(), ALICE, "draw-steel");
		await clickOn(t, "V", mapTop(t));
		t.mockInput.pressEscape();
		await Bun.sleep(40);
		expect(await settle(t)).not.toContain("Cancel");
		await clickOn(t, "V", mapTop(t));
		await clickOn(t, " Move ", 20);
		await clickOn(t, " Cancel ", 20);
		expect(t.captureCharFrame()).not.toContain("Cancel");
		expect(fake.submitted).toEqual([]);
	});

	test("a menu closes when its choice goes: the map unloaded under Move", async () => {
		const { t, run } = await seat(drawSteelTable(), GM, "draw-steel");
		await clickOn(t, "V", mapTop(t));
		await clickOn(t, " Move ", 20);
		expect(rowsOf(t.captureCharFrame()).at(-3)).toBe(
			" Vex · Move: click a square  Cancel"
		);
		const frame = await run(GM, { type: "map" });
		expect(frame).not.toContain("² map");
		expect(frame).not.toContain("Cancel");
	});

	test("a menu closes when its creature dies, and the dead open none", async () => {
		const { fake, t, run } = await seat(drawSteelTable(), GM, "draw-steel");
		await clickOn(t, "w2", mapTop(t));
		expect(t.captureCharFrame()).toContain("Goblin Warrior 2:  Move");

		const frame = await run(GM, {
			type: "dmg",
			who: "goblin-warrior-2",
			amount: 99,
		});

		expect(frame).not.toContain("Cancel");
		await clickOn(t, "x", mapTop(t));
		expect(t.captureCharFrame()).not.toContain("Cancel");
		expect(rowsOf(t.captureCharFrame()).at(-1)).toBe(" > w2");
		expect(fake.submitted).toEqual([]);
	});

	test("a target that dies or leaves is no longer picked", async () => {
		const { fake, t, run } = await seat(drawSteelTable(), ALICE, "draw-steel");
		await clickOn(t, "V", mapTop(t));
		await clickOn(t, " Spinning Strike ", 20);
		await clickOn(t, "w1", mapTop(t));
		await clickOn(t, "w2", mapTop(t));
		expect(rowsOf(t.captureCharFrame()).at(-3)).toBe(
			" Vex · Spinning Strike: on w1 w2  Roll   Cancel"
		);

		const frame = await run(GM, {
			type: "dmg",
			who: "goblin-warrior-1",
			amount: 99,
		});

		expect(rowsOf(frame).at(-3)).toBe(
			" Vex · Spinning Strike: on w2  Roll   Cancel"
		);
		await clickOn(t, "Roll   Cancel", 20);
		expect(fake.submitted).toEqual([
			"/pr vex Spinning Strike on goblin-warrior-2",
		]);
	});

	test("a menu goes when the seat is too small to show it, and Esc is the notice's again", async () => {
		const { fake, t } = await seat(drawSteelTable(), ALICE, "draw-steel");
		await clickOn(t, "V", mapTop(t));
		await clickOn(t, " Move ", 20);
		t.resize(70, 18);
		await settle(t);
		await t.mockInput.typeText("/mouse x");
		t.mockInput.pressEnter();
		expect(await settle(t)).toContain("Usage: /mouse");
		t.mockInput.pressEscape();
		await Bun.sleep(40);
		expect(await settle(t)).not.toContain("Usage: /mouse");
		t.resize(80, 24);
		await settle(t);
		expect(await settle(t)).not.toContain("Cancel");
		expect(fake.submitted).toEqual([]);
	});

	test("a click focuses nothing and clears text selected by a drag; tokens are never selected", async () => {
		const { t } = await seat(drawSteelTable(), ALICE, "draw-steel");
		const feed = where(t, "welcome to the yard");
		await t.mockMouse.drag(feed.col, feed.row, feed.col + 6, feed.row);
		await settle(t);
		expect(t.renderer.hasSelection).toBe(true);
		const hint = rowsOf(t.captureCharFrame()).length - 2;
		await click(t, feed.col + 20, hint - 1);
		expect(t.renderer.hasSelection).toBe(false);
		expect(t.renderer.currentFocusedRenderable).toBeNull();
		const w = where(t, "w1", mapTop(t));
		await t.mockMouse.doubleClick(w.col, w.row, undefined, { delayMs: 0 });
		await settle(t);
		expect(t.renderer.hasSelection).toBe(false);
		await t.mockInput.typeText("hi");
		await t.renderOnce();
		expect(rowsOf(t.captureCharFrame()).at(-1)).toBe(" > w1 w1 hi");
	});

	test("a refused click is answered like a typed line", async () => {
		const { fake, t } = await seat(
			drawSteelTable(),
			ALICE,
			"draw-steel",
			() => "Not now."
		);

		await clickOn(t, "V", mapTop(t));
		await clickOn(t, " Spirit Lash ", 20);
		await clickOn(t, "Roll   Cancel", 20);
		expect(fake.submitted).toEqual(["/pr vex Spirit Lash"]);
		expect(rowsOf(t.captureCharFrame()).at(-3)).toBe(" › Not now.");
	});
});

describe("panel titles and the hidden panels", () => {
	test("a title's click hides its panel; the hint row's entry shows it again", async () => {
		const { t } = await seat(drawSteelTable(), ALICE, "draw-steel");
		await clickOn(t, "³ feed");
		let rows = rowsOf(t.captureCharFrame());
		expect(rows.join("\n")).not.toContain("─ ³ feed");
		expect(rows.at(-2)).toEndWith(" · show ³ feed");
		await clickOn(t, "¹ party");
		rows = rowsOf(t.captureCharFrame());
		expect(rows.at(-2)).toEndWith(" · show ¹ band ³ feed");
		await clickOn(t, "³ feed", rows.length - 2);
		rows = rowsOf(t.captureCharFrame());
		expect(rows.join("\n")).toContain("─ ³ feed");
		expect(rows.at(-2)).toEndWith(" · show ¹ band");
		const map = where(t, "² map");
		await click(t, map.col + 20, map.row);
		expect(t.captureCharFrame()).toContain("² map");
	});

	test("at 80 columns the hint beside the hidden panels is always whole", async () => {
		const { t } = await seat(drawSteelTable(), GM, "draw-steel");

		const hints = [
			"Tab completes · ↑↓ history · PgUp/PgDn scroll · /help · Ctrl-C leaves",
			"Tab completes · ↑↓ history · /help · Ctrl-C leaves",
			"Tab completes · /help · Ctrl-C leaves",
		];

		const hintRow = () => must(rowsOf(t.captureCharFrame()).at(-2));

		const whole = (shows: string) => {
			const row = hintRow();
			expect(row).toEndWith(shows);
			expect(hints.map((h) => ` ${h}${shows}`)).toContain(row);
		};

		await clickOn(t, "³ feed");
		whole(" · show ³ feed");
		await clickOn(t, "¹ party");
		whole(" · show ¹ band ³ feed");
	});

	test("with every panel hidden, each key on the line shows its panel", async () => {
		const { t } = await seat(drawSteelTable(), ALICE, "draw-steel");
		await clickOn(t, "¹ party");
		await clickOn(t, "² map");
		await clickOn(t, "³ feed");
		expect(t.captureCharFrame()).toContain(
			"every panel is hidden · Alt+1 band · Alt+2 map"
		);
		await clickOn(t, "Alt+2 map");
		expect(t.captureCharFrame()).toContain("² map · Yard");
	});

	test("the reply pane's title hides it", async () => {
		const { t } = await seat(
			drawSteelTable(),
			ALICE,
			"draw-steel",
			() => "line one\nline two"
		);

		await t.mockInput.typeText("/sheet vex");
		t.mockInput.pressEnter();
		await settle(t);
		await clickOn(t, "⁴ just for you");
		expect(t.captureCharFrame()).toContain("your reply is hidden");
	});
});

describe("the wheel and /mouse", () => {
	test("the wheel scrolls the feed under the pointer", async () => {
		const fake = fakeView({
			myName: "Alice",
			feed: Array.from({ length: 40 }, (_, i) =>
				line(i + 1, "Oscar", `line ${i + 1}`)
			),
		});

		setup = await testRender(() => <App view={fake.view} />, {
			width: 80,
			height: 24,
			exitOnCtrlC: false,
			autoFocus: false,
		});
		await setup.renderOnce();
		expect(setup.captureCharFrame()).toContain("line 40");
		const feed = where(setup, "line 40");
		await setup.mockMouse.scroll(feed.col, feed.row, "up");
		await setup.renderOnce();
		expect(setup.captureCharFrame()).not.toContain("line 40");
		expect(setup.captureCharFrame()).toContain("line 37");
	});

	test("/mouse off stops the terminal's reports and every click; /mouse on brings them back", async () => {
		const { fake, t } = await seat(drawSteelTable(), ALICE, "draw-steel");
		expect(t.renderer.useMouse).toBe(true);
		await t.mockInput.typeText("/mouse off");
		t.mockInput.pressEnter();
		await settle(t);
		expect(t.renderer.useMouse).toBe(false);
		expect(rowsOf(t.captureCharFrame()).at(-3)).toStartWith(" › mouse off");
		await clickOn(t, "V", mapTop(t));
		await clickOn(t, "³ feed");
		expect(t.captureCharFrame()).not.toContain("Cancel");
		expect(t.captureCharFrame()).toContain("³ feed");
		await t.mockInput.typeText("/mouse on");
		t.mockInput.pressEnter();
		await settle(t);
		expect(t.renderer.useMouse).toBe(true);
		await clickOn(t, "V", mapTop(t));
		expect(t.captureCharFrame()).toContain("Cancel");
		expect(fake.submitted).toEqual([]);
	});
});
