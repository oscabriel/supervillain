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
});
