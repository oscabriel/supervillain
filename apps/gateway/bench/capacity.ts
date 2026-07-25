#!/usr/bin/env bun
/* oxlint-disable promise/avoid-new, node/callback-return, eslint/no-loop-func, eslint/no-await-in-loop -- child-process readiness and plain timers are events rather than promise-returning APIs, the line protocol resolves waiters by hand, and every cell in the matrix is measured strictly one at a time. */
/**
 * **The R9 capacity benchmark** (ADR-0012, NQ-10 — and NQ-14's PTY cap).
 *
 * This harness gates numbers. No cap number and no public capacity claim
 * precedes it; every number in `apps/gateway/src/capacity.ts` is chosen from a
 * run of this file, and the run that chose the current ones is written down in
 * `.agents/benchmarks/2026-07-25-r9-capacity.md`.
 *
 * The matrix: **1 / 10 / 50 / 100 concurrent sessions** × **idle / chat /
 * map-pan / slow-reader**.
 *
 * - *idle* is NQ-14's measurement: seats sitting on a gateway with no ambient
 *   `renderer.start()`, doing nothing. Nothing is posted during it, so the
 *   number is genuinely idle rather than nearly idle.
 * - *chat* is the fan-out shape: one seat types, every seat in the Room
 *   redraws.
 * - *map-pan* is the expensive one: arrow keys over a loaded battle map, which
 *   is per-seat FrameBuffer diffing (ADR-0006/0007) and no Host traffic at all.
 * - *slow-reader* is a correctness probe wearing a benchmark's clothes: a
 *   quarter of the seats stop reading their channel entirely while the Host
 *   posts steadily. A fast reader falling behind here is a **failure**, not a
 *   slow number.
 *
 * Three processes, deliberately: the gateway alone in one (so CPU and RSS are
 * its own), the Host and every SSH client in this one, and nothing shared but
 * sockets.
 *
 *   bun apps/gateway/bench/capacity.ts
 *   bun apps/gateway/bench/capacity.ts --sessions 1,10 --workloads idle,chat
 *   bun apps/gateway/bench/capacity.ts --seconds 20 --json results.json
 */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { openHostPipe } from "@supervillain/room-wire";
import { openWsDialer } from "@supervillain/transport-ws";

import {
	benchSecretKeyHex,
	countingDialer,
	createBenchRoom,
} from "./bench-room.js";
import type { BenchRoom, PipeBytes } from "./bench-room.js";
import { encodeLine, takeLines } from "./protocol.js";
import type { BenchReply, BenchSample } from "./protocol.js";
import { mintSeatKeys, openSeat } from "./seats.js";
import type { Seat, SeatKey } from "./seats.js";

const ROOM = "bench-hall";
const GAME_ID = "fake";
const SEAT_COLUMNS = 120;
const SEAT_ROWS = 40;
/** Seats open in waves: a hundred simultaneous SSH handshakes measure the
 * handshake, and the matrix is about what the gateway carries afterwards. */
const OPEN_BATCH = 10;
const SETTLE_MS = 1500;
const TEARDOWN_MS = 500;
const CHAT_INTERVAL_MS = 2000;
const PAN_INTERVAL_MS = 150;
const POST_INTERVAL_MS = 100;
const SLOW_READER_SHARE = 0.25;
const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = 1024 * 1024;
const PERCENT = 100;

const WORKLOADS = ["idle", "chat", "map-pan", "slow-reader"] as const;
type Workload = (typeof WORKLOADS)[number];

const ARROWS = ["[C", "[B", "[D", "[A"] as const;

const sleep = (ms: number): Promise<void> =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});

const freePort = (): Promise<number> =>
	new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => resolve(port));
		});
	});

const percentile = (values: readonly number[], fraction: number): number => {
	if (values.length === 0) {
		return 0;
	}
	const sorted = values.toSorted((left, right) => left - right);
	const index = Math.min(
		sorted.length - 1,
		Math.floor(fraction * sorted.length)
	);
	return sorted[index] ?? 0;
};

/** The gateway process, plus the two questions the harness asks it. */
interface GatewayUnderTest {
	readonly url: string;
	readonly sshPort: number;
	readonly sample: () => Promise<BenchSample>;
	readonly stop: () => Promise<void>;
}

