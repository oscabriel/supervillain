import { afterEach, describe, expect, test } from "bun:test";

import { TextAttributes } from "@opentui/core";
import { testRender } from "@opentui/solid";

import { Band } from "../../src/table/Band.tsx";
import type { CombatView } from "../../src/table/view.ts";
import { must } from "../game/must.ts";
import {
	brakka,
	combatant,
	fight,
	hasAttribute,
	ford,
	goblins,
	ogre,
	sampleFord,
	sampleFordMidFight,
	sera,
	showsStamina,
	sniper,
	spearmen,
	vex,
} from "./combat.ts";
import { alice, gm } from "./fakeView.ts";

type Setup = Awaited<ReturnType<typeof testRender>>;

let setup: Setup | undefined;

afterEach(() => {
	setup?.renderer.destroy();
	setup = undefined;
});

const mount = async (
	combat: CombatView | undefined,
	width: number,
	height: number,
	maxHeight = Math.floor(height / 2),
	heroesWhole = false
) => {
	setup = await testRender(
		() => (
			<Band
				me={alice.actor}
				present={[gm, alice]}
				combat={combat}
				maxHeight={maxHeight}
				heroesWhole={heroesWhole}
			/>
		),
		{ width, height }
	);
	await setup.renderOnce();

	return setup;
};

const bandRows = (t: Setup): ReadonlyArray<string> => {
	const rows = t
		.captureCharFrame()
		.split("\n")
		.map((r) => r.trimEnd());

	const bottom = rows.findIndex((r, i) => i > 0 && r.startsWith("└"));

	return rows.slice(0, bottom + 1);
};

const rowWith = (rows: ReadonlyArray<string>, text: string) =>
	rows.slice(1).find((r) => r.includes(text)) ?? "";

const party = [vex, spearmen, brakka, ogre, sera, sniper];

