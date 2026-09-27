// Spike A, the load: N simulated players chatting at a human pace, so the GM's
// upload and CPU can be read off the relay and host logs.
//
//   bun spikes/a-render-location/load.ts <host:port> [--players 5] [--seconds 120]
import { parseArgs } from "node:util";

import { connectPlayer, focusInput, sleep } from "./client.js";

const { positionals, values } = parseArgs({
	allowPositionals: true,
	options: {
		players: { default: "5", type: "string" },
		seconds: { default: "120", type: "string" },
	},
});
const [address] = positionals;
if (address === undefined) {
	console.error("usage: load.ts <host:port> [--players n] [--seconds n]");
	process.exit(1);
}
const endAt = performance.now() + Number(values.seconds) * 1000;

const chat = async (index: number) => {
	const player = await connectPlayer(address, `load-${index}`);
	await player.settle(1000, 20_000);
	let line = 0;
	while (performance.now() < endAt) {
		// oxlint-disable-next-line eslint/no-await-in-loop -- a player thinks between lines.
		await sleep(5000 + Math.random() * 15_000);
		// The archived build drops focus off the input line after every send.
		// oxlint-disable-next-line eslint/no-await-in-loop -- focus before typing.
		if (!(await focusInput(player))) {
			throw new Error(`load-${index}: never reached the input line`);
		}
		line += 1;
		const text = `player ${index} says line ${line}, the goblin moves`;
		for (const character of text) {
			player.stream.write(character);
			// oxlint-disable-next-line eslint/no-await-in-loop -- typing speed, about eight keys a second.
			await sleep(80 + Math.random() * 90);
		}
		player.stream.write("\r");
		player.take();
	}
	player.end();
};

await Promise.all(
	Array.from({ length: Number(values.players) }, (_, index) => chat(index + 1))
);
console.log("load: done");
process.exit(0);
