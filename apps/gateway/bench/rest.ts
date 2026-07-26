#!/usr/bin/env bun
/* oxlint-disable promise/avoid-new, node/callback-return, eslint/no-await-in-loop -- child-process readiness and the line protocol are event-shaped, and each lifecycle round must finish before the next begins. */
/**
 * Repeated Room lifecycle regression check (issue #76).
 *
 * One gateway process survives every round. Each round attaches a fresh Room,
 * seats real SSH sessions, exercises their tables, closes the sessions,
 * detaches the Room, settles, then samples gateway CPU and RSS at rest.
 * Flat rows mean teardown returned the gateway to rest; rising rows mean some
 * Room/session resource survived its owner.
 *
 *   bun apps/gateway/bench/rest.ts
 *   bun apps/gateway/bench/rest.ts --rounds 4 --seats 1 --workload idle
 *   bun apps/gateway/bench/rest.ts --gc --json rest-results.json
 */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { openHostPipe } from "@supervillain/room-wire";
import type { HostPipe } from "@supervillain/room-wire";
import { openWsDialer } from "@supervillain/transport-ws";

import {
	benchSecretKeyHex,
	countingDialer,
	createBenchRoom,
} from "./bench-room.js";
import type { PipeBytes } from "./bench-room.js";
import { encodeLine, takeLines } from "./protocol.js";
import type { BenchReply, BenchSample } from "./protocol.js";
import { mintSeatKeys, openSeat } from "./seats.js";
import type { Seat, SeatKey } from "./seats.js";

const ROOM = "rest-hall";
const GAME_ID = "fake";
const SEAT_COLUMNS = 120;
const SEAT_ROWS = 40;
const DEFAULT_ROUNDS = 4;
const DEFAULT_SEATS = 50;
const DEFAULT_ACTIVE_SECONDS = 2;
const DEFAULT_REST_SECONDS = 2;
const DEFAULT_SETTLE_MS = 2000;
const ATTACH_SETTLE_MS = 500;
const TABLE_SETTLE_MS = 1000;
const CLOSE_TIMEOUT_MS = 10_000;
const SEAT_READY_TIMEOUT_MS = 30_000;
const PAN_INTERVAL_MS = 150;
const BYTES_PER_MIB = 1024 * 1024;
const MAX_REST_CPU_GROWTH_MS_PER_SECOND = 50;
const MAX_RSS_RESIDUAL_MIB = 64;
const MAX_RSS_SLOPE_MIB_PER_ROUND = 8;

const WORKLOADS = ["idle", "map-pan"] as const;
type Workload = (typeof WORKLOADS)[number];
const SURFACES = ["table", "lobby"] as const;
type Surface = (typeof SURFACES)[number];

const ARROWS = ["\u001B[C", "\u001B[B", "\u001B[D", "\u001B[A"] as const;

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

