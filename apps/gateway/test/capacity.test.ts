/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; the gateway is Bun-bound by bun:sqlite. */
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

import {
	arrivalNotice,
	capacityFromEnvironment,
	clampPtySize,
	DEFAULT_CAPACITY_LIMITS,
	isOversizedPty,
	oversizedTerminalNotice,
	PTY_LIBRARY_CEILING,
} from "../src/index.js";

const claimed = (
	...names: readonly string[]
): { isClaimed: (n: string) => boolean } => ({
	isClaimed: (name) => names.includes(name),
});

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

describe("what one arrival is told", () => {
	const limits = { sessionsPerRoom: 2 };

	test("a name nobody claimed, and a claimed name with no live pipe", () => {
		expect(arrivalNotice("ghost", undefined, claimed(), limits)).toEqual({
			kind: "unknown-room",
			roomName: "ghost",
		});
		expect(
			arrivalNotice("iron-keep", undefined, claimed("iron-keep"), limits)
		).toEqual({ kind: "offline-room", roomName: "iron-keep" });
	});

	test("a live Room with room to spare admits the arrival", () => {
		expect(
			arrivalNotice(
				"iron-keep",
				{ views: () => 1 },
				claimed("iron-keep"),
				limits
			)
		).toBeUndefined();
	});

	test("a full Room refuses at the lobby and never touches the live table", () => {
		let reads = 0;
		const live = {
			openStore: () => {
				throw new Error("A refused arrival must not open a view.");
			},
			views: () => {
				reads += 1;
				return 2;
			},
		};
		expect(
			arrivalNotice("iron-keep", live, claimed("iron-keep"), limits)
		).toEqual({ kind: "full-room", roomName: "iron-keep" });
		// One count read, and nothing else: no view opened, no seat disturbed.
		expect(reads).toBe(1);
	});
});
