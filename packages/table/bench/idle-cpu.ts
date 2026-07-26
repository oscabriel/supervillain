/**
 * Idle CPU of N tables sitting on one process — the measurement ADR-0012 (NQ-14)
 * demands instead of an assumption about ambient rendering.
 *
 * Every seat gets its own renderer over a pair of in-memory streams (what the
 * gateway does with an SSH channel), mounts the real chrome, and then does
 * nothing: no keystrokes, no envelopes. We sample process CPU across the quiet
 * window and divide by seats.
 *
 *   bun packages/table/bench/idle-cpu.ts --seats 25 --seconds 5
 *   bun packages/table/bench/idle-cpu.ts --seats 25 --seconds 5 --loop
 *
 * `--loop` mounts the historical local-TTY factory instead — the ambient
 * render loop retained as a measurement control — so the runs are comparable.
 *
 * Measured 2026-07-25 on one dev box (Linux 7.1.3 CachyOS, Bun 1.3.13), total
 * process CPU across a 5 s quiet window:
 *
 *   seats   on demand (the fix)   ambient loop (--loop)
 *       1              41 ms                  931 ms
 *      25              64 ms                 1468 ms
 *      50              71 ms                 1819 ms
 *
 * The ambient loop costs roughly 7 ms of CPU per seat per second — ~0.7% of a
 * core each, ~36% of a core at 50 idle seats. On demand, the whole process stays
 * under 15 ms per second no matter how many seats sit there: a fixed floor, not
 * per-seat growth. Caveat: in-memory streams, so this counts render work and not
 * the SSH channel writes a real seat adds — and those only happen on frames that
 * are actually drawn.
 */
import { PassThrough } from "node:stream";
import { parseArgs } from "node:util";

import type { Envelope, RoomStore, ViewEntry } from "@supervillain/core";
import type { Session } from "@supervillain/session";

import { runChrome } from "../src/chrome.js";
import {
	createLocalTtyRenderer,
	createSessionRenderer,
} from "../src/renderer.js";

const MICROSECONDS_PER_MILLISECOND = 1000;
const MILLISECONDS_PER_SECOND = 1000;
const SETTLE_MS = 1000;

const entry: ViewEntry<unknown, unknown, unknown> = {
	model: { apply: (state) => state, init: () => ({}) },
	view: {
		createPanels: () => [],
		notices: [{ runs: [{ text: "idle bench", token: "muted" }] }],
		renderEvent: () => null,
	},
};

// oxlint-disable-next-line promise/avoid-new -- an idle room's stream simply never yields.
const NEVER = new Promise<IteratorResult<Envelope>>(() => {
	// No envelope ever arrives during the quiet window.
});

const idleStore: RoomStore = {
	stream: () => ({
		[Symbol.asyncIterator]: () => ({ next: () => NEVER }),
	}),
	submit: () => Promise.resolve({ accepted: true, envelopes: [] }),
};

const benchSession = (actor: string): Session => {
	const input = new PassThrough();
	const output = new PassThrough();
	output.resume();
	return {
		actor,
		close() {
			input.end();
			output.end();
		},
		input: input as unknown as NodeJS.ReadStream,
		onClose: () => () => {
			// The bench tears down through the renderer, not the session.
		},
		onResize: () => () => {
			// Nothing resizes during the quiet window.
		},
		output: output as unknown as NodeJS.WriteStream,
		size: () => ({ columns: 120, rows: 40 }),
	};
};

const sleep = (ms: number): Promise<void> =>
	// oxlint-disable-next-line promise/avoid-new -- the quiet window is a plain timer.
	new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});

const main = async (): Promise<void> => {
	const { values } = parseArgs({
		options: {
			loop: { type: "boolean" },
			seats: { default: "25", type: "string" },
			seconds: { default: "5", type: "string" },
		},
	});
	const seats = Number(values.seats);
	const seconds = Number(values.seconds);
	const createRenderer = values.loop
		? createLocalTtyRenderer
		: createSessionRenderer;

	const renderers: { destroy: () => void }[] = [];
	const exits: Promise<void>[] = [];
	for (let seat = 0; seat < seats; seat += 1) {
		const session = benchSession(`bench-${seat}`);
		// The bench is each seat's surface (ADR-0016): it mints the renderer,
		// lends it to the chrome, and destroys it after the measurement.
		// oxlint-disable-next-line eslint/no-await-in-loop -- seats are mounted sequentially by design.
		const renderer = await createRenderer(session);
		renderers.push(renderer);
		exits.push(
			runChrome({
				entry,
				gameId: "bench",
				renderer,
				roomLabel: `bench ${seat}`,
				session,
				store: idleStore,
			})
		);
	}
	await sleep(SETTLE_MS);

	const before = process.cpuUsage();
	await sleep(seconds * MILLISECONDS_PER_SECOND);
	const used = process.cpuUsage(before);

	for (const renderer of renderers) {
		renderer.destroy();
	}
	await Promise.all(exits);

	const cpuMs = (used.system + used.user) / MICROSECONDS_PER_MILLISECOND;
	const perSeatPerSecond = cpuMs / seats / seconds;
	process.stdout.write(
		`${values.loop ? "ambient loop" : "on demand"} · ${seats} seats · ${seconds}s idle\n` +
			`  total CPU: ${cpuMs.toFixed(1)} ms\n` +
			`  per seat per second: ${perSeatPerSecond.toFixed(2)} ms\n`
	);
};

await main();