const startGatewayProcess = async (
	stateDir: string
): Promise<GatewayUnderTest> => {
	const sshPort = await freePort();
	const child: ChildProcessWithoutNullStreams = spawn(
		process.execPath,
		[
			path.join(import.meta.dirname, "gateway-process.ts"),
			"--state",
			stateDir,
			"--ssh-port",
			String(sshPort),
		],
		{ stdio: ["pipe", "pipe", "inherit"] }
	);
	// A harness that dies mid-matrix must not leave a gateway behind: the next
	// run would then be measuring a box with somebody else's gateway on it.
	process.on("exit", () => child.kill("SIGKILL"));
	const pending: ((reply: BenchReply) => void)[] = [];
	let buffer = "";
	child.stdout.setEncoding("utf-8");
	child.stdout.on("data", (chunk: string) => {
		const taken = takeLines(buffer + chunk);
		buffer = taken.rest;
		for (const line of taken.lines) {
			pending.shift()?.(JSON.parse(line) as BenchReply);
		}
	});
	const next = (): Promise<BenchReply> =>
		new Promise<BenchReply>((resolve) => {
			pending.push(resolve);
		});
	const ready = await next();
	if (ready.kind !== "ready") {
		throw new Error(
			`The gateway process did not start: ${JSON.stringify(ready)}`
		);
	}
	return {
		sample: async () => {
			const answer = next();
			child.stdin.write(encodeLine({ kind: "sample" }));
			const reply = await answer;
			if (reply.kind !== "sample") {
				throw new Error("The gateway process answered something else.");
			}
			return reply;
		},
		sshPort: ready.sshPort,
		stop: async () => {
			const answer = next();
			child.stdin.write(encodeLine({ kind: "stop" }));
			await Promise.race([answer, sleep(5000)]);
			child.kill();
		},
		url: ready.url,
	};
};

/** One cell of the matrix, in the units the caps are chosen in. */
interface CellResult {
	readonly workload: Workload;
	readonly sessions: number;
	readonly seconds: number;
	/** Gateway CPU across the measurement window, in ms. */
	readonly cpuMs: number;
	/** The number a cap is read off: CPU ms per session per wall-clock second. */
	readonly cpuMsPerSessionPerSecond: number;
	/** CPU the gateway spent seating the sessions, before the window opened. */
	readonly setupCpuMs: number;
	readonly rssBytes: number;
	readonly peakRssBytes: number;
	/** RSS growth over the empty gateway, per session. */
	readonly rssBytesPerSession: number;
	/** Bytes the gateway wrote to seats, summed — the Room's total. */
	readonly bytesOutRoom: number;
	readonly bytesOutPerSession: number;
	readonly bytesOutMaxSession: number;
	/** Bytes over the one Host pipe, both directions. */
	readonly pipeBytesSent: number;
	readonly pipeBytesReceived: number;
	readonly latencyKind: "key-to-frame" | "broadcast" | "none";
	readonly latencyP50: number;
	readonly latencyP95: number;
	readonly latencyMax: number;
	readonly latencySamples: number;
	/** Seats the gateway closed before the window ended. Expected only in
	 * slow-reader, and only ever the slow ones. */
	readonly closedSeats: number;
	readonly closedFastSeats: number;
}

interface CellInput {
	readonly gateway: GatewayUnderTest;
	readonly room: BenchRoom;
	readonly pipe: PipeBytes;
	readonly keys: readonly SeatKey[];
	readonly workload: Workload;
	readonly sessions: number;
	readonly seconds: number;
}

const openSeats = async (
	input: CellInput,
	slowCount: number
): Promise<readonly Seat[]> => {
	const seats: Seat[] = [];
	for (let opened = 0; opened < input.sessions; opened += OPEN_BATCH) {
		const batch: Promise<Seat>[] = [];
		for (
			let index = opened;
			index < Math.min(opened + OPEN_BATCH, input.sessions);
			index += 1
		) {
			const key = input.keys[index];
			if (key === undefined) {
				throw new Error("The seat key pool is too small for this matrix.");
			}
			batch.push(
				openSeat({
					columns: SEAT_COLUMNS,
					host: "127.0.0.1",
					key,
					port: input.gateway.sshPort,
					room: ROOM,
					rows: SEAT_ROWS,
					slow: index < slowCount,
				})
			);
		}
		seats.push(...(await Promise.all(batch)));
	}
	return seats;
};

/** Drives one workload for its window and returns what kind of latency it
 * produced. */
