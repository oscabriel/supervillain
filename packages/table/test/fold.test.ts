/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-lane suite. */
import { describe, expect, test } from "bun:test";

import type { Envelope, ViewEntry } from "@supervillain/core";

import {
	createTableCheckpointProducer,
	readTableCheckpoint,
} from "../src/checkpoint.js";
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
	test("checkpoint plus tail is exactly equivalent to full replay", () => {
		const log = [
			envelope("core.room-created", { gameId: "game" }, "gm-key", 1),
			envelope(
				"core.seat-claimed",
				{ seatId: "player-1" },
				"guest:abcdef123456",
				2
			),
			envelope(
				"core.actor-linked",
				{ linked: "guest:abcdef123456" },
				"player-key",
				3
			),
			envelope("game.counted", { count: 4 }, "player-key", 4),
			envelope(
				"core.map-loaded",
				{ legend: { ".": "floor" }, name: "Hall", rows: ["..", ".."] },
				"gm-key",
				5
			),
			envelope(
				"core.token-placed",
				{
					glyph: "@",
					id: "hero",
					label: "Hero",
					seatId: "player-1",
					x: 1,
					y: 1,
				},
				"gm-key",
				6
			),
			envelope(
				"core.character-bound",
				{ characterId: "missing", seatId: "unknown" },
				"gm-key",
				7
			),
			envelope(
				"core.chat-posted",
				{ text: "still here" },
				"guest:abcdef123456",
				8
			),
		] as const;
		const full = createTableFold(entry, "game", "player-key");
		const fullFeed = log.flatMap((next) => {
			const line = full.apply(next);
			return line === null ? [] : [line];
		});
		const fullWarning = full.endReplay();
		if (fullWarning !== null) {
			fullFeed.push(fullWarning);
		}

		const producer = createTableCheckpointProducer(entry, "game");
		for (const next of log.slice(0, 5)) {
			producer.apply(next);
		}
		const checkpoint = readTableCheckpoint<State>(producer.capture());
		const restored = createTableFold(
			entry,
			"game",
			"player-key",
			checkpoint.fold
		);
		const checkpointFeed = [...checkpoint.feed];
		for (const next of log.slice(5)) {
			const line = restored.apply(next);
			if (line !== null) {
				checkpointFeed.push(line);
			}
		}
		const checkpointWarning = restored.endReplay();
		if (checkpointWarning !== null) {
			checkpointFeed.push(checkpointWarning);
		}

		expect(checkpointFeed).toEqual(fullFeed);
		expect(restored.state()).toEqual(full.state());
		expect(restored.table()).toEqual(full.table());
		expect(restored.map()).toEqual(full.map());
		expect(restored.tokens()).toEqual(full.tokens());
		expect(restored.skips()).toEqual(full.skips());
		expect(restored.sameActor("guest:abcdef123456", "player-key")).toBe(
			full.sameActor("guest:abcdef123456", "player-key")
		);
	});

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
			runs: [{ attrs: ["dim"], text: "gm joined the table", token: "muted" }],
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
				{ attrs: ["bold"], text: "gm: ", token: "accent" },
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
		).toEqual({
			runs: [{ attrs: ["dim"], text: "room created · game", token: "muted" }],
		});
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
				{ attrs: ["bold"], text: "actor-ke", token: "accent" },
				{ text: " rolled 2d6+1 → 2, 5 = ", token: "primary" },
				{ attrs: ["bold"], text: "8", token: "success" },
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
		).toEqual({
			runs: [{ attrs: ["dim"], text: "map loaded · Hall", token: "muted" }],
		});
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
		).toEqual({
			runs: [{ attrs: ["dim"], text: "map cleared", token: "muted" }],
		});
		expect(fold.map()).toBeNull();
	});

	test("folds tokens over the map without spending a feed line on them", () => {
		const fold = createTableFold(entry, "game", "viewer-key");
		fold.endReplay();
		fold.apply(
			envelope(
				"core.map-loaded",
				{ legend: { ".": "floor" }, name: "Hall", rows: ["...", "..."] },
				"gm-key",
				1
			)
		);
		expect(
			fold.apply(
				envelope(
					"core.token-placed",
					{
						glyph: "@",
						id: "token-1",
						label: "Kraan",
						seatId: null,
						x: 1,
						y: 1,
					},
					"gm-key",
					2
				)
			)
		).toBeNull();
		expect(fold.tokens()).toEqual([
			{ glyph: "@", id: "token-1", label: "Kraan", seatId: null, x: 1, y: 1 },
		]);
		fold.apply(
			envelope("core.token-moved", { id: "token-1", x: 2, y: 0 }, "gm-key", 3)
		);
		expect(fold.tokens()[0]).toMatchObject({ x: 2, y: 0 });
		fold.apply(envelope("core.token-removed", { id: "token-1" }, "gm-key", 4));
		expect(fold.tokens()).toEqual([]);
	});

	test("clears the surface when the map is cleared or replaced", () => {
		const fold = createTableFold(entry, "game", "viewer-key");
		fold.endReplay();
		const load = (name: string, seq: number): void => {
			fold.apply(
				envelope(
					"core.map-loaded",
					{ legend: { ".": "floor" }, name, rows: ["...", "..."] },
					"gm-key",
					seq
				)
			);
		};
		const place = (seq: number): void => {
			fold.apply(
				envelope(
					"core.token-placed",
					{ glyph: "@", id: "token-1", label: "", seatId: null, x: 0, y: 0 },
					"gm-key",
					seq
				)
			);
		};
		load("Hall", 1);
		place(2);
		load("Bog", 3);
		expect(fold.tokens()).toEqual([]);
		place(4);
		fold.apply(envelope("core.map-cleared", {}, "gm-key", 5));
		expect(fold.tokens()).toEqual([]);
	});

	test("skips a known-invalid token event loudly without halting", () => {
		const fold = createTableFold(entry, "game", "viewer-key");
		fold.endReplay();
		expect(
			fold.apply(
				envelope("core.token-moved", { id: "token-1", x: 0, y: 0 }, "a", 6)
			)
		).toEqual({
			runs: [
				{
					text: "⚠ skipped event #6 (core.token-moved): no map is loaded",
					token: "danger",
				},
			],
		});
		expect(fold.tokens()).toEqual([]);
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
				{ attrs: ["bold"], text: "a: ", token: "accent" },
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
				{ attrs: ["bold"], text: "a: ", token: "accent" },
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
