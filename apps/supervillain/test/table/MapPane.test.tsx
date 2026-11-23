import { afterEach, describe, expect, test } from "bun:test";

import { RGBA, TextAttributes } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { charsOf, columnLabel } from "@supervillain/domain";
import { createSignal } from "solid-js";

import { focusOf, mapLayout, tokenAt } from "../../src/table/map.ts";
import type { Focus } from "../../src/table/map.ts";
import { MapPane } from "../../src/table/MapPane.tsx";
import { color } from "../../src/table/theme.ts";
import type { MapView } from "../../src/table/view.ts";
import { must } from "../game/must.ts";
import { hasAttribute } from "./combat.ts";
import { ford, hall, lair, token } from "./maps.ts";

type Setup = Awaited<ReturnType<typeof testRender>>;

let setup: Setup | undefined;

afterEach(() => {
	setup?.renderer.destroy();
	setup = undefined;
});

const mount = async (
	map: () => MapView,
	width: number,
	height: number,
	focus?: Focus
) => {
	setup = await testRender(
		() => <MapPane map={map()} height={height} focus={focus} />,
		{
			width,
			height: height + 2,
		}
	);
	await setup.renderOnce();

	return setup;
};

const paneRows = (t: Setup, height: number) =>
	t.captureCharFrame().split("\n").slice(0, height);

const inside = (row: string) => charsOf(row).slice(2, -2).join("").trimEnd();

const spansOf = (t: Setup) => t.captureSpans().lines.flatMap((l) => l.spans);

const hex = (c: string) => RGBA.fromHex(c);

describe("column names, as in c5", () => {
	test("a to z, then aa, ab and on, like a spreadsheet", () => {
		expect([0, 1, 2, 25, 26, 27, 51, 52, 701, 702].map(columnLabel)).toEqual([
			"a",
			"b",
			"c",
			"z",
			"aa",
			"ab",
			"az",
			"ba",
			"zz",
			"aaa",
		]);
	});
});

describe("a small map", () => {
	test("fits and is centred: two columns a square, column letters on top, row numbers left", async () => {
		const t = await mount(() => ford, 40, 7);
		const rows = paneRows(t, 7);
		expect(rows[0]).toContain("map · Ford crossing");
		const pad = " ".repeat(11);
		expect(rows.slice(1, 6).map(inside)).toEqual([
			`${pad}  a b c d e f`,
			`${pad}1 • • • · · ·`,
			`${pad}2 • V ████· ·`,
			`${pad}3 • • ~ ~ g1·`,
			`${pad}4 · · · · · x`,
		]);
		expect(rows[6]).toStartWith("└");
	});

	test("a dead token is an x, and the creature's letter is gone", async () => {
		const t = await mount(() => ford, 40, 7);
		const frame = t.captureCharFrame();
		expect(frame).not.toContain("O");
		expect(inside(must(paneRows(t, 7)[5]))).toEndWith("x");
	});

	test("tokens in role colours, the seat's own in its own; terrain never shares them", async () => {
		const t = await mount(() => ford, 40, 7);
		const spans = spansOf(t);
		const vex = spans.find((s) => s.text.trim() === "V");
		const goblin = spans.find((s) => s.text.trim() === "g1");
		expect(vex?.fg.equals(hex(color.you))).toBe(true);
		expect(goblin?.fg.equals(hex(color.director))).toBe(true);

		const tokenColours = [
			color.heroes,
			color.director,
			color.you,
			color.gm,
		].map(hex);

		const terrain = spans.filter((s) => /^[·•█~]/u.test(s.text.trim()));
		expect(terrain.length).toBeGreaterThan(0);

		for (const s of terrain) {
			for (const c of tokenColours) {
				expect(s.fg.equals(c)).toBe(false);
			}
		}
	});

	test("another hero is in the heroes' colour", async () => {
		const map: MapView = {
			...ford,
			tokens: [
				...ford.tokens,
				token({ id: "brakka", mark: "B", x: 0, y: 3, side: "heroes" }),
			],
		};

		const t = await mount(() => map, 40, 7);
		const brakka = spansOf(t).find((s) => s.text.trim() === "B");
		expect(brakka?.fg.equals(hex(color.heroes))).toBe(true);
	});

	test("the acting token is underlined and bold, so colour isn't the only sign", async () => {
		const t = await mount(() => ford, 40, 7);
		const spans = spansOf(t);
		const vex = spans.find((s) => s.text.trim() === "V");
		const goblin = spans.find((s) => s.text.trim() === "g1");
		expect(hasAttribute(vex?.attributes, TextAttributes.UNDERLINE)).toBe(true);
		expect(hasAttribute(vex?.attributes, TextAttributes.BOLD)).toBe(true);
		expect(hasAttribute(goblin?.attributes, TextAttributes.UNDERLINE)).toBe(
			false
		);
	});

	test("reachable squares are tinted, and their dot is a bigger one", async () => {
		const t = await mount(() => ford, 40, 7);
		const spans = spansOf(t);
		const reach = spans.filter((s) => s.text.includes("•"));
		const floor = spans.filter((s) => s.text.includes("·"));
		expect(reach.length).toBeGreaterThan(0);

		for (const s of reach) {
			expect(s.bg.equals(hex(color.reach))).toBe(true);
		}

		for (const s of floor) {
			expect(s.bg.equals(hex(color.reach))).toBe(false);
		}
	});

	test("with room to spare it is centred up and down too", async () => {
		const t = await mount(() => ford, 40, 11);
		const rows = paneRows(t, 11).map(inside);
		expect(rows[1]).toBe("");
		expect(rows[2]).toBe("");
		expect(rows[3]?.trim()).toBe("a b c d e f");
		expect(rows[7]?.trim()).toBe("4 · · · · · x");
	});
});

