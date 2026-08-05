import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { PassThrough } from "node:stream";

/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-lane suite. */
import {
	BoxRenderable,
	CliRenderEvents,
	createCliRenderer,
	RendererControlState,
	TextRenderable,
} from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { TestRendererSetup } from "@opentui/core/testing";
import {
	CORE_CHAT_POSTED,
	CORE_MAP_CLEARED,
	CORE_MAP_LOADED,
} from "@supervillain/core";
import type {
	Envelope,
	RoomStore,
	RoomSubmission,
	ViewEntry,
} from "@supervillain/core";
import type { Session, TerminalSize } from "@supervillain/session";

import { runChrome } from "../src/chrome.js";
import type {
	TableHold,
	TablePreferenceChange,
	TableViewOptions,
} from "../src/index.js";
import { runLobby } from "../src/lobby.js";

const ACTOR = "actor-key";
const sleep = (ms: number): Promise<void> =>
	// oxlint-disable-next-line promise/avoid-new -- a bare timer flushes OpenTUI's ambiguous bare-Esc parser input.
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

const entry: ViewEntry<unknown, unknown, unknown> = {
	model: { apply: (state) => state, init: () => ({}) },
	view: {
		createPanels: () => [],
		notices: [{ runs: [{ text: "notice line", token: "muted" }] }],
		renderEvent: () => null,
	},
};

const contextualEntry: ViewEntry<unknown, unknown, unknown> = {
	...entry,
	view: {
		...entry.view,
		createPanels: () => [
			{
				id: "tasks",
				onKey: (key, input) => {
					if (key.name !== "a") {
						return false;
					}
					input.requestMessageTask({
						submit: (name) => ({ name, type: "fake.add" }),
						title: "add fixture",
					});
					return true;
				},
				render: () => [],
				slot: "sidebar",
			},
		],
	},
};

const tabbedEntry = (
	actions: string[]
): ViewEntry<unknown, unknown, unknown> => ({
	...entry,
	view: {
		...entry.view,
		createPanels: () => [
			{
				id: "first",
				onKey: (key) => {
					actions.push(`first:key:${key.name}`);
					return true;
				},
				onRowClick: (row) => {
					actions.push(`first:row:${row}`);
					return true;
				},
				render: () => [
					{ runs: [{ text: "first panel", token: "primary" }] },
					{ runs: [{ text: "action row", token: "primary" }] },
				],
				slot: "sidebar",
			},
			{
				id: "second",
				onKey: (key) => {
					actions.push(`second:key:${key.name}`);
					return true;
				},
				render: () => [{ runs: [{ text: "second panel", token: "primary" }] }],
				slot: "sidebar",
			},
		],
	},
});

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

