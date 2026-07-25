/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; the gateway is Bun-bound by bun:sqlite. */
import { describe, expect, test } from "bun:test";

import {
	createConnectionRateLimiter,
	createLobbyDeadlines,
	DEFAULT_LOBBY_LIMITS,
	LOBBY_EXPIRY_MESSAGE,
} from "../src/hardening.js";

const sleep = (ms: number): Promise<void> =>
	// oxlint-disable-next-line promise/avoid-new -- a bare timer needs the constructor.
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

describe("per-IP connection rate limiting", () => {
	test("admits up to the window's allowance and refuses the rest", () => {
		let now = 0;
		const limiter = createConnectionRateLimiter({
			limits: { connectionsPerWindow: 3, windowMs: 1000 },
			now: () => now,
		});
		expect(limiter.admit("10.0.0.1")).toBe(true);
		expect(limiter.admit("10.0.0.1")).toBe(true);
		expect(limiter.admit("10.0.0.1")).toBe(true);
		expect(limiter.admit("10.0.0.1")).toBe(false);
		// A different IP is unaffected by its neighbour's squatting.
		expect(limiter.admit("10.0.0.2")).toBe(true);
		now += 1001;
		expect(limiter.admit("10.0.0.1")).toBe(true);
	});

	test("the default limits are a working configuration", () => {
		const limiter = createConnectionRateLimiter({
			limits: DEFAULT_LOBBY_LIMITS,
		});
		expect(limiter.admit("10.0.0.1")).toBe(true);
	});
});

describe("lobby deadlines", () => {
	test("expires an idle lobby and names the reason", async () => {
		const reasons: string[] = [];
		const deadlines = createLobbyDeadlines({
			limits: { idleMs: 15, maxHoldMs: 10_000 },
			onExpire: (reason) => reasons.push(reason),
		});
		deadlines.hold();
		await sleep(40);
		expect(reasons).toEqual(["idle"]);
		expect(LOBBY_EXPIRY_MESSAGE.idle).toContain("ssh back");
	});

	test("a keystroke resets the idle timer", async () => {
		const reasons: string[] = [];
		const deadlines = createLobbyDeadlines({
			limits: { idleMs: 40, maxHoldMs: 10_000 },
			onExpire: (reason) => reasons.push(reason),
		});
		deadlines.hold();
		await sleep(25);
		deadlines.touch();
		await sleep(25);
		expect(reasons).toEqual([]);
		deadlines.release();
	});

	test("the max deadline fires however busily the visitor types", async () => {
		const reasons: string[] = [];
		const deadlines = createLobbyDeadlines({
			limits: { idleMs: 10_000, maxHoldMs: 20 },
			onExpire: (reason) => reasons.push(reason),
		});
		deadlines.hold();
		deadlines.touch();
		await sleep(50);
		expect(reasons).toEqual(["max"]);
	});

	test("release stops the clock while a room holds the terminal", async () => {
		const reasons: string[] = [];
		const deadlines = createLobbyDeadlines({
			limits: { idleMs: 15, maxHoldMs: 15 },
			onExpire: (reason) => reasons.push(reason),
		});
		deadlines.hold();
		deadlines.release();
		await sleep(40);
		expect(reasons).toEqual([]);
	});

	test("re-entering the lobby does not extend the max deadline", async () => {
		const reasons: string[] = [];
		const deadlines = createLobbyDeadlines({
			limits: { idleMs: 10_000, maxHoldMs: 30 },
			onExpire: (reason) => reasons.push(reason),
		});
		deadlines.hold();
		await sleep(20);
		deadlines.release();
		deadlines.hold();
		await sleep(30);
		expect(reasons).toEqual(["max"]);
	});
});