const floor = (n: number) => Array.from({ length: n }, () => "·").join(" ");

const squares = (n: number, marks: Readonly<Record<number, string>> = {}) =>
	Array.from({ length: n }, (_, i) => (marks[i] ?? "·").padEnd(2))
		.join("")
		.trimEnd();

describe("a map bigger than the pane", () => {
	test("follows the acting token, with arrows at the edges toward the tokens out of view", async () => {
		const t = await mount(() => hall(), 50, 12);
		const rows = paneRows(t, 12).map(inside);
		expect(rows[1]).toBe(`${" ".repeat(17)}a a a a a a a a a a a a a a`);
		expect(rows[2]).toBe("     u v w x y z a b c d e f g h i j k l m n");
		expect(rows[3]).toBe(`   ↖ ${" ".repeat(20)}▴`);
		expect(rows[4]).toBe(`23   ${floor(20)}`);
		expect(rows[7]).toBe(`26 ◂ ${floor(15)} V ${floor(4)}`);
		expect(rows[10]).toBe(`29   ${floor(20)}`);
	});

	test("the bottom border names the tokens out of view, arrow first; the dead get none", async () => {
		const t = await mount(() => hall(), 50, 12);
		const bottom = must(paneRows(t, 12)[11]);
		expect(bottom).toContain(" ↖B ▴g ◂O ");
		expect(bottom).not.toContain("s");
	});

	test("pans when the turn passes to another token", async () => {
		const [map, setMap] = createSignal(hall());
		const t = await mount(map, 50, 12);
		setMap(hall({ acting: "brakka" }));
		await t.renderOnce();
		const rows = paneRows(t, 12).map(inside);
		expect(rows[1]).toBe("   a b c d e f g h i j k l m n o p q r s t");
		expect(rows[2]).toBe(` 1 x ${floor(19)}`);
		expect(rows[5]).toBe(` 4 · · B ${floor(17)}`);
		expect(rows[7]).toBe(` 6 ${floor(20)} ▸`);
		expect(rows[9]).toBe(` 8 ${floor(20)}`);
		expect(rows[10]).toBe(`${" ".repeat(23)}▾${" ".repeat(19)}↘`);
		expect(paneRows(t, 12)[11]).toContain(" ↘V ▸g ▾O ");
	});

	test("in the fewest rows the App gives it, the edge rows give way and nothing spills", async () => {
		const t = await mount(() => hall(), 50, 5);
		const rows = paneRows(t, 5);
		expect(rows[4]).toStartWith("└");
		expect(inside(must(rows[1]))).toBe(
			"     u v w x y z aa  ac  ae  ag  ai  ak  am"
		);
		expect(inside(must(rows[2]))).toStartWith("25 ");
		expect(inside(must(rows[3]))).toStartWith("26 ◂");
		expect(inside(must(rows[3]))).toContain("V");
		expect(rows[4]).toContain(" ↖B ▴g ◂O ");
	});

	test("with nobody acting, it follows the seat's own hero", async () => {
		const t = await mount(
			() => hall({ acting: "nobody", mine: "brakka" }),
			50,
			12
		);

		const rows = paneRows(t, 12).map(inside);
		expect(rows[5]).toBe(` 4 · · B ${floor(17)}`);
	});

	test("with nobody to follow, as on the GM's seat between turns, it shows the most tokens it can", async () => {
		const base = hall({ acting: "nobody", mine: "nobody" });

		const map: MapView = {
			...base,
			tokens: [
				...base.tokens,
				token({ id: "goblin-2", mark: "g2", x: 32, y: 6 }),
				token({ id: "goblin-3", mark: "g3", x: 28, y: 4 }),
			],
		};

		const t = await mount(() => map, 50, 12);
		const rows = paneRows(t, 12).map(inside);
		expect(rows[2]).toBe("     u v w x y z a b c d e f g h i j k l m n");
		expect(rows[3]).toBe(` 3   ${floor(20)}`);
		expect(rows[4]).toBe(` 4 ◂ ${floor(20)}`);
		expect(rows[5]).toBe(` 5   ${squares(20, { 8: "g3" })}`);
		expect(rows[6]).toBe(` 6   ${squares(20, { 10: "g" })}`);
		expect(rows[7]).toBe(` 7   ${squares(20, { 12: "g2" })}`);
		expect(paneRows(t, 12)[11]).toContain(" ▾V ◂B ↙O ");
	});

	test("a seat can centre it anywhere: /view gives it a square to centre on", async () => {
		const t = await mount(() => hall(), 50, 12, { x: 10, y: 25 });
		const rows = paneRows(t, 12).map(inside);
		expect(rows[1]).toBe("   a b c d e f g h i j k l m n o p q r s t");
		expect(rows.find((r) => r.startsWith("26"))).toBe(
			`26 ${squares(20, { 10: "O" })} ▸`
		);
	});

	test("an arrow is in its token's colour: the seat's own hero's, out of view, in its own", async () => {
		const [map, setMap] = createSignal(hall());
		const t = await mount(map, 50, 12);
		setMap(hall({ acting: "brakka" }));
		await t.renderOnce();
		const spans = spansOf(t);
		expect(
			spans.find((s) => s.text.trim() === "↘")?.fg.equals(hex(color.you))
		).toBe(true);
		expect(
			spans.find((s) => s.text.trim() === "▸")?.fg.equals(hex(color.director))
		).toBe(true);
	});
});