const driveWorkload = async (
	input: CellInput,
	seats: readonly Seat[],
	slowCount: number
): Promise<CellResult["latencyKind"]> => {
	const windowMs = input.seconds * 1000;
	const timers: ReturnType<typeof setInterval>[] = [];
	let kind: CellResult["latencyKind"] = "none";
	if (input.workload === "chat") {
		kind = "key-to-frame";
		let round = 0;
		timers.push(
			setInterval(() => {
				round += 1;
				for (const [index, seat] of seats.entries()) {
					setTimeout(
						() => seat.type(`bench ${round}\r`),
						(index * CHAT_INTERVAL_MS) / Math.max(seats.length, 1)
					);
				}
			}, CHAT_INTERVAL_MS)
		);
	}
	if (input.workload === "map-pan") {
		kind = "key-to-frame";
		for (const seat of seats) {
			// Tab once to hand focus to chrome's map region, then pan.
			seat.type("\t");
		}
		await sleep(250);
		let step = 0;
		timers.push(
			setInterval(() => {
				const arrow = ARROWS[step % ARROWS.length] ?? ARROWS[0];
				step += 1;
				for (const seat of seats) {
					seat.type(arrow);
				}
			}, PAN_INTERVAL_MS)
		);
	}
	if (input.workload === "slow-reader") {
		kind = "broadcast";
		let post = 0;
		timers.push(
			setInterval(() => {
				post += 1;
				const at = performance.now();
				for (const seat of seats.slice(slowCount)) {
					seat.expectBroadcast(at);
				}
				input.room.post(`bench post ${post}`);
			}, POST_INTERVAL_MS)
		);
	}
	await sleep(windowMs);
	for (const timer of timers) {
		clearInterval(timer);
	}
	return kind;
};

const runCell = async (input: CellInput): Promise<CellResult> => {
	const slowCount =
		input.workload === "slow-reader"
			? Math.max(1, Math.round(input.sessions * SLOW_READER_SHARE))
			: 0;
	const empty = await input.gateway.sample();
	const pipeBefore = { received: input.pipe.received, sent: input.pipe.sent };
	const seats = await openSeats(input, slowCount);
	await sleep(SETTLE_MS);
	const before = await input.gateway.sample();
	const bytesBefore = seats.map((seat) => seat.bytesOut());
	const latencyKind = await driveWorkload(input, seats, slowCount);
	const after = await input.gateway.sample();
	const deltas = seats.map(
		(seat, index) => seat.bytesOut() - (bytesBefore[index] ?? 0)
	);
	const latencies = seats.flatMap((seat) => [...seat.latencies()]);
	const closed = seats.filter((seat) => seat.closed());
	const result: CellResult = {
		bytesOutMaxSession: deltas.length === 0 ? 0 : Math.max(...deltas),
		bytesOutPerSession:
			deltas.reduce((sum, value) => sum + value, 0) /
			Math.max(deltas.length, 1),
		bytesOutRoom: deltas.reduce((sum, value) => sum + value, 0),
		closedFastSeats: seats.slice(slowCount).filter((seat) => seat.closed())
			.length,
		closedSeats: closed.length,
		cpuMs: after.cpuMs - before.cpuMs,
		cpuMsPerSessionPerSecond:
			(after.cpuMs - before.cpuMs) / input.sessions / input.seconds,
		latencyKind,
		latencyMax: latencies.length === 0 ? 0 : Math.max(...latencies),
		latencyP50: percentile(latencies, 0.5),
		latencyP95: percentile(latencies, 0.95),
		latencySamples: latencies.length,
		peakRssBytes: after.peakRssBytes,
		pipeBytesReceived: input.pipe.received - pipeBefore.received,
		pipeBytesSent: input.pipe.sent - pipeBefore.sent,
		rssBytes: after.rssBytes,
		rssBytesPerSession: (after.rssBytes - empty.rssBytes) / input.sessions,
		seconds: input.seconds,
		sessions: input.sessions,
		setupCpuMs: before.cpuMs - empty.cpuMs,
		workload: input.workload,
	};
	for (const seat of seats) {
		seat.close();
	}
	await sleep(TEARDOWN_MS);
	return result;
};

const pad = (value: string, width: number): string => value.padEnd(width);
const padLeft = (value: string, width: number): string => value.padStart(width);

const HEADERS = [
	["workload", 12],
	["seats", 6],
	["cpu ms/s", 9],
	["cpu ms/seat/s", 14],
	["rss MiB", 8],
	["rss KiB/seat", 13],
	["out KiB/seat/s", 15],
	["pipe KiB/s", 11],
	["p50 ms", 7],
	["p95 ms", 7],
	["closed", 7],
] as const;

const rowFor = (cell: CellResult): readonly string[] => [
	cell.workload,
	String(cell.sessions),
	(cell.cpuMs / cell.seconds).toFixed(1),
	cell.cpuMsPerSessionPerSecond.toFixed(3),
	(cell.rssBytes / BYTES_PER_MIB).toFixed(1),
	(cell.rssBytesPerSession / BYTES_PER_KIB).toFixed(0),
	(cell.bytesOutPerSession / BYTES_PER_KIB / cell.seconds).toFixed(2),
	(
		(cell.pipeBytesSent + cell.pipeBytesReceived) /
		BYTES_PER_KIB /
		cell.seconds
	).toFixed(2),
	cell.latencySamples === 0 ? "-" : cell.latencyP50.toFixed(1),
	cell.latencySamples === 0 ? "-" : cell.latencyP95.toFixed(1),
	`${cell.closedSeats}/${cell.closedFastSeats}`,
];

