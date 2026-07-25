/**
 * The Host's half of the pipe (ADR-0012). The direction is inverted from the
 * founding design: the Host dials out and keeps dialing, and the gateway never
 * dials back. The dialing side is still the side that *answers* requests —
 * registration goes up, info/submit/stream come down.
 */
import { setTimeout as delay } from "node:timers/promises";

import type { RoomStore } from "@supervillain/core";

import {
	encodePipeHello,
	parsePipeHandshakeOutcome,
	SUPPORTED_PIPE_PROTOCOL_VERSIONS,
} from "./frames.js";
import {
	decodeJson,
	encodeJson,
	parseRegistrationOutcome,
	parseRoomCommand,
	parseStreamCredit,
	parseStreamOpen,
} from "./messages.js";
import type { RoomInfo } from "./messages.js";
import { MultiplexPipe } from "./pipe.js";
import type { PipeStream } from "./pipe.js";
import type { TransportConnection, TransportDialer } from "./seam.js";

/** One Room this Host offers over the pipe. */
export interface HostedRoom {
	readonly name: string;
	readonly info: RoomInfo;
	readonly store: RoomStore;
}

/** What the gateway told this Host when it accepted the registration. */
export interface HostPipeAttachment {
	/** The gateway's authenticated identity — 64 lowercase hex chars. */
	readonly gatewayId: string;
	readonly sshHost: string;
	readonly sshPort: number;
}

/** Metadata only, per the logging policy (ADR-0012, NQ-11): lifecycle, counts,
 * error text of our own making, and room names. Never payloads. */
export type HostPipeEvent =
	| { readonly kind: "attached"; readonly rooms: readonly string[] }
	| { readonly kind: "detached"; readonly reason: string }
	| { readonly kind: "dialing"; readonly attempt: number }
	| { readonly kind: "refused"; readonly reason: string };

/** The gateway said no in a way redialling cannot fix: an unsupported protocol
 * version, or a name another identity owns. Honest refusal, never a retry loop
 * against a wall. */
export class HostPipeRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HostPipeRefusedError";
	}
}

export interface HostPipeOptions {
	readonly dialer: TransportDialer;
	readonly rooms: readonly HostedRoom[];
	/** Delay in ms before redial attempt `attempt` (1-based). Default:
	 * exponential 500ms doubling, capped at 30s, with full jitter. */
	readonly reconnectDelayMs?: (attempt: number) => number;
	readonly heartbeatIntervalMs?: number;
	readonly heartbeatMisses?: number;
	readonly onEvent?: (event: HostPipeEvent) => void;
}

export interface HostPipe {
	/** Resolves when the gateway first accepts this Host's rooms; rejects on a
	 * refusal. Reattachment after a drop does not resolve it again. */
	readonly attached: Promise<HostPipeAttachment>;
	readonly close: () => Promise<void>;
}

const MAX_RECONNECT_DELAY_MS = 30_000;

/** Backoff with full jitter: an unattended homelab Host redials forever, and a
 * fleet of them must not redial in lockstep. */
const defaultReconnectDelay = (attempt: number): number =>
	Math.random() * Math.min(500 * 2 ** (attempt - 1), MAX_RECONNECT_DELAY_MS);

const serveInfo = async (
	stream: PipeStream,
	room: HostedRoom
): Promise<void> => {
	await stream.receive();
	await stream.send(encodeJson(room.info));
	stream.close();
};

/**
 * The peer on this pipe is the gateway this Host chose to dial and
 * challenge-signature authenticated, so it is the trusted stamper of ADR-0003:
 * the actors it names are the players it admitted at its own door.
 */
const serveSubmit = async (
	stream: PipeStream,
	room: HostedRoom
): Promise<void> => {
	for (;;) {
		// oxlint-disable-next-line eslint/no-await-in-loop -- submit is a sequential request/response channel.
		const command = parseRoomCommand(decodeJson(await stream.receive()));
		// oxlint-disable-next-line eslint/no-await-in-loop -- each response follows one submitted command.
		const submission = await room.store.submit(command);
		// oxlint-disable-next-line eslint/no-await-in-loop -- responses leave in the order their commands arrived.
		await stream.send(encodeJson(submission));
	}
};

const serveStream = async (
	stream: PipeStream,
	room: HostedRoom
): Promise<void> => {
	const fromSeq = parseStreamOpen(decodeJson(await stream.receive()));
	const iterator = room.store.stream(fromSeq)[Symbol.asyncIterator]();
	try {
		for (;;) {
			// oxlint-disable-next-line eslint/no-await-in-loop -- each credit requests exactly one Envelope.
			parseStreamCredit(decodeJson(await stream.receive()));
			// oxlint-disable-next-line eslint/no-await-in-loop -- the Log is read in order, one Envelope per credit.
			const next = await iterator.next();
			if (next.done === true) {
				stream.close();
				return;
			}
			// oxlint-disable-next-line eslint/no-await-in-loop -- stream envelopes must be sent in Log order.
			await stream.send(encodeJson(next.value));
		}
	} finally {
		void iterator.return?.();
	}
};