describe("when the reach doesn't fit", () => {
	const open: MapView = {
		...ford,
		width: 16,
		height: 12,
		terrain: Array.from({ length: 12 }, () => ".".repeat(16)),
		tokens: [
			token({
				id: "vex",
				mark: "V",
				x: 3,
				y: 3,
				side: "heroes",
				mine: true,
				acting: true,
			}),
		],
		reach: Array.from({ length: 12 * 16 }, (_, i) => ({
			x: i % 16,
			y: Math.floor(i / 16),
		})).filter(({ x, y }) => Math.abs(x - 3) + Math.abs(y - 3) <= 5),
	};

	test("the layout says so, so the table can point at /view map", () => {
		expect(mapLayout(open, 76, 5).reachClipped).toBe(true);
		expect(mapLayout(open, 76, 11).reachClipped).toBe(false);
		expect(mapLayout({ ...open, reach: [] }, 76, 5).reachClipped).toBe(false);
		expect(mapLayout(open, 12, 11).reachClipped).toBe(true);
	});
});

describe("a cropped view says what it shows", () => {
	test("the title names the rows and columns in view when some are left out, and nothing when all show", () => {
		const open: MapView = {
			...ford,
			width: 16,
			height: 12,
			terrain: Array.from({ length: 12 }, () => ".".repeat(16)),
			tokens: [
				token({ id: "vex", mark: "V", x: 3, y: 3, side: "heroes", mine: true }),
			],
			reach: [],
		};

		expect(mapLayout(open, 76, 13).title).toBe(` map · ${ford.name} `);
		expect(mapLayout(open, 76, 6).title).toBe(
			` map · ${ford.name} · rows 2-6 of 12 `
		);
		expect(mapLayout(open, 20, 13).title).toBe(
			` map · ${ford.name} · columns a-h of a-p `
		);
	});
});

