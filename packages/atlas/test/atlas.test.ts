/* oxlint-disable eslint/no-bitwise, oxc/bad-bitwise-operator, vitest/prefer-importing-vitest-globals -- Bun-lane suite; 1-bit glyph packing is bitmask arithmetic by nature. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
	CELL_PIXEL_HEIGHT,
	CELL_PIXEL_WIDTH,
	DINGS_ATLAS,
	GLYPH_HEIGHT,
	GLYPH_WIDTH,
	glyphRowBytes,
	OCTANT_CHARS,
	octantPattern,
	TEXT_ATLAS,
	TILE_COLUMNS,
	TILE_ROWS,
} from "../src/index.ts";

const OCTANT_PATTERN_COUNT = 256;
const HEX_ROW_PATTERN = /^[0-9a-f]{24}$/u;
const BLANK_ENTRY = "0".repeat(GLYPH_HEIGHT * 2);

describe("tile geometry (ADR-0021)", () => {
	test("one tile is 4x3 cells of 2x4 pixels — the full 8x12 glyph", () => {
		expect(TILE_COLUMNS).toBe(4);
		expect(TILE_ROWS).toBe(3);
		expect(TILE_COLUMNS * CELL_PIXEL_WIDTH).toBe(GLYPH_WIDTH);
		expect(TILE_ROWS * CELL_PIXEL_HEIGHT).toBe(GLYPH_HEIGHT);
	});
});

describe("octant table", () => {
	test("covers all 256 patterns with single characters", () => {
		expect(OCTANT_CHARS).toHaveLength(OCTANT_PATTERN_COUNT);
		for (const char of OCTANT_CHARS) {
			expect([...char]).toHaveLength(1);
		}
	});

	test("empty and full patterns are space and full block", () => {
		expect(OCTANT_CHARS[0]).toBe(" ");
		expect(OCTANT_CHARS[OCTANT_PATTERN_COUNT - 1]).toBe("\u2588");
	});

	test("is bijective: every pattern round-trips through its character", () => {
		const inverse = new Map<string, number>();
		for (const [pattern, char] of OCTANT_CHARS.entries()) {
			expect(inverse.has(char as string)).toBe(false);
			inverse.set(char as string, pattern);
		}
		expect(inverse.size).toBe(OCTANT_PATTERN_COUNT);
		for (let pattern = 0; pattern < OCTANT_PATTERN_COUNT; pattern += 1) {
			expect(inverse.get(OCTANT_CHARS[pattern] as string)).toBe(pattern);
		}
	});
});

describe("octant composition is lossless for 1-bit glyphs", () => {
	test("every atlas glyph survives encode/decode bit-identically", () => {
		const inverse = new Map<string, number>();
		for (const [pattern, char] of OCTANT_CHARS.entries()) {
			inverse.set(char as string, pattern);
		}
		for (const atlas of [TEXT_ATLAS, DINGS_ATLAS]) {
			for (const entry of Object.values(atlas)) {
				const rows = glyphRowBytes(entry);
				const decoded = new Uint8Array(GLYPH_HEIGHT);
				for (let cellRow = 0; cellRow < TILE_ROWS; cellRow += 1) {
					for (let cellCol = 0; cellCol < TILE_COLUMNS; cellCol += 1) {
						const pattern = octantPattern(rows, cellCol, cellRow);
						const roundTripped = inverse.get(
							OCTANT_CHARS[pattern] as string
						) as number;
						for (let dy = 0; dy < CELL_PIXEL_HEIGHT; dy += 1) {
							for (let dx = 0; dx < CELL_PIXEL_WIDTH; dx += 1) {
								const bit = (roundTripped >> (dy * CELL_PIXEL_WIDTH + dx)) & 1;
								const y = cellRow * CELL_PIXEL_HEIGHT + dy;
								const x = cellCol * CELL_PIXEL_WIDTH + dx;
								const current = decoded[y] as number;
								decoded[y] = current | (bit << (GLYPH_WIDTH - 1 - x));
							}
						}
					}
				}
				expect(decoded).toEqual(rows);
			}
		}
	});
});

describe("atlas data", () => {
	test("covers the full MEKMODE repertoire", () => {
		expect(Object.keys(TEXT_ATLAS)).toHaveLength(313);
		expect(Object.keys(DINGS_ATLAS)).toHaveLength(119);
	});

	test("every entry is keyed by one character and holds 12 hex row bytes", () => {
		for (const atlas of [TEXT_ATLAS, DINGS_ATLAS]) {
			for (const [key, entry] of Object.entries(atlas)) {
				expect([...key]).toHaveLength(1);
				expect(entry).toMatch(HEX_ROW_PATTERN);
			}
		}
	});

	test("space is blank in both modes", () => {
		expect(TEXT_ATLAS[" "]).toBe(BLANK_ENTRY);
		expect(DINGS_ATLAS[" "]).toBe(BLANK_ENTRY);
	});

	test("text and ding modes depict the same key differently", () => {
		expect(TEXT_ATLAS.A).toBeDefined();
		expect(DINGS_ATLAS.A).toBeDefined();
		expect(TEXT_ATLAS.A).not.toBe(DINGS_ATLAS.A);
	});

	test("no glyph is empty except space", () => {
		for (const atlas of [TEXT_ATLAS, DINGS_ATLAS]) {
			for (const [key, entry] of Object.entries(atlas)) {
				if (key !== " ") {
					expect(entry).not.toBe(BLANK_ENTRY);
				}
			}
		}
	});
});

describe("provenance headers (ADR-0011)", () => {
	const generatedDir = path.join(import.meta.dir, "..", "src", "generated");
	const requiredFields = [
		"work:",
		"version:",
		"author: MEK.txt",
		"license:",
		"sourceUrl:",
		"accessed:",
		"sourceSha256:",
	];

	test.each(["text.ts", "dings.ts"])(
		"%s carries the generated-data header",
		(file) => {
			const source = readFileSync(path.join(generatedDir, file), "utf-8");
			expect(source).toContain("GENERATED FILE");
			for (const field of requiredFields) {
				expect(source).toContain(field);
			}
		}
	);
});
