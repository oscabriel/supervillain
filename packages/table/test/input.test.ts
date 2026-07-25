/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-lane suite. */
import { describe, expect, test } from "bun:test";

import { parseInput } from "../src/input.js";

describe("parseInput", () => {
	test("parses chat, roll, quit, unknown commands, and empty input", () => {
		expect(parseInput("  ")).toEqual({ kind: "empty" });
		expect(parseInput(" hello table ")).toEqual({
			kind: "chat",
			text: "hello table",
		});
		expect(parseInput("/roll 2d6+1")).toEqual({
			kind: "roll",
			notation: "2d6+1",
		});
		expect(parseInput(" /quit ")).toEqual({ kind: "quit" });
		expect(parseInput("/dance now")).toEqual({
			command: "/dance",
			kind: "unknown-command",
		});
	});

	test("parses the map verbs", () => {
		expect(parseInput("/map load cavern")).toEqual({
			kind: "load-map",
			name: "cavern",
		});
		expect(parseInput("/map clear")).toEqual({ kind: "clear-map" });
		expect(parseInput("/map")).toMatchObject({ kind: "usage" });
		expect(parseInput("/map load")).toMatchObject({ kind: "usage" });
	});

	test("parses the token verbs, with the seat binding last", () => {
		expect(parseInput("/token place @")).toEqual({
			glyph: "@",
			kind: "place-token",
			label: "",
			seatId: null,
		});
		expect(parseInput("/token place g Cave Goblin")).toEqual({
			glyph: "g",
			kind: "place-token",
			label: "Cave Goblin",
			seatId: null,
		});
		expect(parseInput("/token place @ Kraan @player-1")).toEqual({
			glyph: "@",
			kind: "place-token",
			label: "Kraan",
			seatId: "player-1",
		});
		expect(parseInput("/token glyph K")).toEqual({
			glyph: "K",
			kind: "reglyph-token",
		});
		expect(parseInput("/token remove")).toEqual({ kind: "remove-token" });
	});

	test("explains itself rather than guessing", () => {
		expect(parseInput("/token")).toMatchObject({ kind: "usage" });
		expect(parseInput("/token place")).toMatchObject({ kind: "usage" });
		expect(parseInput("/token place gg")).toMatchObject({ kind: "usage" });
		expect(parseInput("/token glyph KK")).toMatchObject({ kind: "usage" });
		expect(parseInput("/token wiggle")).toMatchObject({ kind: "usage" });
	});
});
