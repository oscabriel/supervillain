import { describe, expect, test } from "bun:test";
/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-lane suite. */
import { once } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";

import { CliRenderEvents, createCliRenderer } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { TestRendererSetup } from "@opentui/core/testing";
import type {
	BattleMap,
	Envelope,
	MapToken,
	RoomCommand,
	RoomStore,
	ViewEntry,
} from "@supervillain/core";
import type { Session, TerminalSize } from "@supervillain/session";

import { runChrome } from "../src/chrome.js";
import { MapSurfaceRenderable } from "../src/map-region.js";
import type { MapRegionState } from "../src/map-region.js";

const ACTOR = "gm-key";

const entry: ViewEntry<unknown, unknown, unknown> = {
	model: { apply: (state) => state, init: () => ({}) },
	view: { createPanels: () => [], renderEvent: () => null },
};

const HALL: BattleMap = {
	legend: { "#": "wall", "+": "door", ".": "floor", "^": "hazard" },
	name: "Hall",
	rows: ["#####", "#...#", "#.^.#", "##+##"],
};

const VIEWPORT_SOAK_MAP: BattleMap = {
	legend: { ".": "floor" },
	name: "Viewport Soak",
	rows: Array.from({ length: 100 }, () => ".".repeat(200)),
};

const envelope = (
	type: `${string}.${string}`,
	payload: unknown,
	seq: number
): Envelope => ({ actor: ACTOR, payload, seq, timestamp: "now", type });

const MAP_EVENTS: readonly Envelope[] = [
	envelope("core.seat-claimed", { seatId: "gm" }, 1),
	envelope("core.map-loaded", HALL, 2),
	envelope(
		"core.token-placed",
		{ glyph: "K", id: "token-1", label: "Kraan", seatId: "gm", x: 1, y: 1 },
		3
	),
];

interface StoreProbe {
	readonly store: RoomStore;
	readonly push: (next: Envelope) => void;
	readonly submitted: () => readonly RoomCommand[];
}

const fakeStore = (): StoreProbe => {
	const pending: Envelope[] = [];
	const submitted: RoomCommand[] = [];
	let wake: (() => void) | undefined;
	const pushed = (): Promise<void> =>
		// oxlint-disable-next-line promise/avoid-new -- a hand-rolled signal for the idle stream.
		new Promise<void>((resolve) => {
			wake = resolve;
		});
	const stream = async function* stream(): AsyncGenerator<Envelope> {
		for (;;) {
			const next = pending.shift();
			if (next === undefined) {
				// oxlint-disable-next-line eslint/no-await-in-loop -- the stream idles between envelopes.
				await pushed();
				continue;
			}
			yield next;
		}
	};
	return {
		push(next) {
			pending.push(next);
			wake?.();
			wake = undefined;
		},
		store: {
			stream: () => stream(),
			submit: (command) => {
				submitted.push(command);
				return Promise.resolve({ accepted: true, envelopes: [] });
			},
		},
		submitted: () => submitted,
	};
};

const fakeSession = (
	output: NodeJS.WriteStream,
	size: TerminalSize
): Session => ({
	actor: ACTOR,
	close() {
		// The tests tear the renderer down directly.
	},
	input: new PassThrough() as unknown as NodeJS.ReadStream,
	onClose: () => () => {
		// No close listener is exercised here.
	},
	onResize: () => () => {
		// No resize listener is exercised here.
	},
	output,
	size: () => size,
});

const mount = async (
	setup: TestRendererSetup,
	store: RoomStore
): Promise<{ readonly exited: Promise<void> }> => {
	const exited = runChrome({
		entry,
		gameId: "fake",
		renderer: setup.renderer,
		roomLabel: "the table",
		session: fakeSession({} as NodeJS.WriteStream, { columns: 60, rows: 24 }),
		store,
	});
	await setup.waitForFrame((frame) => frame.includes("the table"));
	// Wrapped: awaiting a bare promise here would adopt the table's whole life.
	return { exited };
};

