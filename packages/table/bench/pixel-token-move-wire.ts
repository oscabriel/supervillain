import { once } from "node:events";
import { PassThrough } from "node:stream";

import { CliRenderEvents, createCliRenderer } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import type { BattleMap, MapToken } from "@supervillain/core";

import { tableMapRegionAvailable } from "../src/chrome.js";
import { MapSurfaceRenderable, mapRegionSize } from "../src/map-region.js";
import type { MapRegionState } from "../src/map-region.js";

const FRAMEBUFFER_RANGE_MIN_BYTES = 100;
const FRAMEBUFFER_RANGE_MAX_BYTES = 2048;
const CSI = `${String.fromCodePoint(27)}\\[`;
const TRUECOLOR_SGR = new RegExp(`${CSI}[\\d;]*[34]8;2;`, "u");
const INDEXED_SGR = new RegExp(`${CSI}(?:38|48);5;(?<slot>\\d+)m`, "gu");

const MAP: BattleMap = {
	legend: { ".": "floor" },
	name: "Pixel wire benchmark",
	rows: Array.from({ length: 100 }, () => ".".repeat(200)),
};

const TOKEN: MapToken = {
	glyph: "K",
	id: "token-1",
	label: "Kraan",
	seatId: "gm",
	x: 10,
	y: 4,
};

const nextFrame = async (renderer: CliRenderer): Promise<void> => {
	const listeners = new AbortController();
	try {
		const rendered = await Promise.race([
			once(renderer, CliRenderEvents.FRAME, { signal: listeners.signal }).then(
				() => true
			),
			once(renderer, CliRenderEvents.DESTROY, {
				signal: listeners.signal,
			}).then(() => false),
		]);
		if (!rendered) {
			throw new Error("renderer was destroyed before the expected frame");
		}
	} finally {
		listeners.abort();
	}
};

const state = (token: MapToken): MapRegionState => ({
	cursor: null,
	map: MAP,
	mode: "pixel",
	ownSeatId: "gm",
	selectedTokenId: null,
	tokens: [token],
});

interface Measurement {
	readonly terminal: { readonly width: number; readonly height: number };
	readonly region: { readonly width: number; readonly height: number };
	readonly viewport: {
		readonly width: number;
		readonly height: number;
		readonly originX: number;
		readonly originY: number;
	};
	readonly tokenMoveBytes: number;
}

const measure = async (terminal: {
	readonly width: number;
	readonly height: number;
}): Promise<Measurement> => {
	const chunks: Buffer[] = [];
	const output = new PassThrough();
	output.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
	const renderer = await createCliRenderer({
		exitOnCtrlC: false,
		height: terminal.height,
		remote: false,
		stdin: new PassThrough() as unknown as NodeJS.ReadStream,
		stdout: output as unknown as NodeJS.WriteStream,
		width: terminal.width,
	});
	try {
		const region = mapRegionSize(
			MAP,
			tableMapRegionAvailable(terminal),
			"pixel"
		);
		const surface = new MapSurfaceRenderable(renderer, region, () => {
			// The wire benchmark never clicks.
		});
		const mounted = nextFrame(renderer);
		renderer.root.add(surface);
		await mounted;
		chunks.length = 0;
		const initial = nextFrame(renderer);
		surface.update(state(TOKEN));
		await initial;
		chunks.length = 0;
		const moved = nextFrame(renderer);
		surface.update(state({ ...TOKEN, x: TOKEN.x + 1 }));
		await moved;
		const bytes = Buffer.concat(chunks);
		const wire = bytes.toString("latin1");
		if (TRUECOLOR_SGR.test(wire)) {
			throw new Error("pixel token move emitted a truecolor SGR escape");
		}
		const slots = [...wire.matchAll(INDEXED_SGR)].map((match) =>
			Number(match.groups?.slot)
		);
		if (slots.length === 0 || slots.some((slot) => slot >= 16)) {
			throw new Error(
				"pixel token move left the exact ANSI-16 indexed palette"
			);
		}
		if (
			bytes.length < FRAMEBUFFER_RANGE_MIN_BYTES ||
			bytes.length > FRAMEBUFFER_RANGE_MAX_BYTES
		) {
			throw new Error(
				`pixel token move cost ${bytes.length} bytes, outside #38's 0.1–2 KB range`
			);
		}
		return {
			region,
			terminal,
			tokenMoveBytes: bytes.length,
			viewport: surface.viewport,
		};
	} finally {
		renderer.destroy();
	}
};

const hadTerm = Object.hasOwn(process.env, "TERM");
const originalTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
try {
	const measurements = [
		await measure({ height: 60, width: 188 }),
		await measure({ height: 24, width: 80 }),
	];
	process.stdout.write(`${JSON.stringify({ measurements }, null, 2)}\n`);
} finally {
	if (hadTerm && originalTerm !== undefined) {
		process.env.TERM = originalTerm;
	} else {
		delete process.env.TERM;
	}
}
