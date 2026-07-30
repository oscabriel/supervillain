import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { PassThrough } from "node:stream";

/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-lane suite. */
import {
	CliRenderEvents,
	createCliRenderer,
	RendererControlState,
	TextRenderable,
} from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { TestRendererSetup } from "@opentui/core/testing";
import { CORE_CHAT_POSTED, CORE_MAP_LOADED } from "@supervillain/core";
import type {
	Envelope,
	RoomStore,
	RoomSubmission,
	ViewEntry,
} from "@supervillain/core";
import type { Session, TerminalSize } from "@supervillain/session";

import { runChrome } from "../src/chrome.js";
import type { TableHold } from "../src/index.js";
import { runLobby } from "../src/lobby.js";

const ACTOR = "actor-key";

const entry: ViewEntry<unknown, unknown, unknown> = {
	model: { apply: (state) => state, init: () => ({}) },
	view: {
		createPanels: () => [],
		notices: [{ runs: [{ text: "notice line", token: "muted" }] }],
		renderEvent: () => null,
	},
};

const wireEntry: ViewEntry<unknown, unknown, unknown> = {
	...entry,
	view: {
		...entry.view,
		notices: Array.from({ length: 24 }, (_, index) => ({
			runs: [{ text: `notice ${index}`, token: "muted" }],
		})),
	},
};

interface SessionProbe {
	readonly session: Session;
	readonly resizeListeners: () => number;
	readonly closeListeners: () => number;
	readonly resize: (size: TerminalSize) => void;
}

const fakeSession = (): SessionProbe => {
	const resizeListeners = new Set<(size: TerminalSize) => void>();
	const closeListeners = new Set<() => void>();
	const session: Session = {
		actor: ACTOR,
		close() {
			for (const listener of closeListeners) {
				listener();
			}
		},
		input: {} as NodeJS.ReadStream,
		onClose(listener) {
			closeListeners.add(listener);
			return () => closeListeners.delete(listener);
		},
		onResize(listener) {
			resizeListeners.add(listener);
			return () => resizeListeners.delete(listener);
		},
		output: {} as NodeJS.WriteStream,
		size: () => ({ columns: 60, rows: 12 }),
	};
	return {
		closeListeners: () => closeListeners.size,
		resize(size) {
			for (const listener of resizeListeners) {
				listener(size);
			}
		},
		resizeListeners: () => resizeListeners.size,
		session,
	};
};

interface StoreProbe {
	readonly store: RoomStore;
	readonly push: (envelope: Envelope) => void;
}

const fakeStore = (): StoreProbe => {
	const pending: Envelope[] = [];
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
		push(envelope) {
			pending.push(envelope);
			wake?.();
			wake = undefined;
		},
		store: {
			stream: () => stream(),
			submit: () => Promise.resolve({ accepted: true, envelopes: [] }),
		},
	};
};

const chatEnvelope = (text: string): Envelope => ({
	actor: ACTOR,
	payload: { text },
	roomId: "room",
	seq: 1,
	ts: 0,
	type: CORE_CHAT_POSTED,
});

const mapEnvelope = (): Envelope => ({
	actor: ACTOR,
	payload: { legend: { ".": "floor" }, name: "Hall", rows: ["..", ".."] },
	roomId: "room",
	seq: 1,
	ts: 0,
	type: CORE_MAP_LOADED,
});

/** Mounts the table on the injected renderer and draws one frame. The exit
 * promise is wrapped so awaiting the mount never adopts it. */
const mountTable = async (
	setup: TestRendererSetup,
	probe: SessionProbe,
	store: RoomStore,
	hold?: TableHold
): Promise<{ readonly exited: Promise<void> }> => {
	const exited = runChrome({
		entry,
		gameId: "fake",
		hold,
		renderer: setup.renderer,
		roomLabel: "the table",
		session: probe.session,
		store,
	});
	await setup.waitForFrame((frame) => frame.includes("the table"));
	return { exited };
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
			throw new Error("Renderer was destroyed before the expected frame.");
		}
	} finally {
		listeners.abort();
	}
};

