import { describe, expect, test } from "bun:test";

import { COLUMNS, ROWS, TERRAIN } from "../src/Encounter.ts";
import { homeView } from "../src/Home.ts";
import { DEMO, sent, toggledLog } from "../src/Table.ts";
import { terminalView } from "../src/Terminal.ts";
import { countOf, htmlOf } from "./render.ts";

const walls = TERRAIN.join("")
	.split("")
	.filter((square) => square === "#").length;

describe("the terminal on the front page", () => {
	test("draws the band, the map, the feed, the hint row and the input line", async () => {
		const html = await htmlOf((model, h) => terminalView(model.demo, h));

		expect(html).toContain("Brann · you");
		expect(html).toContain("Bandit Bruiser");
		expect(html).toContain("Bandit Slinger");
		expect(html).toContain("The Ford Road");
		expect(html).toContain("Combat begins, round 1.");
		expect(html).toContain(
			"your turn · 5 movement left · main action ready · /done ends it"
		);
		expect(html).toContain('id="demo-line"');
		expect(countOf(html, 'class="sq')).toBe(COLUMNS * ROWS);
		expect(countOf(html, 'class="sq is-wall"')).toBe(walls);
		expect(countOf(html, "is-reach")).toBeGreaterThan(0);
	});

	test("shows a refusal in the hint row", async () => {
		const html = await htmlOf(
			(model, h) => terminalView(model.demo, h),
			sent(DEMO, "/move brann k4")
		);

		expect(html).toContain('class="hint is-refusal"');
		expect(html).toContain("Refused: Brann can't move that far");
	});

	test("puts a reply where the map was, and tails the log when asked", async () => {
		const html = await htmlOf(
			(model, h) => terminalView(model.demo, h),
			toggledLog(sent(DEMO, "/help"))
		);

		expect(html).toContain("panel reply");
		expect(html).not.toContain("panel map");
		expect(html).toContain("tail events.jsonl");
		expect(html).toContain("ds.map-loaded");
	});

	test("sits under a pitch that says what supervillain is", async () => {
		const html = await htmlOf((model, h) => h.div([], homeView(model, h)));

		expect(html).toContain("A virtual tabletop you join with ssh.");
		expect(html).toContain("Draw Steel");
		expect(html).toContain("rules: draw-steel");
		expect(html).toContain("set.world");
		expect(html).toContain("rules: set-world");
		expect(html).toContain("PF2e Remaster (ORC)");
		expect(html).toContain("rules: pf2e");
		expect(html).toContain('aria-label="Copy ssh command"');
		expect(html).toContain('href="/docs/hosting"');
	});
});
