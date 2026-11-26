import { describe, expect, test } from "bun:test";

import {
	CARDS_MAX,
	codexText,
	completeLine,
	parseInputLine,
	PINNED_MAX,
	prepStage,
	RECAP_MAX,
	rules,
	stageModeOf,
	stageOf,
} from "@supervillain/domain";
import type { StageCard } from "@supervillain/domain";

import { fold, throughJson } from "../game/fold.ts";
import { ALICE, env, GM, Table } from "../game/table.ts";

const card = (kind: StageCard["kind"], id: string, title = id): StageCard => ({
	key: `${kind}:${id}`,
	kind,
	title,
	body: [{ kind: "para", text: `About ${title}.` }],
});

const MARA = card("npc", "mara", "Mara Venn");

const MARKET = card("scene", "market", "The Drowned Market");

const LIGHTHOUSE = card("scene", "lighthouse", "The Lighthouse");

const LEDGER = card("handout", "ledger", "A torn ledger page");

const show = (table: Table, c: StageCard) => {
	table.run(GM, { type: "show", ref: c.key, card: c });
};

const reveal = (table: Table, c: StageCard) => {
	table.run(GM, { type: "reveal", ref: c.key, card: c });
};

const evil = (patch: Partial<StageCard>): StageCard => ({
	...MARA,
	...patch,
});

const fighting = (table: Table) => {
	table.run(GM, {
		type: "ff-pc",
		id: "rook",
		sheet: { id: "rook", name: "Rook", resources: { hp: 3 } },
	});
	table.run(GM, { type: "ff-start", who: [] });
};

const feed = (table: Table) => table.state.feed.map((e) => e.text);

describe("the stage's cards", () => {
	test("revealed cards go in the codex; shown cards go on the table too", () => {
		const table = new Table();
		reveal(table, MARA);
		show(table, LEDGER);

		const view = stageOf(table.state, ALICE, "freeform");

		expect(view.pinned.map((c) => c.key)).toEqual(["handout:ledger"]);
		expect(view.codex.map((c) => [c.key, c.tier])).toEqual([
			["handout:ledger", "on-table"],
			["npc:mara", "revealed"],
		]);
		expect(feed(table)).toEqual([
			"In the codex: NPC: Mara Venn.",
			"On the table: Handout: A torn ledger page.",
		]);
	});

	test("showing a scene makes it the scene; the old scene drops to the codex", () => {
		const table = new Table();
		show(table, MARKET);
		show(table, LIGHTHOUSE);

		const view = stageOf(table.state, ALICE, "freeform");

		expect(view.scene?.key).toBe("scene:lighthouse");
		expect(view.pinned).toEqual([]);
		expect(table.state.stage.cards["scene:market"]?.tier).toBe("revealed");
		expect(feed(table).at(-1)).toBe("The scene is The Lighthouse.");
	});

	test("/unpin leaves a card in the codex; /hide takes it back completely", () => {
		const table = new Table();
		show(table, MARA);
		table.run(GM, { type: "unpin", ref: "mara" });

		expect(table.state.stage.cards["npc:mara"]?.tier).toBe("revealed");
		expect(table.submit(GM, { type: "unpin", ref: "mara" })).toBe(
			"Mara Venn isn't on the table."
		);
		table.run(GM, { type: "hide", ref: "npc:mara" });
		expect(table.state.stage.cards).toEqual({});
		expect(stageOf(table.state, ALICE, "freeform").codex).toEqual([]);
		expect(table.submit(GM, { type: "hide", ref: "mara" })).toBe(
			"Nothing called 'mara' is on the stage or in the codex."
		);
	});

	test("at most six cards sit on the table at once", () => {
		const table = new Table();

		for (const n of Array.from({ length: PINNED_MAX }, (_, i) => i)) {
			show(table, card("item", `thing-${n}`));
		}

		expect(
			table.submit(GM, {
				type: "show",
				ref: "item:extra",
				card: card("item", "extra"),
			})
		).toBe("The table holds at most 6 cards: /unpin one first.");
		show(table, MARKET);
		expect(stageOf(table.state, GM, "freeform").pinned).toHaveLength(
			PINNED_MAX
		);
	});

	test("showing or revealing twice is refused, and a card shown again is read afresh", () => {
		const table = new Table();
		reveal(table, MARA);

		expect(table.submit(GM, { type: "reveal", ref: "mara", card: MARA })).toBe(
			"Mara Venn is in the codex already."
		);
		show(table, { ...MARA, subtitle: "Harbour-master" });
		expect(table.state.stage.cards["npc:mara"]?.card.subtitle).toBe(
			"Harbour-master"
		);
		expect(table.submit(GM, { type: "show", ref: "mara", card: MARA })).toBe(
			"Mara Venn is on the table already."
		);
	});

	test("terminal controls in any text are refused when decided and when folded", () => {
		const table = new Table();

		for (const bad of [
			evil({ title: "Mara\u001B[2J" }),
			evil({ subtitle: "x\u0007" }),
			evil({ body: [{ kind: "para", text: "\u001B]0;pwned\u0007" }] }),
			evil({ readAloud: [{ kind: "pre", lines: ["\u001B[31m"] }] }),
			evil({ art: ["ok", "\u001B[5m"] }),
			evil({ tags: ["\u009B"] }),
			evil({ key: "npc:Mara" }),
		]) {
			expect(
				table.submit(GM, { type: "show", ref: "mara", card: bad })
			).toMatch(/^npc:/u);
		}

		const folded = fold(
			rules,
			[env(1, "core.stage-pinned", { card: evil({ title: "\u001B[2J" }) })],
			{ strict: true }
		);

		expect(folded.error?.message).toContain(
			"holds a card the table can't show"
		);
	});

	test("cards past their size are refused: 8 KB of text, 40 lines of art of 80", () => {
		const table = new Table();

		expect(
			table.submit(GM, {
				type: "show",
				ref: "mara",
				card: { ...MARA, body: [{ kind: "para", text: "x".repeat(9000) }] },
			})
		).toContain("within 8 KB");
		expect(
			table.submit(GM, {
				type: "show",
				ref: "mara",
				card: { ...MARA, art: Array.from({ length: 41 }, () => "#") },
			})
		).toContain("at most 40 lines of 80 columns");
		expect(
			table.submit(GM, {
				type: "show",
				ref: "mara",
				card: { ...MARA, title: "x".repeat(81) },
			})
		).toContain("at most 80 characters");
	});

	test("only the GM sets the stage", () => {
		const table = new Table();

		expect(table.submit(ALICE, { type: "show", ref: "mara", card: MARA })).toBe(
			"Only the GM can use /show."
		);
		expect(table.submit(ALICE, { type: "recap", text: "we won" })).toBe(
			"Only the GM can use /recap."
		);
	});
});

