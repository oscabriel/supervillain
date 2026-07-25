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
	parseActorRosterRequest,
	parseRegistrationOutcome,
	parseStreamCredit,
	parseStreamOpen,
	parseSubmitRequest,
} from "./messages.js";
import type { RoomInfo } from "./messages.js";
import { MultiplexPipe } from "./pipe.js";
import type { PipeStream } from "./pipe.js";
import type { TransportConnection, TransportDialer } from "./seam.js";
import { TransportTrustError } from "./seam.js";
import { createSubmissionMemory } from "./submissions.js";
import type { SubmissionMemory } from "./submissions.js";

/** One Room this Host offers over the pipe. */
export interface HostedRoom {
	readonly name: string;
	readonly info: RoomInfo;
	readonly store: RoomStore;
	/**
	 * Every actor this room's log mentions, read fresh each time the gateway
	 * asks. It is the room's whole half of ADR-0005 linking: the gateway
	 * resolves the roster against its graph and stamps back what is missing, so
	 * no queue of pending linkings exists on either side (ADR-0013).
	 *
	 * Omitted, the room simply declines to be told — nothing breaks, and
	 * nothing links.
	 */
	readonly actors?: () => readonly string[];
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
	/** Answered submission ids one Room remembers, for the replay dedupe.
	 * Defaults to the memory's own pinned size. */
	readonly submissionMemory?: number;
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
 *
 * The Host is also where the submission-id dedupe is enforced (ADR-0012,
 * NQ-6), because the Host is the only writer: a replayed id is answered from
 * memory and never reaches `submit` twice, so a command lands exactly once or
 * not at all.
 */
const serveSubmit = async (
	stream: PipeStream,
	room: HostedRoom,
	memory: SubmissionMemory
): Promise<void> => {
	for (;;) {
		// oxlint-disable-next-line eslint/no-await-in-loop -- submit is a sequential request/response channel.
		const request = parseSubmitRequest(decodeJson(await stream.receive()));
		const { submissionId } = request;
		const remembered =
			submissionId === undefined ? undefined : memory.recall(submissionId);
		// oxlint-disable-next-line eslint/no-await-in-loop -- each response follows one submitted command.
		const submission = remembered ?? (await room.store.submit(request.command));
		if (submissionId !== undefined && remembered === undefined) {
			memory.remember(submissionId, submission);
		}
		// oxlint-disable-next-line eslint/no-await-in-loop -- responses leave in the order their commands arrived.
		await stream.send(encodeJson(submission));
	}
};

/** The room's half of ADR-0005 linking: hand the gateway the actor list its
 * graph needs, and let it stamp back what this log is missing. The list is
 * derived from the log on the spot — the Host keeps no linking bookkeeping. */
const serveLink = async (
	stream: PipeStream,
	room: HostedRoom
): Promise<void> => {
	parseActorRosterRequest(decodeJson(await stream.receive()));
	await stream.send(encodeJson({ actors: room.actors?.() ?? [] }));
	stream.close();
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
	rooms: ReadonlyMap<string, HostedRoom>,
	memories: ReadonlyMap<string, SubmissionMemory>
): Promise<void> => {
	const room = rooms.get(stream.room);
	const memory = memories.get(stream.room);
	if (room === undefined || memory === undefined) {
		stream.fail(`No room named '${stream.room}' is hosted here.`);
		return;
	}
	if (stream.channel === "info") {
		await serveInfo(stream, room);
		return;
	}
	if (stream.channel === "submit") {
		await serveSubmit(stream, room, memory);
		return;
	}
	if (stream.channel === "stream") {
		await serveStream(stream, room);
		return;
	}
	if (stream.channel === "link") {
		await serveLink(stream, room);
		return;
	}
	// `register` is the Host's to open, not to answer.
	stream.fail(`Channel '${stream.channel}' is not served by this Host.`);
};

/** A malformed request or a dropped pipe ends that exchange only. */
const serve = async (
	stream: PipeStream,
	rooms: ReadonlyMap<string, HostedRoom>,
	memories: ReadonlyMap<string, SubmissionMemory>
): Promise<void> => {
	try {
		await serveRoomStream(stream, rooms, memories);
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

/** The two-message version negotiation every pipe opens with. Exported inside
 * the package so the link client dials the same contract, not a lookalike. */
export const handshake = async (
	connection: TransportConnection
): Promise<void> => {
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
	// One memory per Room, minted here rather than per pipe: the resend that
	// dedupe exists to make safe is precisely the one that follows a dropped
	// pipe, so the memory has to outlive the pipe (ADR-0012, NQ-6).
	const memories = new Map(
		options.rooms.map((room) => [
			room.name,
			createSubmissionMemory(options.submissionMemory),
		])
	);
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
				void serve(stream, rooms, memories);
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
				// Two errors stop the redial loop rather than feeding it. A refusal
				// is the gateway's answer and will not change on retry; a trust
				// failure is worse — redialing a gateway whose certificate is not
				// the pinned one is exactly the silent continue trust-on-first-use
				// exists to prevent (ADR-0014).
				if (
					error instanceof HostPipeRefusedError ||
					error instanceof TransportTrustError
				) {
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
