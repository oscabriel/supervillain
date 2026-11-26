import { describe, expect, test } from "bun:test";

import {
	BAND_MIN,
	bandRows,
	heights,
	mapHeights,
	roomFor,
} from "../../src/table/layout.ts";
import type { HeightsInput, Screen } from "../../src/table/layout.ts";
import { ALL_SHOWN } from "../../src/table/panels.ts";
import {
	meter,
	meterTone,
	partyRow,
	partyWanted,
	sheetLine,
} from "../../src/table/party.ts";
import { chipLabel, chipRows, stageEntries } from "../../src/table/prep.ts";
import { clip, proseLines, wrap } from "../../src/table/prose.ts";
import {
	campaignShown,
	cardPlan,
	clockFace,
	codexFind,
	codexLabel,
	codexWanted,
	gridView,
	hasStage,
	pinnedColumns,
	rowsOfCards,
	stagePlan,
	stageWanted,
	trackerLines,
	trackerText,
} from "../../src/table/stage.ts";
import {
	ambush,
	brann,
	campaignStage,
	emptyStage,
	kesh,
	mara,
	sketch,
} from "./stageViews.ts";

describe("prose", () => {
	test("paragraphs wrap at the width and long words break", () => {
		expect(wrap("the road dips toward the ford", 12)).toEqual([
			"the road",
			"dips toward",
			"the ford",
		]);
		expect(wrap("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
		expect(wrap("", 10)).toEqual([""]);
	});

	test("each block has its own look, with a blank line between blocks", () => {
		const lines = proseLines(
			[
				{ kind: "heading", level: 2, text: "The Ford" },
				{ kind: "para", text: "Water runs." },
				{ kind: "list", ordered: true, items: ["first thing", "second"] },
				{ kind: "quote", text: "Toll's gone up." },
			],
			20
		);

		expect(lines.map((l) => [l.tone, l.text])).toEqual([
			["heading", "The Ford"],
			["text", ""],
			["text", "Water runs."],
			["text", ""],
			["list", "1. first thing"],
			["list", "2. second"],
			["text", ""],
			["quote", "│ Toll's gone up."],
		]);
	});

	test("preformatted lines are kept verbatim, clipped to the width", () => {
		const lines = proseLines(
			[{ kind: "pre", lines: ["+--------------+", "|  W A N T E D  |"] }],
			8
		);

		expect(lines).toEqual([
			{ text: "+-------", tone: "pre" },
			{ text: "|  W A N", tone: "pre" },
		]);
		expect(clip("日本語のテキスト", 5)).toBe("日本");
	});

	test("a list item that wraps hangs under its marker", () => {
		expect(
			proseLines(
				[{ kind: "list", ordered: false, items: ["one two three four"] }],
				10
			).map((l) => l.text)
		).toEqual(["• one two", "  three", "  four"]);
	});
});

describe("party", () => {
	test("a meter fills with what's left and turns as it runs down", () => {
		expect(meter(15, 20, 8)).toBe("██████░░");
		expect(meter(0, 20, 8)).toBe("░░░░░░░░");
		expect(meterTone(15, 20, false)).toBe("healthy");
		expect(meterTone(10, 20, false)).toBe("winded");
		expect(meterTone(0, 20, false)).toBe("dying");
		expect(meterTone(12, 20, true)).toBe("dying");
	});

	test("a row keeps the name and drops what doesn't fit, least first", () => {
		const wide = partyRow(brann, 100);

		expect(wide.segments.map((s) => s.text).join("")).toBe(
			"Brann (Alice)  Stamina ██████░░ 15/20  judged  Censor 1 · recoveries 8/8"
		);

		const narrow = partyRow(brann, 40)
			.segments.map((s) => s.text)
			.join("");

		expect(narrow).toBe("Brann (Alice)  Stamina ██████░░ 15/20");
		expect(partyRow(kesh, 100).segments[0]).toEqual({
			text: "Kesh",
			tone: "mine",
		});
		expect(partyRow(kesh, 100).segments.some((s) => s.tone === "winded")).toBe(
			true
		);
	});

	test("the strip wants a row a member and a click asks for the sheet", () => {
		expect(partyWanted([brann, kesh])).toBe(4);
		expect(partyWanted([])).toBe(3);
		expect(sheetLine("brann")).toBe("/sheet brann");
	});
});

describe("the stage's plan", () => {
	test("a stage with nothing on it isn't shown", () => {
		expect(hasStage(undefined)).toBe(false);
		expect(hasStage(emptyStage)).toBe(false);
		expect(hasStage(campaignStage)).toBe(true);
	});

	test("the campaign shows out of a fight, the board in one, and a peek wins", () => {
		const base = {
			stage: campaignStage,
			mapLoaded: false,
			peek: undefined,
			prepping: false,
		};

		expect(campaignShown(base)).toBe(true);
		expect(
			campaignShown({
				...base,
				stage: { ...campaignStage, mode: "encounter", combat: true },
			})
		).toBe(false);
		expect(campaignShown({ ...base, peek: "board" })).toBe(false);
		expect(
			campaignShown({
				...base,
				stage: { ...campaignStage, mode: "encounter" },
				peek: "stage",
			})
		).toBe(true);
		expect(campaignShown({ ...base, stage: emptyStage })).toBe(false);
		expect(campaignShown({ ...base, stage: undefined, peek: "stage" })).toBe(
			false
		);
	});

	test("the GM setting up a fight in prep sees the board unless the stage was chosen", () => {
		const prepping = {
			stage: campaignStage,
			mapLoaded: true,
			peek: undefined,
			prepping: true,
		};

		expect(campaignShown(prepping)).toBe(false);
		expect(
			campaignShown({
				...prepping,
				stage: { ...campaignStage, override: true },
			})
		).toBe(true);
		expect(campaignShown({ ...prepping, prepping: false })).toBe(true);
	});

	test("a card plans its rows: title, read-aloud box, body, map and notes", () => {
		const plain = cardPlan(ambush, 40);

		expect(plain.head).toBe("Ambush at the Ford");
		expect(plain.readAloud.map((l) => l.text)).toEqual([
			"The Ford Road runs down to the",
			"water.",
		]);
		expect(plain.body.map((l) => l.text)).toEqual([
			"The road dips toward the ford.",
			"",
			"• a ruined wall",
			"• brush",
		]);
		expect(plain.notes).toEqual([]);
		expect(plain.height).toBe(1 + 1 + (2 + 2) + 1 + 4 + 2);

		const noted = cardPlan(ambush, 40, [
			{ kind: "para", text: "GMSECRET the chief waits." },
		]);

		expect(noted.notes.map((l) => l.text)).toEqual([
			"GMSECRET the chief waits.",
		]);
		expect(noted.height).toBe(plain.height + 1 + 3);

		const map = cardPlan(sketch, 40);

		expect(map.map?.width).toBe(10);
		expect(map.mapRows).toBe(3 + 1 + 2);
		expect(cardPlan(mara, 40).head).toBe("Old Mara · Ferry-keeper");
		expect(cardPlan(mara, 40).tags).toBe("local");
	});

	test("a card's map becomes a board with nobody on it", () => {
		expect(gridView({ name: "Ford", terrain: ["..", "...", "#"] })).toEqual({
			name: "Ford",
			width: 3,
			height: 3,
			terrain: ["..", "...", "#"],
			tokens: [],
			reach: [],
		});
	});

	test("pinned cards sit side by side when there's room", () => {
		expect(pinnedColumns(75)).toBe(1);
		expect(pinnedColumns(76)).toBe(2);
		expect(rowsOfCards([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
		expect(rowsOfCards([1, 2], 1)).toEqual([[1], [2]]);
	});

	test("clocks fill in quarters and segments, counters and quests count", () => {
		expect([0, 1, 2, 3, 4].map((v) => clockFace(v, 4))).toEqual([
			"○",
			"◔",
			"◑",
			"◕",
			"●",
		]);
		expect(
			trackerText({
				id: "a",
				label: "Alarm",
				kind: "clock",
				value: 2,
				max: 4,
				hidden: false,
			})
		).toBe("◑ Alarm ●●○○ 2/4");
		expect(
			trackerText({
				id: "q",
				label: "Find Gall",
				kind: "quest",
				value: 3,
				max: 3,
				hidden: true,
			})
		).toBe("✓ Find Gall 3/3 (only you)");
		expect(
			trackerText({
				id: "c",
				label: "Toll",
				kind: "counter",
				value: 7,
				hidden: false,
			})
		).toBe("# Toll 7");
		expect(trackerLines(campaignStage.trackers, 80)).toEqual([
			"◑ The alarm ●●○○ 2/4",
		]);
	});

	test("the stage wants its cards, trackers and recap, framed", () => {
		const plan = stagePlan(campaignStage, 100);

		expect(plan.scene?.card.key).toBe("scene:ford-ambush");
		expect(plan.pinned.map((row) => row.map((c) => c.card.key))).toEqual([
			["npc:old-mara", "handout:ford-sketch"],
		]);
		expect(plan.recap).toEqual([
			"• The caravan reached the ford.",
			"• Mara waved, then didn't.",
		]);
		expect(stageWanted(plan)).toBe(plan.rows + 2);
		expect(stageWanted(stagePlan(emptyStage, 100))).toBe(5);

		const noted = stagePlan(campaignStage, 100, (key) =>
			key === "scene:ford-ambush"
				? [{ kind: "para", text: "GMSECRET" }]
				: undefined
		);

		expect(noted.scene?.notes.map((l) => l.text)).toEqual(["GMSECRET"]);
	});

	test("the codex finds a card by key, id or title, and wants a row each", () => {
		expect(codexFind(campaignStage.codex, "old-mara")?.key).toBe(
			"npc:old-mara"
		);
		expect(codexFind(campaignStage.codex, "A Wanted Poster")?.key).toBe(
			"handout:wanted-poster"
		);
		expect(codexFind(campaignStage.codex, "ghost")).toBeUndefined();
		expect(codexLabel(campaignStage.codex[0] ?? never(), 60)).toBe(
			"◈ Ambush at the Ford  on the table"
		);
		expect(codexWanted(campaignStage, {}, 100)).toBe(1 + 4 + 2);
		expect(
			codexWanted(campaignStage, { key: "npc:old-mara" }, 100)
		).toBeGreaterThan(1 + 4 + 2);
	});
});

const never = (): never => {
	throw new Error("the codex has its first card");
};

describe("the prep panel's stage", () => {
	test("each card's buttons group under it, with its tier and its fight", () => {
		const entries = stageEntries([
			{ kind: "send", label: "Show Ambush", line: "/show scene:ford-ambush" },
			{
				kind: "send",
				label: "Hide Ambush",
				line: "/hide scene:ford-ambush",
				note: "in the codex",
			},
			{
				kind: "send",
				label: "Start fight: Ambush",
				line: "/map ford-road",
				lines: ["/map ford-road", "/add bandit-chief"],
			},
			{ kind: "send", label: "Show Old Mara", line: "/show npc:old-mara" },
			{ kind: "send", label: "Codex Old Mara", line: "/reveal npc:old-mara" },
		]);

		expect(
			entries.map((e) => [e.key, e.name, e.tier, e.items.map(chipLabel)])
		).toEqual([
			["scene:ford-ambush", "Ambush", "in-codex", ["Show", "Hide", "▶ fight"]],
			["npc:old-mara", "Old Mara", undefined, ["Show", "Codex"]],
		]);
	});

	test("buttons wrap onto rows that fit the panel", () => {
		expect(chipRows(["Show", "Codex", "Hide", "▶ fight"], 22)).toEqual([
			[0, 1, 2],
			[3],
		]);
		expect(chipRows(["Show"], 3)).toEqual([[0]]);
	});
});

const screen = (over: Partial<Screen> = {}): Screen => ({
	width: 100,
	height: 30,
	knocks: false,
	menuRows: 0,
	fighting: false,
	...over,
});

describe("layout", () => {
	test("the room is what's left after the fixed rows, the feed and a notice", () => {
		expect(roomFor(screen(), ALL_SHOWN, false)).toEqual({ room: 22, cap: 15 });
		expect(
			roomFor(screen({ knocks: true, menuRows: 2 }), ALL_SHOWN, true)
		).toEqual({ room: 18, cap: 15 });
		expect(
			roomFor(screen({ fighting: true }), { ...ALL_SHOWN, feed: false }, false)
		).toEqual({ room: 27, cap: 27 });
	});

	test("the band shares with the map, which folds the band when it comes first", () => {
		const band = bandRows(undefined, 100, 15);

		expect(band).toEqual({ wanted: BAND_MIN, keep: BAND_MIN });
		expect(mapHeights(14, band, 22, ALL_SHOWN)).toEqual({ band: 3, map: 14 });
		expect(mapHeights(30, band, 22, { ...ALL_SHOWN, mapFirst: true })).toEqual({
			band: 3,
			map: 19,
		});
		expect(mapHeights(30, band, 22, { ...ALL_SHOWN, band: false })).toEqual({
			band: 0,
			map: 22,
		});
		expect(mapHeights(3, band, 22, ALL_SHOWN).map).toBe(0);
	});

	test("the party strip takes the band's place and its own rows", () => {
		const input: HeightsInput = {
			screen: screen(),
			shown: ALL_SHOWN,
			combat: undefined,
			noticeLine: false,
			paneOpen: false,
			paneRows: 0,
			small: false,
			mapWanted: undefined,
		};

		expect(heights(input)).toEqual({ band: 15, pane: 0, map: 0 });
		expect(heights({ ...input, party: { wanted: 4, keep: 4 } })).toEqual({
			band: 4,
			pane: 0,
			map: 0,
		});
		expect(
			heights({ ...input, party: { wanted: 4, keep: 4 }, mapWanted: 40 })
		).toEqual({ band: 4, map: 18, pane: 0 });
		expect(heights({ ...input, small: true })).toEqual({
			band: 0,
			pane: 0,
			map: 0,
		});
	});
});