/**
 * Mounts the whole table chrome except the conditional map region over a byte-
 * recording pipe. The overflowing feed makes ScrollBox's painted scrollbar
 * part of the frame; `map-region.test.ts` separately covers every map cell.
 * OpenTUI initializes untouched/track-only cells with an opaque RGB-white
 * foreground, and Slider's public options cannot replace the foreground used
 * by its `fillRect` track. That pinned remainder is the only allowed truecolor.
 */
const paintTableChrome = async (): Promise<{
	readonly bytes: string;
	readonly stop: () => Promise<void>;
}> => {
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
	try {
		const chunks: string[] = [];
		const output = new PassThrough();
		output.on("data", (chunk: Buffer) => chunks.push(chunk.toString("latin1")));
		const renderer = await createCliRenderer({
			exitOnCtrlC: false,
			height: 12,
			remote: false,
			stdin: new PassThrough() as unknown as NodeJS.ReadStream,
			stdout: output as unknown as NodeJS.WriteStream,
			width: 60,
		});
		const probe = fakeSession();
		chunks.length = 0;
		const painted = nextFrame(renderer);
		const exited = runChrome({
			entry: wireEntry,
			gameId: "fake",
			renderer,
			roomLabel: "the table",
			session: probe.session,
			store: fakeStore().store,
		});
		await painted;
		return {
			bytes: chunks.join(""),
			stop: async () => {
				try {
					probe.session.close();
					await exited;
				} finally {
					renderer.destroy();
					restoreTerm();
				}
			},
		};
	} catch (error) {
		restoreTerm();
		throw error;
	}
};

const CSI = `${String.fromCodePoint(27)}\\[`;
const TRUECOLOR_SGR = new RegExp(
	`${CSI}[\\d;]*[34]8;2;(?<rgb>\\d+;\\d+;\\d+)m`,
	"gu"
);
const INDEXED_SGR = new RegExp(`${CSI}(?:38|48);5;(?<slot>\\d+)m`, "gu");