describe("reach on difficult terrain", () => {
	test("a reachable difficult square is a doubled wave, so the tint isn't the only sign", async () => {
		const map: MapView = { ...ford, reach: [...ford.reach, { x: 2, y: 2 }] };
		const t = await mount(() => map, 40, 7);
		const rows = paneRows(t, 7).map(inside);
		expect(rows[4]).toEndWith("3 • • ≈ ~ g1·");
	});
});

describe("where /view points", () => {
	test("a token by its mark (case and all), its id or name or a start of one, else a square", () => {
		const map = hall();
		expect(focusOf(map, "B")).toEqual({ token: "brakka" });
		expect(focusOf(map, "bra")).toEqual({ token: "brakka" });
		expect(focusOf(map, "Ogre")).toEqual({ token: "ogre" });
		expect(focusOf(map, "k26")).toEqual({ square: { x: 10, y: 25 } });
		expect(focusOf(map, "g")).toEqual({ token: "goblin" });
		expect(focusOf(map, "zz9")).toEqual({ refusal: "zz9 is outside the map." });
		expect(focusOf(map, "nobody")).toEqual({
			refusal:
				"No token on the map is called 'nobody'; /view <square|who>, or map, feed or both",
		});

		const two = {
			...map,
			tokens: [
				...map.tokens,
				token({ id: "goblin-2", mark: "g2", x: 1, y: 1 }),
			],
		};

		expect(focusOf(two, "gob")).toEqual({
			refusal: "'gob' could be goblin or goblin-2.",
		});
	});
});

describe("a creature bigger than a square", () => {
	test("shows its mark on its top-left square and its body, tinted, on the rest", async () => {
		const t = await mount(() => lair, 40, 7);
		const rows = paneRows(t, 7).slice(1, 6).map(inside);
		const pad = " ".repeat(12);
		expect(rows).toEqual([
			`${pad}  a b c d e`,
			`${pad}1 · · · · V`,
			`${pad}2 · o ░░· ·`,
			`${pad}3 · ░░░░· ·`,
			`${pad}4 · · · · ·`,
		]);
		const body = spansOf(t).filter((s) => s.text.includes("░"));
		expect(body.length).toBeGreaterThan(0);

		for (const s of body) {
			expect(s.bg.equals(hex(color.directorBody))).toBe(true);
			expect(s.fg.equals(hex(color.director))).toBe(true);
		}
	});

	test("any square under it is it, and the squares beside it are not", () => {
		expect(tokenAt(lair, { x: 1, y: 1 })?.id).toBe("ogre");
		expect(tokenAt(lair, { x: 2, y: 2 })?.id).toBe("ogre");
		expect(tokenAt(lair, { x: 3, y: 1 })).toBeUndefined();
		expect(tokenAt(lair, { x: 0, y: 1 })).toBeUndefined();
		expect(mapLayout(lair, 76, 10).bottomTitle).toBe("");
	});
});