describe("in combat", () => {
	test("at 100x30 the title has the round, whose turn it is, Malice and hero tokens", async () => {
		const t = await mount(fight(party), 100, 30);
		const [top] = bandRows(t);
		expect(top).toContain("round 2 · Vex's turn · Malice 5 · hero tokens 2");
		expect(top).not.toContain("next");
	});

	test("another's hero's turn is named by the hero alone; between turns the side next is", async () => {
		const theirs = {
			...brakka,
			name: "Brakka (Bob)",
			acting: true,
			acted: false,
		};

		const t = await mount(fight([{ ...vex, acting: false }, theirs]), 100, 30);
		expect(bandRows(t)[0]).toContain("round 2 · Brakka's turn · Malice 5");
		setup?.renderer.destroy();
		const u = await mount(fight([{ ...vex, acting: false }, brakka]), 100, 30);
		expect(bandRows(u)[0]).toContain("round 2 · director next · Malice 5");
	});

	test("at 100x30 each combatant has one row, in turn order, with its meter and numbers", async () => {
		const t = await mount(fight(party), 100, 30);
		const rows = bandRows(t);
		const mine = rowWith(rows, "Vex");
		expect(mine).toContain("▶");
		expect(mine).toContain("▐████░░▌ 14/21 +5");

		for (const part of [
			"slowed (EoT)",
			"Wrath 3",
			"recoveries 6/8",
			"2 surges",
		]) {
			expect(mine).toContain(part);
		}

		const winded = rowWith(rows, "Brakka");
		expect(winded).toContain("✓");
		expect(winded).toContain("▐██░░░░▌  8/24");
		expect(winded).toContain("winded");
		expect(winded).toContain("recoveries 4/10");

		const dying = rowWith(rows, "Sera");
		expect(dying).toContain("▐░░░░░░▌ -3/18");
		expect(dying).toContain("dying");
		expect(dying).toContain("bleeding (save)");

		const squad = rowWith(rows, "Goblin Spearmen x3");
		expect(squad).toContain("✓");
		expect(squad).toContain("▐█████░▌ 12/15");

		expect(rowWith(rows, "Ogre")).toContain("▐███░░░▌ 40/76");
		expect(rowWith(rows, "Goblin Sniper")).toContain("dead");

		const order = ["Vex", "Spearmen", "Brakka", "Ogre", "Sera", "Sniper"].map(
			(n) => rows.findIndex((r) => r.includes(n))
		);

		expect(order).toEqual(order.toSorted((a, b) => a - b));
		expect(new Set(order).size).toBe(order.length);
	});

	test("any Stamina above 0 shows at least one cell of the meter", async () => {
		const t = await mount(
			fight([combatant({ id: "rat", name: "Rat", stamina: 1, max: 21 })]),
			100,
			30
		);

		expect(rowWith(bandRows(t), "Rat")).toContain("▐█░░░░░▌ 1/21");
	});

	test("at 80x24 every combatant's whole state is still on screen", async () => {
		const t = await mount(fight(party), 80, 24);
		const band = bandRows(t).join("\n");
		expect(bandRows(t).length).toBeLessThanOrEqual(12);

		for (const part of [
			"round 2",
			"Malice 5",
			"▐████░░▌ 14/21 +5",
			"slowed (EoT)",
			"Wrath 3",
			"recoveries 6/8",
			"2 surges",
			"winded",
			"dying",
			"bleeding (save)",
			"Goblin Spearmen x3",
			"dead",
		]) {
			expect(band).toContain(part);
		}

		expect(band).not.toContain("more");
	});

	test("at 80x24 ten combatants fit with nothing cut: short rows pair up, long ones take the width", async () => {
		const t = await mount(fight([...party, ...goblins(4)]), 80, 24);
		const rows = bandRows(t);
		const band = rows.join("\n");
		expect(rows.length).toBeLessThanOrEqual(12);

		for (const part of [
			"slowed (EoT)",
			"2 surges",
			"recoveries 4/10",
			"bleeding (save)",
			"Goblin 4",
		]) {
			expect(band).toContain(part);
		}

		expect(band).not.toContain("…");
		expect(band).not.toContain("more");
		expect(rowWith(rows, "Goblin 1 ")).toMatch(/Goblin \d+ .*Goblin \d+ /u);
	});

	test("the seat's own hero is highlighted: bold, on its own background", async () => {
		const t = await mount(fight(party), 100, 30);
		const spans = t.captureSpans().lines.flatMap((l) => l.spans);
		const mine = spans.find((s) => s.text.startsWith("Vex"));
		const other = spans.find((s) => s.text.startsWith("Brakka"));
		expect(mine).toBeDefined();
		expect(other).toBeDefined();
		expect(hasAttribute(mine?.attributes, TextAttributes.BOLD)).toBe(true);
		expect(mine?.bg.equals(must(other).bg)).toBe(false);
	});

	test("short rows go two to a row when the band is wide enough", async () => {
		const t = await mount(fight(goblins(6)), 100, 30);
		const rows = bandRows(t);
		expect(rowWith(rows, "Goblin 1")).toContain("Goblin 2");
		expect(rowWith(rows, "Goblin 5")).toContain("Goblin 6");
	});

	test("fourteen at 80x24: everyone still shows, heroes giving up their Recoveries rather than anyone hidden", async () => {
		const t = await mount(fight([...party, ...goblins(8)]), 80, 24);
		const rows = bandRows(t);
		const band = rows.join("\n");
		expect(rows.length).toBeLessThanOrEqual(12);

		for (const name of [
			"Vex",
			"Spearmen",
			"Brakka",
			"Ogre",
			"Sera",
			"Goblin 8",
		]) {
			expect(band).toContain(name);
		}

		expect(rowWith(rows, "dead:")).toContain("Goblin Sniper");
		expect(rowWith(rows, "Vex")).toContain("slowed (EoT) · Wrath 3 · 2 surges");
		expect(band).not.toContain("recoveries");
		expect(band).not.toContain("more");
	});

	test("past that, long rows are cut with … rather than anyone hidden", async () => {
		const long = {
			...vex,
			conditions: ["slowed (EoT)", "dazed (save)", "weakened (save)"],
		};

		const t = await mount(
			fight([long, spearmen, brakka, ogre, sera, ...goblins(12)]),
			80,
			24
		);

		const rows = bandRows(t);
		const band = rows.join("\n");

		for (const name of ["Vex", "x3", "Brakka", "Ogre", "Sera", "12 "]) {
			expect(band).toContain(name);
		}

		expect(rowWith(rows, "Vex")).toMatch(/ …\s+/u);
		expect(band).not.toContain("more");
	});

	test("however tight the band, winded, dying and dead are spelled out, never colour alone", async () => {
		const t = await mount(fight([...party, ...goblins(30)]), 80, 24, 8);
		const rows = bandRows(t);
		expect(rows.join("\n")).toMatch(/\+\d+ more/u);
		expect(rowWith(rows, "Brakka")).toContain("winded");
		expect(rowWith(rows, "Sera")).toContain("dying");
	});

	test("rows too long for half the width keep one combatant each", async () => {
		const t = await mount(fight(party), 80, 24);
		expect(rowWith(bandRows(t), "Vex")).not.toContain("Brakka");
	});

	test("too many to fit: the band keeps its height and says how many more, never clipping silently", async () => {
		const many = [...goblins(15), vex, ...goblins(25).slice(15)];
		const t = await mount(fight(many), 80, 24, 8);
		const rows = bandRows(t);
		expect(rows.length).toBeLessThanOrEqual(8);
		const more = /\+(?<more>\d+) more/u.exec(rows.join("\n"));
		expect(more).not.toBeNull();
		const shown = (rows.join("\n").match(/Goblin \d+/gu) ?? []).length + 1;
		expect(shown + Number(more?.groups?.more)).toBe(many.length);
		expect(rowWith(rows, "Vex")).toContain("▶");
	});
});

