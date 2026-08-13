#!/usr/bin/env bun
/**
 * The gateway under measurement, alone in its own process (ADR-0012, NQ-10).
 * `capacity.ts` spawns it, reads the `ready` line for the addresses, and asks
 * for a `sample` at each end of a measurement window.
 *
 * The caps are deliberately opened wide here: the harness measures what 100
 * sessions *cost*, and a cap that refused the hundredth session would measure
 * the cap instead. At-capacity behaviour is asserted in the gateway's tests,
 * where it belongs.
 *
 *   bun apps/gateway/bench/gateway-process.ts --state <dir> --ssh-port <port>
 */
import { mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";

import { DEFAULT_CAPACITY_LIMITS, startGateway } from "../src/index.js";
import { encodeLine, takeLines } from "./protocol.js";
import type { BenchReply, BenchRequest } from "./protocol.js";

const MICROSECONDS_PER_MILLISECOND = 1000;
const RSS_POLL_MS = 200;
/** Far above anything the matrix asks for: the harness measures cost, not the
 * caps. */
const UNCAPPED = 100_000;

const say = (reply: BenchReply): void => {
	process.stdout.write(encodeLine(reply));
};

const activeResources = () => {
	const counts: Record<string, number> = {};
	for (const resource of process.getActiveResourcesInfo()) {
		counts[resource] = (counts[resource] ?? 0) + 1;
	}
	return counts;
};

const main = async (): Promise<void> => {
	const { values } = parseArgs({
		options: {
			"ssh-port": { type: "string" },
			state: { type: "string" },
		},
	});
	const stateDir = values.state;
	const sshPort = Number(values["ssh-port"]);
	if (stateDir === undefined || !Number.isInteger(sshPort)) {
		say({ kind: "failed", message: "--state and --ssh-port are required." });
		process.exitCode = 1;
		return;
	}
	await mkdir(stateDir, { recursive: true });
	const gateway = await startGateway({
		capacity: {
			doorSessionsGlobal: UNCAPPED,
			doorSessionsPerConnection: UNCAPPED,
			pty: { columns: 500, rows: 200 },
			roomsPerIdentity: UNCAPPED,
			// The envelope budget keeps its shipped default: the slow-reader
			// workload is a probe of *it*, and opening it would measure a
			// gateway nobody runs. (The byte half of the envelope-lag budget is
			// `@opentui/ssh`'s backpressure now — #62.)
			sessionBudget: DEFAULT_CAPACITY_LIMITS.sessionBudget,
			sessionsPerRoom: UNCAPPED,
		},
		// The harness drives sessions for minutes at a time and never types in
		// the lobby; the squatting floors would close them out mid-window.
		lobbyLimits: {
			connectionsPerWindow: UNCAPPED,
			idleMs: 60 * 60_000,
			maxHoldMs: 60 * 60_000,
			windowMs: 1000,
		},
		sshHost: "127.0.0.1",
		sshPort,
		stateDir,
		// Plaintext on loopback: TLS is a per-byte cost the R9 matrix is not
		// measuring, and #64 owns the certificate story.
		tls: { mode: "terminated-upstream" },
	});
	let peakRssBytes = 0;
	const rssTimer = setInterval(() => {
		peakRssBytes = Math.max(peakRssBytes, process.memoryUsage.rss());
	}, RSS_POLL_MS);
	rssTimer.unref?.();
	say({ kind: "ready", sshPort: gateway.sshPort, url: gateway.url });

	let buffer = "";
	const stop = async (): Promise<void> => {
		clearInterval(rssTimer);
		await gateway.close();
		say({ kind: "stopped" });
		process.exit(0);
	};
	process.stdin.on("data", (chunk: Buffer) => {
		const taken = takeLines(buffer + chunk.toString("utf-8"));
		buffer = taken.rest;
		for (const line of taken.lines) {
			const request = JSON.parse(line) as BenchRequest;
			if (request.kind === "stop") {
				void stop();
				return;
			}
			if (request.gc) {
				// Diagnostic only: the rest harness uses this to distinguish reachable
				// retention from an allocator high-water mark. Capacity samples never
				// request it, and production never forces collection.
				Bun.gc(true);
			}
			const used = process.cpuUsage();
			const memory = process.memoryUsage();
			peakRssBytes = Math.max(peakRssBytes, memory.rss);
			say({
				cpuMs: (used.user + used.system) / MICROSECONDS_PER_MILLISECOND,
				kind: "sample",
				memory: {
					arrayBuffers: memory.arrayBuffers,
					external: memory.external,
					heapTotal: memory.heapTotal,
					heapUsed: memory.heapUsed,
				},
				peakRssBytes,
				processListeners: {
					beforeExit: process.listenerCount("beforeExit"),
					uncaughtException: process.listenerCount("uncaughtException"),
					unhandledRejection: process.listenerCount("unhandledRejection"),
					warning: process.listenerCount("warning"),
				},
				resources: activeResources(),
				rssBytes: memory.rss,
			});
			peakRssBytes = memory.rss;
		}
	});
};

await main();
