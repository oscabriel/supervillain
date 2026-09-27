// Spike A, the GM side: one process owns the log, runs decide, and renders one
// OpenTUI screen per SSH session. With --dial it also dials out to a relay and
// serves every player connection the relay hands it.
//
//   bun spikes/a-render-location/host.ts <campaign-folder> [--port 2222]
//        [--dial relay-host:7000]
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";

import {
	apply,
	createServer,
	decide,
	eventTypes,
	init,
	InProcessRoomStore,
	RoomHost,
	runTable,
	view,
} from "./deps.js";

const { positionals, values } = parseArgs({
	allowPositionals: true,
	options: {
		dial: { type: "string" },
		port: { default: "2222", type: "string" },
	},
});
const [campaignFolder] = positionals;
if (campaignFolder === undefined) {
	console.error(
		"usage: host.ts <campaign-folder> [--port n] [--dial host:port]"
	);
	process.exit(1);
}

const actorFor = (seed: string): string =>
	createHash("sha256").update(seed).digest("hex");
const gmActor = actorFor("spike-a-gm");

await mkdir(campaignFolder, { recursive: true });
const registry = {
	get: () =>
		({
			authority: { decide },
			grammar: { eventTypes },
			model: { apply, init },
		}) as never,
};
const entry = { model: { apply, init }, view } as never;
const host = await RoomHost.open({
	actor: gmActor,
	campaignFolder,
	gameId: "draw-steel",
	registry,
});
const store = new InProcessRoomStore(host);

let sessions = 0;
const server = createServer({
	auth: { publicKey: "any" },
	hostKey: { path: `${campaignFolder}/.spike-host-key` },
}).serve(async (ssh) => {
	const actor = actorFor(ssh.identity.fingerprint);
	await store.submit({ actor, command: { type: "core.claim-seat" } });
	sessions += 1;
	const closeListeners = new Set<() => void>();
	let closed = false;
	const close = () => {
		if (closed) {
			return;
		}
		closed = true;
		for (const listener of closeListeners) {
			listener();
		}
	};
	ssh.onClose(close);
	ssh.renderer.keyInput.on(
		"keypress",
		(key: { ctrl: boolean; name: string }) => {
			if (key.ctrl && key.name === "c") {
				close();
			}
		}
	);
	const output = new Writable({
		write(chunk: Buffer, _encoding, callback) {
			ssh.write(chunk);
			callback();
		},
	}) as unknown as NodeJS.WriteStream;
	const session = {
		actor,
		close,
		input: ssh.renderer.stdin,
		onClose(listener: () => void) {
			closeListeners.add(listener);
			return () => closeListeners.delete(listener);
		},
		onResize(listener: (size: { columns: number; rows: number }) => void) {
			return ssh.onResize((columns, rows) => listener({ columns, rows }));
		},
		output,
		size: () => ({ columns: ssh.cols, rows: ssh.rows }),
	};
	try {
		await runTable({
			entry,
			gameId: "draw-steel",
			renderer: ssh.renderer,
			roomLabel: "spike-a",
			session,
			store,
		});
	} finally {
		sessions -= 1;
		ssh.end();
	}
});

const listening = await server.listen(Number(values.port), "0.0.0.0");
console.log(`host: serving SSH on :${listening.port}`);

// Dial-out mode: one control connection to the relay; for each player the
// relay announces, open a data connection and splice it into our own SSH port.
const dialRelay = (address: string) => {
	const [relayHost, relayPort] = address.split(":");
	const control = net.connect(Number(relayPort), relayHost, () => {
		control.write("HOST\n");
		console.log(`host: dialed relay ${address}`);
	});
	let pending = "";
	control.on("data", (chunk) => {
		pending += chunk.toString();
		let newline = pending.indexOf("\n");
		while (newline !== -1) {
			const line = pending.slice(0, newline);
			pending = pending.slice(newline + 1);
			const [verb, id] = line.split(" ");
			if (verb === "OPEN" && id !== undefined) {
				const data = net.connect(Number(relayPort), relayHost, () => {
					data.write(`DATA ${id}\n`);
					const local = net.connect(listening.port, "127.0.0.1");
					data.pipe(local).pipe(data);
					local.on("error", () => data.destroy());
					data.on("error", () => local.destroy());
				});
				data.setNoDelay(true);
			}
			newline = pending.indexOf("\n");
		}
	});
	control.on("close", () => {
		console.log("host: relay control closed; redialing in 2s");
		setTimeout(() => dialRelay(address), 2000);
	});
	control.on("error", () => undefined);
};
if (values.dial !== undefined) {
	dialRelay(values.dial);
}

// Once every ten seconds: how many screens, and what they cost the GM.
let lastCpu = process.cpuUsage();
let lastAt = performance.now();
setInterval(() => {
	const cpu = process.cpuUsage(lastCpu);
	const now = performance.now();
	const percent = ((cpu.user + cpu.system) / 1000 / (now - lastAt)) * 100;
	lastCpu = process.cpuUsage();
	lastAt = now;
	const rss = Math.round(process.memoryUsage().rss / 1024 / 1024);
	console.log(
		`host: ${sessions} screens · cpu ${percent.toFixed(1)}% · rss ${rss} MiB`
	);
}, 10_000).unref();