const chatEnvelope = (text: string, seq = 1): Envelope => ({
	actor: ACTOR,
	payload: { text },
	roomId: "room",
	seq,
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

const mapClearedEnvelope = (): Envelope => ({
	actor: ACTOR,
	payload: {},
	roomId: "room",
	seq: 2,
	ts: 0,
	type: CORE_MAP_CLEARED,
});

/** Mounts the table on the injected renderer and draws one frame. The exit
 * promise is wrapped so awaiting the mount never adopts it. */
const mountTable = async (
	setup: TestRendererSetup,
	probe: SessionProbe,
	store: RoomStore,
	hold?: TableHold,
	viewOptions?: TableViewOptions,
	tableEntry: ViewEntry<unknown, unknown, unknown> = entry,
	onPreferenceChange?: (change: TablePreferenceChange) => void
): Promise<{ readonly exited: Promise<void> }> => {
	const exited = runChrome({
		entry: tableEntry,
		gameId: "fake",
		hold,
		onPreferenceChange,
		renderer: setup.renderer,
		roomLabel: "the table",
		session: probe.session,
		store,
		viewOptions,
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

	test("draws independent Pane frames and leaves passive bands open", async () => {
		const setup = await createTestRenderer({ height: 12, width: 60 });
		const probe = fakeSession();
		const store = fakeStore();
		const { exited } = await mountTable(setup, probe, store.store);

		const wide = setup.captureCharFrame().split("\n");
		expect(wide[0]).toBe("the table · fake".padEnd(60));
		expect(wide[1]).toStartWith("┌─feed");
		expect(wide[1]).toContain("┐ ┌─sidebar");
		expect(wide[6]).toContain("┘ └");
		expect(wide[8]).toStartWith("┌─message");
		expect(wide[10]).toStartWith("└");
		expect(wide[11]).toStartWith("feed  [tab] pane");

		probe.resize({ columns: 40, rows: 8 });
		await setup.waitForFrame((frame) => frame.startsWith("terminal too small"));
		expect(setup.captureCharFrame()).toContain("increase the terminal size");

		setup.renderer.destroy();
		await exited;
	});

	test("click and Tab traverse real Pane focus with the optional marker", async () => {
		const setup = await createTestRenderer({ height: 24, width: 80 });
		const probe = fakeSession();
		const store = fakeStore();
		const { exited } = await mountTable(setup, probe, store.store, undefined, {
			focusMarker: true,
		});

		expect(setup.captureCharFrame()).toContain("┌─> feed");
		setup.mockMouse.click(60, 3);
		await setup.waitForFrame((frame) => frame.includes("┌─> sidebar"));
		setup.mockInput.pressTab();
		await setup.waitForFrame((frame) => frame.includes("┌─> message"));
		setup.mockInput.pressTab();
		await setup.waitForFrame((frame) => frame.includes("┌─> feed"));
		setup.mockInput.pressTab({ shift: true });
		await setup.waitForFrame((frame) => frame.includes("┌─> message"));

		const screenRoot = setup.renderer.root.getChildren().at(0);
		if (!(screenRoot instanceof BoxRenderable)) {
			throw new Error("Table root was not mounted.");
		}
		const main = screenRoot.getChildren().at(1);
		if (!(main instanceof BoxRenderable)) {
			throw new Error("Table main row was not mounted.");
		}
		const messagePane = screenRoot.getChildren().at(3);
		const panes = [...main.getChildren(), messagePane];
		for (const pane of panes) {
			if (!(pane instanceof BoxRenderable)) {
				throw new Error("Table Pane was not a BoxRenderable.");
			}
			expect(pane.focusable).toBe(true);
			expect(Math.floor(pane.borderColor.buffer[0] / 256)).toBe(8);
			expect(Math.floor(pane.focusedBorderColor.buffer[0] / 256)).toBe(6);
		}

		setup.renderer.destroy();
		await exited;
	});

	test("renders the inset key sheet and lets its top layer consume all input", async () => {
		const setup = await createTestRenderer({ height: 24, width: 80 });
		const probe = fakeSession();
		const store = fakeStore();
		const actions: string[] = [];
		const changes: TablePreferenceChange[] = [];
		const { exited } = await mountTable(
			setup,
			probe,
			store.store,
			undefined,
			undefined,
			tabbedEntry(actions),
			(change) => changes.push(change)
		);

		await setup.mockInput.typeText("?");
		await setup.waitForFrame(
			(frame) => frame.includes("keys") && frame.includes("key sheet")
		);
		await setup.mockInput.typeText("cv");
		setup.mockInput.pressTab();
		await setup.mockInput.typeText("f");
		await setup.waitForFrame((frame) => frame.includes("┌─keys"));
		expect(actions).toEqual([]);
		expect(changes).toEqual([{ preference: "focusMarker", value: true }]);
		expect(setup.captureCharFrame()).toContain("feed [−]");

		setup.mockInput.pressEscape();
		await sleep(40);
		await setup.waitForFrame(
			(frame) => frame.includes("┌─> feed") && !frame.includes("┌─keys")
		);

		setup.renderer.destroy();
		await exited;
	});

	test("toggles both Rails with c while preserving the Pane focus ring", async () => {
		const setup = await createTestRenderer({ height: 24, width: 80 });
		const probe = fakeSession();
		const store = fakeStore();
		const changes: TablePreferenceChange[] = [];
		const { exited } = await mountTable(
			setup,
			probe,
			store.store,
			undefined,
			{ focusMarker: true },
			entry,
			(change) => changes.push(change)
		);

		await setup.mockInput.typeText("c");
		await setup.waitForFrame(
			(frame) => frame.includes("┌───┐") && frame.includes("│[+]│")
		);
		expect(setup.captureCharFrame()).toContain("feed  [tab] pane");
		setup.mockInput.pressTab();
		await setup.waitForFrame((frame) => frame.includes("sidebar  [tab] pane"));
		await setup.mockInput.typeText("c");
		await setup.waitForFrame((frame) =>
			frame.split("\n")[1]?.includes("┌───┐ ┌───┐")
		);

		const screenRoot = setup.renderer.root.getChildren().at(0);
		if (!(screenRoot instanceof BoxRenderable)) {
			throw new Error("Table root was not mounted.");
		}
		const main = screenRoot.getChildren().at(1);
		if (!(main instanceof BoxRenderable)) {
			throw new Error("Table main row was not mounted.");
		}
		for (const pane of [main.getChildren().at(0), main.getChildren().at(2)]) {
			if (!(pane instanceof BoxRenderable)) {
				throw new Error("Rail was not the original focusable Pane.");
			}
			expect(pane.focusable).toBe(true);
		}
		expect(changes).toEqual([
			{ preference: "feedRail", value: true },
			{ preference: "sidebarRail", value: true },
		]);

		setup.renderer.destroy();
		await exited;
	});

	test("gives title [−] and Rail [+] clicks keyboard parity", async () => {
		const setup = await createTestRenderer({ height: 24, width: 80 });
		const probe = fakeSession();
		const store = fakeStore();
		const changes: TablePreferenceChange[] = [];
		const { exited } = await mountTable(
			setup,
			probe,
			store.store,
			undefined,
			undefined,
			entry,
			(change) => changes.push(change)
		);
		const screenRoot = setup.renderer.root.getChildren().at(0);
		const main =
			screenRoot instanceof BoxRenderable
				? screenRoot.getChildren().at(1)
				: undefined;
		const feedPane =
			main instanceof BoxRenderable ? main.getChildren().at(0) : undefined;
		const sidebarPane =
			main instanceof BoxRenderable ? main.getChildren().at(2) : undefined;
		if (
			!(feedPane instanceof BoxRenderable) ||
			!(sidebarPane instanceof BoxRenderable)
		) {
			throw new Error("Side Panes were not mounted.");
		}

		setup.mockMouse.click(feedPane.x + 8, feedPane.y);
		await setup.waitForFrame((frame) => frame.includes("│[+]│"));
		setup.mockMouse.click(feedPane.x + 2, feedPane.y + 1);
		await setup.waitForFrame((frame) => frame.includes("feed [−]"));
		setup.mockMouse.click(sidebarPane.x + 11, sidebarPane.y);
		await setup.waitForFrame((frame) => frame.includes("│[+]│"));
		setup.mockMouse.click(sidebarPane.x + 2, sidebarPane.y + 1);
		await setup.waitForFrame((frame) => frame.includes("sidebar [−]"));
		expect(changes).toEqual([
			{ preference: "feedRail", value: true },
			{ preference: "feedRail", value: false },
			{ preference: "sidebarRail", value: true },
			{ preference: "sidebarRail", value: false },
		]);

		setup.renderer.destroy();
		await exited;
	});

	test("counts FeedLines received while railed and clears on expansion", async () => {
		const setup = await createTestRenderer({ height: 24, width: 80 });
		const probe = fakeSession();
		const store = fakeStore();
		const { exited } = await mountTable(setup, probe, store.store, undefined, {
			feedRail: true,
		});

		store.push(chatEnvelope("first", 1));
		await setup.waitForFrame(
			(frame) => frame.includes("│ ● │") && frame.includes("│1  │")
		);
		store.push(chatEnvelope("second", 2));
		await setup.waitForFrame((frame) => frame.includes("│2  │"));
		await setup.mockInput.typeText("c");
		await setup.waitForFrame((frame) => frame.includes("feed [−]"));
		await setup.mockInput.typeText("c");
		await setup.waitForFrame(
			(frame) => frame.includes("│[+]│") && !frame.includes("│2  │")
		);

		setup.renderer.destroy();
		await exited;
	});

	test("forces Rails in map-focused order and restores them on grow", async () => {
		const setup = await createTestRenderer({ height: 24, width: 80 });
		const probe = fakeSession();
		const store = fakeStore();
		const changes: TablePreferenceChange[] = [];
		const { exited } = await mountTable(
			setup,
			probe,
			store.store,
			undefined,
			undefined,
			entry,
			(change) => changes.push(change)
		);
		store.push(mapEnvelope());
		await setup.waitForFrame(
			(frame) =>
				frame.includes("feed [−]") &&
				frame.includes("map · Hall") &&
				frame.includes("sidebar [−]")
		);

		probe.resize({ columns: 59, rows: 24 });
		await setup.waitForFrame(
			(frame) => frame.includes("│[+]│") && frame.includes("sidebar [−]")
		);
		store.push(chatEnvelope("while forced", 2));
		await setup.waitForFrame((frame) => frame.includes("│1  │"));
		setup.mockInput.pressTab({ shift: true });
		await setup.waitForFrame((frame) => frame.includes("feed  [tab] pane"));
		await setup.mockInput.typeText("c");
		expect(setup.captureCharFrame()).toContain("│1  │");
		expect(changes).toEqual([]);
		probe.resize({ columns: 52, rows: 24 });
		await setup.waitForFrame((frame) =>
			frame.split("\n")[1]?.includes("┌───┐")
		);
		probe.resize({ columns: 80, rows: 24 });
		await setup.waitForFrame(
			(frame) => frame.includes("feed [−]") && frame.includes("sidebar [−]")
		);
		probe.resize({ columns: 59, rows: 24 });
		await setup.waitForFrame(
			(frame) =>
				frame.includes("│[+]│") &&
				frame.includes("sidebar [−]") &&
				!frame.includes("│1  │")
		);
		expect(changes).toEqual([]);

		setup.renderer.destroy();
		await exited;
	});

	test("holds an explicit Rail inert until visible expansion can occur", async () => {
		const setup = await createTestRenderer({ height: 24, width: 80 });
		const probe = fakeSession();
		const store = fakeStore();
		const changes: TablePreferenceChange[] = [];
		const { exited } = await mountTable(
			setup,
			probe,
			store.store,
			undefined,
			{ feedRail: true },
			entry,
			(change) => changes.push(change)
		);
		store.push(mapEnvelope());
		await setup.waitForFrame((frame) => frame.includes("map · Hall"));
		probe.resize({ columns: 59, rows: 24 });
		await setup.waitForFrame((frame) => frame.includes("│[+]│"));
		store.push(chatEnvelope("unseen", 2));
		await setup.waitForFrame((frame) => frame.includes("│2  │"));
		setup.mockInput.pressTab({ shift: true });
		await setup.waitForFrame((frame) => frame.includes("feed  [tab] pane"));

		await setup.mockInput.typeText("c");
		expect(setup.captureCharFrame()).toContain("│2  │");
		expect(changes).toEqual([]);
		probe.resize({ columns: 80, rows: 24 });
		await setup.waitForFrame((frame) => frame.includes("│2  │"));
		await setup.mockInput.typeText("c");
		await setup.waitForFrame(
			(frame) => frame.includes("feed [−]") && !frame.includes("│2  │")
		);
		expect(changes).toEqual([{ preference: "feedRail", value: false }]);

		setup.renderer.destroy();
		await exited;
	});

	test("shows and recovers from the honest no-map too-small surface", async () => {
		const setup = await createTestRenderer({ height: 24, width: 17 });
		const probe = fakeSession();
		const store = fakeStore();
		const changes: TablePreferenceChange[] = [];
		const exited = runChrome({
			entry,
			gameId: "fake",
			onPreferenceChange: (change) => changes.push(change),
			renderer: setup.renderer,
			roomLabel: "the table",
			session: probe.session,
			store: store.store,
			viewOptions: { layout: "no-map" },
		});
		await setup.waitForFrame(
			(frame) =>
				frame.includes("terminal too") && frame.includes("increase the")
		);
		await setup.mockInput.typeText("c");
		expect(changes).toEqual([]);
		await Promise.resolve();
		expect(probe.resizeListeners()).toBe(1);
		probe.resize({ columns: 80, rows: 24 });
		await setup.waitForFrame(
			(frame) =>
				frame.includes("the table · fake") && frame.includes("feed [−]")
		);

		setup.renderer.destroy();
		await exited;
	});

	test("renders one active Panel and gives tabs, keys, and rows click parity", async () => {
		const setup = await createTestRenderer({ height: 24, width: 80 });
		const probe = fakeSession();
		const store = fakeStore();
		const actions: string[] = [];
		const { exited } = await mountTable(
			setup,
			probe,
			store.store,
			undefined,
			{ focusMarker: true },
			tabbedEntry(actions)
		);

		const initial = setup.captureCharFrame();
		expect(initial).toContain("[first]  second");
		expect(initial).toContain("first panel");
		expect(initial).not.toContain("second panel");

		setup.mockInput.pressTab();
		await setup.waitForFrame((frame) => frame.includes("┌─> sidebar"));
		await setup.mockInput.typeText("v");
		expect(actions).toEqual([]);
		setup.mockInput.pressArrow("down");
		expect(actions).toEqual(["first:key:down"]);

		setup.mockInput.pressArrow("right");
		await setup.waitForFrame(
			(frame) =>
				frame.includes("first  [second]") &&
				frame.includes("second panel") &&
				!frame.includes("first panel") &&
				frame.includes("panel: second")
		);
		await setup.mockInput.typeText("]");
		expect(actions).toContain("second:key:]");
		setup.mockInput.pressArrow("right");
		await setup.waitForFrame((frame) => frame.includes("[first]  second"));

		const screenRoot = setup.renderer.root.getChildren().at(0);
		if (!(screenRoot instanceof BoxRenderable)) {
			throw new Error("Table root was not mounted.");
		}
		const main = screenRoot.getChildren().at(1);
		if (!(main instanceof BoxRenderable)) {
			throw new Error("Table main row was not mounted.");
		}
		const sidebar = main.getChildren().at(2);
		if (!(sidebar instanceof BoxRenderable)) {
			throw new Error("Sidebar Pane was not mounted.");
		}
		const tabs = sidebar.getChildren().at(1);
		const panel = sidebar.getChildren().at(2);
		if (
			!(tabs instanceof TextRenderable) ||
			!(panel instanceof BoxRenderable)
		) {
			throw new Error("Sidebar tab strip and Panel were not mounted.");
		}
		// The strip renders "[first]  second": "second" spans columns 9-14,
		// so column 10 lands inside the inactive tab's label.
		setup.mockMouse.click(tabs.x + 10, tabs.y);
		await setup.waitForFrame((frame) => frame.includes("first  [second]"));
		expect(setup.captureCharFrame()).toContain("┌─> sidebar");

		setup.mockInput.pressArrow("left");
		await setup.waitForFrame((frame) => frame.includes("[first]  second"));
		const actionRow = panel.getChildren().at(1);
		if (!(actionRow instanceof TextRenderable)) {
			throw new Error("Active Panel row was not mounted.");
		}
		setup.mockMouse.click(actionRow.x, actionRow.y);
		await setup.waitForFrame((frame) => frame.includes("┌─> sidebar"));
		expect(actions).toContain("first:row:1");

		setup.renderer.destroy();
		await exited;
	});

	test("opens, submits, and cancels contextual Message tasks", async () => {
		const setup = await createTestRenderer({ height: 24, width: 80 });
		const probe = fakeSession();
		const stream = fakeStore();
		const commands: unknown[] = [];
		const store: RoomStore = {
			stream: stream.store.stream,
			submit: (submission) => {
				commands.push(submission.command);
				return Promise.resolve({ accepted: true, envelopes: [] });
			},
		};
		const { exited } = await mountTable(
			setup,
			probe,
			store,
			undefined,
			{ focusMarker: true },
			contextualEntry
		);

		setup.mockInput.pressTab();
		setup.mockInput.pressTab();
		await setup.mockInput.typeText("ordinary draft");
		setup.mockInput.pressTab({ shift: true });
		await setup.mockInput.typeText("a");
		await setup.waitForFrame((frame) => frame.includes("┌─> add fixture"));
		await setup.mockInput.typeText("New Hero");
		setup.mockInput.pressEnter();
		await setup.waitForFrame((frame) => frame.includes("┌─> sidebar"));
		expect(commands).toEqual([{ name: "New Hero", type: "fake.add" }]);

		await setup.mockInput.typeText("a");
		await setup.waitForFrame((frame) => frame.includes("┌─> add fixture"));
		await setup.mockInput.typeText("discard me");
		setup.mockInput.pressEscape();
		await sleep(40);
		await setup.waitForFrame((frame) => frame.includes("┌─> sidebar"));
		expect(commands).toHaveLength(1);
		setup.mockInput.pressTab();
		await setup.waitForFrame(
			(frame) =>
				frame.includes("┌─> message") &&
				frame.includes("ordinary draft") &&
				!frame.includes("discard me")
		);

		setup.renderer.destroy();
		await exited;
	});

	test("carries the ordinary draft through a task re-request", async () => {
		const setup = await createTestRenderer({ height: 24, width: 80 });
		const probe = fakeSession();
		const store = fakeStore();
		const { exited } = await mountTable(
			setup,
			probe,
			store.store,
			undefined,
			{ focusMarker: true },
			contextualEntry
		);

		setup.mockInput.pressTab();
		setup.mockInput.pressTab();
		await setup.mockInput.typeText("ordinary draft");
		setup.mockInput.pressTab({ shift: true });
		await setup.mockInput.typeText("a");
		await setup.waitForFrame((frame) => frame.includes("┌─> add fixture"));
		await setup.mockInput.typeText("stale half-name");
		// Tab away: the task stays pending with its contextual draft in the
		// input. Re-requesting from the sidebar must abandon the stale task
		// while carrying the original ordinary draft forward.
		setup.mockInput.pressTab();
		await setup.waitForFrame((frame) => frame.includes("┌─> feed"));
		setup.mockInput.pressTab();
		await setup.waitForFrame((frame) => frame.includes("┌─> sidebar"));
		await setup.mockInput.typeText("a");
		await setup.waitForFrame(
			(frame) =>
				frame.includes("┌─> add fixture") && !frame.includes("stale half-name")
		);
		setup.mockInput.pressEscape();
		await sleep(40);
		await setup.waitForFrame((frame) => frame.includes("┌─> sidebar"));
		setup.mockInput.pressTab();
		await setup.waitForFrame(
			(frame) =>
				frame.includes("┌─> message") &&
				frame.includes("ordinary draft") &&
				!frame.includes("stale half-name")
		);

		setup.renderer.destroy();
		await exited;
	});

	test("preserves ordinary Message drafts across Tab and Esc", async () => {
		const setup = await createTestRenderer({ height: 24, width: 80 });
		const probe = fakeSession();
		const store = fakeStore();
		const { exited } = await mountTable(setup, probe, store.store, undefined, {
			focusMarker: true,
		});

		setup.mockInput.pressTab();
		setup.mockInput.pressTab();
		await setup.mockInput.typeText("draft?v");
		setup.mockInput.pressTab();
		setup.mockInput.pressTab();
		setup.mockInput.pressTab();
		await setup.waitForFrame(
			(frame) => frame.includes("┌─> message") && frame.includes("draft?v")
		);
		setup.mockInput.pressEscape();
		await sleep(40);
		await setup.waitForFrame((frame) => frame.includes("┌─> sidebar"));
		setup.mockInput.pressTab();
		await setup.waitForFrame(
			(frame) => frame.includes("┌─> message") && frame.includes("draft?v")
		);

		setup.renderer.destroy();
		await exited;
	});

	test.each(["send", "cancel"] as const)(
		"repairs a vanished Message origin on %s",
		async (action) => {
			const setup = await createTestRenderer({ height: 24, width: 80 });
			const probe = fakeSession();
			const store = fakeStore();
			const { exited } = await mountTable(
				setup,
				probe,
				store.store,
				undefined,
				{
					focusMarker: true,
				}
			);
			store.push(mapEnvelope());
			await setup.waitForFrame((frame) => frame.includes("┌─> map · Hall"));
			setup.mockMouse.click(10, 21);
			await setup.waitForFrame((frame) => frame.includes("┌─> message"));
			store.push(mapClearedEnvelope());
			await setup.waitForFrame((frame) => !frame.includes("map · Hall"));
			if (action === "send") {
				await setup.mockInput.typeText("hello");
				setup.mockInput.pressEnter();
			} else {
				setup.mockInput.pressEscape();
				await sleep(40);
			}
			await setup.waitForFrame((frame) => frame.includes("┌─> feed"));

			setup.renderer.destroy();
			await exited;
		}
	);

	test("adds Map as its own titled Pane between Feed and Sidebar", async () => {
		const setup = await createTestRenderer({ height: 16, width: 60 });
		const probe = fakeSession();
		const store = fakeStore();
		const { exited } = await mountTable(setup, probe, store.store);

		store.push(mapEnvelope());
		await setup.waitForFrame((frame) => frame.includes("map · Hall"));
		const frame = setup.captureCharFrame().split("\n");
		expect(frame[1]).toStartWith("┌─feed");
		expect(frame[1]).toContain("┐ ┌─map · Hall");
		expect(frame[1]).toContain("┐ ┌─sidebar");

		// The repair below is only exercised if Map actually held focus first —
		// without this wait a slow run could pass without testing the repair.
		await setup.waitForFrame((next) => next.includes("map  [tab] pane"));

		store.push(mapClearedEnvelope());
		await setup.waitForFrame(
			(next) =>
				!next.includes("map · Hall") && next.includes("feed  [tab] pane")
		);

		setup.renderer.destroy();
		await exited;
	});

	test("a Map in a batched replay tail receives layout-derived initial focus", async () => {
		const setup = await createTestRenderer({ height: 16, width: 60 });
		const probe = fakeSession();
		const tail = fakeStore();
		tail.push(mapEnvelope());
		// A checkpointing store replays a frozen tail in one batch (RoomStore
		// .replay()); the map arriving inside that tail must still take the
		// map-focused layout's initial focus once the batch renders.
		const store: RoomStore = {
			...tail.store,
			replay: () =>
				Promise.resolve({ stream: tail.store.stream(1), throughSeq: 1 }),
		};
		const { exited } = await mountTable(setup, probe, store);

		await setup.waitForFrame(
			(frame) =>
				frame.includes("map · Hall") && frame.includes("map  [tab] pane")
		);

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
		const status = screenRoot.getChildren().at(2);
		if (!(status instanceof TextRenderable)) {
			throw new Error("table status line was not mounted");
		}

		setup.mockInput.pressTab();
		setup.mockInput.pressTab();
		await setup.mockInput.typeText("hello");
		setup.mockInput.pressEnter();
		expect(submissions).toBe(1);
		setup.mockInput.pressTab();
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
