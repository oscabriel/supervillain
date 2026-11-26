import { describe, expect, test } from "bun:test";

import { AUTOPLAY_SCRIPT, advanceAutoplay } from "../src/Autoplay.ts";
import { FIGHTERS } from "../src/Encounter.ts";
import { fold } from "../src/Rules.ts";
import { DEMO, sent, suggestionsOf } from "../src/Table.ts";
import type { Demo } from "../src/Table.ts";
import { terminalView } from "../src/Terminal.ts";
import { countOf, htmlOf } from "./render.ts";

const EM_DASH = "\u2014";

const beatsOf = (): Array<Demo> => {
	const beats: Array<Demo> = [];
	let demo = DEMO;

	for (const step of AUTOPLAY_SCRIPT.keys()) {
		beats.push(demo);
		({ demo } = advanceAutoplay(demo, step));
	}

	return beats;
};

const foughtOut = (seed: number): Demo => {
	let demo: Demo = { ...DEMO, seed };

	for (
		let turn = 0;
		turn < 120 && fold(demo.log).state.winner === "";
		turn += 1
	) {
		demo = sent(demo, suggestionsOf(demo)[0] ?? "/done");
	}

	return demo;
};

const ASIDES: ReadonlyArray<string> = [
	"/help",
	"/sheet",
	...FIGHTERS.map((fighter) => `/sheet ${fighter.mark}`),
	"/sheet nobody",
	"/move brann k4",
	"/move brann b2",
	"/move brann h4",
	"/move brann g4 quickly",
	"/pr brann glare on s",
	"/pr brann might",
	"/pr brann a on b",
	"/recover brann",
	"/undo",
	"/undo brann",
	"/fs b brann",
	"/roll 2d",
	"/dist B",
	"/strike b",
];

const rendered = async (demo: Demo): Promise<string> => {
	const page = await htmlOf((model, h) => terminalView(model.demo, h), demo);

	return page;
};

const textsOf = (demo: Demo): Array<string> =>
	fold(demo.log).feed.map((line) => line.text);

describe("the demo's feed", () => {
	test("renders no em-dash at any beat of the scripted autoplay", async () => {
		const beats = beatsOf();
		const pages = await Promise.all(beats.map(rendered));
		const last = beats.at(-1) ?? DEMO;

		expect(fold(last.log).state.round).toBe(3);
		expect(pages.length).toBe(AUTOPLAY_SCRIPT.length);
		expect(pages.filter((page) => page.includes(EM_DASH))).toStrictEqual([]);
		expect(
			beats.flatMap(textsOf).filter((text) => text.includes(EM_DASH))
		).toStrictEqual([]);
		expect(textsOf(last).some((text) => text.includes(" · tier "))).toBe(true);
	});

	test("words no line with an em-dash in a fight played out, under many seeds", () => {
		const fights = Array.from({ length: 24 }, (_unused, index) =>
			foughtOut(index + 1)
		);

		expect(
			fights.flatMap(textsOf).filter((text) => text.includes(EM_DASH))
		).toStrictEqual([]);
	});

	test("answers and refuses without an em-dash", async () => {
		const asides = ASIDES.map((line) => sent(DEMO, line));
		const pages = await Promise.all(asides.map(rendered));

		expect(pages.filter((page) => page.includes(EM_DASH))).toStrictEqual([]);
		expect(
			asides.filter((demo) => demo.refusal === "" && demo.reply === null)
		).toStrictEqual([]);
	});

	test("shows a dead minion at 0 Stamina in the band, as the real table does", async () => {
		const last = beatsOf().at(-1) ?? DEMO;
		const page = await rendered(last);

		expect(page).toContain("<span>0/3</span>");
		expect(page).not.toContain("-7/3");
		expect(countOf(page, "tui-band-row dead")).toBe(1);
		expect(textsOf(last)).toContain(
			"Bandit Slinger takes 10 damage → 0/3 · dead"
		);
	});
});
