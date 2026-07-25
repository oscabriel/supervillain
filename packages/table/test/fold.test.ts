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
// A module fold skips what its grammar does not recognize, silently — the
// double has to do the same or the unknown tier cannot be observed here.
const entry: ViewEntry<State, unknown, Event> = {
	model: {
		apply: (state, event) =>
			event.type === "game.counted" ? { count: event.count } : state,
		init: () => ({ count: 0 }),
	},
	view: {
		createPanels: () => [],
		renderEvent: (event, state) =>
			event.type === "game.counted"
				? {
						runs: [{ text: `${event.type}:${state.count}`, token: "primary" }],
					}
				: null,
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
			seats: [{ actor: "actor-key-long", characterId: null, id: "gm" }],
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

	test("folds character bindings last-write-wins and skips unknown seats", () => {
		const fold = createTableFold(entry, "game", "viewer-key");
		fold.endReplay();
		fold.apply(
			envelope("core.seat-claimed", { seatId: "gm" }, "actor-key-long", 2)
		);
		expect(
			fold.apply(
				envelope(
					"core.character-bound",
					{ characterId: "hero", seatId: "gm" },
					"actor-key-long",
					3
				)
			)
		).toBeNull();
		expect(fold.table().seats[0]?.characterId).toBe("hero");
		fold.apply(
			envelope(
				"core.character-bound",
				{ characterId: null, seatId: "gm" },
				"actor-key-long",
				4
			)
		);
		expect(fold.table().seats[0]?.characterId).toBeNull();
		expect(
			fold.apply(
				envelope(
					"core.character-bound",
					{ characterId: "ignored", seatId: "ramona" },
					"actor-key-long",
					42
				)
			)
		).toEqual({
			runs: [
				{
					text: "⚠ skipped event #42 (core.character-bound): unknown seat 'ramona'",
					token: "danger",
				},
			],
		});
		expect(fold.skips()).toEqual([
			{
				reason: "unknown seat 'ramona'",
				seq: 42,
				type: "core.character-bound",
			},
		]);
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

	test("folds the map from the log alone and lets the last load win", () => {
		const fold = createTableFold(entry, "game", "viewer-key");
		expect(fold.map()).toBeNull();
		expect(
			fold.apply(
				envelope(
					"core.map-loaded",
					{
						legend: { "#": "wall", ".": "floor" },
						name: "Hall",
						rows: ["#.#"],
					},
					"actor-key-long",
					2
				)
			)
		).toEqual({ runs: [{ text: "map loaded · Hall", token: "muted" }] });
		expect(fold.map()).toEqual({
			legend: { "#": "wall", ".": "floor" },
			name: "Hall",
			rows: ["#.#"],
		});
		fold.apply(
			envelope(
				"core.map-loaded",
				{ legend: { o: "floor" }, name: "Bog", rows: ["oo", "oo"] },
				"actor-key-long",
				3
			)
		);
		expect(fold.map()).toEqual({
			legend: { o: "floor" },
			name: "Bog",
			rows: ["oo", "oo"],
		});
		expect(
			fold.apply(envelope("core.map-cleared", {}, "actor-key-long", 4))
		).toEqual({ runs: [{ text: "map cleared", token: "muted" }] });
		expect(fold.map()).toBeNull();
	});

	test("skips a known-invalid map payload loudly without halting", () => {
		const fold = createTableFold(entry, "game", "viewer-key");
		// Past the replay window, so the skip speaks for itself instead of being
		// held back for the collapsed summary (ADR-0010).
		fold.endReplay();
		expect(
			fold.apply(
				envelope(
					"core.map-loaded",
					{ legend: { ".": "floor" }, name: "Hall", rows: ["..", "."] },
					"actor-key-long",
					7
				)
			)
		).toEqual({
			runs: [
				{
					text: "⚠ skipped event #7 (core.map-loaded): map payload is not a valid map",
					token: "danger",
				},
			],
		});
		expect(fold.map()).toBeNull();
		expect(
			fold.apply(envelope("core.chat-posted", { text: "still here" }, "a", 8))
		).toEqual({
			runs: [
				{ text: "a: ", token: "accent" },
				{ text: "still here", token: "primary" },
			],
		});
	});

	test("applies game envelopes before rendering and shortens unknown actors", () => {
		const fold = createTableFold(entry, "game", "viewer-key");
		expect(
			fold.apply(envelope("game.counted", { count: 3 }, "1234567890"))
		).toEqual({ runs: [{ text: "game.counted:3", token: "primary" }] });
		expect(fold.state()).toEqual({ count: 3 });
		expect(fold.actorLabel("1234567890")).toBe("12345678");
	});

	test("skips unknown types silently and never halts on them", () => {
		const fold = createTableFold(entry, "game", "viewer-key");
		fold.endReplay();
		expect(
			fold.apply(
				envelope("core.written-by-a-newer-host", { name: "keep" }, "a", 7)
			)
		).toBeNull();
		expect(
			fold.apply(envelope("game.unheard-of", { count: 9 }, "a", 8))
		).toBeNull();
		expect(fold.skips()).toEqual([]);
	});

	test("skips malformed payloads on recognized core types loudly", () => {
		const fold = createTableFold(entry, "game", "viewer-key");
		fold.endReplay();
		expect(
			fold.apply(envelope("core.room-created", { gameId: 7 }, "a", 1))
		).toEqual({
			runs: [
				{
					text: "⚠ skipped event #1 (core.room-created): no game id",
					token: "danger",
				},
			],
		});
		expect(fold.apply(envelope("core.seat-claimed", {}, "a", 2))).toEqual({
			runs: [
				{
					text: "⚠ skipped event #2 (core.seat-claimed): no seat id",
					token: "danger",
				},
			],
		});
		expect(
			fold.apply(envelope("core.chat-posted", { text: 3 }, "a", 3))
		).toEqual({
			runs: [
				{
					text: "⚠ skipped event #3 (core.chat-posted): no chat text",
					token: "danger",
				},
			],
		});
		expect(
			fold.apply(
				envelope("core.dice-rolled", { notation: "2d6", rolls: "x" }, "a", 4)
			)
		).toEqual({
			runs: [
				{
					text: "⚠ skipped event #4 (core.dice-rolled): malformed dice roll",
					token: "danger",
				},
			],
		});
		expect(
			fold.apply(envelope("core.character-bound", { seatId: 1 }, "a", 5))
		).toEqual({
			runs: [
				{
					text: "⚠ skipped event #5 (core.character-bound): malformed character binding",
					token: "danger",
				},
			],
		});
		expect(fold.table().seats).toEqual([]);
		expect(fold.skips()).toHaveLength(5);
	});

	test("skips duplicate seat claims loudly and keeps the first seat", () => {
		const fold = createTableFold(entry, "game", "viewer-key");
		fold.endReplay();
		fold.apply(envelope("core.seat-claimed", { seatId: "gm" }, "actor-a", 1));
		expect(
			fold.apply(envelope("core.seat-claimed", { seatId: "gm" }, "actor-b", 2))
		).toEqual({
			runs: [
				{
					text: "⚠ skipped event #2 (core.seat-claimed): seat 'gm' is already claimed",
					token: "danger",
				},
			],
		});
		expect(
			fold.apply(
				envelope("core.seat-claimed", { seatId: "player-1" }, "actor-a", 3)
			)
		).toEqual({
			runs: [
				{
					text: "⚠ skipped event #3 (core.seat-claimed): gm already holds a seat",
					token: "danger",
				},
			],
		});
		expect(fold.table().seats).toEqual([
			{ actor: "actor-a", characterId: null, id: "gm" },
		]);
	});

	test("skips a non-object game payload loudly", () => {
		const fold = createTableFold(entry, "game", "viewer-key");
		fold.endReplay();
		expect(fold.apply(envelope("game.counted", "nope", "a", 11))).toEqual({
			runs: [
				{
					text: "⚠ skipped event #11 (game.counted): payload is not an object",
					token: "danger",
				},
			],
		});
		expect(fold.state()).toEqual({ count: 0 });
	});

	test("collapses a replay burst into one summary and stays alive", () => {
		const fold = createTableFold(entry, "game", "viewer-key");
		for (const seq of [42, 43, 44]) {
			expect(
				fold.apply(
					envelope(
						"core.character-bound",
						{ characterId: "x", seatId: "ramona" },
						"a",
						seq
					)
				)
			).toBeNull();
		}
		expect(
			fold.apply(envelope("core.chat-posted", { text: "still here" }, "a", 45))
		).toEqual({
			runs: [
				{ text: "a: ", token: "accent" },
				{ text: "still here", token: "primary" },
			],
		});
		expect(fold.endReplay()).toEqual({
			runs: [
				{
					text: "⚠ 3 events skipped during replay (first: #42 core.character-bound — unknown seat 'ramona')",
					token: "danger",
				},
			],
		});
		expect(fold.endReplay()).toBeNull();
	});

	test("a lone replay skip keeps its own warning line", () => {
		const fold = createTableFold(entry, "game", "viewer-key");
		fold.apply(
			envelope(
				"core.character-bound",
				{ characterId: null, seatId: "ramona" },
				"a",
				42
			)
		);
		expect(fold.endReplay()).toEqual({
			runs: [
				{
					text: "⚠ skipped event #42 (core.character-bound): unknown seat 'ramona'",
					token: "danger",
				},
			],
		});
	});

	test("a clean replay produces no summary", () => {
		const fold = createTableFold(entry, "game", "viewer-key");
		fold.apply(envelope("core.room-created", { gameId: "game" }, "a", 1));
		expect(fold.endReplay()).toBeNull();
	});
});