describe("the stage's mode", () => {
	test("it follows the fight: encounter while one is on, campaign after", () => {
		const table = new Table();

		expect(stageModeOf(table.state)).toBe("campaign");
		fighting(table);
		expect(stageModeOf(table.state)).toBe("encounter");
		table.run(GM, { type: "ff-end" });
		expect(stageModeOf(table.state)).toBe("campaign");
	});

	test("a GM's /stage holds until the next fight starts or ends", () => {
		const table = new Table();
		table.run(GM, { type: "stage", mode: "encounter" });

		expect(stageModeOf(table.state)).toBe("encounter");
		expect(stageOf(table.state, GM, "freeform").override).toBe(true);
		fighting(table);
		expect(table.state.stage.override).toBeUndefined();
		table.run(GM, { type: "stage", mode: "campaign" });
		expect(stageModeOf(table.state)).toBe("campaign");
		table.run(GM, { type: "ff-end" });
		expect(stageModeOf(table.state)).toBe("campaign");
		expect(table.state.stage.override).toBeUndefined();
		fighting(table);
		expect(stageModeOf(table.state)).toBe("encounter");
	});

	test("/stage auto goes back to following the fight; asking for what it shows is refused", () => {
		const table = new Table();

		expect(table.submit(GM, { type: "stage", mode: "campaign" })).toBe(
			"The stage shows the campaign already."
		);
		expect(table.submit(GM, { type: "stage", mode: "auto" })).toBe(
			"The stage follows the fight already."
		);
		table.run(GM, { type: "stage", mode: "encounter" });
		table.run(GM, { type: "stage", mode: "auto" });
		expect(stageModeOf(table.state)).toBe("campaign");
	});

	test("the stage sits outside undo: undoing the fight's start keeps the cards", () => {
		const table = new Table();
		show(table, MARA);
		fighting(table);
		table.run(GM, { type: "undo" });

		expect(table.state.ff.order).toBeUndefined();
		expect(table.state.stage.cards["npc:mara"]?.tier).toBe("on-table");
	});
});

