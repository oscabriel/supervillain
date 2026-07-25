import { describe, expect, test } from "bun:test";

/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-lane suite. */
import { RendererControlState } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { TestRendererSetup } from "@opentui/core/testing";
import { CORE_CHAT_POSTED } from "@supervillain/core";
import type { Envelope, RoomStore, ViewEntry } from "@supervillain/core";
import type { Session, TerminalSize } from "@supervillain/session";

import { runChrome } from "../src/chrome.js";
import type { TableHold } from "../src/index.js";

const ACTOR = "actor-key";

const entry: ViewEntry<unknown, unknown, unknown> = {
	model: { apply: (state) => state, init: () => ({}) },
	view: {
		createPanels: () => [],
		notices: [{ runs: [{ text: "notice line", token: "muted" }] }],
		renderEvent: () => null,
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

describe("table renderer injection", () => {
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
