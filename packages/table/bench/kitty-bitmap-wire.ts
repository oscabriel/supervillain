/**
 * The bitmap tier's wire-cost harness (ADR-0012/NQ-10). The three shipped
 * numbers in `map-kitty.ts` — deflate level 3, 4096-byte transmit chunks, and
 * the ≤12-tile strip budget — are placeholders pending this measurement. All
 * byte counts here are deterministic (seeded terrain, fixed cell metrics, the
 * one true encoder), so headless runs decide everything that is arithmetic;
 * only link-latency judgment stays for the live ssh leg Oscar drives.
 *
 * Headless run:
 *
 *     bun packages/table/bench/kitty-bitmap-wire.ts
 *
 * Live ssh leg (after the headless run narrows the candidates):
 *
 *     ssh <host> 'bun …/kitty-bitmap-wire.ts'   # remote CPU on the same box
 *
 * then drive the product over a real ssh Door — `create` + `join`,
 * `/map load cavern`, pan and token-move while watching perceived latency —
 * with the two or three surviving level/chunk combinations. The results doc
 * in `.agents/benchmarks/` records both legs per its README pattern; until it
 * exists, the shipped numbers remain placeholders, not decisions.
 *
 * Sweeps:
 *
 * - Deflate level: full-base transmit bytes and median encode time at levels
 *   1–9 (through `transmitSequences` itself, so the measured encoder is the
 *   shipped one).
 * - Chunk size: wire bytes and sequence count at 1 KiB–64 KiB. Base64 length
 *   is invariant under chunking, so what moves is APC framing overhead and
 *   chunk count; how chunk count interacts with ssh packetization is a
 *   live-leg judgment, not measurable here.
 * - Strip budget: strip re-encode cost as a function of changed-tile count,
 *   against the full-base retransmit it avoids. The sweep computes what a
 *   strip *would* cost past MAX_STRIP_TILES — the surface's own policy caps
 *   at 12 — because the cap's job is to stop before strips stop paying.
 *   Changes are modeled as one compact rectangle of re-rendered tiles.
 */
import { deflateSync } from "node:zlib";

import type { BattleMap, MapToken } from "@supervillain/core";

import { tableMapRegionAvailable } from "../src/chrome.js";
import {
	FALLBACK_CELL_METRICS,
	KittyMapSurface,
	rasterizeCells,
	transmitSequences,
	virtualPlacementSequence,
} from "../src/map-kitty.js";
import {
	pixelViewportSize,
	TILE_COLUMNS,
	TILE_ROWS,
} from "../src/map-pixel.js";
import { mapRegionSize } from "../src/map-region.js";
import { composeMapCells } from "../src/map.js";
import type { MapComposition, MapSize } from "../src/map.js";

const IMAGE_ID = 3100;
const CHUNK_BYTES = 4096;
const DEFLATE_LEVEL = 3;
const SWEEP_LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
const SWEEP_CHUNKS = [1024, 2048, 4096, 8192, 16_384, 32_768, 65_536] as const;
const STRIP_TILE_COUNTS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96];
const ENCODE_RUNS = 15;

// A 200×100 representative dungeon: walled border, hazard and difficult
// patches, doors — the shape family of docs/examples/cavern.map at the pixel
// bench's scale. Seeded LCG so every byte count reproduces.
const MAP_COLUMNS = 200;
const MAP_ROWS = 100;

const lcg = (seed: number): (() => number) => {
	let state = seed % 2_147_483_647;
	if (state <= 0) {
		state += 2_147_483_646;
	}
	return () => {
		state = (state * 16_807) % 2_147_483_647;
		return (state - 1) / 2_147_483_646;
	};
};

const terrainMap = (): BattleMap => {
	const random = lcg(20_260_824);
	const rows: string[] = [];
	for (let y = 0; y < MAP_ROWS; y += 1) {
		let row = "";
		for (let x = 0; x < MAP_COLUMNS; x += 1) {
			const border =
				x === 0 || y === 0 || x === MAP_COLUMNS - 1 || y === MAP_ROWS - 1;
			if (border) {
				row += "#";
				continue;
			}
			const roll = random();
			if (roll < 0.72) {
				row += ".";
			} else if (roll < 0.84) {
				row += "^";
			} else if (roll < 0.94) {
				row += "~";
			} else {
				row += "+";
			}
		}
		rows.push(row);
	}
	return {
		legend: {
			"#": "wall",
			"+": "door",
			".": "floor",
			"^": "hazard",
			"~": "difficult",
		},
		name: "Bitmap wire benchmark",
		rows,
	};
};

