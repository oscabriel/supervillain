/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-lane suite. */
/* oxlint-disable unicorn/escape-case, unicorn/no-hex-escape -- kitty APC bytes are written \x1b throughout gloomberb and the protocol documents; another notation breaks greppability against them. */
/* oxlint-disable eslint/no-control-regex -- matching APC framing requires control characters in the patterns. */
/* oxlint-disable eslint/sort-keys -- cell rects keep the protocol's own x,y,w,h field order everywhere. */
import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";

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
	subtractRect,
	transmitSequences,
} from "../src/map-kitty.js";
import type { CellRect } from "../src/map-kitty.js";
import type { MapCell } from "../src/map.js";

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

const area = (rect: CellRect): number => rect.w * rect.h;

/** Deterministic small-state PRNG, so property failures reproduce exactly. */
const lcg = (seed: number): (() => number) => {
	let state = seed;
	return () => {
		state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
		return state / 2_147_483_648;
	};
};

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
				index === sequences.length - 1
					? /^\x1b_Gm=0;/u
					: /^\x1b_Gm=1;/u
			);
		}
	});

	test("the chunk chain round-trips to the exact framebuffer bytes", () => {
		const frame = px(48, 24);
		const base64 = payloadsOf(transmitSequences(3, frame, 512)).join("");
		const inflated = inflateSync(Buffer.from(base64, "base64"));
		expect([...inflated]).toEqual([...frame.pixels]);
	});
});

describe("placement and deletion", () => {
	test("a placement saves, moves, places with crop, and restores", () => {
		expect(
			placementSequence(
				3100,
				42,
				{ x: 5, y: 7, w: 12, h: 9 },
				-1,
				{ x: 0, y: 36, w: 96, h: 72 }
			)
		).toBe(
			"\x1b[s\x1b[7;5H\x1b_Ga=p,i=3100,p=42,q=2,c=12,r=9,z=-1,C=1,x=0,y=36,w=96,h=72\x1b\\\x1b[u"
		);
	});

	test("deletion targets an image, or one placement of it", () => {
		expect(deleteImageSequence(3200)).toBe("\x1b_Ga=d,d=I,i=3200,q=2\x1b\\");
		expect(deleteImageSequence(3200, 51)).toBe(
			"\x1b_Ga=d,d=I,i=3200,p=51,q=2\x1b\\"
		);
	});
});

