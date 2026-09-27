// A scripted SSH player for the probe and the load generator.
import { ssh2 } from "./deps.js";
import type { Ssh2Stream } from "./deps.js";

export interface Player {
	readonly stream: Ssh2Stream;
	/** Output received since the last `take()`. */
	readonly take: () => Buffer;
	/** Resolves once no output has arrived for `quietMs` (or `maxMs` passes). */
	readonly settle: (quietMs: number, maxMs: number) => Promise<void>;
	/** Resolves with the time at which `needle` next appears in the output. */
	readonly waitFor: (
		needle: Buffer,
		timeoutMs: number
	) => Promise<number | null>;
	readonly end: () => void;
}

export const connectPlayer = (
	address: string,
	name: string,
	size = { cols: 100, rows: 30 }
): Promise<Player> => {
	const [host, port] = address.split(":");
	const client = new ssh2.Client();
	const key = ssh2.utils.generateKeyPairSync("ed25519");
	let buffered: Buffer[] = [];
	let lastOutputAt = performance.now();
	const watchers = new Set<(chunk: Buffer, at: number) => void>();
	return new Promise((resolve, reject) => {
		client.on("error", reject);
		client.on("ready", () => {
			client.shell({ ...size, term: "xterm-256color" }, (error, stream) => {
				if (error !== undefined) {
					reject(error);
					return;
				}
				stream.on("data", (chunk: Buffer) => {
					const at = performance.now();
					lastOutputAt = at;
					buffered.push(chunk);
					for (const watcher of watchers) {
						watcher(chunk, at);
					}
				});
				resolve({
					end: () => client.end(),
					settle: (quietMs, maxMs) =>
						new Promise((done) => {
							const started = performance.now();
							const tick = setInterval(() => {
								const now = performance.now();
								if (now - lastOutputAt >= quietMs || now - started >= maxMs) {
									clearInterval(tick);
									done();
								}
							}, 10);
						}),
					stream,
					take: () => {
						const all = Buffer.concat(buffered);
						buffered = [];
						return all;
					},
					waitFor: (needle, timeoutMs) =>
						new Promise((done) => {
							let tail = Buffer.alloc(0);
							const watcher = (chunk: Buffer, at: number) => {
								tail = Buffer.concat([tail, chunk]);
								if (tail.includes(needle)) {
									finish(at);
								} else {
									tail = tail.subarray(-needle.length);
								}
							};
							const timer = setTimeout(() => finish(null), timeoutMs);
							const finish = (at: number | null) => {
								clearTimeout(timer);
								watchers.delete(watcher);
								done(at);
							};
							watchers.add(watcher);
						}),
				});
			});
		});
		client.connect({
			host,
			port: Number(port),
			privateKey: key.private,
			readyTimeout: 20_000,
			username: name,
		});
	});
};

export const sleep = (ms: number) =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** A character the table never draws on its own. */
export const MARK = "ж";

/** The archived build opens with focus off the input line: Tab until typing
 * echoes. Resolves false if it never does. */
export const focusInput = async (player: Player): Promise<boolean> => {
	const needle = Buffer.from(MARK);
	for (let tries = 0; tries < 5; tries += 1) {
		const echoed = player.waitFor(needle, 1000);
		player.stream.write(MARK);
		// oxlint-disable-next-line eslint/no-await-in-loop -- each try depends on the last.
		const focused = (await echoed) !== null;
		player.stream.write(focused ? "\u007f" : "\t");
		// oxlint-disable-next-line eslint/no-await-in-loop -- let the pane change land.
		await player.settle(200, 2000);
		if (focused) {
			return true;
		}
	}
	return false;
};
