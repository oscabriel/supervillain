/* oxlint-disable eslint/no-bitwise, oxc/bad-bitwise-operator, vitest/prefer-importing-vitest-globals -- Bun-lane suite; decoding proves the 1-bit ornamental exercise lossless. */
import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { PassThrough } from "node:stream";

import { CliRenderEvents, createCliRenderer } from "@opentui/core";
import {
	GLYPH_HEIGHT,
	GLYPH_WIDTH,
	glyphRowBytes,
	OCTANT_CHARS,
	TEXT_ATLAS,
	TILE_COLUMNS,
	TILE_ROWS,
} from "@supervillain/atlas";

import {
	PIXEL_WORDMARK_COLUMNS,
	PIXEL_WORDMARK_ROWS,
	pixelWordmarkRows,
	wordmarkTierForWidth,
} from "../src/pixel-wordmark.js";
import { WORDMARK_SOURCE, WORDMARK_TEXT } from "../src/wordmark-data.js";

const decodeGlyph = (glyphIndex: number): Uint8Array => {
	const inverse = new Map<string, number>();
	for (const [pattern, glyph] of OCTANT_CHARS.entries()) {
		inverse.set(glyph as string, pattern);
	}
	const rows = new Uint8Array(GLYPH_HEIGHT);
	for (let cellRow = 0; cellRow < TILE_ROWS; cellRow += 1) {
		for (let cellColumn = 0; cellColumn < TILE_COLUMNS; cellColumn += 1) {
			const glyph =
				pixelWordmarkRows[cellRow]?.[glyphIndex * TILE_COLUMNS + cellColumn] ??
				" ";
			const pattern = inverse.get(glyph) ?? 0;
			for (let dy = 0; dy < GLYPH_HEIGHT / TILE_ROWS; dy += 1) {
				for (let dx = 0; dx < GLYPH_WIDTH / TILE_COLUMNS; dx += 1) {
					const bit = (pattern >> (dy * (GLYPH_WIDTH / TILE_COLUMNS) + dx)) & 1;
					const y = cellRow * (GLYPH_HEIGHT / TILE_ROWS) + dy;
					const x = cellColumn * (GLYPH_WIDTH / TILE_COLUMNS) + dx;
					rows[y] = (rows[y] ?? 0) | (bit << (GLYPH_WIDTH - 1 - x));
				}
			}
		}
	}
	return rows;
};

const CSI = `${String.fromCodePoint(27)}\\[`;
const TRUECOLOR_SGR = new RegExp(`${CSI}[\\d;]*[34]8;2;`, "u");
const INDEXED_SGR = new RegExp(`${CSI}(?:38|48);5;(?<slot>\\d+)m`, "gu");

describe("the ornamental wordmark", () => {
	test("is the pinned text source rendered losslessly through MEKMODE Text", () => {
		expect(WORDMARK_TEXT).toBe([...WORDMARK_SOURCE].join(" "));
		expect(pixelWordmarkRows).toHaveLength(PIXEL_WORDMARK_ROWS);
		for (const row of pixelWordmarkRows) {
			expect(row).toHaveLength(PIXEL_WORDMARK_COLUMNS);
		}
		for (const [index, glyph] of [...WORDMARK_SOURCE].entries()) {
			expect(decodeGlyph(index)).toEqual(
				glyphRowBytes(TEXT_ATLAS[glyph] as string)
			);
		}
	});

	test("uses pixel glyphs at 80 columns and real text when width cannot fit", () => {
		expect(wordmarkTierForWidth(80 - 2)).toBe("pixel");
		expect(wordmarkTierForWidth(PIXEL_WORDMARK_COLUMNS - 1)).toBe("text");
		expect(wordmarkTierForWidth(PIXEL_WORDMARK_COLUMNS)).toBe("pixel");
	});

	test("emits exact ANSI-16 and no truecolor SGR", async () => {
		const hadTerm = Object.hasOwn(process.env, "TERM");
		const originalTerm = process.env.TERM;
		process.env.TERM = "xterm-256color";
		const output = new PassThrough();
		const chunks: Buffer[] = [];
		output.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
		const renderer = await createCliRenderer({
			exitOnCtrlC: false,
			height: PIXEL_WORDMARK_ROWS,
			remote: false,
			stdin: new PassThrough() as unknown as NodeJS.ReadStream,
			stdout: output as unknown as NodeJS.WriteStream,
			width: PIXEL_WORDMARK_COLUMNS,
		});
		try {
			const frame = once(renderer, CliRenderEvents.FRAME);
			const { PixelWordmarkRenderable } =
				await import("../src/pixel-wordmark.js");
			renderer.root.add(new PixelWordmarkRenderable(renderer));
			await frame;
			const bytes = Buffer.concat(chunks).toString("latin1");
			expect(bytes.length).toBeGreaterThan(0);
			expect(TRUECOLOR_SGR.test(bytes)).toBe(false);
			const slots = [...bytes.matchAll(INDEXED_SGR)].map((match) =>
				Number(match.groups?.slot)
			);
			expect(slots.length).toBeGreaterThan(0);
			for (const slot of slots) {
				expect(slot).toBeLessThan(16);
			}
		} finally {
			renderer.destroy();
			if (hadTerm && originalTerm !== undefined) {
				process.env.TERM = originalTerm;
			} else {
				delete process.env.TERM;
			}
		}
	});
});