describe("table renderer injection", () => {
	test("themes non-map chrome, with only OpenTUI's blank-cell RGB remainder", async () => {
		const wire = await paintTableChrome();
		try {
			expect(wire.bytes.length).toBeGreaterThan(0);
			// The one permitted remainder is OpenTUI's untouched/track-only-cell
			// RGB-white foreground, which has no public override. Whether those
			// cells paint at all varies by environment (a headless CI frame may
			// emit none), so the claim is "nothing but white", not "white appears".
			const truecolors = new Set(
				[...wire.bytes.matchAll(TRUECOLOR_SGR)].map(
					(match) => match.groups?.rgb
				)
			);
			for (const rgb of truecolors) {
				expect(rgb).toBe("255;255;255");
			}
			const slots = [...wire.bytes.matchAll(INDEXED_SGR)].map((match) =>
				Number(match.groups?.slot)
			);
			expect(slots.length).toBeGreaterThan(0);
			for (const slot of slots) {
				expect(slot).toBeLessThan(16);
			}
		} finally {
			await wire.stop();
		}
	});

	test("draws exact wide and narrow character-frame bands", async () => {
		const setup = await createTestRenderer({ height: 12, width: 60 });
		const probe = fakeSession();
		const store = fakeStore();
		const { exited } = await mountTable(setup, probe, store.store);

		const wide = setup.captureCharFrame().split("\n");
		expect(wide[0]).toBe(
			"─┤ the table · fake ├──────────┬─┤ seats ├──────────────────"
		);
		expect(wide[1]).toBe("─┤ feed ├──────────────────────┤".padEnd(60));
		expect(wide[4]?.at(31)).toBe("│");
		expect(wide[9]).toBe(
			"─┤ state ├─────────────────────┴────────────────────────────"
		);

		probe.resize({ columns: 40, rows: 8 });
		await setup.waitForFrame((frame) =>
			frame.startsWith("─┤ the t… ├┬─┤ seats ├──────────────────")
		);
		const narrow = setup.captureCharFrame().split("\n");
		expect(narrow[0]).toBe("─┤ the t… ├┬─┤ seats ├──────────────────");
		expect(narrow[1]).toBe("─┤ feed ├──┤".padEnd(40));
		expect(narrow[5]).toBe("─┤ state ├─┴────────────────────────────");

		setup.renderer.destroy();
		await exited;
	});

	test("turns the existing map title row into a band-header junction", async () => {
		const setup = await createTestRenderer({ height: 12, width: 60 });
		const probe = fakeSession();
		const store = fakeStore();
		const { exited } = await mountTable(setup, probe, store.store);

		store.push(mapEnvelope());
		await setup.waitForFrame((frame) => frame.includes("map · Hall 2×2"));
		const frame = setup.captureCharFrame().split("\n");
		expect(frame[1]).toBe("─┤ map · Hall 2×2 ├────────────┤".padEnd(60));
		const feedRule = frame.find((row) => row.startsWith("─┤ feed ├"));
		expect(feedRule?.at(31)).toBe("┤");

		setup.renderer.destroy();
		await exited;
	});

	test("draws on the injected renderer without starting a render loop", async () => {
		const setup = await createTestRenderer({ height: 12, width: 60 });
		const probe = fakeSession();
		const store = fakeStore();
		const { exited } = await mountTable(setup, probe, store.store);

		expect(setup.captureCharFrame()).toContain("the table");
		expect(setup.captureCharFrame()).toContain("notice line");
		expect(setup.renderer.isRunning).toBe(false);
		expect(setup.renderer.controlState).toBe(RendererControlState.IDLE);

		setup.renderer.destroy();
		await exited;
	});

	test("paints stream envelopes on demand with no ambient loop", async () => {
		const setup = await createTestRenderer({ height: 12, width: 60 });
		const probe = fakeSession();
		const store = fakeStore();
		const { exited } = await mountTable(setup, probe, store.store);

		store.push(chatEnvelope("hail and well met"));
		await setup.waitForFrame((frame) => frame.includes("hail and well met"));
		expect(setup.renderer.isRunning).toBe(false);

		setup.renderer.destroy();
		await exited;
	});

	test("resolves on renderer destroy and releases the session listeners", async () => {
		const setup = await createTestRenderer({ height: 12, width: 60 });
		const probe = fakeSession();
		const store = fakeStore();
		const { exited } = await mountTable(setup, probe, store.store);

		expect(probe.resizeListeners()).toBe(1);
		expect(probe.closeListeners()).toBe(1);

		setup.renderer.destroy();
		await exited;

		expect(probe.resizeListeners()).toBe(0);
		expect(probe.closeListeners()).toBe(0);
	});

	test("passes session resizes through to the injected renderer", async () => {
		const setup = await createTestRenderer({ height: 12, width: 60 });
		const probe = fakeSession();
		const store = fakeStore();
		const { exited } = await mountTable(setup, probe, store.store);

		probe.resize({ columns: 40, rows: 8 });
		expect(setup.renderer.terminalWidth).toBe(40);

		setup.renderer.destroy();
		await exited;
	});

	test("shows the hold's notice and hands the terminal back when it ends", async () => {
		const setup = await createTestRenderer({ height: 12, width: 60 });
		const probe = fakeSession();
		const store = fakeStore();
		let notify: ((message: string) => void) | undefined;
		let end: (() => void) | undefined;
		// oxlint-disable-next-line promise/avoid-new -- the hold's end is an event this test fires by hand.
		const ends = new Promise<void>((resolve) => {
			end = resolve;
		});
		const hold: TableHold = {
			onNotice(listener) {
				notify = listener;
				return () => {
					notify = undefined;
				};
			},
			until: ends,
		};
		const { exited } = await mountTable(setup, probe, store.store, hold);

		notify?.("The host went offline. Your seat is held while it reconnects.");
		await setup.waitForFrame((frame) => frame.includes("host went offline"));

		end?.();
		await exited;

		// The hold ended the screen, not the renderer: the surface owns that
		// lifetime (ADR-0016), and the next screen finds the root clean.
		expect(setup.renderer.isDestroyed).toBe(false);
		expect(setup.renderer.root.getChildren()).toHaveLength(0);
		setup.renderer.destroy();
	});

	test("a slow submission completing after quit cannot write to the destroyed tree", async () => {
		const setup = await createTestRenderer({ height: 12, width: 60 });
		const probe = fakeSession();
		const stream = fakeStore();
		let submissions = 0;
		let resolveSubmission: ((result: RoomSubmission) => void) | undefined;
		// oxlint-disable-next-line promise/avoid-new -- the test controls this completion across the screen boundary.
		const submitted = new Promise<RoomSubmission>((resolve) => {
			resolveSubmission = resolve;
		});
		const store: RoomStore = {
			stream: stream.store.stream,
			submit: () => {
				submissions += 1;
				return submitted;
			},
		};
		const { exited } = await mountTable(setup, probe, store);
		const screenRoot = setup.renderer.root.getChildren().at(0);
		if (screenRoot === undefined || !("getChildren" in screenRoot)) {
			throw new Error("table screen root was not mounted");
		}
		const status = screenRoot.getChildren().at(3);
		if (!(status instanceof TextRenderable)) {
			throw new Error("table status line was not mounted");
		}

		await setup.mockInput.typeText("hello");
		setup.mockInput.pressEnter();
		expect(submissions).toBe(1);
		await setup.mockInput.typeText("/quit");
		setup.mockInput.pressEnter();
		await exited;
		expect(setup.renderer.root.getChildren()).toHaveLength(0);

		resolveSubmission?.({ message: "late rejection", rejected: true });
		await Promise.resolve();
		await Promise.resolve();
		expect(status.chunks.map((chunk) => chunk.text).join("")).not.toContain(
			"late rejection"
		);
		expect(setup.renderer.root.getChildren()).toHaveLength(0);
		setup.renderer.destroy();
	});

	test("one renderer releases key listeners across a real lobby and table", async () => {
		const setup = await createTestRenderer({ height: 24, width: 80 });
		const probe = fakeSession();
		const baseline = setup.renderer.keyInput.listenerCount("keypress");
		const lobby = runLobby({
			connection: probe.session,
			keyed: true,
			renderer: setup.renderer,
			sshHost: "supervillain.app",
		});
		await setup.waitForFrame((frame) => frame.includes("join a room"));
		setup.mockInput.pressEnter();
		await setup.waitForFrame((frame) => frame.includes("type the name"));
		await setup.mockInput.typeText("gloomhold");
		setup.mockInput.pressEnter();
		expect(await lobby).toEqual({ kind: "join", roomName: "gloomhold" });
		expect(setup.renderer.keyInput.listenerCount("keypress")).toBe(baseline);

		const store = fakeStore();
		const { exited } = await mountTable(setup, probe, store.store);
		probe.session.close();
		await exited;
		expect(setup.renderer.keyInput.listenerCount("keypress")).toBe(baseline);
		setup.renderer.destroy();
	});

	test("resolves when the session closes and leaves the renderer alive", async () => {
		const setup = await createTestRenderer({ height: 12, width: 60 });
		const probe = fakeSession();
		const store = fakeStore();
		const { exited } = await mountTable(setup, probe, store.store);

		probe.session.close();
		await exited;

		expect(setup.renderer.isDestroyed).toBe(false);
		expect(setup.renderer.root.getChildren()).toHaveLength(0);
		setup.renderer.destroy();
	});
});
