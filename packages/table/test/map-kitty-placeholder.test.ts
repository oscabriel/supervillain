/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-lane suite. */
import { describe, expect, test } from "bun:test";

import {
	imageIdRgb,
	PLACEHOLDER_GRID_LIMIT,
	placeholderCell,
	ROW_COLUMN_DIACRITICS,
} from "../src/map-kitty-placeholder.js";

describe("the rowcolumn diacritics table", () => {
	test("opens with the spec's own worked examples", () => {
		// The kitty spec's 2x2 example: U+0305 is 0, U+030D is 1, U+030E is 2.
		expect(ROW_COLUMN_DIACRITICS[0]).toBe(0x03_05);
		expect(ROW_COLUMN_DIACRITICS[1]).toBe(0x03_0d);
		expect(ROW_COLUMN_DIACRITICS[2]).toBe(0x03_0e);
	});

	test("carries kitty's full table, ending where the published file ends", () => {
		// rowcolumn-diacritics.txt: 297 entries, the last three being the
		// Greek musical triseme/tetraseme/pentaseme combining marks.
		expect(PLACEHOLDER_GRID_LIMIT).toBe(297);
		expect(ROW_COLUMN_DIACRITICS.at(-1)).toBe(0x01_d2_44);
		expect(ROW_COLUMN_DIACRITICS.at(-2)).toBe(0x01_d2_43);
		expect(ROW_COLUMN_DIACRITICS.at(-3)).toBe(0x01_d2_42);
	});
});

describe("placeholder cells", () => {
	test("spell the spec's 2x2 example exactly", () => {
		expect(placeholderCell(0, 0)).toBe("\u{10EEEE}\u0305\u0305");
		expect(placeholderCell(0, 1)).toBe("\u{10EEEE}\u0305\u030D");
		expect(placeholderCell(1, 0)).toBe("\u{10EEEE}\u030D\u0305");
		expect(placeholderCell(1, 1)).toBe("\u{10EEEE}\u030D\u030D");
	});

	test("reach the far corner of the table without falling off it", () => {
		const last = PLACEHOLDER_GRID_LIMIT - 1;
		expect(placeholderCell(last, last)).toBe("\u{10EEEE}\u{1D244}\u{1D244}");
	});
});

describe("image-ID foreground encoding", () => {
	test("packs the low 24 bits big-endian into r, g, b", () => {
		// The spec's example encodes ID 42 as color 42.
		expect(imageIdRgb(42)).toEqual([0, 0, 42]);
		expect(imageIdRgb(3100)).toEqual([0, 12, 28]);
		expect(imageIdRgb(0xab_cd_ef)).toEqual([0xab, 0xcd, 0xef]);
	});
});
