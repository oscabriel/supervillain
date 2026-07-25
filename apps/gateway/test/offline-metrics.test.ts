import { describe, expect, test } from "bun:test";
/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite: the gateway is Bun-bound by bun:sqlite. */

import {
	createOfflineMetrics,
	OFFLINE_JOIN_TRIPWIRE,
} from "../src/offline-metrics.js";

describe("the offline tripwire's counters", () => {
	test("starts at zero, with no rate to read into", () => {
		const metrics = createOfflineMetrics();

		expect(metrics.counts()).toEqual({
			graceExpiries: 0,
			hostDrops: 0,
			offlineJoinAttempts: 0,
			registeredJoinAttempts: 0,
		});
		expect(metrics.offlineJoinRate()).toBe(0);
	});

	test("counts every join attempt and the share that found nobody home", () => {
		const metrics = createOfflineMetrics();

		metrics.recordJoinAttempt(true);
		metrics.recordJoinAttempt(true);
		metrics.recordJoinAttempt(true);
		metrics.recordJoinAttempt(false);

		expect(metrics.counts().registeredJoinAttempts).toBe(4);
		expect(metrics.counts().offlineJoinAttempts).toBe(1);
		expect(metrics.offlineJoinRate()).toBe(0.25);
		expect(metrics.offlineJoinRate()).toBeGreaterThan(OFFLINE_JOIN_TRIPWIRE);
	});

	test("counts mid-session host drops and grace-window expiries apart", () => {
		const metrics = createOfflineMetrics();

		metrics.recordHostDrop();
		metrics.recordHostDrop();
		metrics.recordGraceExpiry();

		expect(metrics.counts().hostDrops).toBe(2);
		expect(metrics.counts().graceExpiries).toBe(1);
	});

	test("hands out a copy, so a reader cannot edit the record", () => {
		const metrics = createOfflineMetrics();
		const before = metrics.counts();

		metrics.recordHostDrop();

		expect(before.hostDrops).toBe(0);
		expect(metrics.counts().hostDrops).toBe(1);
	});

	test("the tripwire is the pinned one-in-five line", () => {
		expect(OFFLINE_JOIN_TRIPWIRE).toBe(0.2);
	});
});
