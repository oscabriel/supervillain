// Spike A, the relay: a dumb TCP forwarder. The GM's host dials in once on the
// control port; each player's TCP connection is announced to the host, which
// dials back a data connection that the relay splices to the player. SSH runs
// end to end between player and host, so the relay sees only ciphertext
// (the `ssh -J` variant from ASSESSMENT §6). It knows nothing about games.
//
//   bun spikes/a-render-location/relay.ts [--players 2222] [--control 7000]
//        [--delay-ms 0]
//
// --delay-ms adds that much one-way delay to every chunk crossing the
// host leg, in both directions, to simulate a distant GM on one machine.
import net from "node:net";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		control: { default: "7000", type: "string" },
		"delay-ms": { default: "0", type: "string" },
		players: { default: "2222", type: "string" },
	},
});
const delayMs = Number(values["delay-ms"]);

let hostControl: net.Socket | undefined;
const waiting = new Map<string, net.Socket>();
let nextId = 1;
let bytesFromHost = 0;
let bytesToHost = 0;

const forward = (
	from: net.Socket,
	to: net.Socket,
	count: (n: number) => void
) => {
	from.on("data", (chunk) => {
		count(chunk.length);
		if (delayMs > 0) {
			setTimeout(() => to.write(chunk), delayMs);
		} else {
			to.write(chunk);
		}
	});
	from.on("close", () => setTimeout(() => to.destroy(), delayMs));
	from.on("error", () => to.destroy());
};

net
	.createServer((socket) => {
		socket.setNoDelay(true);
		socket.once("data", (first) => {
			const newline = first.indexOf("\n");
			const [verb, id] = first.subarray(0, newline).toString().split(" ");
			const rest = first.subarray(newline + 1);
			if (verb === "HOST") {
				hostControl?.destroy();
				hostControl = socket;
				console.log("relay: host connected");
				socket.on("close", () => {
					if (hostControl === socket) {
						hostControl = undefined;
					}
				});
				return;
			}
			const player = id === undefined ? undefined : waiting.get(id);
			if (verb !== "DATA" || player === undefined) {
				socket.destroy();
				return;
			}
			waiting.delete(id as string);
			if (rest.length > 0) {
				bytesFromHost += rest.length;
				player.write(rest);
			}
			forward(socket, player, (n) => {
				bytesFromHost += n;
			});
			forward(player, socket, (n) => {
				bytesToHost += n;
			});
			player.resume();
		});
	})
	.listen(Number(values.control), "0.0.0.0");

net
	.createServer((player) => {
		player.setNoDelay(true);
		if (hostControl === undefined) {
			player.end("SSH-2.0-relay\r\nno table is open here\r\n");
			return;
		}
		player.pause();
		const id = String(nextId);
		nextId += 1;
		waiting.set(id, player);
		hostControl.write(`OPEN ${id}\n`);
		player.on("close", () => waiting.delete(id));
	})
	.listen(Number(values.players), "0.0.0.0");

console.log(
	`relay: players on :${values.players}, host control on :${values.control}, delay ${delayMs} ms`
);

// GM upload is what the host sends the relay.
let lastFromHost = 0;
let lastToHost = 0;
setInterval(() => {
	const up = (bytesFromHost - lastFromHost) / 10 / 1024;
	const down = (bytesToHost - lastToHost) / 10 / 1024;
	lastFromHost = bytesFromHost;
	lastToHost = bytesToHost;
	console.log(
		`relay: GM upload ${up.toFixed(1)} KiB/s · GM download ${down.toFixed(1)} KiB/s`
	);
}, 10_000).unref();
