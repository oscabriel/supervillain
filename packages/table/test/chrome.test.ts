/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-lane suite. */
import { describe, expect, test } from "bun:test";

import type { GamePanel, GamePanelInput } from "@supervillain/core";

import {
	adaptPanelKey,
	formatSeatList,
	forwardPanelKey,
	initialFeedLines,
	nextPanelFocus,
} from "../src/chrome.js";

describe("table sidebar", () => {
	test("shows seats derived after a seat-claimed envelope", () => {
		expect(
			formatSeatList(
				{
					actor: "player-key",
					gmSeatId: "gm",
					seats: [
						{ actor: "gm-key", id: "gm" },
						{ actor: "player-key", id: "player-1" },
					],
				},
				"player-key"
			)
		).toBe("○ gm\n● player-1");
	});

	test("cycles input focus through interactive panels and back", () => {
		expect(nextPanelFocus(-1, 2)).toBe(0);
		expect(nextPanelFocus(0, 2)).toBe(1);
		expect(nextPanelFocus(1, 2)).toBe(-1);
		expect(nextPanelFocus(-1, 0)).toBe(-1);
	});

	test("starts the feed with module notices", () => {
		const notice = {
			runs: [{ text: "independent", token: "muted" as const }],
		};
		expect(initialFeedLines([notice])).toEqual([notice]);
		expect(initialFeedLines()).toEqual([]);
	});

	test("adapts printable keys and forwards them to a panel", () => {
		const captured: unknown[] = [];
		const panel: GamePanel<unknown, unknown> = {
			id: "keys",
			onKey: (key) => {
				captured.push(key);
				return true;
			},
			render: () => [],
			slot: "sidebar",
		};
		const input: GamePanelInput<unknown, unknown> = {
			dispatch: () => {},
			state: {},
			table: { actor: "viewer", gmSeatId: "gm", seats: [] },
		};
		const key = adaptPanelKey({
			ctrl: false,
			meta: false,
			name: "A",
			sequence: "a",
		});
		expect(forwardPanelKey(key, panel, input)).toBe(true);
		expect(captured).toEqual([{ name: "a", text: "a" }]);
		expect(
			adaptPanelKey({
				ctrl: false,
				meta: false,
				name: "up",
				sequence: "\\x1b[A",
			})
		).toEqual({ name: "up" });
	});
});
