import { describe, expect, test } from "bun:test";

import { rateLimiter } from "../src/rate.ts";

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
});