describe("trackers and the recap", () => {
	test("/tracker sets one up, /tick moves it within its most, and hidden ones stay the GM's", () => {
		const table = new Table();
		table.run(GM, {
			type: "tracker",
			id: "alarm",
			action: "set",
			kind: "clock",
			label: "The alarm",
			max: 4,
		});

		expect(stageOf(table.state, ALICE, "freeform").trackers).toEqual([]);
		expect(table.state.feed).toEqual([]);
		table.run(GM, { type: "tracker", id: "alarm", action: "show" });
		expect(feed(table)).toEqual(["The alarm: 0/4."]);
		table.run(GM, { type: "tick", id: "alarm", op: "add", amount: 1 });
		table.run(GM, { type: "tick", id: "alarm", op: "add", amount: 9 });

		expect(table.state.stage.trackers).toEqual([
			{
				id: "alarm",
				label: "The alarm",
				kind: "clock",
				value: 4,
				max: 4,
				tier: "revealed",
			},
		]);
		expect(
			table.submit(GM, { type: "tick", id: "alarm", op: "add", amount: 1 })
		).toBe("The alarm is at 4 already.");
		table.run(GM, {
			type: "tracker",
			id: "plot",
			action: "set",
			kind: "counter",
			label: "GMSECRET plot",
		});

		const before = table.state.feed.length;

		table.run(GM, { type: "tick", id: "plot", op: "set", amount: 3 });
		expect(table.state.feed.length).toBe(before);
		expect(
			stageOf(table.state, ALICE, "freeform").trackers.map((t) => t.id)
		).toEqual(["alarm"]);
		expect(
			stageOf(table.state, GM, "freeform").trackers.map((t) => [t.id, t.hidden])
		).toEqual([
			["alarm", false],
			["plot", true],
		]);
		table.run(GM, { type: "tracker", id: "alarm", action: "remove" });
		expect(table.state.stage.trackers.map((t) => t.id)).toEqual(["plot"]);
	});

	test("the recap keeps its latest fifty lines", () => {
		const table = new Table();

		for (const n of Array.from({ length: RECAP_MAX + 5 }, (_, i) => i)) {
			table.run(GM, { type: "recap", text: `line ${n}` });
		}

		const { recap } = stageOf(table.state, ALICE, "freeform");

		expect(recap).toHaveLength(RECAP_MAX);
		expect(recap[0]?.text).toBe("line 5");
		expect(feed(table).at(-1)).toBe("Recap: line 54");
	});

	test("/sync reads shown cards again, keeping their tiers", () => {
		const table = new Table();
		reveal(table, MARA);
		table.run(GM, {
			type: "sync",
			cards: [{ ...MARA, title: "Mara Venn, Harbour-master" }],
		});

		expect(table.state.stage.cards["npc:mara"]).toMatchObject({
			tier: "revealed",
			card: { title: "Mara Venn, Harbour-master" },
		});
		expect(table.submit(GM, { type: "sync", cards: [LEDGER] })).toBe(
			"None of those cards could be read again."
		);
	});

	test("/sync with nothing changed is refused, and only changed cards are synced", () => {
		const table = new Table();
		reveal(table, MARA);
		reveal(table, LEDGER);

		expect(table.submit(GM, { type: "sync", cards: [MARA, LEDGER] })).toBe(
			"Nothing changed."
		);

		table.run(GM, {
			type: "sync",
			cards: [MARA, { ...LEDGER, title: "A burned ledger page" }],
		});

		expect(feed(table).at(-1)).toBe(
			"Handout: A burned ledger page is read again."
		);
	});

	test("a card's map is at most 60 columns by 40 rows, decided and folded", () => {
		const table = new Table();

		const wide = { name: "Wide", terrain: [".".repeat(61)] };

		const tall = {
			name: "Tall",
			terrain: Array.from({ length: 41 }, () => "."),
		};

		for (const map of [wide, tall]) {
			expect(
				table.submit(GM, {
					type: "show",
					ref: "market",
					card: { ...MARKET, map },
				})
			).toBe("scene:market: a card's map is at most 60 columns by 40 rows.");
		}

		const folded = fold(
			rules,
			[env(1, "core.card-revealed", { card: { ...MARKET, map: wide } })],
			{ strict: true }
		);

		expect(folded.error?.message).toContain("at most 60 columns by 40 rows");
	});

	test("the codex holds at most 200 cards, decided and folded", () => {
		const many = Array.from({ length: CARDS_MAX }, (_, i) =>
			card("item", `thing-${i}`)
		);

		const table = new Table();

		for (const c of many) {
			reveal(table, c);
		}

		expect(table.submit(GM, { type: "reveal", ref: "mara", card: MARA })).toBe(
			`The codex holds at most ${CARDS_MAX} cards: /hide some first.`
		);

		const folded = fold(
			rules,
			[
				...many.map((c, i) => env(i + 1, "core.card-revealed", { card: c })),
				env(CARDS_MAX + 1, "core.stage-pinned", { card: MARA }),
			],
			{ strict: true }
		);

		expect(folded.error?.message).toContain(
			`holds more than ${CARDS_MAX} cards`
		);
	});

	test("a recap that cleans to nothing is refused, never folded", () => {
		const table = new Table();

		expect(table.submit(GM, { type: "recap", text: "\u0007\u001B[2J" })).toBe(
			"Usage: /recap <text>"
		);
		expect(table.envelopes).toEqual([]);
	});

	test("the stage replays from its log through JSON", () => {
		const table = new Table();
		show(table, MARKET);
		reveal(table, MARA);
		table.run(GM, {
			type: "tracker",
			id: "alarm",
			action: "set",
			kind: "clock",
			label: "Alarm",
			max: 4,
		});
		table.run(GM, { type: "recap", text: "The market burned." });

		const folded = fold(table.rules, throughJson(table.envelopes), {
			strict: true,
		});

		expect(folded.error).toBeUndefined();
		expect(folded.state.stage).toEqual(table.state.stage);
	});
});

