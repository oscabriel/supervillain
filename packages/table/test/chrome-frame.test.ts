/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-lane suite. */
import { describe, expect, test } from "bun:test";

import {
	bandHeader,
	ruleHeader,
	ruleJunction,
	verticalBandDivider,
} from "../src/chrome-frame.js";

const text = (line: {
	readonly runs: readonly { readonly text: string }[];
}): string => line.runs.map((run) => run.text).join("");

describe("ruleJunction", () => {
	test("computes every legal light-rule meeting", () => {
		for (const [connections, glyph] of [
			[{ left: true, right: true }, "─"],
			[{ down: true, up: true }, "│"],
			[{ down: true, right: true }, "┌"],
			[{ down: true, left: true }, "┐"],
			[{ right: true, up: true }, "└"],
			[{ left: true, up: true }, "┘"],
			[{ down: true, right: true, up: true }, "├"],
			[{ down: true, left: true, up: true }, "┤"],
			[{ down: true, left: true, right: true }, "┬"],
			[{ left: true, right: true, up: true }, "┴"],
			[{ down: true, left: true, right: true, up: true }, "┼"],
		] as const) {
			expect(ruleJunction(connections)).toBe(glyph);
		}
	});

	test("refuses marks that are not meetings", () => {
		expect(() => ruleJunction({ right: true })).toThrow(
			"A rule junction needs at least two connections."
		);
	});
});

describe("ruleHeader", () => {
	test("fills the requested width with a label in one light rule", () => {
		const header = ruleHeader("seats", 14);
		expect(text(header)).toBe("─┤ seats ├────");
		expect(header.runs).toEqual([
			{ attrs: ["dim"], text: "─┤ ", token: "muted" },
			{ attrs: ["bold"], text: "seats", token: "primary" },
			{ attrs: ["dim"], text: " ├────", token: "muted" },
		]);
	});

	test("clips by terminal cells without splitting graphemes", () => {
		expect(text(ruleHeader("seat assignments", 9))).toBe("─┤ sea… ├");
		const wide = text(ruleHeader("界域", 8));
		expect(wide).toBe("─┤ 界… ├");
		expect(Bun.stringWidth(wide)).toBe(8);
	});

	test("demotes to an unbroken rule when no label fits", () => {
		expect(text(ruleHeader("feed", 6))).toBe("──────");
		expect(text(ruleHeader("feed", 5))).toBe("─────");
		expect(text(ruleHeader("feed", 1))).toBe("─");
		expect(text(ruleHeader("feed", 0))).toBe("");
	});
});

describe("band frame", () => {
	test("joins the table and sidebar headers to the divider below", () => {
		expect(
			text(
				bandHeader({
					leftLabel: "room",
					rightLabel: "seats",
					rightWidth: 10,
					vertical: "down",
					width: 24,
				})
			)
		).toBe("─┤ room ├────┬─┤ seats ├");
	});

	test("ends the sidebar divider at the state band", () => {
		const header = text(
			bandHeader({
				leftLabel: "state",
				rightLabel: "",
				rightWidth: 10,
				vertical: "up",
				width: 24,
			})
		);
		expect(header).toBe("─┤ state ├───┴──────────");
	});

	test("marks internal headers where they meet the sidebar divider", () => {
		expect(verticalBandDivider(5, [0, 3])).toBe("┤\n│\n│\n┤\n│");
	});
});
