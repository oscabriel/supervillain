/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; the gateway is Bun-bound by bun:sqlite. */
import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { CliRenderEvents, RendererControlState } from "@opentui/core";
import type { CliRenderer, KeyEvent } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { RoomView, RoomViewReservation } from "@supervillain/room-wire";

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
	injectedRenderer?: CliRenderer,
	bufferUntilEnd = false
): ShellProbe => {
	const stdin = new PassThrough();
	const closeListeners = new Set<() => void>();
	const resizeListeners = new Set<(cols: number, rows: number) => void>();
	const keypressListeners = new Set<(key: KeyEvent) => void>();
	let transcript = "";
	let pending = "";
	let ended = false;
	const close = (): void => {
		if (ended) {
			return;
		}
		transcript += pending;
		pending = "";
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
				if (bufferUntilEnd) {
					pending += data.toString();
					return;
				}
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

interface ReservationProbe {
	readonly reservation: RoomViewReservation;
	readonly opens: () => number;
	readonly releases: () => number;
}

const reservationProbe = (): ReservationProbe => {
	let held = true;
	let opens = 0;
	let releases = 0;
	return {
		opens: () => opens,
		releases: () => releases,
		reservation: {
			open: (): RoomView | undefined => {
				if (!held) {
					return;
				}
				held = false;
				opens += 1;
				return {} as RoomView;
			},
			release: () => {
				if (!held) {
					return;
				}
				held = false;
				releases += 1;
			},
		},
	};
};

const withLiveRoom = (
	sessions: ReturnType<typeof createKeyedSessions>,
	live: {
		readonly deliverLinks: () => Promise<void>;
		readonly reserveStore: () => RoomViewReservation | undefined;
	}
): Parameters<typeof serveShell>[1] => {
	const options = shellOptions(sessions);
	return {
		...options,
		rooms: {
			...options.rooms,
			metrics: { recordJoinAttempt: () => {} } as never,
			pipes: { live: () => live } as never,
			registry: { isClaimed: () => true } as never,
		},
	};
};

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

test("a lobby expiry drains its farewell before the session closes", async () => {
	const setup = await createTestRenderer({ height: 24, width: 80 });
	const sessions = createKeyedSessions();
	const probe = shellProbe(80, 24, setup.renderer, true);
	const base = shellOptions(sessions);
	const serving = serveShell(probe.session, {
		...base,
		limits: { ...base.limits, idleMs: 5, maxHoldMs: 1000 },
		rooms: {
			...base.rooms,
			metrics: { recordJoinAttempt: () => {} } as never,
			pipes: { live() {} } as never,
			registry: { isClaimed: () => false } as never,
		},
	});

	await serving;

	// The fake models @opentui/ssh's raw-write contract: write only queues the
	// bytes, and end drains that queue before announcing close. Seeing the text
	// after close therefore proves delivery rather than merely call order.
	expect(probe.ended()).toBe(true);
	expect(probe.transcript()).toContain(
		"the lobby went quiet, so we closed it. ssh back any time.\r\n"
	);
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

test("a disconnect releases an arrival reserved while links are in flight", async () => {
	const sessions = createKeyedSessions();
	const probe = shellProbe(120, 40);
	const links = Promise.withResolvers<boolean>();
	const reserved = reservationProbe();
	const serving = serveShell(
		probe.session,
		withLiveRoom(sessions, {
			deliverLinks: () => links.promise,
			reserveStore: () => reserved.reservation,
		})
	);

	await Bun.sleep(0);
	probe.session.end();
	expect(reserved.releases()).toBe(1);
	links.resolve(true);
	await serving;

	expect(reserved.opens()).toBe(0);
});

test("a link-delivery failure releases the reserved arrival", async () => {
	const sessions = createKeyedSessions();
	const probe = shellProbe(120, 40);
	const reserved = reservationProbe();
	const serving = serveShell(
		probe.session,
		withLiveRoom(sessions, {
			deliverLinks: () => Promise.reject(new Error("link delivery failed")),
			reserveStore: () => reserved.reservation,
		})
	);

	await expect(serving).rejects.toThrow("link delivery failed");
	expect(reserved.releases()).toBe(1);
	expect(reserved.opens()).toBe(0);
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
