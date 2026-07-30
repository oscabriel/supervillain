/* oxlint-disable eslint/no-bitwise, vitest/prefer-importing-vitest-globals -- verifies OpenTUI's packed indexed-color metadata in the Bun lane. */
import { describe, expect, test } from "bun:test";

import { resolveTextAttributes, resolveThemeToken } from "../src/theme.js";

describe("resolveTextAttributes", () => {
	test("maps each named attribute to OpenTUI's exact bit", () => {
		// Independent literals from the pinned clone @ a0b9064 (types.ts):
		// BOLD 1, DIM 2, ITALIC 4, UNDERLINE 8, INVERSE 32. DESIGN.md's
		// "reverse" is OpenTUI's INVERSE.
		for (const [attr, bit] of [
			["bold", 1],
			["dim", 2],
			["italic", 4],
			["underline", 8],
			["reverse", 32],
		] as const) {
			expect(resolveTextAttributes([attr])).toBe(bit);
		}
	});

	test("combines attributes into one bitmask", () => {
		expect(resolveTextAttributes(["bold", "reverse"])).toBe(33);
	});

	test("an absent or empty list carries no attributes", () => {
		expect(resolveTextAttributes()).toBe(0);
		expect(resolveTextAttributes([])).toBe(0);
	});
});

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
