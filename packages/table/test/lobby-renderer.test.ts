/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-lane suite. */
import { describe, expect, test } from "bun:test";

import { RendererControlState, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { TestRendererSetup } from "@opentui/core/testing";
import type { TerminalConnection, TerminalSize } from "@supervillain/session";

import { runLobby } from "../src/lobby.js";
import type { LobbyNotice, LobbyOutcome } from "../src/lobby.js";

const sleep = (ms: number): Promise<void> =>
	// oxlint-disable-next-line promise/avoid-new -- a bare timer needs the constructor.
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

interface ConnectionProbe {
	readonly connection: TerminalConnection;
	readonly resizeListeners: () => number;
	readonly closeListeners: () => number;
	readonly close: () => void;
}

const fakeConnection = (): ConnectionProbe => {
	const resizeListeners = new Set<(size: TerminalSize) => void>();
	const closeListeners = new Set<() => void>();
	const close = (): void => {
		for (const listener of closeListeners) {
			listener();
		}
	};
	return {
		close,
		closeListeners: () => closeListeners.size,
		connection: {
			close,
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
			size: () => ({ columns: 80, rows: 24 }),
		},
		resizeListeners: () => resizeListeners.size,
	};
};

const mountLobby = async (
	setup: TestRendererSetup,
	probe: ConnectionProbe,
	notice?: LobbyNotice
): Promise<{ readonly outcome: Promise<LobbyOutcome> }> => {
	const outcome = runLobby({
		connection: probe.connection,
		keyed: false,
		notice,
		renderer: setup.renderer,
		sshHost: "supervillain.app",
	});
	await setup.waitForFrame((frame) => frame.includes("join a room"));
	return { outcome };
};

describe("the lobby", () => {
	test("holds a live splash on the injected renderer without a render loop", async () => {
		const setup = await createTestRenderer({ height: 24, width: 80 });
		const probe = fakeConnection();
		const { outcome } = await mountLobby(setup, probe);

		const frame = setup.captureCharFrame();
		expect(frame).toContain("S U P E R V I L L A I N");
		expect(frame).toContain("join a room");
		expect(frame).toContain("become a GM");
		expect(setup.renderer.isRunning).toBe(false);
		expect(setup.renderer.controlState).toBe(RendererControlState.IDLE);

		setup.renderer.destroy();
		expect(await outcome).toEqual({ kind: "leave" });
	});

	test("renders the unknown-room notice inline, over the full lobby", async () => {
		const setup = await createTestRenderer({ height: 24, width: 80 });
		const probe = fakeConnection();
		const { outcome } = await mountLobby(setup, probe, {
			kind: "unknown-room",
			roomName: "gloomhold",
		});

		const frame = setup.captureCharFrame();
		expect(frame).toContain("no table named 'gloomhold'");
		expect(frame).toContain("join a room");

		setup.renderer.destroy();
		await outcome;
	});

	test("renders the offline-room notice with its own copy", async () => {
		const setup = await createTestRenderer({ height: 24, width: 80 });
		const probe = fakeConnection();
		const { outcome } = await mountLobby(setup, probe, {
			kind: "offline-room",
			roomName: "gloomhold",
		});

		const frame = setup.captureCharFrame();
		expect(frame).toContain("gloomhold");
		expect(frame).toContain("isn't live right now");
		expect(frame).not.toContain("no table named");

		setup.renderer.destroy();
		await outcome;
	});

	test("walks the menu to the become-a-GM screen", async () => {
		const setup = await createTestRenderer({ height: 24, width: 80 });
		const probe = fakeConnection();
		const { outcome } = await mountLobby(setup, probe);

		setup.mockInput.pressArrow("down");
		setup.mockInput.pressEnter();
		await setup.waitForFrame((frame) => frame.includes("cannot create a room"));
		expect(setup.captureCharFrame()).toContain("ssh <name>@supervillain.app");

		setup.mockInput.pressEscape();
		// A bare ESC sits in OpenTUI's stdin parser until its escape-sequence
		// timeout flushes it; the test clock has to be a real one for that.
		await sleep(40);
		await setup.waitForFrame((frame) => frame.includes("up/down to move"));
		expect(setup.captureCharFrame()).not.toContain("cannot create a room");

		setup.renderer.destroy();
		await outcome;
	});

	test("hands a typed room name back and returns the renderer intact", async () => {
		const setup = await createTestRenderer({ height: 24, width: 80 });
		const probe = fakeConnection();
		const { outcome } = await mountLobby(setup, probe);

		setup.mockInput.pressEnter();
		await setup.waitForFrame((frame) => frame.includes("type the name"));
		await setup.mockInput.typeText("gloomhold");
		setup.mockInput.pressEnter();

		expect(await outcome).toEqual({ kind: "join", roomName: "gloomhold" });
		// Borrowed, not owned (ADR-0016): the visit detaches its renderables
		// and leaves the surface's renderer standing for the next screen.
		expect(setup.renderer.isDestroyed).toBe(false);
		expect(setup.renderer.root.getChildren()).toHaveLength(0);
		expect(probe.resizeListeners()).toBe(0);
		expect(probe.closeListeners()).toBe(0);
		setup.renderer.destroy();
	});

	test("a closed connection leaves the lobby with the renderer standing", async () => {
		const setup = await createTestRenderer({ height: 24, width: 80 });
		const probe = fakeConnection();
		const { outcome } = await mountLobby(setup, probe);

		probe.close();
		expect(await outcome).toEqual({ kind: "leave" });
		expect(setup.renderer.isDestroyed).toBe(false);
		setup.renderer.destroy();
	});

	test("one renderer serves the lobby and then the table (ADR-0016)", async () => {
		const setup = await createTestRenderer({ height: 24, width: 80 });
		const probe = fakeConnection();
		const { outcome } = await mountLobby(setup, probe);

		setup.mockInput.pressEnter();
		await setup.waitForFrame((frame) => frame.includes("type the name"));
		await setup.mockInput.typeText("gloomhold");
		setup.mockInput.pressEnter();
		expect(await outcome).toEqual({ kind: "join", roomName: "gloomhold" });

		// The same renderer now hosts the next screen, clean: nothing of the
		// lobby survives on it.
		const banner = new TextRenderable(setup.renderer, {
			content: "the next screen",
		});
		setup.renderer.root.add(banner);
		await setup.waitForFrame((frame) => frame.includes("the next screen"));
		expect(setup.captureCharFrame()).not.toContain("join a room");
		setup.renderer.destroy();
	});
});
