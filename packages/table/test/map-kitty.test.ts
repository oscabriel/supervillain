/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-lane suite. */
/* oxlint-disable unicorn/escape-case, unicorn/no-hex-escape -- kitty APC bytes are written \x1b throughout gloomberb and the protocol documents; another notation breaks greppability against them. */
/* oxlint-disable eslint/no-control-regex -- matching APC framing requires control characters in the patterns. */
/* oxlint-disable eslint/sort-keys -- cell rects keep the protocol's own x,y,w,h field order everywhere. */
import { describe, expect, test } from "bun:test";
import { deflateSync, inflateSync } from "node:zlib";

import { PLACEHOLDER_GRID_LIMIT } from "../src/map-kitty-placeholder.js";
import {
	BITMAP_THEME_RGB,
	deleteImageSequence,
	FALLBACK_CELL_METRICS,
	Framebuffer,
	KittyMapSurface,
	parseProbeResponse,
	placementSequence,
	rasterizeCells,
	spanBounds,
	transmitSequences,
	virtualPlacementSequence,
} from "../src/map-kitty.js";
import type { MapCell, MapSize } from "../src/map.js";

const px = (w: number, h: number): Framebuffer => {
	const fb = new Framebuffer(w, h);
	for (let y = 0; y < h; y += 1) {
		for (let x = 0; x < w; x += 1) {
			fb.setPixel(x, y, [(x * 7) % 256, (y * 11) % 256, x * 3 + y]);
		}
	}
	return fb;
};

const payloadsOf = (sequences: readonly string[]): string[] =>
	sequences.map((sequence) => {
		const match = sequence.match(/^\x1b_G[^;]*;(?<payload>[\s\S]*)\x1b\\$/u);
		expect(match).not.toBeNull();
		return match?.groups?.payload ?? "";
	});

interface CapturingSurface {
	surface: KittyMapSurface;
	writes: string[];
}

const surfaceOn = (): CapturingSurface => {
	const writes: string[] = [];
	const surface = new KittyMapSurface((data) => writes.push(data));
	return { surface, writes };
};

const emitted = (writes: readonly string[]): string => writes.join("");

describe("transmit framing", () => {
	test("a lone chunk ends with m=0 — never a dangling m=1", () => {
		const sequences = transmitSequences(9, px(4, 4), 4096);
		expect(sequences).toHaveLength(1);
		expect(sequences[0]).toContain("m=0");
		expect(sequences[0]).toMatch(
			/^\x1b_Ga=t,f=32,t=d,o=z,s=4,v=4,i=9,q=2,m=0;[\s\S]*\x1b\\$/u
		);
	});

	test("multi-chunk chains mark every continuation but the last", () => {
		const sequences = transmitSequences(5, px(64, 64), 256);
		expect(sequences.length).toBeGreaterThan(1);
		expect(sequences[0]).toContain("m=1");
		for (const [index, sequence] of sequences.entries()) {
			if (index === 0) {
				continue;
			}
			expect(sequence).toMatch(
				index === sequences.length - 1 ? /^\x1b_Gm=0;/u : /^\x1b_Gm=1;/u
			);
		}
	});

	test("the chunk chain round-trips to the exact framebuffer bytes", () => {
		const frame = px(48, 24);
		const base64 = payloadsOf(transmitSequences(3, frame, 512)).join("");
		const inflated = inflateSync(Buffer.from(base64, "base64"));
		expect([...inflated]).toEqual([...frame.pixels]);
	});

	test("the caller picks the deflate level; the shipped default stays 6", () => {
		// The benchmarks run (ADR-0012/NQ-10) measured the sweep headlessly
		// (2026-08-24: level 6 halves full-base wire for +3 ms of host CPU);
		// the default must not drift from the results doc's pick.
		const frame = px(48, 24);
		expect(payloadsOf(transmitSequences(7, frame)).join("")).toBe(
			deflateSync(frame.pixels, { level: 6 }).toString("base64")
		);
		expect(payloadsOf(transmitSequences(7, frame, 4096, 9)).join("")).toBe(
			deflateSync(frame.pixels, { level: 9 }).toString("base64")
		);
	});
});

describe("placement and deletion", () => {
	test("a placement saves, moves, places with crop, and restores", () => {
		expect(
			placementSequence(3100, 42, { x: 5, y: 7, w: 12, h: 9 }, -1, {
				x: 0,
				y: 36,
				w: 96,
				h: 72,
			})
		).toBe(
			"\x1b[s\x1b[7;5H\x1b_Ga=p,i=3100,p=42,q=2,c=12,r=9,z=-1,C=1,x=0,y=36,w=96,h=72\x1b\\\x1b[u"
		);
	});

	test("a virtual placement pins the grid without touching the cursor", () => {
		// U=1: shown by placeholder cells, so no save/move/restore wrapper.
		expect(virtualPlacementSequence(3100, 48, 15)).toBe(
			"\x1b_Ga=p,U=1,i=3100,c=48,r=15,q=2\x1b\\"
		);
	});

	test("deletion targets an image, or one placement of it", () => {
		expect(deleteImageSequence(3200)).toBe("\x1b_Ga=d,d=I,i=3200,q=2\x1b\\");
		expect(deleteImageSequence(3200, 51)).toBe(
			"\x1b_Ga=d,d=I,i=3200,p=51,q=2\x1b\\"
		);
	});
});