interface GatewayUnderTest {
	readonly url: string;
	readonly sshPort: number;
	readonly sample: (gc?: boolean) => Promise<BenchSample>;
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
	process.on("exit", () => child.kill("SIGKILL"));
	const pending: {
		readonly reject: (error: Error) => void;
		readonly resolve: (reply: BenchReply) => void;
	}[] = [];
	let buffer = "";
	child.stdout.setEncoding("utf-8");
	child.stdout.on("data", (chunk: string) => {
		const taken = takeLines(buffer + chunk);
		buffer = taken.rest;
		for (const line of taken.lines) {
			pending.shift()?.resolve(JSON.parse(line) as BenchReply);
		}
	});
	const failPending = (error: Error): void => {
		for (const waiter of pending.splice(0)) {
			waiter.reject(error);
		}
	};
	child.once("error", failPending);
	child.once("exit", (code, signal) => {
		failPending(
			new Error(
				`The gateway process exited before replying (code ${String(code)}, signal ${String(signal)}).`
			)
		);
	});
	const next = (): Promise<BenchReply> =>
		new Promise<BenchReply>((resolve, reject) => {
			pending.push({ reject, resolve });
		});
	const ready = await next();
	if (ready.kind !== "ready") {
		throw new Error(
			`The gateway process did not start: ${JSON.stringify(ready)}`
		);
	}
	return {
		sample: async (gc = false) => {
			const answer = next();
			child.stdin.write(encodeLine({ gc, kind: "sample" }));
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

interface RestSample {
	readonly cpuMsPerSecond: number;
	readonly memory: BenchSample["memory"];
	readonly peakRssBytes: number;
	readonly processListeners: BenchSample["processListeners"];
	readonly resources: BenchSample["resources"];
	readonly rssBytes: number;
}

interface RoundResult extends RestSample {
	readonly round: number;
	readonly closeMs: number;
}

const sampleRest = async (
	gateway: GatewayUnderTest,
	seconds: number,
	gc: boolean
): Promise<RestSample> => {
	const before = await gateway.sample(gc);
	await sleep(seconds * 1000);
	const after = await gateway.sample(gc);
	return {
		cpuMsPerSecond: (after.cpuMs - before.cpuMs) / seconds,
		memory: after.memory,
		peakRssBytes: after.peakRssBytes,
		processListeners: after.processListeners,
		resources: after.resources,
		rssBytes: after.rssBytes,
	};
};

const waitForSeated = async (seats: readonly Seat[]): Promise<void> => {
	const deadline = performance.now() + SEAT_READY_TIMEOUT_MS;
	while (seats.some((seat) => !seat.transcript().includes("the rest hall"))) {
		if (performance.now() >= deadline) {
			throw new Error("Timed out waiting for SSH sessions to reach the table.");
		}
		await sleep(10);
	}
};

const waitForClosedSeats = async (seats: readonly Seat[]): Promise<void> => {
	const deadline = performance.now() + CLOSE_TIMEOUT_MS;
	while (seats.some((seat) => !seat.closed())) {
		if (performance.now() >= deadline) {
			throw new Error("Timed out waiting for SSH sessions to close.");
		}
		await sleep(10);
	}
};

const openSeats = (
	gateway: GatewayUnderTest,
	keys: readonly SeatKey[],
	room: string
): Promise<readonly Seat[]> =>
	Promise.all(
		keys.map((key) =>
			openSeat({
				columns: SEAT_COLUMNS,
				host: "127.0.0.1",
				key,
				port: gateway.sshPort,
				room,
				rows: SEAT_ROWS,
				slow: false,
			})
		)
	);

const exercise = async (
	seats: readonly Seat[],
	workload: Workload,
	seconds: number
): Promise<void> => {
	if (workload === "idle") {
		await sleep(seconds * 1000);
		return;
	}
	for (const seat of seats) {
		seat.type("\t");
	}
	await sleep(250);
	let step = 0;
	const timer = setInterval(() => {
		const arrow = ARROWS[step % ARROWS.length] ?? ARROWS[0];
		step += 1;
		for (const seat of seats) {
			seat.type(arrow);
		}
	}, PAN_INTERVAL_MS);
	await sleep(seconds * 1000);
	clearInterval(timer);
};

const runRound = async (input: {
	readonly activeSeconds: number;
	readonly gateway: GatewayUnderTest;
	readonly gc: boolean;
	readonly keys: readonly SeatKey[];
	readonly map: boolean;
	readonly quit: boolean;
	readonly restSeconds: number;
	readonly round: number;
	readonly secretKeyHex: string;
	readonly settleMs: number;
	readonly surface: Surface;
	readonly workload: Workload;
}): Promise<RoundResult> => {
	let host: HostPipe | undefined;
	let seats: readonly Seat[] = [];
	try {
		if (input.surface === "table") {
			const pipe: PipeBytes = { received: 0, sent: 0 };
			host = openHostPipe({
				dialer: countingDialer(
					openWsDialer({
						secretKeyHex: input.secretKeyHex,
						url: input.gateway.url,
					}),
					pipe
				),
				rooms: [
					{
						info: { gameId: GAME_ID, label: "the rest hall" },
						name: ROOM,
						store: createBenchRoom(GAME_ID, { map: input.map }),
					},
				],
			});
			await host.attached;
			await sleep(ATTACH_SETTLE_MS);
		}
		seats = await openSeats(
			input.gateway,
			input.keys,
			input.surface === "table" ? ROOM : `missing-room-${input.round}`
		);
		if (input.surface === "table") {
			await waitForSeated(seats);
		}
		await sleep(TABLE_SETTLE_MS);
		await exercise(seats, input.workload, input.activeSeconds);
		const closeStarted = performance.now();
		for (const seat of seats) {
			if (input.quit && input.surface === "table") {
				seat.type("/quit\r");
			} else {
				seat.close();
			}
		}
		await waitForClosedSeats(seats);
		await host?.close();
		host = undefined;
		const closeMs = performance.now() - closeStarted;
		await sleep(input.settleMs);
		return {
			...(await sampleRest(input.gateway, input.restSeconds, input.gc)),
			closeMs,
			round: input.round,
		};
	} finally {
		for (const seat of seats) {
			if (!seat.closed()) {
				seat.close();
			}
		}
		await host?.close();
	}
};

const slope = (values: readonly number[]): number => {
	if (values.length < 2) {
		return 0;
	}
	const meanX = (values.length - 1) / 2;
	const meanY = values.reduce((sum, value) => sum + value, 0) / values.length;
	let numerator = 0;
	let denominator = 0;
	for (const [index, value] of values.entries()) {
		const dx = index - meanX;
		numerator += dx * (value - meanY);
		denominator += dx * dx;
	}
	return denominator === 0 ? 0 : numerator / denominator;
};

const renderSample = (
	label: string,
	sample: RestSample,
	closeMs?: number
): string =>
	[
		label.padEnd(9),
		sample.cpuMsPerSecond.toFixed(1).padStart(13),
		(sample.rssBytes / BYTES_PER_MIB).toFixed(1).padStart(9),
		(sample.peakRssBytes / BYTES_PER_MIB).toFixed(1).padStart(14),
		(sample.memory.heapUsed / BYTES_PER_MIB).toFixed(1).padStart(13),
		(sample.memory.external / BYTES_PER_MIB).toFixed(1).padStart(12),
		String(sample.processListeners.warning).padStart(17),
		String(sample.resources.Timeout ?? 0).padStart(8),
		(closeMs === undefined ? "-" : closeMs.toFixed(0)).padStart(9),
	].join(" ");

const nonNegativeInteger = (raw: string, name: string): number => {
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`${name} must be a non-negative integer.`);
	}
	return value;
};

const positiveInteger = (raw: string, name: string): number => {
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer.`);
	}
	return value;
};

const positiveNumber = (raw: string, name: string): number => {
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`${name} must be greater than zero.`);
	}
	return value;
};

const main = async (): Promise<void> => {
	const { values } = parseArgs({
		options: {
			"active-seconds": {
				default: String(DEFAULT_ACTIVE_SECONDS),
				type: "string",
			},
			gc: { default: false, type: "boolean" },
			json: { type: "string" },
			"no-map": { default: false, type: "boolean" },
			quit: { default: false, type: "boolean" },
			"rest-seconds": {
				default: String(DEFAULT_REST_SECONDS),
				type: "string",
			},
			rounds: { default: String(DEFAULT_ROUNDS), type: "string" },
			seats: { default: String(DEFAULT_SEATS), type: "string" },
			"settle-ms": { default: String(DEFAULT_SETTLE_MS), type: "string" },
			surface: { default: "table", type: "string" },
			workload: { default: "map-pan", type: "string" },
		},
	});
	const rounds = positiveInteger(values.rounds, "--rounds");
	const seatCount = nonNegativeInteger(values.seats, "--seats");
	const activeSeconds = positiveNumber(
		values["active-seconds"],
		"--active-seconds"
	);
	const restSeconds = positiveNumber(values["rest-seconds"], "--rest-seconds");
	const settleMs = positiveNumber(values["settle-ms"], "--settle-ms");
	if (!WORKLOADS.includes(values.workload as Workload)) {
		throw new Error(`--workload must be one of ${WORKLOADS.join(", ")}.`);
	}
	const workload = values.workload as Workload;
	if (!SURFACES.includes(values.surface as Surface)) {
		throw new Error(`--surface must be one of ${SURFACES.join(", ")}.`);
	}
	const surface = values.surface as Surface;
	const withMap = !values["no-map"];
	if (surface === "lobby" && workload !== "idle") {
		throw new Error("--surface lobby only supports --workload idle.");
	}
	if (!withMap && workload === "map-pan") {
		throw new Error("--no-map does not support --workload map-pan.");
	}
	const stateDir = await mkdtemp(path.join(tmpdir(), "supervillain-rest-"));
	const gateway = await startGatewayProcess(stateDir);
	const keys = mintSeatKeys(seatCount);
	const secretKeyHex = benchSecretKeyHex();
	const results: RoundResult[] = [];
	let baseline: RestSample;
	try {
		await sleep(settleMs);
		baseline = await sampleRest(gateway, restSeconds, values.gc);
		process.stdout.write(
			"sample      rest cpu ms/s  rss MiB  peak rss MiB  heap used MiB  external MiB  warning listeners  timeouts  close ms\n"
		);
		process.stdout.write(
			"---------  -------------  -------  ------------  -------------  ------------  -----------------  --------  --------\n"
		);
		process.stdout.write(`${renderSample("baseline", baseline)}\n`);
		for (let round = 1; round <= rounds; round += 1) {
			process.stderr.write(`  round ${round}/${rounds}\n`);
			const result = await runRound({
				activeSeconds,
				gateway,
				gc: values.gc,
				keys,
				map: withMap,
				quit: values.quit,
				restSeconds,
				round,
				secretKeyHex,
				settleMs,
				surface,
				workload,
			});
			results.push(result);
			process.stdout.write(
				`${renderSample(`round ${round}`, result, result.closeMs)}\n`
			);
		}
	} finally {
		await gateway.stop();
		await rm(stateDir, { force: true, recursive: true });
	}

	const rssSlopeBytes = slope(results.map((result) => result.rssBytes));
	const maxRssBytes = Math.max(...results.map((result) => result.rssBytes));
	const maxRestCpu = Math.max(
		...results.map((result) => result.cpuMsPerSecond)
	);
	const cpuGrowth = maxRestCpu - baseline.cpuMsPerSecond;
	const rssResidualMib = (maxRssBytes - baseline.rssBytes) / BYTES_PER_MIB;
	const rssSlopeMib = rssSlopeBytes / BYTES_PER_MIB;
	const retainedRendererListeners = Math.max(
		...results.map(
			(result) =>
				result.processListeners.warning - baseline.processListeners.warning
		)
	);
	const flat =
		cpuGrowth <= MAX_REST_CPU_GROWTH_MS_PER_SECOND &&
		rssResidualMib <= MAX_RSS_RESIDUAL_MIB &&
		rssSlopeMib <= MAX_RSS_SLOPE_MIB_PER_ROUND &&
		retainedRendererListeners === 0;
	process.stdout.write(
		`\nRSS slope: ${rssSlopeMib.toFixed(2)} MiB/round; max RSS residual: ${rssResidualMib.toFixed(1)} MiB; max rest CPU growth: ${cpuGrowth.toFixed(1)} ms/s; retained renderer listeners: ${retainedRendererListeners}.\n`
	);
	process.stdout.write(
		flat
			? "PASS: the long-lived gateway returned to rest between rounds.\n"
			: "FAIL: the long-lived gateway retained work or memory across rounds.\n"
	);
	if (!flat) {
		process.exitCode = 1;
	}
	if (values.json !== undefined) {
		await writeFile(
			values.json,
			`${JSON.stringify(
				{
					baseline,
					environment: {
						arch: process.arch,
						bun: process.versions.bun,
						platform: process.platform,
					},
					limits: {
						maxRestCpuGrowthMsPerSecond: MAX_REST_CPU_GROWTH_MS_PER_SECOND,
						maxRssResidualMib: MAX_RSS_RESIDUAL_MIB,
						maxRssSlopeMibPerRound: MAX_RSS_SLOPE_MIB_PER_ROUND,
					},
					options: {
						activeSeconds,
						gc: values.gc,
						map: withMap,
						quit: values.quit,
						restSeconds,
						rounds,
						seatCount,
						settleMs,
						surface,
						workload,
					},
					results,
					verdict: flat ? "pass" : "fail",
				},
				null,
				2
			)}\n`
		);
	}
};

await main();