describe("rectangle subtraction", () => {
	test("no hole is the whole rect; a swallowing hole is empty", () => {
		const whole = { x: 2, y: 3, w: 10, h: 6 };
		expect(subtractRect(whole, null)).toEqual([whole]);
		expect(subtractRect(whole, { x: 0, y: 0, w: 30, h: 30 })).toEqual([]);
	});

	test("property: fragments plus hole tile the whole exactly", () => {
		const random = lcg(20_260_822);
		for (let trial = 0; trial < 500; trial += 1) {
			const whole = {
				x: Math.floor(random() * 20),
				y: Math.floor(random() * 20),
				w: 1 + Math.floor(random() * 30),
				h: 1 + Math.floor(random() * 30),
			};
			const hole = {
				x: whole.x + Math.floor(random() * whole.w),
				y: whole.y + Math.floor(random() * whole.h),
				w: Math.floor(random() * whole.w),
				h: Math.floor(random() * whole.h),
			};
			const fragments = subtractRect(whole, hole);
			// No overlap: the area sum equals the count of distinct covered cells.
			let covered = 0;
			const cells = new Set<string>();
			for (const fragment of [...fragments, hole]) {
				covered += area(fragment);
				for (let dy = 0; dy < fragment.h; dy += 1) {
					for (let dx = 0; dx < fragment.w; dx += 1) {
						cells.add(`${fragment.x + dx},${fragment.y + dy}`);
					}
				}
			}
			expect(covered).toBe(cells.size);
			// Full coverage: every cell of the whole is covered by exactly one piece.
			let wholeCells = 0;
			for (let dy = 0; dy < whole.h; dy += 1) {
				for (let dx = 0; dx < whole.w; dx += 1) {
					if (cells.has(`${whole.x + dx},${whole.y + dy}`)) {
						wholeCells += 1;
					}
				}
			}
			expect(wholeCells).toBe(area(whole));
			for (const fragment of fragments) {
				expect(fragment.x).toBeGreaterThanOrEqual(whole.x);
				expect(fragment.y).toBeGreaterThanOrEqual(whole.y);
				expect(fragment.x + fragment.w).toBeLessThanOrEqual(
					whole.x + whole.w
				);
				expect(fragment.y + fragment.h).toBeLessThanOrEqual(
					whole.y + whole.h
				);
			}
		}
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
	// Two tiles square.
	const MAP_RECT: CellRect = { x: 3, y: 4, w: 8, h: 6 };

	test("the first render transmits and places below text, deleting nothing", () => {
		const { surface, writes } = surfaceOn();
		surface.render(px(96, 72), MAP_RECT, null);
		const stream = emitted(writes);
		expect(stream).toContain("a=t,f=32,t=d,o=z,s=96,v=72,i=3100");
		expect(stream).toContain("z=-1,C=1");
		expect(stream).not.toContain("a=d");
	});
	test("an identical re-render emits nothing", () => {
		const { surface, writes } = surfaceOn();
		const frame = px(96, 72);
		surface.render(frame, MAP_RECT, null);
		writes.length = 0;
		surface.render(px(96, 72), MAP_RECT, null);
		expect(emitted(writes)).toBe("");
	});

	test("a small change rides a strip placed above the base", () => {
		const { surface, writes } = surfaceOn();
		surface.render(px(96, 72), MAP_RECT, null);
		const changed = px(96, 72);
		// Inside the first tile.
		changed.setPixel(10, 10, [255, 255, 255]);
		writes.length = 0;
		surface.render(changed, MAP_RECT, null);
		const stream = emitted(writes);
		// Strip slot A, above the base; no prior strip to retire yet.
		expect(stream).toContain("i=3200");
		expect(stream).toContain("z=1,C=1");
		expect(stream).not.toContain("a=d");
	});

	test("the next strip retires its predecessor, not the base", () => {
		const { surface, writes } = surfaceOn();
		surface.render(px(96, 72), MAP_RECT, null);
		const first = px(96, 72);
		first.setPixel(10, 10, [255, 255, 255]);
		surface.render(first, MAP_RECT, null);
		const second = px(96, 72);
		second.setPixel(10, 10, [0, 255, 0]);
		writes.length = 0;
		surface.render(second, MAP_RECT, null);
		const stream = emitted(writes);
		// Strip slot B replaces slot A; the base stays resident.
		expect(stream).toContain("i=3201");
		expect(stream).toContain("d=I,i=3200");
		expect(stream).not.toContain("d=I,i=3100");
	});

	test("a large change retransmits double-buffered and retires base plus strip", () => {
		const { surface, writes } = surfaceOn();
		// Six tiles square.
		const bigRect: CellRect = { x: 2, y: 2, w: 24, h: 18 };
		const bigFrame = (): Framebuffer => px(24 * 12, 18 * 24);
		surface.render(bigFrame(), bigRect, null);
		const first = bigFrame();
		// One tile: rides a strip.
		first.setPixel(10, 10, [255, 255, 255]);
		surface.render(first, bigRect, null);
		const second = bigFrame();
		// Touch eighteen of the thirty-six tiles: past the strip budget.
		for (let ty = 0; ty < 3; ty += 1) {
			for (let tx = 0; tx < 6; tx += 1) {
				second.setPixel(tx * 48 + 5, ty * 108 + 5, [255, 0, 0]);
			}
		}
		writes.length = 0;
		surface.render(second, bigRect, null);
		const stream = emitted(writes);
		// Full-size transmit into the other base slot; old base and stale strip retire.
		expect(stream).toContain("s=288,v=432");
		expect(stream).toContain("i=3101");
		expect(stream).toContain("d=I,i=3100");
		expect(stream).toContain("d=I,i=3200");
	});

	test("an occluder fragments the placement around its hole", () => {
		const { surface, writes } = surfaceOn();
		// The dialog lesson: occluded updates take the full path, whose
		// fragmenting handles the hole — strips would ignore it.
		const occluder: CellRect = { x: 6, y: 6, w: 3, h: 2 };
		surface.render(px(96, 72), MAP_RECT, occluder);
		const placements = emitted(writes).match(/c=\d+,r=\d+/gu) ?? [];
		expect(placements).toHaveLength(4);
		expect(emitted(writes)).not.toContain("z=1");
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
