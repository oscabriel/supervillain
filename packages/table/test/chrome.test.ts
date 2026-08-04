/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-lane suite. */
import { describe, expect, test } from "bun:test";

import type { GamePanel, GamePanelInput } from "@supervillain/core";

import {
	adaptPanelKey,
	formatSeatList,
	forwardPanelKey,
	initialFeedLines,
	styledLine,
} from "../src/chrome.js";

describe("styledLine", () => {
	test("an attributed run's chunk carries the packed bitmask", () => {
		const line = styledLine({
			runs: [
				{ attrs: ["bold", "reverse"], text: "Aria", token: "accent" },
				{ text: " rolls", token: "primary" },
			],
		});
		// BOLD(1) | INVERSE(32) from the pinned clone @ a0b9064.
		expect(line.chunks[0]?.attributes).toBe(33);
		expect(line.chunks[0]?.text).toBe("Aria");
	});

	test("a plain run's chunk carries no attributes", () => {
		const line = styledLine({ runs: [{ text: "quiet", token: "muted" }] });
		expect(line.chunks[0]?.attributes).toBeUndefined();
	});
});

describe("table sidebar", () => {
	test("shows seats derived after a seat-claimed envelope", () => {
		expect(
			formatSeatList(
				{
					actor: "player-key",
					gmSeatId: "gm",
					seats: [
						{ actor: "gm-key", characterId: null, id: "gm" },
						{ actor: "player-key", characterId: null, id: "player-1" },
					],
				},
				"player-key"
			)
		).toBe("○ gm\n● player-1");
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
			focused: true,
			requestMessageTask: () => {},
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
