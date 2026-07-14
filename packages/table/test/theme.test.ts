/* oxlint-disable eslint/no-bitwise, vitest/prefer-importing-vitest-globals -- verifies OpenTUI's packed indexed-color metadata in the Bun lane. */
import { describe, expect, test } from "bun:test";

import { resolveThemeToken } from "../src/theme.js";

describe("resolveThemeToken", () => {
	test("uses exact ANSI-16 indexed palette slots", () => {
		for (const [token, index] of [
			["primary", 7],
			["muted", 8],
			["accent", 6],
			["success", 2],
			["danger", 1],
		] as const) {
			const color = resolveThemeToken(token);
			expect(color.buffer[0] >> 8).toBe(index);
			expect(color.buffer[1] >> 8).toBe(1);
		}
	});
});
