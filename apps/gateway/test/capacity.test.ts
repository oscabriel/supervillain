/* oxlint-disable vitest/prefer-importing-vitest-globals, promise/avoid-new -- Bun-only suite; the gateway is Bun-bound by bun:sqlite, and the quiet fold source intentionally parks forever. */
/**
 * The protective caps (ADR-0012, NQ-10) and the production PTY cap (NQ-14).
 *
 * Two rules are asserted here rather than described: every number is
 * ops-tunable from the environment, and a cap that is reached refuses the
 * *next* arrival without touching the table already sitting there.
 *
 * The byte/stall halves of R9's envelope-lag budget are not here any more: they
 * rode `attachSshChannel`, and `@opentui/ssh` owns channel backpressure now
 * (#62). The envelope half (`sessionBudget`) still drops a lagging view, and
 * that path is exercised in the room-wire capacity suite.
 */
import { describe, expect, test } from "bun:test";

import { createRoomFold } from "@supervillain/room-wire";
import type { RoomView } from "@supervillain/room-wire";

import {
	reserveArrival,
	capacityFromEnvironment,
	clampPtySize,
	DEFAULT_CAPACITY_LIMITS,
	isOversizedPty,
	oversizedTerminalNotice,
	PTY_LIBRARY_CEILING,
} from "../src/index.js";

const claimed = (...names: readonly string[]) => ({
	isClaimed: (name: string) => names.includes(name),
});

const quietStream = (): AsyncIterable<never> => ({
	[Symbol.asyncIterator]: () => ({
		next: () => new Promise<IteratorResult<never>>(() => {}),
	}),
});

const isRoomView = (result: unknown): result is RoomView =>
	typeof result === "object" && result !== null && "close" in result;

describe("capacity from the environment", () => {
	test("an empty environment is the benchmark's chosen defaults", () => {
		expect(capacityFromEnvironment({}).limits).toEqual(DEFAULT_CAPACITY_LIMITS);
	});

	test("every cap is an operator's to turn", () => {
		const capacity = capacityFromEnvironment({
			SUPERVILLAIN_GATEWAY_DOOR_SESSIONS_GLOBAL: "40",
			SUPERVILLAIN_GATEWAY_DOOR_SESSIONS_PER_CONNECTION: "2",
			SUPERVILLAIN_GATEWAY_LOBBY_CONNECTIONS_PER_WINDOW: "17",
			SUPERVILLAIN_GATEWAY_LOBBY_IDLE_MS: "90000",
			SUPERVILLAIN_GATEWAY_LOBBY_MAX_MS: "120000",
			SUPERVILLAIN_GATEWAY_LOBBY_WINDOW_MS: "30000",
			SUPERVILLAIN_GATEWAY_PTY_COLUMNS: "200",
			SUPERVILLAIN_GATEWAY_PTY_ROWS: "60",
			SUPERVILLAIN_GATEWAY_ROOMS_PER_IDENTITY: "3",
			SUPERVILLAIN_GATEWAY_SESSIONS_PER_ROOM: "12",
			SUPERVILLAIN_GATEWAY_SESSION_BUDGET: "64",
		});
		expect(capacity.limits).toEqual({
			doorSessionsGlobal: 40,
			doorSessionsPerConnection: 2,
			pty: { columns: 200, rows: 60 },
			roomsPerIdentity: 3,
			sessionBudget: 64,
			sessionsPerRoom: 12,
		});
		expect(capacity.lobby).toEqual({
			connectionsPerWindow: 17,
			idleMs: 90_000,
			maxHoldMs: 120_000,
			windowMs: 30_000,
		});
	});

	test("a value that cannot be used is refused by name, never ignored", () => {
		expect(() =>
			capacityFromEnvironment({
				SUPERVILLAIN_GATEWAY_SESSIONS_PER_ROOM: "lots",
			})
		).toThrow("SUPERVILLAIN_GATEWAY_SESSIONS_PER_ROOM");
		expect(() =>
			capacityFromEnvironment({ SUPERVILLAIN_GATEWAY_ROOMS_PER_IDENTITY: "0" })
		).toThrow("1 or more");
	});

	test("the PTY cap may never be raised past the library's own ceiling", () => {
		expect(() =>
			capacityFromEnvironment({
				SUPERVILLAIN_GATEWAY_PTY_COLUMNS: String(
					PTY_LIBRARY_CEILING.columns + 1
				),
			})
		).toThrow("ceiling");
		expect(DEFAULT_CAPACITY_LIMITS.pty.columns).toBeLessThan(
			PTY_LIBRARY_CEILING.columns
		);
		expect(DEFAULT_CAPACITY_LIMITS.pty.rows).toBeLessThan(
			PTY_LIBRARY_CEILING.rows
		);
	});
});

