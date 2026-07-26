/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; the gateway is Bun-bound by bun:sqlite. */
import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { CliRenderEvents, RendererControlState } from "@opentui/core";
import type { CliRenderer, KeyEvent } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import { keyedIdentity } from "../src/guest.js";
import {
	DEFAULT_CAPACITY_LIMITS,
	REVOKED_SESSION_MESSAGE,
	serveShell,
} from "../src/index.js";
import type { DoorSession } from "../src/index.js";
import { createKeyedSessions } from "../src/revocation.js";

const ACTOR = "a".repeat(64);

interface ShellProbe {
	readonly session: DoorSession;
	readonly transcript: () => string;
	readonly ended: () => boolean;
	readonly resize: (cols: number, rows: number) => void;
}

const shellProbe = (
	cols: number,
	rows: number,
	injectedRenderer?: CliRenderer
): ShellProbe => {
	const stdin = new PassThrough();
	const closeListeners = new Set<() => void>();
	const resizeListeners = new Set<(cols: number, rows: number) => void>();
	const keypressListeners = new Set<(key: KeyEvent) => void>();
	let transcript = "";
	let ended = false;
	const close = (): void => {
		if (ended) {
			return;
		}
		ended = true;
		for (const listener of closeListeners) {
			listener();
		}
	};
	const renderer = {
		keyInput: {
			off: (_event: string, listener: (key: KeyEvent) => void) => {
				keypressListeners.delete(listener);
			},
			on: (_event: string, listener: (key: KeyEvent) => void) => {
				keypressListeners.add(listener);
			},
		},
		resize: () => {},
		resume: () => {},
		stdin,
		suspend: () => {},
	} as unknown as CliRenderer;
	return {
		ended: () => ended,
		resize(nextCols, nextRows) {
			for (const listener of resizeListeners) {
				listener(nextCols, nextRows);
			}
		},
		session: {
			cols,
			end: close,
			onClose(listener) {
				if (ended) {
					listener();
					return () => {};
				}
				closeListeners.add(listener);
				return () => closeListeners.delete(listener);
			},
			onResize(listener) {
				resizeListeners.add(listener);
				return () => resizeListeners.delete(listener);
			},
			renderer: injectedRenderer ?? renderer,
			rows,
			write(data) {
				transcript += data.toString();
			},
		},
		transcript: () => transcript,
	};
};

const shellOptions = (sessions: ReturnType<typeof createKeyedSessions>) =>
	({
		identity: keyedIdentity(ACTOR),
		limits: {
			connectionsPerWindow: 30,
			idleMs: 300_000,
			maxHoldMs: 1_800_000,
			windowMs: 60_000,
		},
		roomName: "the-kitchen",
		rooms: {
			limits: DEFAULT_CAPACITY_LIMITS,
			metrics: {} as never,
			pipes: {} as never,
			registry: {} as never,
			sessions,
		},
		sshHost: "supervillain.app",
	}) satisfies Parameters<typeof serveShell>[1];

test("an oversized-terminal notice suspends real frames until the keypress", async () => {
	const setup = await createTestRenderer({ height: 24, width: 80 });
	const sessions = createKeyedSessions();
	const probe = shellProbe(400, 150, setup.renderer);
	let frames = 0;
	setup.renderer.on(CliRenderEvents.FRAME, () => {
		frames += 1;
	});
	const serving = serveShell(probe.session, shellOptions(sessions), () => {
		expect(probe.transcript()).toContain("400x150");
		expect(frames).toBe(0);
		expect(setup.renderer.controlState).not.toBe(
			RendererControlState.EXPLICIT_SUSPENDED
		);
		return Promise.resolve();
	});

	expect(probe.transcript()).toContain("400x150");
	expect(setup.renderer.controlState).toBe(
		RendererControlState.EXPLICIT_SUSPENDED
	);
	probe.resize(500, 200);
	await Bun.sleep(0);
	expect(frames).toBe(0);

	setup.renderer.stdin.emit("data", Buffer.from(" "));
	await serving;
	await setup.flush();

	expect(frames).toBeGreaterThan(0);
	setup.renderer.destroy();
});

test("revocation is armed while an oversized-terminal notice is waiting", async () => {
	const sessions = createKeyedSessions();
	const probe = shellProbe(400, 150);
	const serving = serveShell(probe.session, shellOptions(sessions), () =>
		Promise.resolve()
	);

	expect(probe.transcript()).toContain("400x150");
	expect(sessions.count(ACTOR)).toBe(1);
	expect(sessions.drop(ACTOR)).toBe(1);
	await serving;

	expect(probe.transcript()).toContain(REVOKED_SESSION_MESSAGE);
	expect(probe.ended()).toBe(true);
});

test("a table failure says the collapse message and still rejects", async () => {
	const sessions = createKeyedSessions();
	const probe = shellProbe(120, 40);
	const serving = serveShell(probe.session, shellOptions(sessions), () =>
		Promise.reject(new Error("openStore failed"))
	);

	await expect(serving).rejects.toThrow("openStore failed");
	expect(probe.transcript()).toContain("The table collapsed. Try again.\r\n");
	expect(probe.ended()).toBe(true);
	expect(sessions.count(ACTOR)).toBe(0);
});
