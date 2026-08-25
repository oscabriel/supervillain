/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-lane suite. */
/* oxlint-disable unicorn/escape-case, unicorn/no-hex-escape -- ANSI bytes are written \x1b throughout the protocol documents; another notation breaks greppability against them. */
/* oxlint-disable eslint/sort-keys -- strip rects keep the protocol's own x,y,w,h field order, as in map-kitty.ts. */
/* oxlint-disable promise/prefer-await-to-callbacks -- the Writable sink and bare timer are the capture harness; promisifying them hides what the renderer schedules (the experiment's own pattern). */
/**
 * The bitmap tier's placeholder paint, through the real renderer: the map
 * region spells U+10EEEE cells (fg = image ID, diacritics = row/column) into
 * OpenTUI's buffer via drawText, and those graphemes must survive to the
 * emitted frame bytes. This is the product-side half of the #134 experiment:
 * the emitter's bytes are covered in map-kitty.test.ts; here the cell grid
 * itself is the assertion surface.
 */
import { describe, expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";

import { CliRenderer } from "@opentui/core";
import type { BattleMap } from "@supervillain/core";

import { placeholderCell } from "../src/map-kitty-placeholder.js";
import type { Framebuffer, PlaceholderLayout } from "../src/map-kitty.js";
import { MapSurfaceRenderable } from "../src/map-region.js";
import type { MapSize } from "../src/map.js";

const CAVERN: BattleMap = {
	legend: { "#": "wall", "+": "door", ".": "floor", "^": "hazard" },
	name: "Cavern Mouth",
	rows: ["#####", "#...#", "#.^.#", "##+##"],
};

/** Mirrors OpenTUI's own custom-stdout test setup: frame bytes land here. */
class CollectingStdout extends Writable {
	readonly isTTY = true;
	readonly columns = 40;
	readonly rows = 12;
	readonly writes: Buffer[] = [];
	override _write(
		// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Writable's own _write contract passes unknown chunks; Buffer.isBuffer is the parse at this I/O boundary.
		chunk: unknown,
		_encoding: BufferEncoding,
		callback: (error?: Error | null) => void
	): void {
		this.writes.push(
			Buffer.isBuffer(chunk)
				? Buffer.from(chunk)
				: Buffer.from(chunk as Uint8Array)
		);
		callback();
	}
	bytes(): Buffer {
		return Buffer.concat(this.writes);
	}
}

const sleep = (ms: number): Promise<void> =>
	// oxlint-disable-next-line promise/avoid-new -- a bare timer drains the renderer's feed pipe into the collector.
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

const PLACEHOLDER_UTF8 = Buffer.from("\u{10EEEE}", "utf-8");

const countPlaceholders = (bytes: Buffer): number => {
	let count = 0;
	let at = bytes.indexOf(PLACEHOLDER_UTF8);
	while (at !== -1) {
		count += 1;
		at = bytes.indexOf(PLACEHOLDER_UTF8, at + PLACEHOLDER_UTF8.length);
	}
	return count;
};

interface BitmapPaint {
	bytes: Buffer;
	frames: Framebuffer[];
	grids: MapSize[];
}

/** Mounts an 8×6-cell bitmap map region and paints one frame through it. */
const paintBitmapRegion = async (
	layoutFor: (frame: Framebuffer, grid: MapSize) => PlaceholderLayout | null
): Promise<BitmapPaint> => {
	const stdout = new CollectingStdout();
	// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- OpenTUI's constructor wants a ReadStream; a PassThrough is the pinned clone's own test-stdin stand-in and has no nearer type.
	const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
	const renderer = new CliRenderer(stdin, stdout, 40, 12, {
		consoleMode: "disabled",
	});
	const surface = new MapSurfaceRenderable(
		renderer,
		{ height: 6, width: 8 },
		() => {
			// Clicks never happen in the paint harness.
		}
	);
	surface.position = "absolute";
	surface.x = 0;
	surface.y = 0;
	renderer.root.add(surface);
	const frames: Framebuffer[] = [];
	const grids: MapSize[] = [];
	surface.onBitmapFrame = (frame, grid) => {
		frames.push(frame);
		grids.push(grid);
		return layoutFor(frame, grid);
	};
	surface.update({
		cursor: null,
		map: CAVERN,
		mode: "bitmap",
		ownSeatId: null,
		selectedTokenId: null,
		tokens: [],
	});
	renderer.requestRender();
	await sleep(150);
	const bytes = stdout.bytes();
	await renderer.destroy();
	return { bytes, frames, grids };
};

describe("the bitmap map region's placeholder paint", () => {
	test("spells base and strip cells with grid- and strip-local diacritics", async () => {
		// 8×6 cells is two 4×3 tiles each way; the strip claims the
		// bottom-right tile.
		const { bytes, frames, grids } = await paintBitmapRegion(() => ({
			baseImageId: 3100,
			strip: { imageId: 3200, x: 4, y: 3, w: 4, h: 3 },
		}));
		// The hook received the rasterized frame and its cell grid.
		expect(grids).toEqual([{ height: 6, width: 8 }]);
		expect(frames[0]?.width).toBe(96);
		expect(frames[0]?.height).toBe(144);
		// Every cell of the grid is a placeholder, exactly once.
		expect(countPlaceholders(bytes)).toBe(48);
		// Base cells spell grid coordinates: row 0 reaches column 7 …
		expect(bytes.includes(Buffer.from(placeholderCell(0, 7), "utf-8"))).toBe(
			true
		);
		// … but the bottom-right grid corner belongs to the strip and is
		// spelled strip-locally, so its grid spelling never appears …
		expect(bytes.includes(Buffer.from(placeholderCell(5, 7), "utf-8"))).toBe(
			false
		);
		// … while the base's own bottom row still does, left of the strip.
		expect(bytes.includes(Buffer.from(placeholderCell(5, 3), "utf-8"))).toBe(
			true
		);
		// Foreground colors carry the image IDs: 3100 and 3200 big-endian.
		expect(bytes.includes(Buffer.from("\x1b[38;2;0;12;28m", "latin1"))).toBe(
			true
		);
		expect(bytes.includes(Buffer.from("\x1b[38;2;0;12;128m", "latin1"))).toBe(
			true
		);
	});

	test("a null layout paints no placeholders at all", async () => {
		const { bytes, frames } = await paintBitmapRegion(() => null);
		expect(frames).toHaveLength(1);
		expect(countPlaceholders(bytes)).toBe(0);
	});
});
