/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-lane suite. */
import { describe, expect, test } from "bun:test";

import {
	clipPaneTitle,
	initialPaneFocus,
	nextPaneFocus,
	paneFocusOrder,
} from "../src/chrome.js";

describe("Table Pane focus", () => {
	test("uses the stable ring and omits an absent Map Pane", () => {
		expect(paneFocusOrder(true)).toEqual(["feed", "map", "sidebar", "message"]);
		expect(paneFocusOrder(false)).toEqual(["feed", "sidebar", "message"]);
	});

	test("traverses forward and backward with wrapping", () => {
		expect(nextPaneFocus("feed", true)).toBe("map");
		expect(nextPaneFocus("message", true)).toBe("feed");
		expect(nextPaneFocus("feed", true, true)).toBe("message");
		expect(nextPaneFocus("feed", false)).toBe("sidebar");
		expect(nextPaneFocus("sidebar", false, true)).toBe("feed");
	});

	test("derives initial focus from layout and never chooses Message", () => {
		expect(initialPaneFocus("map-focused", true)).toBe("map");
		expect(initialPaneFocus("map-focused", false)).toBe("feed");
		expect(initialPaneFocus("feed-focused", true)).toBe("feed");
		expect(initialPaneFocus("no-map", false)).toBe("feed");
	});
});

describe("Pane title clipping", () => {
	test("returns a title that already fits unchanged", () => {
		expect(clipPaneTitle("map · Hall", 10)).toBe("map · Hall");
	});

	test("clips an overlong title on a grapheme boundary with an ellipsis", () => {
		expect(clipPaneTitle("map · The Sunken Cathedral", 12)).toBe(
			"map · The S…"
		);
	});

	test("counts wide graphemes as two cells and never splits one", () => {
		// 界 and 域 each occupy two cells: "map · 界域" is ten cells wide.
		expect(clipPaneTitle("map · 界域", 10)).toBe("map · 界域");
		// A nine-cell budget cannot hold half of 域: the clip ends after 界.
		expect(clipPaneTitle("map · 界域", 9)).toBe("map · 界…");
	});
});
