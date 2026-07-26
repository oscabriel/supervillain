/**
 * The Host half of the R9 harness: one in-memory Room, plus the byte counter
 * wrapped around the pipe it is served over.
 *
 * It is deliberately not a real `room-host`: the gateway may not import that
 * package (the lattice forbids it, and rightly — the gateway never decides),
 * and a real log would put disk I/O inside a measurement of gateway CPU. What
 * the harness needs from a Host is exactly what the pipe asks of one: answer
 * `info`, serve `stream`, and turn a submitted command into envelopes.
 */
/* oxlint-disable eslint/no-loop-func -- the feed's park closes over its own waiter list, which is the point. */
import { randomUUID } from "node:crypto";

import { DEFAULT_MAP_LEGEND } from "@supervillain/core";
import type {
	Envelope,
	NamespacedType,
	RoomCommand,
	RoomStore,
	RoomSubmission,
} from "@supervillain/core";
import type {
	TransportConnection,
	TransportDialer,
} from "@supervillain/room-wire";

/** Bytes counted on the one Host pipe — the single-pipe saturation question
 * (NQ-2's only reopening trigger is this measurement or production telemetry). */
export interface PipeBytes {
	/** Frames this Host sent up to the gateway. */
	sent: number;
	/** Frames the gateway sent down to this Host. */
	received: number;
}

/** Wraps a dialer so every byte over the one pipe is counted. It changes
 * nothing about the connection: the seam is three methods and this forwards
 * all three. */
export const countingDialer = (
	inner: TransportDialer,
	bytes: PipeBytes
): TransportDialer => ({
	dial: async () => {
		const connection = await inner.dial();
		const counted: TransportConnection = {
			close: () => connection.close(),
			receive: async () => {
				const message = await connection.receive();
				bytes.received += message.byteLength;
				return message;
			},
			remoteId: connection.remoteId,
			send: async (message) => {
				bytes.sent += message.byteLength;
				await connection.send(message);
			},
		};
		return counted;
	},
});

const MAP_WIDTH = 72;
const MAP_HEIGHT = 22;

/** A room-sized grid: walls around the outside, floor inside, a scatter of
 * hazards so a pan actually changes cells rather than repainting one colour. */
const benchMapRows = (): readonly string[] => {
	const rows: string[] = [];
	for (let y = 0; y < MAP_HEIGHT; y += 1) {
		let row = "";
		for (let x = 0; x < MAP_WIDTH; x += 1) {
			const edge =
				x === 0 || y === 0 || x === MAP_WIDTH - 1 || y === MAP_HEIGHT - 1;
			const inside = (x * 7 + y * 3) % 11 === 0 ? "^" : ".";
			row += edge ? "#" : inside;
		}
		rows.push(row);
	}
	return rows;
};

export interface BenchRoomOptions {
	/** Seeds the Room with the battle map the capacity matrix pans. */
	readonly map?: boolean;
}

export interface BenchRoom extends RoomStore {
	/** Appends one envelope from the Host side — the harness's stand-in for a
	 * GM's machine producing events nobody asked it for. */
	readonly post: (text: string) => void;
	readonly length: () => number;
}

/**
 * The Room the matrix runs against: seeded with a created event and a battle
 * map (map-pan needs a map to pan), and answering the handful of commands the
 * table can send.
 */
export const createBenchRoom = (
	gameId: string,
	options: BenchRoomOptions = {}
): BenchRoom => {
	const envelopes: Envelope[] = [];
	let waiters: (() => void)[] = [];
	let seats = 0;

	const append = (
		actor: string,
		type: NamespacedType,
		payload: unknown
	): Envelope => {
		const envelope: Envelope = {
			actor,
			payload,
			seq: envelopes.length + 1,
			timestamp: new Date().toISOString(),
			type,
		};
		envelopes.push(envelope);
		const woken = waiters;
		waiters = [];
		for (const wake of woken) {
			wake();
		}
		return envelope;
	};

	append("bench-host", "core.room-created", { gameId });
	if (options.map ?? true) {
		append("bench-host", "core.map-loaded", {
			legend: DEFAULT_MAP_LEGEND,
			name: "bench-hall",
			rows: benchMapRows(),
		});
	}

	const decide = (command: RoomCommand): readonly Envelope[] => {
		const asked = command.command as { readonly type?: string };
		if (asked.type === "core.claim-seat") {
			seats += 1;
			return [
				append(command.actor, "core.seat-claimed", { seatId: `seat-${seats}` }),
			];
		}
		if (asked.type === "core.chat") {
			const { text } = command.command as { readonly text: string };
			return [append(command.actor, "core.chat-posted", { text })];
		}
		// Everything else is accepted and folds to nothing: the matrix measures
		// carrying and rendering, not a game's rules.
		return [];
	};

	return {
		length: () => envelopes.length,
		post: (text) => {
			append("bench-host", "core.chat-posted", { text });
		},
		stream: (fromSeq) => ({
			// oxlint-disable-next-line eslint/func-names -- a named generator would not read better here.
			async *[Symbol.asyncIterator](): AsyncGenerator<Envelope> {
				let index = Math.max(0, fromSeq - 1);
				for (;;) {
					while (index < envelopes.length) {
						const next = envelopes[index];
						index += 1;
						if (next !== undefined) {
							yield next;
						}
					}
					// oxlint-disable-next-line eslint/no-await-in-loop, promise/avoid-new -- one park per quiet gap is the shape of a feed.
					await new Promise<void>((resolve) => {
						waiters.push(resolve);
					});
				}
			},
		}),
		submit: (command) =>
			Promise.resolve<RoomSubmission>({
				accepted: true,
				envelopes: decide(command),
			}),
	};
};

/** A fresh ed25519 seed, as the transport wants it. The harness's Host has no
 * durable identity: it is a new machine every run. */
export const benchSecretKeyHex = (): string =>
	randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