describe("probe response parsing", () => {
	test("an APC graphics reply confirms support", () => {
		const reply = "\x1b_Gi=31;OK\x1b\\\x1b[?62;c";
		expect(parseProbeResponse(reply)).toEqual({
			graphicsSupported: true,
			cellPx: null,
		});
	});

	test("DA1 advertising _G confirms support without an APC reply", () => {
		expect(parseProbeResponse("\x1b[?62;_Gc")).toEqual({
			graphicsSupported: true,
			cellPx: null,
		});
	});

	test("plain DA1 alone is a definitive no", () => {
		expect(parseProbeResponse("\x1b[?61;c")).toEqual({
			graphicsSupported: false,
			cellPx: null,
		});
	});

	test("cell-size reports parse as height-then-width", () => {
		expect(parseProbeResponse("\x1b[6;30;16t")).toEqual({
			graphicsSupported: false,
			cellPx: { height: 30, width: 16 },
		});
	});

	test("a real combined stream parses both signals", () => {
		const stream = "\x1b_Gi=31;OK\x1b\\\x1b[?62;c\x1b[6;30;16t";
		const reading = parseProbeResponse(stream);
		expect(reading.graphicsSupported).toBe(true);
		expect(reading.cellPx).toEqual({ height: 30, width: 16 });
	});
});

describe("span bounds and rasterization", () => {
	test("spans partition their extent exactly, even non-integrally", () => {
		for (const extent of [72, 90, 75, 61]) {
			const bounds = Array.from({ length: 12 }, (_, gy) =>
				spanBounds(gy, 12, extent)
			);
			expect(bounds[0]?.[0]).toBe(0);
			expect(bounds[11]?.[1]).toBe(extent);
			for (const [index, pair] of bounds.entries()) {
				const [start, end] = pair;
				expect(end).toBeGreaterThan(start);
				if (index > 0) {
					expect(start).toBe(bounds[index - 1]?.[1]);
				}
			}
		}
	});

	const CELL: MapCell = { bg: "muted", fg: "primary", glyph: "#" };

	test("a composed cell fills its tile opaquely; a missing cell stays transparent", () => {
		const rows = [[CELL, null]];
		const fb = rasterizeCells(rows, FALLBACK_CELL_METRICS);
		expect(fb.width).toBe(2 * 4 * FALLBACK_CELL_METRICS.width);
		expect(fb.height).toBe(1 * 3 * FALLBACK_CELL_METRICS.height);
		// Inside the first tile: opaque everywhere.
		for (let y = 0; y < fb.height; y += 1) {
			for (let x = 0; x < 4 * FALLBACK_CELL_METRICS.width; x += 1) {
				expect(fb.alphaAt(x, y)).toBe(255);
			}
		}
		// Inside the second: untouched by anything.
		for (let y = 0; y < fb.height; y += 1) {
			for (let x = 4 * FALLBACK_CELL_METRICS.width; x < fb.width; x += 1) {
				expect(fb.alphaAt(x, y)).toBe(0);
			}
		}
	});

	test("glyph pixels carry the cell's foreground color over the shaded background", () => {
		const rows = [[{ bg: "primary", fg: "muted", glyph: "#" }]];
		const fb = rasterizeCells(rows, FALLBACK_CELL_METRICS);
		const colors = new Set<string>();
		for (let y = 0; y < fb.height; y += 1) {
			for (let x = 0; x < fb.width; x += 1) {
				colors.add(fb.getPixel(x, y).join(","));
			}
		}
		expect(colors.has(BITMAP_THEME_RGB.primary.join(","))).toBe(true);
		// Shading plus glyph at minimum.
		expect(colors.size).toBeGreaterThanOrEqual(2);
	});
});

