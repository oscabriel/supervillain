/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-lane suite. */
import { describe, expect, test } from "bun:test";

import { formatSeatList } from "../src/chrome.js";

describe("table sidebar", () => {
	test("shows seats derived after a seat-claimed envelope", () => {
		expect(
			formatSeatList(
				{
					gmSeatId: "gm",
					seats: [
						{ actor: "gm-key", id: "gm" },
						{ actor: "player-key", id: "player-1" },
					],
				},
				"player-key"
			)
		).toBe("○ gm\n● player-1");
	});
});