describe("the codex at a seat", () => {
	test("/codex lists or reads only what the table has been shown", () => {
		const table = new Table();
		reveal(table, MARA);

		expect(parseInputLine("/codex mara")).toEqual({
			kind: "codex",
			ref: "mara",
		});
		expect(codexText(table.state, undefined)).toContain("npc:mara");
		expect(codexText(table.state, "mara")).toBe(
			"Mara Venn\n\nAbout Mara Venn."
		);
		expect(codexText(table.state, "ledger")).toEqual({
			refusal: "Nothing called 'ledger' is on the stage or in the codex.",
		});
	});

	test("Tab offers only revealed and shown cards, never one hidden again", () => {
		const table = new Table();
		reveal(table, MARA);
		show(table, LEDGER);
		table.run(GM, { type: "hide", ref: "ledger" });

		expect(completeLine(table.state, ALICE, "/codex ")).toEqual([
			"/codex npc:mara",
		]);
		expect(completeLine(table.state, ALICE, "/codex l")).toEqual([]);
	});
});

describe("prep for the stage", () => {
	test("each scene, person, handout and item offers Show, Codex or Hide; a scene's fight starts", () => {
		const table = new Table();
		reveal(table, MARA);

		const sections = prepStage(
			table.state.stage,
			{
				heroes: [],
				monsters: [],
				maps: [],
				scenes: [
					{
						id: "market",
						name: "Market",
						encounter: { map: "wharf", monsters: [{ id: "thug", count: 2 }] },
					},
				],
				npcs: [{ id: "mara", name: "Mara" }],
				trackers: [{ id: "alarm", label: "Alarm", kind: "clock", max: 4 }],
			},
			(encounter) => [`/map ${encounter.map ?? ""}`, "/add 2 thug"]
		);

		expect(
			sections.map((s) => [s.title, s.items.map((i) => [i.label, i.line])])
		).toEqual([
			[
				"scenes",
				[
					["Show Market", "/show scene:market"],
					["Codex Market", "/reveal scene:market"],
					["Start fight: Market", "/map wharf"],
				],
			],
			[
				"npcs",
				[
					["Show Mara", "/show npc:mara"],
					["Hide Mara", "/hide npc:mara"],
				],
			],
			["trackers", [["Track Alarm", "/tracker alarm clock 4 Alarm"]]],
		]);
		expect(sections[0]?.items[2]?.lines).toEqual(["/map wharf", "/add 2 thug"]);
	});

	test("Track sets a tracker up as its file says, whatever its label starts with", () => {
		const table = new Table();

		const sections = prepStage(
			table.state.stage,
			{
				heroes: [],
				monsters: [],
				maps: [],
				trackers: [
					{ id: "days", label: "3 Days Left", kind: "counter", value: 3 },
					{ id: "doom", label: "Doom", kind: "clock", max: 6, value: 2 },
					{ id: "dash", label: "-- odd", kind: "quest" },
				],
			},
			() => []
		);

		const lines = sections[0]?.items.map((i) => i.line) ?? [];

		expect(lines).toEqual([
			"/tracker days counter =3 -- 3 Days Left",
			"/tracker doom clock 6 =2 Doom",
			"/tracker dash quest -- -- odd",
		]);

		for (const line of lines) {
			const parsed = parseInputLine(line);

			if (parsed.kind !== "command") {
				throw new Error(`${line} didn't parse`);
			}

			table.run(GM, parsed.command);
		}

		expect(
			table.state.stage.trackers.map((t) => [t.id, t.label, t.value, t.max])
		).toEqual([
			["days", "3 Days Left", 3, undefined],
			["doom", "Doom", 2, 6],
			["dash", "-- odd", 0, undefined],
		]);
		expect(
			table.submit(GM, {
				type: "tracker",
				id: "doom",
				action: "set",
				kind: "clock",
				max: 6,
				value: 7,
				label: "Doom",
			})
		).toBe("a tracker's value is 0 to 6.");
	});
});
