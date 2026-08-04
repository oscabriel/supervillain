/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-lane suite. */
import { describe, expect, test } from "bun:test";

import type { GamePanel, GamePanelInput } from "@supervillain/core";

import {
	adaptPanelKey,
	formatPanelTabs,
	formatSeatList,
	forwardPanelKey,
	initialFeedLines,
	nextPanelIndex,
	panelTabAtColumn,
	styledLine,
} from "../src/chrome.js";
import {
	formatFeedRail,
	formatSidebarRail,
	resolveTableFit,
	TABLE_DEMOTION_STAGES,
} from "../src/rails.js";

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

describe("table Rails and demotion", () => {
	test("formats the three-cell Feed summary and caps visible activity", () => {
		expect(formatFeedRail(0, 5)).toEqual(["[+]"]);
		expect(formatFeedRail(1, 5)).toEqual(["[+]", " ● ", "1"]);
		expect(formatFeedRail(100, 5)).toEqual(["[+]", " ● ", "99+"]);
	});

	test("formats claimed Seats, optional Spectators, and height overflow", () => {
		const seats = [
			{ actor: "a" },
			{ actor: null },
			{ actor: "c" },
			{ actor: "d" },
		];
		expect(formatSidebarRail(seats, 8, 3)).toEqual([
			"[+]",
			" ● ",
			" ○ ",
			" ● ",
			" ● ",
			"+3",
		]);
		expect(formatSidebarRail(seats, 5, 2)).toEqual([
			"[+]",
			" ● ",
			" ○ ",
			"+2",
			"+2",
		]);
	});

	test("applies preset forced-Rail order without changing explicit prefs", () => {
		const mapFirst = resolveTableFit({ height: 24, width: 59 }, "map-focused");
		expect(mapFirst).toMatchObject({
			feedRail: true,
			forcedFeedRail: true,
			forcedSidebarRail: false,
			sidebarRail: false,
		});
		const mapSecond = resolveTableFit({ height: 24, width: 52 }, "map-focused");
		expect(mapSecond).toMatchObject({
			forcedFeedRail: true,
			forcedSidebarRail: true,
		});
		for (const layout of ["feed-focused", "no-map"] as const) {
			const fit = resolveTableFit({ height: 24, width: 40 }, layout);
			expect(fit.forcedFeedRail).toBe(false);
			expect(fit.forcedSidebarRail).toBe(true);
			expect(fit.feedRail).toBe(false);
		}
	});

	test("restores forced Rails on grow and fails no-map honestly", () => {
		const explicit = { feedRail: false, sidebarRail: false };
		expect(
			resolveTableFit({ height: 24, width: 52 }, "map-focused", explicit)
		).toMatchObject({ feedRail: true, sidebarRail: true });
		expect(
			resolveTableFit({ height: 24, width: 80 }, "map-focused", explicit)
		).toMatchObject({
			feedRail: false,
			forcedFeedRail: false,
			forcedSidebarRail: false,
			sidebarRail: false,
			tooSmall: false,
		});
		expect(
			resolveTableFit({ height: 24, width: 17 }, "no-map", explicit)
		).toMatchObject({ feedRail: false, sidebarRail: true, tooSmall: true });
	});

	test("keeps all six named ladder stages in one ordered engine", () => {
		expect(TABLE_DEMOTION_STAGES.map((stage) => stage.id)).toEqual([
			"compact-keybar",
			"compact-sidebar-rows",
			"readable-pane-minima",
			"preset-forced-rails",
			"map-viewport-floor",
			"terminal-too-small",
		]);
		expect(
			TABLE_DEMOTION_STAGES.find((stage) => stage.id === "compact-sidebar-rows")
				?.implemented
		).toBe(false);
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

	test("formats and hit-tests module tabs in declaration order", () => {
		const panels = [{ id: "initiative" }, { id: "sheet" }];
		expect(formatPanelTabs(panels, 0)).toBe("[initiative]  sheet");
		expect(formatPanelTabs(panels, 1)).toBe("initiative  [sheet]");
		expect(panelTabAtColumn(panels, 0, 2)).toBe(0);
		expect(panelTabAtColumn(panels, 0, 12)).toBeNull();
		expect(panelTabAtColumn(panels, 0, 15)).toBe(1);
	});

	test("wraps tab traversal and handles one or zero Panels", () => {
		expect(nextPanelIndex(0, 2, -1)).toBe(1);
		expect(nextPanelIndex(1, 2, 1)).toBe(0);
		expect(nextPanelIndex(0, 1, 1)).toBe(0);
		expect(nextPanelIndex(-1, 0, 1)).toBe(-1);
		expect(formatPanelTabs([], -1)).toBe("");
		expect(formatPanelTabs([{ id: "only" }], 0)).toBe("[only]");
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