describe("the PTY cap", () => {
	test("an oversized terminal is capped, never refused, and told the numbers", () => {
		const cap = { columns: 300, rows: 100 };
		const asked = { columns: 520, rows: 210 };
		expect(isOversizedPty(asked, cap)).toBe(true);
		expect(clampPtySize(asked, cap)).toEqual(cap);
		const notice = oversizedTerminalNotice(asked, cap);
		expect(notice).toContain("520x210");
		expect(notice).toContain("300x100");
	});

	test("an ordinary window is left exactly as it asked", () => {
		const cap = { columns: 300, rows: 100 };
		expect(isOversizedPty({ columns: 120, rows: 40 }, cap)).toBe(false);
		expect(clampPtySize({ columns: 120, rows: 40 }, cap)).toEqual({
			columns: 120,
			rows: 40,
		});
	});
});

describe("the sessions-per-Room bound", () => {
	test("admits exactly one of many simultaneous arrivals racing for one slot", async () => {
		const fold = createRoomFold({
			source: {
				close: () => Promise.resolve(),
				info: () => Promise.resolve({ gameId: "fake", label: "the table" }),
				openSubmit: () => ({
					close: () => {},
					send: () => Promise.resolve({ accepted: true, envelopes: [] }),
				}),
				stream: quietStream,
			},
		});
		const seated = Array.from({ length: 31 }, () => fold.openView());
		const live = {
			deliverLinks: async () => {
				await Promise.resolve();
			},
			reserveStore: fold.reserveView,
		};
		const starting = Promise.withResolvers<boolean>();
		const attempts = Array.from({ length: 20 }, async () => {
			await starting.promise;
			const decision = reserveArrival("iron-keep", live, claimed("iron-keep"), {
				sessionsPerRoom: 32,
			});
			if (decision.kind !== "admitted") {
				return decision;
			}
			await live.deliverLinks();
			return decision.reservation.open();
		});
		starting.resolve(true);
		const results = await Promise.all(attempts);
		const admitted = results.filter(isRoomView);
		const refused = results.filter(
			(result) => result !== undefined && "kind" in result
		);

		expect(admitted).toHaveLength(1);
		expect(refused).toHaveLength(19);
		for (const refusal of refused) {
			expect(refusal).toEqual({
				kind: "full-room",
				roomName: "iron-keep",
			});
		}
		expect(fold.views()).toBe(32);

		await Promise.all(admitted.map((view) => view.close()));
		await Promise.all(seated.map((view) => view.close()));
		await fold.close();
	});
});

describe("what one arrival is told", () => {
	const limits = { sessionsPerRoom: 2 };

	test("a name nobody claimed, and a claimed name with no live pipe", () => {
		expect(reserveArrival("ghost", undefined, claimed(), limits)).toEqual({
			kind: "unknown-room",
			roomName: "ghost",
		});
		expect(
			reserveArrival("iron-keep", undefined, claimed("iron-keep"), limits)
		).toEqual({ kind: "offline-room", roomName: "iron-keep" });
	});

	test("a live Room with room to spare admits the arrival", () => {
		let released = false;
		const arrival = reserveArrival(
			"iron-keep",
			{
				reserveStore: () => ({
					// oxlint-disable-next-line unicorn/no-useless-undefined -- the fake reservation is released, never opened.
					open: () => undefined,
					release: () => {
						released = true;
					},
				}),
			},
			claimed("iron-keep"),
			limits
		);
		expect(arrival.kind).toBe("admitted");
		if (arrival.kind === "admitted") {
			arrival.reservation.release();
		}
		expect(released).toBe(true);
	});

	test("a full Room refuses at the lobby and never touches the live table", () => {
		let attempts = 0;
		const live = {
			reserveStore: () => {
				attempts += 1;
				// oxlint-disable-next-line unicorn/no-useless-undefined -- this fake models a failed reservation.
				return undefined;
			},
		};
		expect(
			reserveArrival("iron-keep", live, claimed("iron-keep"), limits)
		).toEqual({ kind: "full-room", roomName: "iron-keep" });
		// One atomic attempt, and nothing else: no reservation, view, or fold entry.
		expect(attempts).toBe(1);
	});
});
