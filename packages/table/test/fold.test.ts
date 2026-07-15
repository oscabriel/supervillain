/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-lane suite. */
import { describe, expect, test } from "bun:test";

import type { Envelope, ViewEntry } from "@supervillain/core";

import { createTableFold } from "../src/fold.js";

interface State {
	count: number;
}
interface Event {
	type: "game.counted";
	count: number;
}
const entry: ViewEntry<State, unknown, Event> = {
	model: {
		apply: (_state, event) => ({ count: event.count }),
		init: () => ({ count: 0 }),
	},
	view: {
		panels: [],
		renderEvent: (event, state) => ({
			runs: [{ text: `${event.type}:${state.count}`, token: "primary" }],
		}),
	},
};
const envelope = (
	type: `${string}.${string}`,
	payload: unknown,
	actor = "actor-key-long",
	seq = 1
): Envelope => ({ actor, payload, seq, timestamp: "now", type });

describe("createTableFold", () => {
	test("derives seats, renders their feed line, and uses live actor labels", () => {
		const fold = createTableFold(entry, "game", "viewer-key");
		expect(fold.table()).toEqual({
			actor: "viewer-key",
			gmSeatId: "gm",
			seats: [],
		});
		expect(
			fold.apply(
				envelope("core.seat-claimed", { seatId: "gm" }, "actor-key-long", 2)
			)
		).toEqual({
			runs: [{ text: "gm joined the table", token: "muted" }],
		});
		expect(fold.table()).toEqual({
			actor: "viewer-key",
			gmSeatId: "gm",
			seats: [{ actor: "actor-key-long", id: "gm" }],
		});
		expect(fold.actorLabel("actor-key-long")).toBe("gm");
		expect(
			fold.apply(
				envelope("core.chat-posted", { text: "hello" }, "actor-key-long", 3)
			)
		).toEqual({
			runs: [
				{ text: "gm: ", token: "accent" },
				{ text: "hello", token: "primary" },
			],
		});
	});

	test("renders core room and dice envelopes", () => {
		const fold = createTableFold(entry, "game", "viewer-key");
		expect(
			fold.apply(envelope("core.room-created", { gameId: "game" }))
		).toEqual({ runs: [{ text: "room created · game", token: "muted" }] });
		expect(
			fold.apply(
				envelope("core.dice-rolled", {
					modifier: 1,
					notation: "2d6+1",
					rolls: [2, 5],
					total: 8,
				})
			)
		).toEqual({
			runs: [
				{ text: "actor-ke", token: "accent" },
				{ text: " rolled 2d6+1 → 2, 5 = ", token: "primary" },
				{ text: "8", token: "success" },
			],
		});
		expect(fold.apply(envelope("core.future", {}))).toBeNull();
	});

	test("applies game envelopes before rendering and shortens unknown actors", () => {
		const fold = createTableFold(entry, "game", "viewer-key");
		expect(
			fold.apply(envelope("game.counted", { count: 3 }, "1234567890"))
		).toEqual({ runs: [{ text: "game.counted:3", token: "primary" }] });
		expect(fold.state()).toEqual({ count: 3 });
		expect(fold.actorLabel("1234567890")).toBe("12345678");
	});
});
