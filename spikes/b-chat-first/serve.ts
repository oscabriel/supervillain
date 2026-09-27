// Spike B: serve the mock table over SSH so two or three people can click
// through it together. The first person to sit down is the GM.
//
//   bun spikes/b-chat-first/serve.ts [--port 2400] [--state <dir>]
//
// With --local, this terminal is also a screen (and sits down first, so it is
// the GM).
import { mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { createCliRenderer, createServer } from "./deps.js";
import { mountScreen } from "./screen.js";
import { World } from "./world.js";

const { values } = parseArgs({
	options: {
		local: { type: "boolean" },
		port: { default: "2400", type: "string" },
		state: {
			default: path.join(import.meta.dirname, ".state"),
			type: "string",
		},
	},
});
mkdirSync(values.state, { recursive: true });
const world = new World(
	path.join(values.state, "names.json"),
	path.join(values.state, "inputs.jsonl")
);

const server = createServer({
	auth: { publicKey: "any" },
	hostKey: { path: path.join(values.state, "host-key") },
}).serve((session) => {
	const unmount = mountScreen({
		key: session.identity.fingerprint,
		quit: () => session.end(),
		renderer: session.renderer,
		world,
	});
	session.onClose(unmount);
});
const listening = await server.listen(Number(values.port), "0.0.0.0");

if (values.local) {
	const renderer = await createCliRenderer({ exitOnCtrlC: false });
	mountScreen({
		key: "local",
		quit: () => {
			renderer.destroy();
			process.exit(0);
		},
		renderer,
		world,
	});
} else {
	console.log(`spike b: ssh -p ${listening.port} <this machine>`);
}
