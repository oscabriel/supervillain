/* oxlint-disable promise/avoid-new, promise/prefer-await-to-callbacks -- an SSH channel opening is an event, and ssh2 hands one over through a callback. */
/**
 * One seat in the R9 matrix: a real SSH session against the gateway under
 * test, opened with a real key, carrying a real PTY.
 *
 * Two kinds of reader live here, and the difference is the whole point of the
 * slow-reader workload: a **fast** seat attaches a data handler and counts
 * every byte, while a **slow** seat attaches none at all. An ssh2 channel with
 * no consumer stays in non-flowing mode, so its receive window fills and the
 * gateway's writes to that one seat stall — which is exactly the condition
 * ADR-0012 (NQ-5) promises costs that seat alone.
 */
import { Client, utils } from "ssh2";
import type { ClientChannel } from "ssh2";

export interface SeatKey {
	readonly privateKey: string;
}

/**
 * A pool of keys, minted once and reused across cells: the matrix measures
 * carrying sessions, not generating keys.
 *
 * Each one is parsed before it is kept. `generateKeyPairSync` occasionally
 * hands back a key `parseKey` then refuses — rare enough to survive a short
 * run and common enough to kill a sixteen-cell matrix halfway through, which
 * is the worst possible place to find out.
 */
export const mintSeatKeys = (count: number): readonly SeatKey[] => {
	const keys: SeatKey[] = [];
	while (keys.length < count) {
		const { private: privateKey } = utils.generateKeyPairSync("ed25519");
		if (!(utils.parseKey(privateKey) instanceof Error)) {
			keys.push({ privateKey });
		}
	}
	return keys;
};

export interface SeatOptions {
	readonly host: string;
	readonly port: number;
	/** The SSH username is the room name — that is the whole join surface. */
	readonly room: string;
	readonly key: SeatKey;
	readonly columns: number;
	readonly rows: number;
	/** True for a seat that never reads its channel. */
	readonly slow: boolean;
}

export interface Seat {
	/** Bytes this seat actually received. A slow seat reads none, on purpose. */
	readonly bytesOut: () => number;
	/** Sends keystrokes and starts a key-to-frame stopwatch. */
	readonly type: (keys: string) => void;
	/** Starts a broadcast stopwatch: the Host posted an envelope at `at`. */
	readonly expectBroadcast: (at: number) => void;
	/** Every latency sample this seat produced, in ms. */
	readonly latencies: () => readonly number[];
	/** True once the gateway closed this seat — the fold dropping it, or the
	 * door closing. */
	readonly closed: () => boolean;
	readonly close: () => void;
	/** Whatever the gateway wrote last, for reading refusal copy back. */
	readonly transcript: () => string;
}

const TRANSCRIPT_LIMIT = 4096;

/** Opens one seat and resolves once its channel exists. Rejects on a refused
 * connection: a harness that silently ran 40 seats instead of 50 would be
 * measuring nothing in particular. */
export const openSeat = (options: SeatOptions): Promise<Seat> =>
	new Promise<Seat>((resolve, reject) => {
		const client = new Client();
		let bytesOut = 0;
		let keyAt: number | undefined;
		let broadcastAt: number | undefined;
		let channelClosed = false;
		let clientClosed = false;
		let failed = false;
		let transcript = "";
		const latencies: number[] = [];

		const onData = (chunk: Buffer): void => {
			bytesOut += chunk.byteLength;
			if (transcript.length < TRANSCRIPT_LIMIT) {
				transcript += chunk.toString("utf-8");
			}
			const now = performance.now();
			if (keyAt !== undefined) {
				latencies.push(now - keyAt);
				keyAt = undefined;
			}
			if (broadcastAt !== undefined) {
				latencies.push(now - broadcastAt);
				broadcastAt = undefined;
			}
		};

		const seatFor = (channel: ClientChannel): Seat => ({
			bytesOut: () => bytesOut,
			close: () => {
				channel.end();
				client.end();
			},
			closed: () => failed || (channelClosed && clientClosed),
			expectBroadcast: (at) => {
				broadcastAt ??= at;
			},
			latencies: () => latencies,
			transcript: () => transcript,
			type: (keys) => {
				keyAt ??= performance.now();
				channel.write(keys);
			},
		});

		client
			.on("close", () => {
				clientClosed = true;
			})
			.on("ready", () => {
				client.shell(
					{ cols: options.columns, rows: options.rows, term: "xterm-256color" },
					(error, channel) => {
						if (error) {
							reject(error);
							return;
						}
						channel.on("close", () => {
							channelClosed = true;
							client.end();
						});
						if (options.slow) {
							// No data handler: the channel never flows, the window fills,
							// and this seat stops reading without lying about it.
							channel.on("error", () => {
								failed = true;
							});
						} else {
							channel.on("data", onData);
						}
						resolve(seatFor(channel));
					}
				);
			})
			.on("error", (error: Error) => {
				failed = true;
				reject(error);
			})
			.connect({
				host: options.host,
				port: options.port,
				privateKey: options.key.privateKey,
				readyTimeout: 30_000,
				username: options.room,
			});
	});