describe("the chrome map region", () => {
	test("defaults to the pixel tier and t round-trips to text and back", async () => {
		const setup = await createTestRenderer({ height: 24, width: 60 });
		const store = fakeStore();
		const { exited } = await mount(setup, store.store);

		for (const next of MAP_EVENTS) {
			store.push(next);
		}
		// Pixel is the default (ADR-0007/0021): the title paints, the legend
		// characters do not — the grid is octant blocks, 4×3 cells per tile.
		const pixel = await setup.waitForFrame((text) =>
			text.includes("map · Hall")
		);
		expect(pixel).not.toContain("#####");

		// The toggle is a keystroke on the focused region, and the text tier is
		// ADR-0006's rendering unchanged: terrain reads as the author wrote it,
		// the token sits on top of it.
		await setup.waitForFrame((text) => text.includes("map: arrows/hjkl"));
		setup.mockInput.pressKey("t");
		const text = await setup.waitForFrame((frame) => frame.includes("#K..#"));
		expect(text).toContain("#K..#");
		expect(text).toContain("#.^.#");
		expect(text).toContain("##+##");

		// And back: the toggle round-trips within the session.
		setup.mockInput.pressKey("t");
		const again = await setup.waitForFrame((frame) => !frame.includes("#####"));
		expect(again).toContain("map · Hall");

		setup.renderer.destroy();
		await exited;
	});

	test("a click moves the cursor to the cell it landed on and nothing else", async () => {
		const setup = await createTestRenderer({ height: 24, width: 60 });
		const store = fakeStore();
		const { exited } = await mount(setup, store.store);
		for (const next of MAP_EVENTS) {
			store.push(next);
		}
		await setup.waitForFrame((text) => text.includes("map · Hall"));

		// Feed occupies the left 12 columns and the gutter is column 12, so the
		// Map grid starts at (14,2). In pixel mode a click at (24,7) is local
		// (10,5), which is tile 2,1 — a floor cell.
		setup.mockMouse.click(24, 7);
		await setup.waitForFrame((text) => text.includes("2,1 floor"));

		// Clicking never submits: the mouse reaches only what the keys reach.
		expect(store.submitted()).toEqual([]);

		setup.renderer.destroy();
		await exited;
	});

	test("no drag handler exists anywhere in the table's source", async () => {
		const source = path.join(import.meta.dir, "..", "src");
		const files = await readdir(source);
		const bodies = await Promise.all(
			files.map(
				async (file) => await readFile(path.join(source, file), "utf-8")
			)
		);
		for (const body of bodies) {
			expect(body).not.toContain("onMouseDrag");
			expect(body).not.toContain("onMouseDrop");
			expect(body).not.toContain("onMouseDragEnd");
		}
	});
});

/**
 * A renderer whose whole terminal *is* the map region, over an in-memory pipe
 * that records every byte written to it. This suite covers every map cell;
 * `chrome-renderer.test.ts` mounts the complementary non-map chrome, including
 * an overflowing feed whose OpenTUI scrollbar paints on the wire.
 */
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
			throw new Error("Renderer was destroyed before the expected frame.");
		}
	} finally {
		listeners.abort();
	}
};

const paintSurface = async (size?: {
	readonly width: number;
	readonly height: number;
}): Promise<{
	readonly bytes: () => string;
	readonly clear: () => void;
	readonly update: (state: MapRegionState) => Promise<void>;
	readonly stop: () => void;
}> => {
	// A real seat's terminal answers OpenTUI's capability query over its own
	// stdin; an in-memory pipe answers nothing, so the renderer would fall back
	// to literal RGB and the assertion would be about the harness rather than
	// about us. `remote: false` plus a 256-colour TERM stands in for a terminal
	// that says what it can do.
	const hadTerm = Object.hasOwn(process.env, "TERM");
	const originalTerm = process.env.TERM;
	const restoreTerm = (): void => {
		if (hadTerm && originalTerm !== undefined) {
			process.env.TERM = originalTerm;
			return;
		}
		delete process.env.TERM;
	};
	process.env.TERM = "xterm-256color";
	const dims = size ?? { height: 4, width: 5 };
	try {
		const chunks: string[] = [];
		const output = new PassThrough();
		output.on("data", (chunk: Buffer) => chunks.push(chunk.toString("latin1")));
		const renderer = await createCliRenderer({
			exitOnCtrlC: false,
			height: dims.height,
			remote: false,
			stdin: new PassThrough() as unknown as NodeJS.ReadStream,
			stdout: output as unknown as NodeJS.WriteStream,
			width: dims.width,
		});
		const surface = new MapSurfaceRenderable(
			renderer,
			{ height: dims.height, width: dims.width },
			() => {
				// Hit-testing has its own test; the wire tests never click.
			}
		);
		const mounted = nextFrame(renderer);
		renderer.root.add(surface);
		await mounted;
		chunks.length = 0;
		return {
			bytes: () => chunks.join(""),
			clear: () => {
				chunks.length = 0;
			},
			stop: () => {
				try {
					renderer.destroy();
				} finally {
					restoreTerm();
				}
			},
			update: async (state) => {
				const painted = nextFrame(renderer);
				surface.update(state);
				await painted;
			},
		};
	} catch (error) {
		restoreTerm();
		throw error;
	}
};

