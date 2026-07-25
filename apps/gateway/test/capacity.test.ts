/* oxlint-disable vitest/prefer-importing-vitest-globals, promise/avoid-new -- Bun-only suite; the gateway is Bun-bound by bun:sqlite, and the waits here are timers. */
/**
 * The protective caps (ADR-0012, NQ-10) and the production PTY cap (NQ-14).
 *
 * Two rules are asserted here rather than described: every number is
 * ops-tunable from the environment, and a cap that is reached refuses the
 * *next* arrival without touching the table already sitting there.
 */
import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import {
	arrivalNotice,
	capacityFromEnvironment,
	clampPtySize,
	DEFAULT_CAPACITY_LIMITS,
	isOversizedPty,
	oversizedTerminalNotice,
	PTY_LIBRARY_CEILING,
} from "../src/index.js";
import { attachSshChannel } from "../src/ssh-session.js";
import type { SshChannelStream } from "../src/ssh-session.js";

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
			SUPERVILLAIN_GATEWAY_LOBBY_IDLE_MS: "90000",
			SUPERVILLAIN_GATEWAY_PTY_COLUMNS: "200",
			SUPERVILLAIN_GATEWAY_PTY_ROWS: "60",
			SUPERVILLAIN_GATEWAY_ROOMS_PER_IDENTITY: "3",
			SUPERVILLAIN_GATEWAY_SESSIONS_PER_ROOM: "12",
			SUPERVILLAIN_GATEWAY_SESSION_BUDGET: "64",
			SUPERVILLAIN_GATEWAY_SESSION_OUTPUT_BYTES: "1048576",
			SUPERVILLAIN_GATEWAY_SESSION_STALL_MS: "5000",
		});
		expect(capacity.limits).toEqual({
			pty: { columns: 200, rows: 60 },
			roomsPerIdentity: 3,
			sessionBudget: 64,
			sessionOutputBytes: 1_048_576,
			sessionStallMs: 5000,
			sessionsPerRoom: 12,
		});
		expect(capacity.lobby.idleMs).toBe(90_000);
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

/** A channel nobody reads: its write callbacks never land, which is exactly
 * what a client that stopped reading looks like from here. */
const stalledChannel = (): SshChannelStream =>
	new PassThrough({ highWaterMark: 1 }) as unknown as SshChannelStream;

describe("the per-session output budget", () => {
	test("a seat that stops accepting output is given up on, and only that seat", async () => {
		const stream = stalledChannel();
		const connection = attachSshChannel({
			initialSize: { columns: 80, rows: 24 },
			outputStallMs: 20,
			stream,
		});
		let overflowed = false;
		void connection.outputOverflowed.then(() => {
			overflowed = true;
		});
		stream.write("a frame nobody will ever read");
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 80);
		});
		expect(overflowed).toBe(true);
	});

	test("a seat that keeps up is never given up on", async () => {
		const stream = new PassThrough() as unknown as SshChannelStream;
		stream.resume();
		const connection = attachSshChannel({
			initialSize: { columns: 80, rows: 24 },
			outputStallMs: 20,
			stream,
		});
		let overflowed = false;
		void connection.outputOverflowed.then(() => {
			overflowed = true;
		});
		for (let frame = 0; frame < 20; frame += 1) {
			stream.write(`frame ${frame}`);
		}
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 80);
		});
		expect(overflowed).toBe(false);
	});

	test("unwritten bytes past the budget end the seat too", async () => {
		const stream = stalledChannel();
		const connection = attachSshChannel({
			initialSize: { columns: 80, rows: 24 },
			outputBudgetBytes: 32,
			stream,
		});
		let overflowed = false;
		void connection.outputOverflowed.then(() => {
			overflowed = true;
		});
		stream.write("x".repeat(64));
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 20);
		});
		expect(overflowed).toBe(true);
	});

	test("with no budget set, nothing is watched at all", async () => {
		const stream = stalledChannel();
		const connection = attachSshChannel({
			initialSize: { columns: 80, rows: 24 },
			stream,
		});
		let overflowed = false;
		void connection.outputOverflowed.then(() => {
			overflowed = true;
		});
		stream.write("x".repeat(4096));
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 50);
		});
		expect(overflowed).toBe(false);
	});
});