const serveRoomStream = async (
	stream: PipeStream,
	rooms: ReadonlyMap<string, HostedRoom>
): Promise<void> => {
	const room = rooms.get(stream.room);
	if (room === undefined) {
		stream.fail(`No room named '${stream.room}' is hosted here.`);
		return;
	}
	if (stream.channel === "info") {
		await serveInfo(stream, room);
		return;
	}
	if (stream.channel === "submit") {
		await serveSubmit(stream, room);
		return;
	}
	if (stream.channel === "stream") {
		await serveStream(stream, room);
		return;
	}
	// `register` is the Host's to open, not to answer, and `link` waits on the
	// key-equivalence graph (ADR-0005), which does not exist yet.
	stream.fail(`Channel '${stream.channel}' is not served by this Host.`);
};

/** A malformed request or a dropped pipe ends that exchange only. */
const serve = async (
	stream: PipeStream,
	rooms: ReadonlyMap<string, HostedRoom>
): Promise<void> => {
	try {
		await serveRoomStream(stream, rooms);
	} catch {
		stream.close();
	}
};

const closeQuietly = async (connection: TransportConnection): Promise<void> => {
	try {
		await connection.close();
	} catch {
		// The gateway may already have dropped the connection.
	}
};

const handshake = async (connection: TransportConnection): Promise<void> => {
	await connection.send(
		encodePipeHello({ versions: SUPPORTED_PIPE_PROTOCOL_VERSIONS })
	);
	const outcome = parsePipeHandshakeOutcome(await connection.receive());
	if ("rejected" in outcome) {
		throw new HostPipeRefusedError(outcome.message);
	}
};

const registerRoomOnPipe = async (
	pipe: MultiplexPipe,
	room: HostedRoom
): Promise<HostPipeAttachment> => {
	const stream = pipe.open(room.name, "register");
	await stream.send(encodeJson({ name: room.name }));
	const outcome = parseRegistrationOutcome(decodeJson(await stream.receive()));
	stream.close();
	if ("rejected" in outcome) {
		throw new HostPipeRefusedError(outcome.message);
	}
	return {
		gatewayId: pipe.remoteId,
		sshHost: outcome.sshHost,
		sshPort: outcome.sshPort,
	};
};

const describe = (reason: unknown): string => {
	if (reason === undefined) {
		return "closed";
	}
	return reason instanceof Error ? reason.message : "pipe failed";
};

/**
 * Opens and keeps open the Host's one pipe to a gateway. Every Room and every
 * channel multiplexes over it; when it drops, the Host redials forever with
 * backoff and jitter. A command is never auto-resubmitted by any of this
 * (ADR-0001): reconnecting restores the pipe, not lost work.
 */
export const openHostPipe = (options: HostPipeOptions): HostPipe => {
	const rooms = new Map(options.rooms.map((room) => [room.name, room]));
	const reconnectDelayMs = options.reconnectDelayMs ?? defaultReconnectDelay;
	const attached = Promise.withResolvers<HostPipeAttachment>();
	const onEvent = options.onEvent ?? ((): void => undefined);
	let settled = false;
	let stopped = false;
	let current: MultiplexPipe | undefined;

	const attach = async (): Promise<void> => {
		const connection = await options.dialer.dial();
		try {
			await handshake(connection);
		} catch (error) {
			await closeQuietly(connection);
			throw error;
		}
		const ended = Promise.withResolvers<unknown>();
		const pipe = new MultiplexPipe({
			connection,
			heartbeatIntervalMs: options.heartbeatIntervalMs,
			heartbeatMisses: options.heartbeatMisses,
			initiator: true,
			onClosed: (reason) => ended.resolve(reason),
			onStream: (stream) => {
				void serve(stream, rooms);
			},
		});
		current = pipe;
		try {
			for (const room of options.rooms) {
				// oxlint-disable-next-line eslint/no-await-in-loop -- each name is claimed before the next is asked for.
				const attachment = await registerRoomOnPipe(pipe, room);
				if (!settled) {
					settled = true;
					attached.resolve(attachment);
				}
			}
		} catch (error) {
			await pipe.close();
			throw error;
		}
		onEvent({ kind: "attached", rooms: [...rooms.keys()] });
		const reason = await ended.promise;
		current = undefined;
		onEvent({ kind: "detached", reason: describe(reason) });
	};

	const run = async (): Promise<void> => {
		let attempt = 0;
		for (;;) {
			if (stopped) {
				return;
			}
			attempt += 1;
			onEvent({ attempt, kind: "dialing" });
			try {
				// oxlint-disable-next-line eslint/no-await-in-loop -- one live pipe at a time is the whole design.
				await attach();
				attempt = 0;
			} catch (error) {
				if (error instanceof HostPipeRefusedError) {
					if (settled) {
						onEvent({ kind: "refused", reason: error.message });
					} else {
						settled = true;
						attached.reject(error);
					}
					return;
				}
				if (stopped) {
					return;
				}
				// oxlint-disable-next-line eslint/no-await-in-loop -- backoff happens once per failed attempt.
				await delay(reconnectDelayMs(attempt));
			}
		}
	};

	const loop = run();
	// A caller that never asks whether it attached must not crash the process
	// when the answer turns out to be "no".
	void (async (): Promise<void> => {
		try {
			await attached.promise;
		} catch {
			// The refusal is the caller's to read, or to ignore.
		}
	})();
	return {
		attached: attached.promise,
		close: async (): Promise<void> => {
			stopped = true;
			await current?.close();
			await loop;
			if (!settled) {
				settled = true;
				attached.reject(new HostPipeRefusedError("Host pipe closed."));
			}
		},
	};
};