const kraan: MapToken = {
	glyph: "K",
	id: "token-1",
	label: "Kraan",
	seatId: "gm",
	x: 1,
	y: 1,
};

const surfaceState = (
	tokens: readonly MapToken[],
	mode: MapRegionState["mode"] = "text"
): MapRegionState => ({
	cursor: { x: 2, y: 2 },
	map: HALL,
	mode,
	ownSeatId: "gm",
	selectedTokenId: "token-1",
	tokens,
});

const CSI = `${String.fromCodePoint(27)}\\[`;
/** 24-bit SGR: `38;2;r;g;b` and `48;2;r;g;b`. Exactly what must never appear. */
const TRUECOLOR_SGR = new RegExp(`${CSI}[\\d;]*[34]8;2;`, "u");
/** Indexed SGR: `38;5;n` / `48;5;n`. The only color form the map may emit. */
const INDEXED_SGR = new RegExp(`${CSI}(?:38|48);5;(?<slot>\\d+)m`, "gu");
const FRAMEBUFFER_RANGE_MIN_BYTES = 100;
const FRAMEBUFFER_RANGE_MAX_BYTES = 2048;

describe("the map region on the wire", () => {
	test("restores the terminal capability environment after painting", async () => {
		const hadTerm = Object.hasOwn(process.env, "TERM");
		const originalTerm = process.env.TERM;
		const wire = await paintSurface();
		wire.stop();

		expect(Object.hasOwn(process.env, "TERM")).toBe(hadTerm);
		expect(process.env.TERM).toBe(originalTerm);
	});

	test("paints exact ANSI-16 and never a truecolor SGR escape", async () => {
		const wire = await paintSurface();
		try {
			await wire.update(surfaceState([kraan]));
			const bytes = wire.bytes();
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
			wire.stop();
		}
	});

	test("paints the pixel tier in exact ANSI-16 too (ADR-0021)", async () => {
		// Two whole 4×3 tiles across, two down — the smallest pixel window
		// that exercises tile seams on the wire.
		const wire = await paintSurface({ height: 6, width: 8 });
		try {
			await wire.update(surfaceState([kraan], "pixel"));
			const bytes = wire.bytes();
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
			wire.stop();
		}
	});

	test.each([
		{ height: 51, label: "156x51", width: 156 },
		{ height: 15, label: "48x15", width: 48 },
	])(
		"keeps a pixel-mode token move inside #38's 0.1–2 KB range at $label terminal cells",
		async ({ height, width }) => {
			const size = { height, width };
			const wire = await paintSurface(size);
			const token = { ...kraan, x: 10, y: 4 };
			const pixelState = (next: MapToken): MapRegionState => ({
				cursor: null,
				map: VIEWPORT_SOAK_MAP,
				mode: "pixel",
				ownSeatId: "gm",
				selectedTokenId: null,
				tokens: [next],
			});
			try {
				await wire.update(pixelState(token));
				wire.clear();
				await wire.update(pixelState({ ...token, x: token.x + 1 }));
				const moved = wire.bytes();
				expect(moved.length).toBeGreaterThanOrEqual(
					FRAMEBUFFER_RANGE_MIN_BYTES
				);
				expect(moved.length).toBeLessThanOrEqual(FRAMEBUFFER_RANGE_MAX_BYTES);
				expect(TRUECOLOR_SGR.test(moved)).toBe(false);
			} finally {
				wire.stop();
			}
		}
	);
});