describe("with a map", () => {
	test("each placed combatant's mark leads its name, the legend for the map; the rest line up", async () => {
		const marked = [
			{ ...vex, mark: "V" },
			{ ...spearmen, mark: "gA" },
			brakka,
			{ ...ogre, mark: "o" },
		];

		const t = await mount(fight(marked), 100, 30);
		const rows = bandRows(t);
		expect(rowWith(rows, "Vex")).toContain("▶ V  Vex ");
		expect(rowWith(rows, "Goblin Spearmen")).toContain(
			"✓ gA Goblin Spearmen x3"
		);
		expect(rowWith(rows, "Brakka")).toContain("✓    Brakka ");
		expect(rowWith(rows, "Ogre")).toContain("· o  Ogre ");

		const meters = ["Vex", "Brakka", "Ogre"].map((n) =>
			rowWith(rows, n).indexOf("▐")
		);

		expect(new Set(meters).size).toBe(1);
	});
});

describe("a full fight in a small band", () => {
	test("at 80x24 every hero keeps its numbers, every creature its own name, and the dead fold into one line", async () => {
		const t = await mount(fight(ford), 80, 24);
		const rows = bandRows(t);
		const band = rows.join("\n");
		expect(rows.length).toBeLessThanOrEqual(12);

		for (const part of [
			"wrath 3",
			"recoveries 12/12",
			"ferocity 4",
			"1 surge",
			"weakened (save)",
			"focus 1",
			"recoveries 9/10",
			"dying (dead at -10)",
			"bleeding",
			"dazed (save)",
			"insight 0",
			"recoveries 8/8",
		]) {
			expect(band).toContain(part);
		}

		for (const n of [1, 2, 3, 4, 5]) {
			expect(band).toContain(`Bruiser ${n} `);
		}

		expect(band).toContain("Chief");
		expect(rowWith(rows, "dead:")).toContain("Bandit Cutpurse A");
		expect(rowWith(rows, "dead:")).toContain("Bandit Slinger A");
		expect(band).not.toContain("x0");
		expect(band).not.toContain("more");
	});

	test("kept whole for a reply pane, heroes keep every row but their Recoveries while creatures pair, then the dead go, then the rest count as more", async () => {
		const t = await mount(fight(ford), 80, 24, 8, true);
		const rows = bandRows(t);
		const band = rows.join("\n");
		expect(rows.length).toBeLessThanOrEqual(8);

		for (const part of [
			"wrath 3",
			"ferocity 4",
			"1 surge",
			"weakened (save)",
			"focus 1",
			"dying (dead at -10)",
			"bleeding",
			"dazed (save)",
			"insight 0",
		]) {
			expect(band).toContain(part);
		}

		for (const hero of ["Brann", "Kesh", "Ilsa", "Wren"]) {
			expect(rowWith(rows, hero)).not.toMatch(/ …\s*│$/u);
		}

		expect(band).not.toContain("dead:");
		expect(band).toContain("Chief");
		const more = /\+(?<more>\d+) more/u.exec(band);
		const shown = (band.match(/Bruiser \d/gu) ?? []).length + 1;
		expect(shown + Number(more?.groups?.more)).toBe(8);
		expect(rowWith(rows, "Chief")).toMatch(/Chief .*Bruiser \d/u);
	});

	for (const [when, roster, maxHeight] of [
		["healthy", sampleFord, 9],
		["mid-fight", sampleFordMidFight, 8],
	] as const) {
		test(`beside the map at 80x24, the sample fight ${when}: each hero on one row, every living combatant's Stamina shown`, async () => {
			const t = await mount(fight(roster), 80, 24, maxHeight);
			const rows = bandRows(t);
			const band = rows.join("\n");
			expect(rows.length).toBeLessThanOrEqual(maxHeight);
			const living = roster.filter((c) => c.health !== "dead");

			for (const c of living) {
				expect(showsStamina(band, c)).toBe(true);
			}

			for (const r of rows.slice(1, -1)) {
				expect(r).toMatch(/▐|dead:/u);
			}

			for (const hero of ["Brann", "Ilsa", "Kesh", "Wren"].filter((h) =>
				band.includes(h)
			)) {
				expect(rows.filter((r) => r.includes(hero))).toHaveLength(1);
			}

			const more = Number(/\+(?<more>\d+) more/u.exec(band)?.groups?.more ?? 0);
			expect(more).toBeLessThanOrEqual(roster.length - living.length);
		});
	}

	test("a living creature's row comes before the dead line, which goes first", async () => {
		const t = await mount(fight(sampleFordMidFight), 80, 24, 8);
		const band = bandRows(t).join("\n");
		expect(band).not.toContain("dead:");
		expect(band).toContain("+1 more");

		for (const c of sampleFordMidFight.filter((k) => k.health !== "dead")) {
			expect(showsStamina(band, c)).toBe(true);
		}
	});

	test("squads cut to their last word's start stay apart", async () => {
		const t = await mount(fight(sampleFordMidFight), 80, 24, 8);
		const band = bandRows(t).join("\n");
		expect(band).toMatch(/cA C\S* A x2/u);
		expect(band).toMatch(/sA S\S* A x2/u);
	});

	test("beside the map at 80x24, four heroes and four creature groups each keep one row: every enemy's Stamina shows", async () => {
		const [brann, kesh, ilsa, wren] = ford;

		const heroes = [
			{ ...must(brann), conditions: ["slowed (EoT)"] },
			must(kesh),
			must(ilsa),
			{ ...must(wren), stamina: 12, health: undefined, conditions: [] },
		];

		const enemies = [
			combatant({
				id: "bandit-chief",
				name: "Bandit Chief",
				stamina: 60,
				max: 80,
			}),
			combatant({
				id: "bandit-bruiser-1",
				name: "Bandit Bruiser 1",
				stamina: 9,
				max: 20,
			}),
			combatant({
				id: "bandit-cutpurse-a",
				name: "Bandit Cutpurse A",
				stamina: 16,
				max: 20,
				count: 4,
			}),
			combatant({
				id: "bandit-slinger-a",
				name: "Bandit Slinger A",
				stamina: 20,
				max: 20,
				count: 4,
			}),
		];

		const t = await mount(fight([...heroes, ...enemies]), 80, 24, 8);
		const band = bandRows(t).join("\n");

		for (const part of [
			"60/80",
			"9/20",
			"Cutpurse A x4",
			"Slinger A x4",
			"slowed (EoT)",
			"wrath 3",
		]) {
			expect(band).toContain(part);
		}

		expect(band).not.toContain("more");
	});

	test("a dead hero folds into the dead line with the dead creatures", async () => {
		const [brann, ...rest] = ford;

		const dead = {
			...must(brann),
			stamina: -13,
			health: "dead" as const,
			conditions: [],
		};

		const t = await mount(fight([dead, ...rest]), 80, 24);
		const rows = bandRows(t);
		expect(rowWith(rows, "dead:")).toContain(
			"Brann (Alice), Bandit Cutpurse A"
		);
		expect(rows.filter((r) => r.includes("Brann"))).toHaveLength(1);
	});

	test("kept whole with room for every creature, the band is just as it is without a pane", async () => {
		const t = await mount(fight(ford), 80, 24, 12, true);
		const band = bandRows(t).join("\n");

		for (const n of [1, 2, 3, 4, 5]) {
			expect(band).toContain(`Bruiser ${n} `);
		}

		expect(rowWith(bandRows(t), "dead:")).toContain("Bandit Slinger A");
		expect(band).not.toContain("more");
	});

	test("narrowed names share one width, so every meter on a row starts in the same column", async () => {
		const t = await mount(fight(ford), 80, 24);

		const meters = bandRows(t)
			.filter((r) => r.includes("▐"))
			.flatMap((r) => [...r.matchAll(/▐/gu)].map((m) => m.index));

		expect(new Set(meters.filter((i) => i < 40)).size).toBe(1);
	});

	test("squads keep their letter when their names are cut", async () => {
		const squads = ["A", "B", "C", "D", "E", "F"].map((l) =>
			combatant({
				id: `bandit-cutpurse-${l}`,
				name: `Bandit Cutpurse ${l}`,
				stamina: 20,
				max: 20,
				count: 4,
			})
		);

		const t = await mount(fight([...ford.slice(0, 4), ...squads]), 80, 24, 9);
		const band = bandRows(t).join("\n");

		for (const l of ["A", "B", "C", "D", "E", "F"]) {
			expect(band).toContain(`${l} x4`);
		}
	});

	test("at 100x30 a squad's whole name fits", async () => {
		const t = await mount(
			fight([
				combatant({
					id: "c",
					name: "Bandit Cutpurse A",
					stamina: 20,
					max: 20,
					count: 4,
				}),
			]),
			100,
			30
		);

		expect(bandRows(t).join("\n")).toContain("Bandit Cutpurse A x4");
	});

	test("in a band 44 columns wide, a long name gives way before the numbers and the health word", async () => {
		const dying = [1, 2, 3, 4].map((n) =>
			combatant({
				id: `brann-${n}`,
				name:
					n % 2 === 0
						? "Goblin Spinecleaver Captain"
						: "Brann (Alice the Magnificent)",
				side: n % 2 === 0 ? "director" : "heroes",
				stamina: -5,
				max: 120,
				temp: 15,
				count: n % 2 === 0 ? 3 : undefined,
				health: "dying",
			})
		);

		const t = await mount(fight(dying), 44, 24, 7);
		const rows = bandRows(t).filter((r) => r.includes("▐"));
		expect(rows.length).toBeGreaterThan(0);

		for (const r of rows) {
			expect(r).toContain("-5/120");
			expect(r).toContain("dying");
		}
	});
});