const renderTable = (cells: readonly CellResult[]): string => {
	const lines = [
		HEADERS.map(([name, width]) => pad(name, width)).join(" "),
		HEADERS.map(([, width]) => "-".repeat(width)).join(" "),
	];
	for (const cell of cells) {
		const row = rowFor(cell);
		lines.push(
			HEADERS.map(([, width], index) =>
				index === 0
					? pad(row[index] ?? "", width)
					: padLeft(row[index] ?? "", width)
			).join(" ")
		);
	}
	return lines.join("\n");
};

const parseList = <T extends string>(
	raw: string | undefined,
	fallback: readonly T[],
	allowed: readonly T[]
): readonly T[] => {
	if (raw === undefined) {
		return fallback;
	}
	const asked = raw.split(",").map((part) => part.trim());
	for (const part of asked) {
		if (!allowed.includes(part as T)) {
			throw new Error(`'${part}' is not one of ${allowed.join(", ")}.`);
		}
	}
	return asked as T[];
};

const main = async (): Promise<void> => {
	const { values } = parseArgs({
		options: {
			json: { type: "string" },
			seconds: { default: "10", type: "string" },
			sessions: { type: "string" },
			workloads: { type: "string" },
		},
	});
	const seconds = Number(values.seconds);
	const sessionCounts = (values.sessions ?? "1,10,50,100")
		.split(",")
		.map((part) => Number(part.trim()));
	const workloads = parseList<Workload>(values.workloads, WORKLOADS, WORKLOADS);
	const maxSessions = Math.max(...sessionCounts);

	const stateDir = await mkdtemp(path.join(tmpdir(), "supervillain-r9-"));
	const keys = mintSeatKeys(maxSessions);
	const secretKeyHex = benchSecretKeyHex();

	/**
	 * **Every cell gets its own gateway process, and its own Room inside it.**
	 *
	 * Reuse was tried first and it does not measure sixteen workloads — it
	 * measures the sixteenth cell running on whatever the previous fifteen left
	 * behind. The first run of this matrix on one shared gateway found CPU
	 * pinned at ~1.15 cores from the fourth cell onward and RSS never falling
	 * back between cells, which makes every later number an artefact of the
	 * earlier ones. (That residue is itself worth chasing — see the results
	 * doc — but a capacity matrix is not the instrument for it.)
	 */
	const cells: CellResult[] = [];
	for (const workload of workloads) {
		for (const sessions of sessionCounts) {
			process.stderr.write(`  ${workload} · ${sessions} seats\n`);
			const pipe: PipeBytes = { received: 0, sent: 0 };
			const gateway = await startGatewayProcess(
				path.join(stateDir, `${workload}-${sessions}`)
			);
			const room = createBenchRoom(GAME_ID);
			const host = openHostPipe({
				dialer: countingDialer(
					openWsDialer({ secretKeyHex, url: gateway.url }),
					pipe
				),
				rooms: [
					{
						info: { gameId: GAME_ID, label: "the bench hall" },
						name: ROOM,
						store: room,
					},
				],
			});
			await host.attached;
			await sleep(500);
			cells.push(
				await runCell({
					gateway,
					keys,
					pipe,
					room,
					seconds,
					sessions,
					workload,
				})
			);
			await host.close();
			await gateway.stop();
		}
	}

	await rm(stateDir, { force: true, recursive: true });

	process.stdout.write(`\nR9 capacity matrix · ${seconds}s per cell\n`);
	process.stdout.write(`${renderTable(cells)}\n\n`);
	process.stdout.write(
		"closed = seats the gateway closed / of those, fast readers.\n" +
			"A fast reader closing in slow-reader is a correctness failure (NQ-5).\n"
	);
	const slowest = cells.find(
		(cell) => cell.workload === "slow-reader" && cell.closedFastSeats > 0
	);
	if (slowest !== undefined) {
		process.exitCode = 1;
		process.stderr.write(
			`FAILED: ${slowest.closedFastSeats} fast readers were dropped at ${slowest.sessions} seats.\n`
		);
	}
	if (values.json !== undefined) {
		await writeFile(
			values.json,
			`${JSON.stringify({ cells, environment: { arch: process.arch, bun: process.versions.bun, platform: process.platform }, seconds }, null, 2)}\n`
		);
	}
	process.stdout.write(
		`peak RSS across the run: ${(Math.max(...cells.map((cell) => cell.peakRssBytes)) / BYTES_PER_MIB).toFixed(1)} MiB\n`
	);
	process.stdout.write(
		`slow-reader share: ${(SLOW_READER_SHARE * PERCENT).toFixed(0)}% of seats\n`
	);
};

await main();
