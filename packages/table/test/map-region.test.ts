import { describe, expect, test } from "bun:test";
/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-lane suite. */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";

import { createCliRenderer } from "@opentui/core";
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

const tick = (): Promise<void> =>
	// oxlint-disable-next-line promise/avoid-new -- a bare timer needs the constructor.
	new Promise<void>((resolve) => {
		setTimeout(resolve, 25);
	});

/** Lets the fold's stream, the replay window, and the render queue all drain. */
const settle = async (): Promise<void> => {
	for (let pass = 0; pass < 20; pass += 1) {
		// oxlint-disable-next-line eslint/no-await-in-loop -- draining is sequential by nature.
		await tick();
	}
};

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
	test("draws the folded map as one cell grid with its tokens over it", async () => {
		const setup = await createTestRenderer({ height: 24, width: 60 });
		const store = fakeStore();
		const { exited } = await mount(setup, store.store);

		for (const next of MAP_EVENTS) {
			store.push(next);
		}
		await settle();
		await setup.flush();
		const frame = setup.captureCharFrame();

		expect(frame).toContain("map · Hall 5×4");
		// Terrain reads as the author wrote it; the token sits on top of it.
		expect(frame).toContain("#K..#");
		expect(frame).toContain("#.^.#");
		expect(frame).toContain("##+##");

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
		await setup.waitForFrame((text) => text.includes("#####"));

		// Row 0 of the chrome is the header, row 1 the map title, so the grid
		// starts at row 2 — a click on its third cell is 2,2 in map cells.
		setup.mockMouse.click(2, 4);
		await setup.waitForFrame((text) => text.includes("2,2 hazard"));

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
 * that records every byte written to it. Isolating the surface is the point:
 * the claim under test is about the colors the map region puts on the wire, not
 * about the defaults OpenTUI's own widgets paint elsewhere in the chrome.
 */
const paintSurface = async (): Promise<{
	readonly bytes: () => string;
	readonly clear: () => void;
	readonly update: (state: MapRegionState) => void;
	readonly stop: () => void;
}> => {
	// A real seat's terminal answers OpenTUI's capability query over its own
	// stdin; an in-memory pipe answers nothing, so the renderer would fall back
	// to literal RGB and the assertion would be about the harness rather than
	// about us. `remote: false` plus a 256-colour TERM stands in for a terminal
	// that says what it can do.
	process.env.TERM = "xterm-256color";
	const chunks: string[] = [];
	const output = new PassThrough();
	output.on("data", (chunk: Buffer) => chunks.push(chunk.toString("latin1")));
	const renderer = await createCliRenderer({
		exitOnCtrlC: false,
		height: 4,
		remote: false,
		stdin: new PassThrough() as unknown as NodeJS.ReadStream,
		stdout: output as unknown as NodeJS.WriteStream,
		width: 5,
	});
	const surface = new MapSurfaceRenderable(
		renderer,
		{ height: 4, width: 5 },
		() => {
			// Hit-testing has its own test; the wire tests never click.
		}
	);
	renderer.root.add(surface);
	return {
		bytes: () => chunks.join(""),
		clear: () => {
			chunks.length = 0;
		},
		stop: () => renderer.destroy(),
		update: (state) => surface.update(state),
	};
};

const kraan: MapToken = {
	glyph: "K",
	id: "token-1",
	label: "Kraan",
	seatId: "gm",
	x: 1,
	y: 1,
};

const surfaceState = (tokens: readonly MapToken[]): MapRegionState => ({
	cursor: { x: 2, y: 2 },
	map: HALL,
	ownSeatId: "gm",
	selectedTokenId: "token-1",
	tokens,
});

const CSI = `${String.fromCodePoint(27)}\\[`;
/** 24-bit SGR: `38;2;r;g;b` and `48;2;r;g;b`. Exactly what must never appear. */
const TRUECOLOR_SGR = new RegExp(`${CSI}[\\d;]*[34]8;2;`, "u");
/** Indexed SGR: `38;5;n` / `48;5;n`. The only color form the map may emit. */
const INDEXED_SGR = new RegExp(`${CSI}(?:38|48);5;(?<slot>\\d+)m`, "gu");

describe("the map region on the wire", () => {
	test("paints exact ANSI-16 and never a truecolor SGR escape", async () => {
		const wire = await paintSurface();
		try {
			wire.update(surfaceState([kraan]));
			await settle();
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

	test("costs a token move far less than #38's 2 KB ceiling", async () => {
		const wire = await paintSurface();
		try {
			wire.update(surfaceState([kraan]));
			await settle();
			wire.clear();
			wire.update(surfaceState([{ ...kraan, x: 3, y: 2 }]));
			await settle();
			const moved = wire.bytes();
			expect(moved.length).toBeGreaterThan(0);
			expect(moved.length).toBeLessThan(2048);
			expect(TRUECOLOR_SGR.test(moved)).toBe(false);
		} finally {
			wire.stop();
		}
	});
});