const bandWith = async (joinNote?: string) => {
	setup?.renderer.destroy();
	setup = await testRender(
		() => (
			<Band
				me={gm.actor}
				present={[gm]}
				joinHint="ssh -p 2222 den@relay.example"
				joinNote={joinNote}
				maxHeight={10}
			/>
		),
		{ width: 100, height: 30 }
	);
	await setup.renderOnce();

	return bandRows(setup).join("\n");
};

describe("outside combat", () => {
	test("the band shows the party, compactly: heroes only, no round, no Malice, no turn markers", async () => {
		const t = await mount(
			fight([vex, ogre, brakka], { active: false, next: undefined }),
			100,
			30
		);

		const rows = bandRows(t);
		const band = rows.join("\n");
		expect(rows[0]).toContain("party");
		expect(rows[0]).toContain("hero tokens 2");
		expect(band).toContain("Vex");
		expect(band).toContain("Brakka");
		expect(band).not.toContain("Ogre");
		expect(band).not.toContain("round");
		expect(band).not.toContain("Malice");
		expect(band).not.toContain("▶");
		expect(rows.length).toBeLessThanOrEqual(4);
	});

	test("a party with no heroes yet says so", async () => {
		const t = await mount(fight([], { active: false }), 100, 30);
		expect(bandRows(t).join("\n")).toContain("no heroes yet");
	});

	test("to a GM sitting alone, a join note (the relay's state) takes the join hint's place", async () => {
		expect(await bandWith()).toContain(
			"players join with: ssh -p 2222 den@relay.example"
		);
		const connecting = await bandWith("relay: connecting…");
		expect(connecting).toContain("relay: connecting…");
		expect(connecting).not.toContain("players join with");
	});

	test("without a combat view the band shows who is at the table", async () => {
		const t = await mount(undefined, 100, 30);
		const band = bandRows(t).join("\n");
		expect(band).toContain("at the table");
		expect(band).toContain("Alice (you)");
	});
});

