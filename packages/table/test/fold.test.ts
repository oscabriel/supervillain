/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-lane suite. */
import { describe, expect, test } from "bun:test";

import type { Envelope, TableView, ViewEntry } from "@supervillain/core";

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
const table: TableView = {
	gmSeatId: "gm",
	seats: [{ actor: "actor-key-long", id: "gm" }],
};
const envelope = (
	type: `${string}.${string}`,
	payload: unknown,
	actor = "actor-key-long"
): Envelope => ({ actor, payload, seq: 1, timestamp: "now", type });

describe("createTableFold", () => {
	test("renders core room, chat and dice envelopes with seat labels", () => {
		const fold = createTableFold(entry, table, "game");
		expect(
			fold.apply(envelope("core.room-created", { gameId: "game" }))
		).toEqual({ runs: [{ text: "room created · game", token: "muted" }] });
		expect(fold.apply(envelope("core.chat-posted", { text: "hello" }))).toEqual(
			{
				runs: [
					{ text: "gm: ", token: "accent" },
					{ text: "hello", token: "primary" },
				],
			}
		);
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
				{ text: "gm", token: "accent" },
				{ text: " rolled 2d6+1 → 2, 5 = ", token: "primary" },
				{ text: "8", token: "success" },
			],
		});
		expect(fold.apply(envelope("core.future", {}))).toBeNull();
	});

	test("applies game envelopes before rendering and shortens unknown actors", () => {
		const fold = createTableFold(entry, table, "game");
		expect(
			fold.apply(envelope("game.counted", { count: 3 }, "1234567890"))
		).toEqual({ runs: [{ text: "game.counted:3", token: "primary" }] });
		expect(fold.state()).toEqual({ count: 3 });
		expect(fold.actorLabel("1234567890")).toBe("12345678");
	});
});
