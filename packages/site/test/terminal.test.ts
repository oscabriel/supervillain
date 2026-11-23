import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { COLUMNS, ROWS, TERRAIN } from "../src/Encounter.ts";
import { homeView } from "../src/Home.ts";
import { ranLine } from "../src/Model.ts";
import type { Model } from "../src/Model.ts";
import { AppRoute } from "../src/Route.ts";
import { actedSquare, actedToken, DEMO, sent } from "../src/Table.ts";
import { terminalView } from "../src/Terminal.ts";
import { countOf, htmlOf } from "./render.ts";

const walls = TERRAIN.join("")
	.split("")
	.filter((square) => square === "#").length;

const START: Model = {
	route: AppRoute.Home(),
	demo: DEMO,
	copied: false,
	copiedBlock: "",
	copyToken: 0,
	mapMode: "pictures",
};

describe("the terminal on the front page", () => {
	test("draws the header, band, map, feed, hint row and input line", async () => {
		const html = await htmlOf((model, h) => terminalView(model.demo, h));

		expect(html).toContain("ssh first-fight@supervillain.sh");
		expect(html).toContain("Brann (you)");
		expect(html).toContain("B Brann (you)");
		expect(html).toContain("b Bandit Bruiser");
		expect(html).toContain("s Bandit Slinger");
		expect(html).toContain("The Ford Road · 5 move");
		expect(html).toContain("fight · round 1 · Brann's turn");
		expect(html).toContain("Combat begins, round 1.");
		expect(html).toContain("5 move · main ready");
		expect(html).toContain("click a tinted square to move");
		expect(html).toContain('id="demo-line"');
		expect(html).toContain('placeholder="say something, or /help"');
		expect(html).toContain("/roll 2d10+2");
		expect(countOf(html, 'class="tui-cell')).toBe(COLUMNS * ROWS);
		expect(countOf(html, 'class="tui-cell wall"')).toBe(walls);
		expect(countOf(html, "tui-cell reach")).toBeGreaterThan(0);
		expect(countOf(html, "tui-tile-svg")).toBe(COLUMNS * ROWS);
		expect(html).toContain('class="term-chrome-btn on"');
		expect(html).toContain('aria-pressed="true"');
		expect(html).not.toContain("events.jsonl");
	});

	test("draws the map as text in /view text", async () => {
		const html = await htmlOf((model, h) =>
			terminalView(model.demo, h, "text")
		);

		expect(countOf(html, "text-mode")).toBe(COLUMNS * ROWS);
		expect(countOf(html, 'class="tui-cell wall text-mode"')).toBe(walls);
		expect(countOf(html, "tui-tile-svg")).toBe(0);
		expect(html).toContain("•");
	});

	test("shows a refusal as the lead badge", async () => {
		const html = await htmlOf(
			(model, h) => terminalView(model.demo, h),
			sent(DEMO, "/move brann k4")
		);

		expect(html).toContain('class="tui-lead-badge is-refusal"');
		expect(html).toContain("Refused: Brann can't move that far");
	});

	test("opens a reply under the map and feed, which stay on screen", async () => {
		const html = await htmlOf(
			(model, h) => terminalView(model.demo, h),
			sent(DEMO, "/help")
		);

		expect(html).toContain("tui-reply-box");
		expect(html).toContain("just for you · help");
		expect(html).toContain("tui-map-box");
		expect(html).toContain("tui-feed-box");
	});
});

describe("clicking the map", () => {
	test("moves Brann at once when a tinted square is clicked", () => {
		const moved = actedSquare(DEMO, "g4");

		expect(moved.line).toBe("");
		expect(moved.sent).toStrictEqual(["/move brann g4"]);
		expect(moved.log.length).toBeGreaterThan(DEMO.log.length);
	});

	test("strikes an adjacent bandit at once, and types names otherwise", () => {
		const close = actedSquare(DEMO, "g4");
		const struck = actedToken(close, "bandit-bruiser");

		expect(struck.sent.at(-1)).toBe("/pr brann driving on b");
		expect(struck.log.length).toBeGreaterThan(close.log.length);
		expect(actedToken(DEMO, "bandit-slinger").line).toBe("s");
		expect(actedSquare(DEMO, "n1").line).toBe("n1");
	});
});

describe("the /view and /reset lines", () => {
	test("/view switches the map and /reset starts over", () => {
		const viewed = ranLine(START, "/view text");

		expect(viewed.mapMode).toBe("text");
		expect(viewed.demo.line).toBe("");
		expect(viewed.demo.refusal).toBe("");
		expect(viewed.demo.sent).toStrictEqual(["/view text"]);
		expect(ranLine(viewed, "/view").mapMode).toBe("pictures");
		expect(ranLine(viewed, "/view maps").demo.refusal).toBe(
			"Refused: /view takes pictures or text."
		);

		const moved = { ...viewed, demo: actedSquare(viewed.demo, "g4") };
		const reset = ranLine(moved, "/reset");

		expect(moved.demo.log.length).toBeGreaterThan(DEMO.log.length);
		expect(reset.demo.log).toStrictEqual(DEMO.log);
		expect(reset.mapMode).toBe("text");
		expect(ranLine(moved, "/reset now").demo.refusal).toBe(
			"Refused: /reset takes no arguments."
		);
	});
});

describe("the stylesheet contract", () => {
	test("styles every feed kind emitted by the rules engine", () => {
		const css = readFileSync(
			`${import.meta.dirname}/../src/style.css`,
			"utf-8"
		);

		for (const kind of [
			"plain",
			"turn",
			"move",
			"roll",
			"hit",
			"heal",
			"end",
			"chat",
			"dice",
			"undo",
		]) {
			expect(css).toContain(`[data-kind="${kind}"]`);
		}
	});
});

describe("the front page", () => {
	test("leads with the join command and a quiet copy hint", async () => {
		const html = await htmlOf((model, h) => h.div([], homeView(model, h)));

		expect(html).toContain('<span class="g-ssh">ssh</span>');
		expect(html).toContain("supervillain.sh");
		expect(html).toContain('aria-label="Copy ssh supervillain.sh"');
		expect(html).toContain("Click to copy");
		expect(html).toContain("Copied");
		expect(html).not.toContain("canvas");
		expect(html).not.toContain("events.jsonl");
	});

	test("explains itself below the fold", async () => {
		const html = await htmlOf((model, h) => h.div([], homeView(model, h)));

		expect(html).toContain("A virtual tabletop without the overhead.");
		expect(html).toContain("Zero friction at game night");
		expect(html).toContain("Tactical play, right in the terminal");
		expect(html).toContain("Your machine is the table");
		expect(html).toContain("Three rulesets out of the box");
		expect(html).toContain("Draw Steel · set.world · PF2e");
		expect(countOf(html, 'class="g-row"')).toBe(4);
	});
});