describe("a PF2e encounter", () => {
	const pfView: CombatView = {
		round: 1,
		active: true,
		malice: 0,
		heroTokens: 0,
		meterLabel: "HP",
		title: " round 1 · Ari's turn ",
		combatants: [
			combatant({
				id: "ari",
				name: "Ari",
				side: "heroes",
				stamina: 14,
				max: 20,
				acting: true,
				mine: true,
				conditions: ["frightened 2"],
				resource: "hero points 1",
				actions: { left: 2, max: 3, reaction: true },
				penalty: "MAP -5",
			}),
			combatant({
				id: "gnasher-1",
				name: "Bog Gnasher 1",
				stamina: 12,
				max: 20,
				conditions: ["frightened 1"],
				actions: { left: 0, max: 3, reaction: false },
			}),
		],
	};

	test("rows say HP, show the acting creature's actions as pips with its reaction, and its MAP", async () => {
		const t = await mount(pfView, 100, 30);
		const rows = bandRows(t);
		expect(rows[0]).toContain("round 1 · Ari's turn");
		const ari = rowWith(rows, "Ari");
		expect(ari).toContain("HP ▐");
		expect(ari).toContain("14/20");
		expect(ari).toContain("◆◆◇ ↺");
		expect(ari).toContain("MAP -5");
		expect(ari).toContain("hero points 1");
		expect(ari.indexOf("◆◆◇ ↺")).toBeLessThan(ari.indexOf("frightened 2"));
		expect(ari.indexOf("MAP -5")).toBeLessThan(ari.indexOf("frightened 2"));
		const gnasher = rowWith(rows, "Bog Gnasher 1");
		expect(gnasher).not.toContain("◇");
		expect(gnasher).not.toContain("↺");
		expect(gnasher).toContain("frightened 1");
	});

	test("at 80 columns a dying PC says so in its head, before any cut detail", async () => {
		const dying: CombatView = {
			...pfView,
			combatants: [
				combatant({
					id: "bryn",
					name: "Bryn",
					side: "heroes",
					stamina: 0,
					max: 15,
					health: "dying",
					conditions: [
						"dying 2",
						"wounded 1",
						"unconscious",
						"frightened 2",
						"persistent fire 1d6",
						"off-guard",
					],
					resource: "hero points 1",
					actions: { left: 0, max: 3, reaction: true },
				}),
				...pfView.combatants,
			],
		};

		const t = await mount(dying, 80, 24);
		const bryn = rowWith(bandRows(t), "Bryn");
		expect(bryn).toContain("0/15 · dying");
		expect(bryn).not.toContain("◇");
	});

	test("a Draw Steel band has no meter label or pips", async () => {
		const t = await mount(fight(party), 100, 30);
		const rows = bandRows(t);
		expect(rows.join("\n")).not.toContain("HP ▐");
		expect(rows.join("\n")).not.toContain("◆");
	});
});
