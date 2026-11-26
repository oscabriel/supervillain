import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { AUTOPLAY_SCRIPT, advanceAutoplay } from "../src/Autoplay.ts";
import { COLUMNS, ROWS, TERRAIN } from "../src/Encounter.ts";
import {
	appendClickRipple,
	buildTextField,
	farthestCorner,
	isRippleFinished,
	makeClickRipple,
	pruneRipples,
	rippleIntensityAt,
	scrambleChar,
} from "../src/HeroWaves.ts";
import type { Ripple } from "../src/HeroWaves.ts";
import { homeView } from "../src/Home.ts";
import { ranLine } from "../src/Model.ts";
import type { Model } from "../src/Model.ts";
import { AppRoute } from "../src/Route.ts";
import { fold } from "../src/Rules.ts";
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
	whatIsOpen: false,
	protocolRuleset: "draw-steel",
	protocolRole: "gm",
	protocolQuery: "",
	mapMode: "pictures",
	autoplay: false,
	autoplayStep: 0,
	autoplayLine: "",
};

describe("the terminal on the front page", () => {
	test("draws the band, map, feed, hint row and input line with no header bar", async () => {
		const html = await htmlOf((model, h) => terminalView(model.demo, h));

		expect(html).not.toContain("ssh first-fight@supervillain.sh");
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
		expect(html).not.toContain("term-chrome");
		expect(html).not.toContain("/view pictures");
		expect(html).not.toContain("/view text");
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

describe("the autoplay encounter", () => {
	test("plays every GM and player beat cleanly and loops back to the start", () => {
		let demo = DEMO;
		let step = 0;
		let sawGm = false;
		let sawPreview = false;
		let maxRound = 1;

		for (const index of AUTOPLAY_SCRIPT.keys()) {
			expect(step).toBe(index);

			const {
				demo: nextDemo,
				autoplayLine,
				nextStep,
			} = advanceAutoplay(demo, step);

			expect(nextDemo.refusal).toBe("");

			if (autoplayLine !== "") {
				sawPreview = true;
			}

			const { state, feed } = fold(nextDemo.log);

			if (feed.some((line) => line.who === "GM")) {
				sawGm = true;
			}

			if (state.round > maxRound) {
				maxRound = state.round;
			}

			demo = nextDemo;
			step = nextStep;
		}

		expect(sawGm).toBeTruthy();
		expect(sawPreview).toBeTruthy();
		expect(maxRound).toBeGreaterThanOrEqual(3);
		expect(step).toBe(0);
		expect(demo.log).toStrictEqual(DEMO.log);
	});

	test("shows preview text and no header controls while playing", async () => {
		const html = await htmlOf((model, h) =>
			terminalView(model.demo, h, "pictures", {
				autoplay: true,
				autoplayLine: "/move brann g4",
			})
		);

		expect(html).not.toContain("live preview");
		expect(html).not.toContain("term-chrome");
		expect(html).toContain('value="/move brann g4"');
		expect(html).toContain("is-preview");
	});
});

describe("the hero ASCII wave field", () => {
	test("builds a fantasy text grid, sweeps a calm ripple ring, and scrambles passed characters", () => {
		const field = buildTextField(24, 10, 8);

		expect(field.chars.length).toBe(240);
		expect(field.chars.join("")).toContain("Torchlight");

		const ripple: Ripple = {
			ox: 0,
			oy: 0,
			startedAt: 0,
			speed: 120,
			bandWidth: 40,
			maxRadius: farthestCorner(0, 0, 800, 400),
			strength: 1,
		};

		const atCrest = rippleIntensityAt(ripple, 240, 0, 2000);
		const farAway = rippleIntensityAt(ripple, 600, 0, 2000);

		expect(atCrest).toBeGreaterThan(0.9);
		expect(farAway).toBe(0);
		expect(isRippleFinished(ripple, 2000)).toBeFalsy();
		expect(isRippleFinished(ripple, 12_000)).toBeTruthy();

		expect(scrambleChar("a", 0.05, 4, 2, 10)).toBe("a");

		const flipped = new Set(
			Array.from({ length: 16 }, (_unused, tick) =>
				scrambleChar("a", 0.95, 4, 2, tick)
			)
		);

		expect(flipped.size).toBeGreaterThan(5);
	});

	test("keeps multiple concurrent click ripples alive until each finishes, capped by limit", () => {
		const first = makeClickRipple(100, 120, 800, 400, 0);
		const second = makeClickRipple(400, 200, 800, 400, 200);
		const third = makeClickRipple(700, 80, 800, 400, 400);

		let ripples = appendClickRipple([], first, 0);

		ripples = appendClickRipple(ripples, second, 200);
		ripples = appendClickRipple(ripples, third, 400);

		expect(ripples).toStrictEqual([first, second, third]);
		expect(pruneRipples(ripples, 1000)).toStrictEqual([first, second, third]);

		const capped = appendClickRipple(
			ripples,
			makeClickRipple(250, 300, 800, 400, 600),
			600,
			3
		);

		expect(capped.length).toBe(3);
		expect(capped[0]).toStrictEqual(second);
		expect(capped[1]).toStrictEqual(third);
		expect(capped[2]?.ox).toBe(250);

		const late = makeClickRipple(300, 150, 800, 400, 10_000);
		const afterFirstEnds = appendClickRipple(ripples, late, 10_000);

		expect(afterFirstEnds).toStrictEqual([late]);
	});
});

describe("the front page", () => {
	test("leads with the join command, ASCII wave canvas, and a quiet copy hint", async () => {
		const html = await htmlOf((model, h) => h.div([], homeView(model, h)));

		expect(html).toContain('<span class="g-ssh">ssh</span>');
		expect(html).toContain("supervillain.sh");
		expect(html).toContain('aria-label="Copy ssh supervillain.sh"');
		expect(html).toContain("Click to copy");
		expect(html).toContain("Copied");
		expect(html).toContain('class="g-hero-canvas"');
		expect(html).toContain('class="g-hero-vignette"');
		expect(html).not.toContain("events.jsonl");
	});

	test("explains itself below the fold", async () => {
		const html = await htmlOf((model, h) => h.div([], homeView(model, h)));

		expect(html).toContain("Your terminal is the table.");
		expect(html).toContain("Zero friction at game night");
		expect(html).toContain("Stage and battlemap in one place");
		expect(html).toContain("Plain files on the GM's disk");
		expect(html).toContain("Four rulesets built in");
		expect(html).toContain("Draw Steel · set.world · PF2e · Freeform");
		expect(html).toContain("Bring an agent live");
		expect(countOf(html, 'class="g-row"')).toBe(5);
	});
});