const TOKENS: MapToken[] = [
	{ glyph: "K", id: "token-1", label: "Kraan", seatId: "gm", x: 10, y: 4 },
	{ glyph: "V", id: "token-2", label: "Vex", seatId: "gm", x: 40, y: 20 },
];

interface Viewport extends MapSize {
	originX: number;
	originY: number;
}

const composition = (map: BattleMap, viewport: Viewport): MapComposition => ({
	cursor: null,
	map,
	ownSeatId: "gm",
	selectedTokenId: null,
	tokens: TOKENS,
	viewport,
});

const byteLength = (sequences: readonly string[]): number =>
	sequences.reduce((total, sequence) => total + Buffer.byteLength(sequence), 0);

const medianMs = (encode: () => unknown): number => {
	const samples: number[] = [];
	for (let run = 0; run < ENCODE_RUNS + 2; run += 1) {
		const start = performance.now();
		encode();
		if (run >= 2) {
			samples.push(performance.now() - start);
		}
	}
	samples.sort((a, b) => a - b);
	return samples[Math.floor(samples.length / 2)] ?? 0;
};

/**
 * The map with every cell inside the tile rect flipped to hazard — a compact
 * changed region whose re-render costs what an update of exactly that many
 * tiles would ride as a strip.
 */
const mapWithChangedRect = (
	map: BattleMap,
	originX: number,
	originY: number,
	tilesWide: number,
	tilesHigh: number
): BattleMap => {
	const flipped = map.rows.map((row) => [...row]);
	for (let ty = 0; ty < tilesHigh; ty += 1) {
		for (let tx = 0; tx < tilesWide; tx += 1) {
			for (let cy = 0; cy < TILE_ROWS; cy += 1) {
				const rowChars = flipped[originY + (ty * TILE_ROWS + cy)];
				if (rowChars === undefined) {
					continue;
				}
				for (let cx = 0; cx < TILE_COLUMNS; cx += 1) {
					rowChars[originX + tx * TILE_COLUMNS + cx] = "^";
				}
			}
		}
	}
	return { ...map, rows: flipped.map((rowChars) => rowChars.join("")) };
};

interface LevelReading {
	readonly deflatedBytes: number;
	readonly encodeMs: number;
	readonly level: number;
	readonly rawBytes: number;
	readonly wireBytes: number;
}

interface ChunkReading {
	readonly chunkBytes: number;
	readonly framingOverheadBytes: number;
	readonly sequences: number;
	readonly wireBytes: number;
}

interface StripReading {
	readonly baseWireBytes: number;
	readonly changedTiles: number;
	readonly encodeMs: number;
	readonly ratio: number;
	readonly stripWireBytes: number;
}

interface TerminalResult {
	readonly baseWireBytes: number;
	/** Smallest modeled changed-tile count whose strip no longer beats a full retransmit. */
	readonly crossoverTiles: number | null;
	readonly chunks: readonly ChunkReading[];
	readonly gridCells: MapSize;
	readonly gridTiles: MapSize;
	readonly levels: readonly LevelReading[];
	readonly rawFrameBytes: number;
	readonly strips: readonly StripReading[];
	readonly terminal: MapSize;
}

