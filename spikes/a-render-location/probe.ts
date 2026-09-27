// Spike A, the measurement: keystroke-echo latency as a player feels it.
// Types a character the table never draws on its own, times how long until it
// comes back in the rendered screen, erases it, and repeats.
//
//   bun spikes/a-render-location/probe.ts <host:port> [--samples 200]
import { parseArgs } from "node:util";

import { connectPlayer, focusInput, MARK, sleep } from "./client.js";

const { positionals, values } = parseArgs({
	allowPositionals: true,
	options: { samples: { default: "200", type: "string" } },
});
const [address] = positionals;
if (address === undefined) {
	console.error("usage: probe.ts <host:port> [--samples n]");
	process.exit(1);
}

const needle = Buffer.from(MARK);

const connectStarted = performance.now();
const player = await connectPlayer(address, "probe");
const firstFrame = await player.waitFor(Buffer.from("\u001b["), 20_000);
await player.settle(1000, 20_000);
const seated = performance.now();
console.log(
	`probe: first frame ${Math.round((firstFrame ?? seated) - connectStarted)} ms, settled ${Math.round(seated - connectStarted)} ms after connect`
);

if (!(await focusInput(player))) {
	console.error("probe: never reached the input line");
	process.exit(1);
}

const samples: number[] = [];
let lost = 0;
for (let index = 0; index < Number(values.samples); index += 1) {
	player.take();
	const sent = performance.now();
	const echoed = player.waitFor(needle, 3000);
	player.stream.write(MARK);
	// oxlint-disable-next-line eslint/no-await-in-loop -- samples are sequential by design.
	const at = await echoed;
	if (at === null) {
		lost += 1;
	} else {
		samples.push(at - sent);
	}
	player.stream.write("\u007f");
	// oxlint-disable-next-line eslint/no-await-in-loop -- let the erase land before the next sample.
	await player.settle(100, 1000);
	// oxlint-disable-next-line eslint/no-await-in-loop -- a human-ish gap between keys.
	await sleep(50 + Math.random() * 150);
}
player.end();

const sorted = samples.toSorted((a, b) => a - b);
const pick = (p: number) =>
	sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ??
	Number.NaN;
console.log(
	`probe: ${sorted.length} echoes, ${lost} lost · p50 ${pick(50).toFixed(1)} ms · p95 ${pick(95).toFixed(1)} ms · p99 ${pick(99).toFixed(1)} ms · max ${(sorted.at(-1) ?? Number.NaN).toFixed(1)} ms`
);
process.exit(lost > 0 ? 1 : 0);
