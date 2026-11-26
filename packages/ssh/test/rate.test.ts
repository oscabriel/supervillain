import { describe, expect, test } from "bun:test";

import { rateLimiter } from "../src/rate.ts";

const MANY = 2000;

const counted = () => {
	const seen = { reads: 0 };

	const rate = {
		get burst() {
			seen.reads += 1;

			return 2;
		},
		perSecond: 1,
	};

	return { rate, seen };
};

describe("rateLimiter", () => {
	test("spends a burst, then refills at the rate, never past the burst", () => {
		const take = rateLimiter({ burst: 2, perSecond: 1 });
		expect([take("a", 0), take("a", 0), take("a", 0)]).toEqual([
			true,
			true,
			false,
		]);
		expect(take("b", 0)).toBe(true);
		expect([take("a", 1000), take("a", 1000)]).toEqual([true, false]);
		expect([take("a", 60_000), take("a", 60_000), take("a", 60_000)]).toEqual([
			true,
			true,
			false,
		]);
	});

	test("a clock set back takes no tokens away", () => {
		const take = rateLimiter({ burst: 2, perSecond: 1 });
		expect(take("a", 3_600_000)).toBe(true);
		expect([take("a", 0), take("a", 0)]).toEqual([true, false]);
		expect(take("a", 1000)).toBe(true);
	});

	test("past its thousandth key it sweeps once a second, not on every call", () => {
		const { rate, seen } = counted();
		const take = rateLimiter(rate);

		for (let i = 0; i < MANY; i += 1) {
			take(`k${i}`, 0);
		}

		seen.reads = 0;
		take("k0", 0);
		expect(seen.reads).toBeLessThan(8);

		seen.reads = 0;
		take("k0", 1000);
		expect(seen.reads).toBeGreaterThan(MANY);

		seen.reads = 0;
		take("k1", 1000);
		expect(seen.reads).toBeLessThan(8);
	});

	test("a sweep forgets only keys that are full again", () => {
		const take = rateLimiter({ burst: 2, perSecond: 1 });
		expect([take("a", 0), take("a", 0), take("a", 0)]).toEqual([
			true,
			true,
			false,
		]);

		for (let i = 0; i < MANY; i += 1) {
			take(`k${i}`, 0);
		}

		expect(take("a", 0)).toBe(false);
		expect([take("a", 1000), take("a", 1000)]).toEqual([true, false]);
		expect([
			take("k0", 60_000),
			take("k0", 60_000),
			take("k0", 60_000),
		]).toEqual([true, true, false]);
	});
});