const measureTerminal = (map: BattleMap, terminal: MapSize): TerminalResult => {
	const available = tableMapRegionAvailable(terminal);
	// Exactly #paintBitmap's chain: the region is a terminal-cell budget,
	// whole tiles only; the viewport fits whole map cells (one 4×3-cell tile
	// each) into it; the emitter's grid is the composed tile area in terminal
	// cells.
	const region = mapRegionSize(map, available, "bitmap");
	const viewport: Viewport = {
		originX: 0,
		originY: 0,
		...pixelViewportSize(region),
	};
	const grid: MapSize = {
		height: viewport.height * TILE_ROWS,
		width: viewport.width * TILE_COLUMNS,
	};
	const frame = rasterizeCells(
		composeMapCells(composition(map, viewport)),
		FALLBACK_CELL_METRICS
	);

	// Full-base cost through the real emitter: a fresh surface's first render
	// is exactly one transmit plus one virtual placement.
	let emitted = "";
	const surface = new KittyMapSurface((data) => {
		emitted += data;
	}, CHUNK_BYTES);
	surface.render(frame, grid);
	const baseWireBytes = byteLength([emitted]);

	const levels: LevelReading[] = SWEEP_LEVELS.map((level) => ({
		deflatedBytes: deflateSync(frame.pixels, { level }).length,
		encodeMs: Number(
			medianMs(() => deflateSync(frame.pixels, { level })).toFixed(3)
		),
		level,
		rawBytes: frame.pixels.length,
		wireBytes: byteLength(
			transmitSequences(IMAGE_ID, frame, CHUNK_BYTES, level)
		),
	}));

	const payloadBase64 = deflateSync(frame.pixels, {
		level: DEFLATE_LEVEL,
	}).toString("base64").length;
	const chunks: ChunkReading[] = SWEEP_CHUNKS.map((chunkBytes) => {
		const sequences = transmitSequences(
			IMAGE_ID,
			frame,
			chunkBytes,
			DEFLATE_LEVEL
		);
		const wireBytes = byteLength(sequences);
		return {
			chunkBytes,
			framingOverheadBytes: wireBytes - payloadBase64,
			sequences: sequences.length,
			wireBytes,
		};
	});

	const tilesWide = viewport.width;
	const tilesHigh = viewport.height;
	const pxPerCellX = frame.width / grid.width;
	const pxPerCellY = frame.height / grid.height;

	// Square-ish rects anchored near the map's center, clamped to the grid.
	// Counts collapse onto the same rect (3 and 4 tiles are both 2×2), so
	// dedupe by shape and report the shape's true tile count.
	const rectFor = (count: number) => {
		const wide = Math.min(tilesWide, Math.max(1, Math.ceil(Math.sqrt(count))));
		const high = Math.min(tilesHigh, Math.max(1, Math.ceil(count / wide)));
		return {
			firstTileX: Math.floor((tilesWide - wide) / 2),
			firstTileY: Math.floor((tilesHigh - high) / 2),
			high,
			wide,
		};
	};

	const rects = new Map(
		STRIP_TILE_COUNTS.filter((count) => count <= tilesWide * tilesHigh).map(
			(count) => {
				const rect = rectFor(count);
				return [`${rect.wide}x${rect.high}`, rect] as const;
			}
		)
	);
	const strips: StripReading[] = [...rects.values()]
		.toSorted((a, b) => a.wide * a.high - b.wide * b.high)
		.map(({ firstTileX, firstTileY, high, wide }) => {
			const nextFrame = rasterizeCells(
				composeMapCells(
					composition(
						mapWithChangedRect(
							map,
							viewport.originX + firstTileX * TILE_COLUMNS,
							viewport.originY + firstTileY * TILE_ROWS,
							wide,
							high
						),
						viewport
					)
				),
				FALLBACK_CELL_METRICS
			);
			const cut = nextFrame.cut(
				Math.round(firstTileX * TILE_COLUMNS * pxPerCellX),
				Math.round(firstTileY * TILE_ROWS * pxPerCellY),
				Math.round(wide * TILE_COLUMNS * pxPerCellX),
				Math.round(high * TILE_ROWS * pxPerCellY)
			);
			const encodeStrip = () =>
				byteLength([
					...transmitSequences(IMAGE_ID, cut, CHUNK_BYTES, DEFLATE_LEVEL),
					virtualPlacementSequence(
						IMAGE_ID,
						wide * TILE_COLUMNS,
						high * TILE_ROWS
					),
				]);
			const stripWireBytes = encodeStrip();
			return {
				baseWireBytes,
				changedTiles: wide * high,
				encodeMs: Number(medianMs(encodeStrip).toFixed(3)),
				ratio: Number((stripWireBytes / baseWireBytes).toFixed(3)),
				stripWireBytes,
			};
		});

	const crossing = strips.find((reading) => reading.ratio >= 1);

	return {
		baseWireBytes,
		chunks,
		crossoverTiles: crossing?.changedTiles ?? null,
		gridCells: grid,
		gridTiles: { height: tilesHigh, width: tilesWide },
		levels,
		rawFrameBytes: frame.pixels.length,
		strips,
		terminal,
	};
};

const hadTerm = Object.hasOwn(process.env, "TERM");
const originalTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
try {
	const map = terrainMap();
	const results: TerminalResult[] = [
		{ height: 60, width: 188 },
		{ height: 24, width: 80 },
	].map((terminal) => measureTerminal(map, terminal));
	process.stdout.write(
		`${JSON.stringify({ benchmark: "kitty-bitmap-wire", results }, null, 2)}\n`
	);
} finally {
	if (hadTerm && originalTerm !== undefined) {
		process.env.TERM = originalTerm;
	} else {
		delete process.env.TERM;
	}
}
