import { describe, expect, test } from "bun:test";
/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; the runner is the runtime claim. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { decide } from "../../games/fake/src/authority.js";
import { apply, init } from "../../games/fake/src/model.js";
import type { FakeEvent, FakeState } from "../../games/fake/src/model.js";
import { view } from "../../games/fake/src/view.js";
import { RoomHost } from "../../room-host/src/index.js";
import type { Envelope, HostRegistry, TableView } from "../src/index.js";

const table: TableView = {
	actor: "actor-guest",
	gmSeatId: "gm",
	seats: [
		{ actor: "actor-gm", characterId: null, id: "gm" },
		{ actor: "actor-guest", characterId: "hero", id: "guest" },
	],
};

describe("game module seam", () => {
	test("interleaves core and module envelopes in one log with opaque game state", () => {
		const log: Envelope[] = [
			{
				actor: "actor-gm",
				payload: { gameId: "fake" },
				seq: 1,
				timestamp: "2026-01-01T00:00:00.000Z",
				type: "core.room-created",
			},
			{
				actor: "actor-gm",
				payload: { seatId: "gm" },
				seq: 2,
				timestamp: "2026-01-01T00:00:01.000Z",
				type: "fake.seat-observed",
			},
		];
		const roomState: { game: unknown } = { game: init() };

		expect(log.map(({ type }) => type)).toEqual([
			"core.room-created",
			"fake.seat-observed",
		]);
		// oxlint-disable-next-line unicorn/prefer-structured-clone -- the JSON round-trip IS the conformance assertion: game state must survive JSON serialization
		expect(JSON.parse(JSON.stringify(roomState))).toEqual(roomState);
	});

	test("init is deterministic and decide rejects, reads TableView, and emits multiple events", () => {
		expect(init()).toEqual(init());
		expect(
			decide(init(), { reason: "not now", type: "fake.reject" }, table)
		).toEqual({
			message: "not now",
			rejected: true,
		});
		expect(
			decide(init(), { seatId: "missing", type: "fake.visit" }, table)
		).toMatchObject({
			rejected: true,
		});
		expect(
			decide(init(), { seatId: "guest", type: "fake.visit" }, table)
		).toEqual([
			{
				characterId: "hero",
				seatId: "guest",
				type: "fake.seat-observed",
			},
			{ type: "fake.visit-counted", visits: 1 },
		]);
	});

	test("crosses character bindings through host decide and fresh replay", async () => {
		const folder = await mkdtemp(
			path.join(tmpdir(), "supervillain-conformance-")
		);
		const registry: HostRegistry = {
			get: (gameId) =>
				gameId === "fake"
					? { authority: { decide }, model: { apply, init } }
					: undefined,
		};
		try {
			const host = await RoomHost.open({
				actor: "actor-gm",
				campaignFolder: folder,
				gameId: "fake",
				registry,
			});
			await host.submit({
				actor: "actor-guest",
				command: { type: "core.claim-seat" },
			});
			await host.submit({
				actor: "actor-guest",
				command: { characterId: "  hero  ", type: "core.bind-character" },
			});
			await host.submit({
				actor: "actor-guest",
				command: { seatId: "player-1", type: "fake.visit" },
			});
			const expected = host.snapshot();
			expect(expected.game).toEqual({
				lastCharacterId: "hero",
				lastSeatId: "player-1",
				visits: 1,
			});

			const replayed = await RoomHost.open({
				campaignFolder: folder,
				registry,
			});
			expect(replayed.snapshot()).toEqual(expected);
		} finally {
			await rm(folder, { force: true, recursive: true });
		}
	});

	test("panels render arrays and dispatch through their input", () => {
		const [panel] = view.panels;
		expect(panel).toBeDefined();
		if (panel === undefined) {
			return;
		}
		const dispatched: unknown[] = [];
		const input = {
			dispatch: (command: unknown) => dispatched.push(command),
			focused: false,
			state: init(),
			table,
		};
		expect(panel.render(input)).toEqual([
			{ runs: [{ text: "Visits: 0", token: "primary" }] },
		]);
		expect(panel.render({ ...input, focused: true })).toEqual([
			{ runs: [{ text: "Visits: 0 · v to visit", token: "primary" }] },
		]);
		expect(
			panel.onKey?.({ name: "v", text: "v" }, { ...input, focused: true })
		).toBe(true);
		expect(dispatched).toEqual([{ seatId: "guest", type: "fake.visit" }]);
	});

	test("replay is byte-identical", () => {
		const events: FakeEvent[] = [
			{
				characterId: "hero",
				seatId: "guest",
				type: "fake.seat-observed",
			},
			{ type: "fake.visit-counted", visits: 1 },
		];
		const replay = (): FakeState => {
			let state = init();
			for (const event of events) {
				state = apply(state, event);
			}
			return state;
		};

		expect(JSON.stringify(replay())).toBe(JSON.stringify(replay()));
	});
});