describe("the kitty map surface", () => {
	// Two tiles square: 8×6 cells over a 96×72 px frame (12×12 px per cell
	// — the surface derives scale from frame÷grid, never from metrics).
	const GRID: MapSize = { width: 8, height: 6 };

	test("the first render transmits, places virtually, and deletes nothing", () => {
		const { surface, writes } = surfaceOn();
		const layout = surface.render(px(96, 72), GRID);
		const stream = emitted(writes);
		expect(stream).toContain("a=t,f=32,t=d,o=z,s=96,v=72,i=3100");
		expect(stream).toContain("a=p,U=1,i=3100,c=8,r=6,q=2");
		// Placeholders carry position; nothing addresses the cursor.
		expect(stream).not.toContain("\x1b[s");
		expect(stream).not.toContain("a=d");
		expect(layout).toEqual({ baseImageId: 3100, strip: null });
	});

	test("an identical re-render emits nothing and keeps the layout", () => {
		const { surface, writes } = surfaceOn();
		surface.render(px(96, 72), GRID);
		writes.length = 0;
		const layout = surface.render(px(96, 72), GRID);
		expect(emitted(writes)).toBe("");
		expect(layout).toEqual({ baseImageId: 3100, strip: null });
	});

	test("a small change rides a strip image with its own virtual placement", () => {
		const { surface, writes } = surfaceOn();
		surface.render(px(96, 72), GRID);
		const changed = px(96, 72);
		// Inside the first tile.
		changed.setPixel(10, 10, [255, 255, 255]);
		writes.length = 0;
		const layout = surface.render(changed, GRID);
		const stream = emitted(writes);
		// Strip slot A: one 4×3-cell tile, 48×36 px; nothing retires yet.
		expect(stream).toContain("a=t,f=32,t=d,o=z,s=48,v=36,i=3200");
		expect(stream).toContain("a=p,U=1,i=3200,c=4,r=3,q=2");
		expect(stream).not.toContain("a=d");
		expect(layout).toEqual({
			baseImageId: 3100,
			strip: { imageId: 3200, x: 0, y: 0, w: 4, h: 3 },
		});
	});

	test("a replaced strip retires on the next render, never in its own", () => {
		const { surface, writes } = surfaceOn();
		surface.render(px(96, 72), GRID);
		const first = px(96, 72);
		first.setPixel(10, 10, [255, 255, 255]);
		surface.render(first, GRID);
		const second = px(96, 72);
		second.setPixel(10, 10, [0, 255, 0]);
		writes.length = 0;
		const layout = surface.render(second, GRID);
		// Strip slot B replaces slot A, but cells still reference A until the
		// flip frame flushes — A's deletion is deferred, not written here.
		expect(emitted(writes)).toContain("i=3201");
		expect(emitted(writes)).not.toContain("a=d");
		expect(layout?.strip?.imageId).toBe(3201);
		// The following render — even an idle one — writes exactly that delete.
		writes.length = 0;
		surface.render(second, GRID);
		expect(emitted(writes)).toBe("\x1b_Ga=d,d=I,i=3200,q=2\x1b\\");
	});

	test("a large change flips the double-buffered base and defers retirement", () => {
		const { surface, writes } = surfaceOn();
		// Six tiles square: 24×18 cells.
		const bigGrid: MapSize = { width: 24, height: 18 };
		const bigFrame = (): Framebuffer => px(24 * 12, 18 * 24);
		surface.render(bigFrame(), bigGrid);
		const first = bigFrame();
		// One tile: rides a strip.
		first.setPixel(10, 10, [255, 255, 255]);
		surface.render(first, bigGrid);
		const second = bigFrame();
		// Touch eighteen of the thirty-six tiles: past the strip budget.
		for (let ty = 0; ty < 3; ty += 1) {
			for (let tx = 0; tx < 6; tx += 1) {
				second.setPixel(tx * 48 + 5, ty * 108 + 5, [255, 0, 0]);
			}
		}
		writes.length = 0;
		const layout = surface.render(second, bigGrid);
		const stream = emitted(writes);
		// Full-size transmit into the other base slot; the old base and the
		// stale strip stay resident until the flip frame has flushed.
		expect(stream).toContain("s=288,v=432");
		expect(stream).toContain("a=p,U=1,i=3101,c=24,r=18,q=2");
		expect(stream).not.toContain("a=d");
		expect(layout).toEqual({ baseImageId: 3101, strip: null });
		// The next render retires both.
		writes.length = 0;
		surface.render(second, bigGrid);
		const retirements = emitted(writes);
		expect(retirements).toContain("d=I,i=3100");
		expect(retirements).toContain("d=I,i=3200");
		expect(retirements).not.toContain("a=t");
	});

	test("a grid beyond the diacritic range refuses instead of aliasing", () => {
		const { surface, writes } = surfaceOn();
		const layout = surface.render(px(8, 8), {
			width: PLACEHOLDER_GRID_LIMIT + 1,
			height: 2,
		});
		expect(layout).toBeNull();
		expect(emitted(writes)).toBe("");
	});

	test("outgrowing the diacritic range frees resident images", () => {
		const { surface, writes } = surfaceOn();
		surface.render(px(96, 72), GRID);
		writes.length = 0;
		// A resize past the range: the cells blank (null layout), so nothing
		// references the images — leave none resident on the terminal.
		const layout = surface.render(px(8, 8), {
			width: PLACEHOLDER_GRID_LIMIT + 1,
			height: 2,
		});
		expect(layout).toBeNull();
		expect(emitted(writes)).toContain("d=I,i=3100");
		expect(emitted(writes)).not.toContain("a=t");
		// Shrinking back retransmits from scratch.
		writes.length = 0;
		expect(surface.render(px(96, 72), GRID)).toEqual({
			baseImageId: 3100,
			strip: null,
		});
		expect(emitted(writes)).toContain("a=t,f=32,t=d,o=z,s=96,v=72,i=3100");
	});

	test("clear frees both slots of both layers", () => {
		const { surface, writes } = surfaceOn();
		surface.clear();
		const stream = emitted(writes);
		for (const id of [3100, 3101, 3200, 3201]) {
			expect(stream).toContain(`d=I,i=${id}`);
		}
	});
});
