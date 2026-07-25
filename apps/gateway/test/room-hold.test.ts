import { describe, expect, test } from "bun:test";
/* oxlint-disable vitest/prefer-importing-vitest-globals, promise/avoid-new -- Bun-only suite: the gateway is Bun-bound, and the waits here are timers. */

import { createOfflineMetrics } from "../src/offline-metrics.js";
import {
	GRACE_WINDOW_MS,
	holdRoom,
	HOST_OFFLINE_NOTICE,
} from "../src/room-hold.js";

const tick = (ms = 12): Promise<void> =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});

describe("the grace window", () => {
	test("says nothing while the seat's own Host still carries the name", async () => {
		const attached = { name: "keep" };
		const notices: string[] = [];
		const hold = holdRoom({
			attached,
			graceMs: 20,
			live: () => attached,
			pollMs: 1,
		});
		hold.onNotice((message) => notices.push(message));

		await tick(20);

		expect(notices).toEqual([]);
		expect(hold.end()).toBeUndefined();
		hold.stop();
	});

	test("holds the seat with an honest notice, then returns it to the lobby", async () => {
		const attached = { name: "keep" };
		const notices: string[] = [];
		const metrics = createOfflineMetrics();
		let live: unknown = attached;
		const hold = holdRoom({
			attached,
			graceMs: 25,
			live: () => live,
			onGraceExpiry: () => metrics.recordGraceExpiry(),
			onHostDrop: () => metrics.recordHostDrop(),
			pollMs: 1,
		});
		hold.onNotice((message) => notices.push(message));

		live = undefined;
		await tick();
		expect(notices).toEqual([HOST_OFFLINE_NOTICE]);
		expect(hold.end()).toBeUndefined();
		expect(metrics.counts().hostDrops).toBe(1);

		await hold.until;

		expect(hold.end()).toBe("grace-expired");
		expect(metrics.counts().graceExpiries).toBe(1);
		hold.stop();
	});

	test("ends the hold the moment a Host takes the name back", async () => {
		const attached = { name: "keep" };
		const notices: string[] = [];
		const metrics = createOfflineMetrics();
		let live: unknown = attached;
		const hold = holdRoom({
			attached,
			graceMs: 5000,
			live: () => live,
			onGraceExpiry: () => metrics.recordGraceExpiry(),
			onHostDrop: () => metrics.recordHostDrop(),
			pollMs: 1,
		});
		hold.onNotice((message) => notices.push(message));

		live = undefined;
		await tick();
		live = { name: "keep" };
		await hold.until;

		expect(notices).toEqual([HOST_OFFLINE_NOTICE]);
		expect(hold.end()).toBe("host-returned");
		expect(metrics.counts().hostDrops).toBe(1);
		expect(metrics.counts().graceExpiries).toBe(0);
		hold.stop();
	});

	test("ends the hold when the fold drops this seat for falling behind", async () => {
		const attached = { name: "keep" };
		let drop: (() => void) | undefined;
		const dropped = new Promise<void>((resolve) => {
			drop = resolve;
		});
		const hold = holdRoom({
			attached,
			dropped,
			graceMs: 5000,
			live: () => attached,
			pollMs: 1,
		});

		drop?.();
		await hold.until;

		expect(hold.end()).toBe("dropped");
		hold.stop();
	});

	test("stops watching once the table is gone", async () => {
		const attached = { name: "keep" };
		const notices: string[] = [];
		let live: unknown = attached;
		const hold = holdRoom({
			attached,
			graceMs: 5,
			live: () => live,
			pollMs: 1,
		});
		hold.onNotice((message) => notices.push(message));

		hold.stop();
		live = undefined;
		await tick(20);

		expect(notices).toEqual([]);
		expect(hold.end()).toBeUndefined();
	});

	test("the default window is the pinned five minutes", () => {
		expect(GRACE_WINDOW_MS).toBe(5 * 60_000);
	});
});
