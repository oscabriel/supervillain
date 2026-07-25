/**
 * The gateway's half of the pipe (ADR-0012). It listens; it never dials a Host.
 * Registration splits in two here: the durable half (`name → owner`) belongs to
 * the gateway's store behind {@link RoomOwnership}, and the live half
 * (`name → current pipe`) is memory only — the routing truth, and never durable
 * (ADR-0013's never-durable mirror).
 *
 * Each live name carries one {@link RoomFold}: one upstream feed per Room, and
 * one view per session over it (NQ-5). This file owns the plumbing between the
 * fold and the frames; the fold owns the isolation.
 */
import type { Envelope, RoomCommand, RoomSubmission } from "@supervillain/core";

import {
	encodePipeHandshakeOutcome,
	negotiatePipeVersion,
	parsePipeHello,
	UNSUPPORTED_VERSION_MESSAGE,
} from "./frames.js";
import {
	decodeJson,
	encodeJson,
	encodeSubmitRequest,
	isValidRoomName,
	parseEnvelope,
	parseRegistrationRequest,
	parseRoomInfo,
	parseRoomSubmission,
	ROOM_NAME_RULE,
} from "./messages.js";
import type { RegistrationOutcome, SubmitRequest } from "./messages.js";
import { MultiplexPipe, PipeStreamClosedError } from "./pipe.js";
import type { PipeStream } from "./pipe.js";
import { createRoomFold } from "./room-fold.js";
import type {
	RoomFold,
	RoomFoldSource,
	RoomSubmitChannel,
	RoomView,
} from "./room-fold.js";
import { TransportListenerClosedError } from "./seam.js";
import type { TransportConnection, TransportListener } from "./seam.js";
import { SubmissionUncertainError } from "./submissions.js";

export type ClaimOutcome =
	| { readonly accepted: true; readonly ownerId: string }
	| { readonly rejected: true; readonly message: string };

/**
 * The durable half. `hostKey` is the pipe's challenge-signature authenticated
 * key; the store resolves it to an owner and answers with that owner's id, so
 * the day a resolved identity replaces a bare key nothing above this seam
 * changes.
 */
export interface RoomOwnership {
	readonly claim: (hostKey: string, name: string) => Promise<ClaimOutcome>;
}

/** The live half: which pipe is currently carrying a claimed name. */
export interface LiveRoom {
	readonly name: string;
	readonly ownerId: string;
	/** The Host key on the far end of the live pipe. */
	readonly hostKey: string;
	/** One session's view of the Room's shared fold. Each caller closes its
	 * own; falling behind costs that view alone. */
	readonly openStore: () => RoomView;
	/** Sessions currently viewing this Room. Counts only (NQ-11). */
	readonly views: () => number;
}

/** Metadata only (ADR-0012, NQ-11): lifecycle, room names, error codes. */
export type GatewayPipeEvent =
	| { readonly kind: "pipe-closed"; readonly hostKey: string }
	| { readonly kind: "pipe-opened"; readonly hostKey: string }
	| { readonly kind: "pipe-refused"; readonly reason: string }
	| { readonly kind: "room-attached"; readonly room: string }
	| { readonly kind: "room-offline"; readonly room: string }
	| { readonly kind: "view-dropped"; readonly room: string };

export interface HostPipeServerOptions {
	readonly listener: TransportListener;
	readonly ownership: RoomOwnership;
	/** What a registered Host is told to put in its summon line. */
	readonly door: { readonly sshHost: string; readonly sshPort: number };
	readonly heartbeatIntervalMs?: number;
	readonly heartbeatMisses?: number;
	/** Envelopes one session may fall behind before its view is dropped. */
	readonly sessionBudget?: number;
	readonly onEvent?: (event: GatewayPipeEvent) => void;
}

export interface HostPipeServer {
	/** The live registration for a name, or undefined when no pipe carries it —
	 * which is exactly what "the room is offline" means. */
	readonly live: (name: string) => LiveRoom | undefined;
	readonly liveNames: () => readonly string[];
	readonly close: () => Promise<void>;
}

const NOT_SERVED = "Only the register channel is served by the gateway.";

const closeQuietly = async (connection: TransportConnection): Promise<void> => {
	try {
		await connection.close();
	} catch {
		// The peer may already have dropped the connection.
	}
};

/**
 * The Room's one upstream feed, read by the fold and by nobody else. Credit by
 * credit, so the Host is never asked for more than the gateway has taken.
 *
 * @yields {Envelope} every event the Host serves, in Log order.
 */
const streamRoom = async function* streamRoom(
	pipe: MultiplexPipe,
	room: string,
	fromSeq: number
): AsyncGenerator<Envelope> {
	const stream = pipe.open(room, "stream");
	try {
		await stream.send(encodeJson({ fromSeq }));
		for (;;) {
			// oxlint-disable-next-line eslint/no-await-in-loop -- each credit grants exactly one Envelope.
			await stream.send(encodeJson({ next: true }));
			// oxlint-disable-next-line eslint/no-await-in-loop -- envelopes arrive in Log order, one per credit.
			const envelope = parseEnvelope(decodeJson(await stream.receive()));
			yield envelope;
		}
	} catch {
		// A dead pipe ends the feed; the Room is offline, and nothing here
		// re-dials on the fold's behalf.
	} finally {
		stream.close();
	}
};

const write = async (
	stream: PipeStream,
	request: SubmitRequest
): Promise<void> => {
	await stream.send(encodeSubmitRequest(request));
};

/**
 * One session's submit channel. The single resend it allows is the narrow one
 * ADR-0001 always allowed — a write that failed on a stream this channel was
 * reusing, which the peer had already dropped — and it carries the same
 * submission id, so the Host's dedupe answers instead of appending twice. A
 * lost *answer* is never resent: it surfaces as
 * {@link SubmissionUncertainError} for a person to decide about.
 */
const openSubmitChannel = (
	pipe: MultiplexPipe,
	room: string
): RoomSubmitChannel => {
	let current: PipeStream | undefined;
	let closed = false;

	const discard = (dead: PipeStream): void => {
		if (current === dead) {
			current = undefined;
		}
		dead.close();
	};

	const answer = async (stream: PipeStream): Promise<RoomSubmission> => {
		try {
			return parseRoomSubmission(decodeJson(await stream.receive()));
		} catch (error) {
			discard(stream);
			throw new SubmissionUncertainError({ cause: error });
		}
	};

	return {
		close() {
			closed = true;
			if (current !== undefined) {
				discard(current);
			}
		},
		async send(command: RoomCommand, submissionId: string) {
			if (closed) {
				throw new PipeStreamClosedError("Room view is closed.");
			}
			const request: SubmitRequest = { command, submissionId };
			const reused = current !== undefined;
			const stream = (current ??= pipe.open(room, "submit"));
			try {
				await write(stream, request);
			} catch (error) {
				discard(stream);
				if (!reused) {
					throw error;
				}
				const retry = (current = pipe.open(room, "submit"));
				try {
					await write(retry, request);
				} catch (retryError) {
					discard(retry);
					throw retryError;
				}
				return await answer(retry);
			}
			return await answer(stream);
		},
	};
};

const roomSource = (pipe: MultiplexPipe, room: string): RoomFoldSource => ({
	close: () => Promise.resolve(),
	async info() {
		const stream = pipe.open(room, "info");
		try {
			await stream.send(encodeJson({}));
			return parseRoomInfo(decodeJson(await stream.receive()));
		} finally {
			stream.close();
		}
	},
	openSubmit: () => openSubmitChannel(pipe, room),
	stream: (fromSeq) => streamRoom(pipe, room, fromSeq),
});

interface PipeRegistrar {
	readonly attach: (name: string, ownerId: string) => void;
	readonly detach: (pipe: MultiplexPipe) => void;
	readonly ownership: RoomOwnership;
	readonly door: { readonly sshHost: string; readonly sshPort: number };
	readonly onEvent: (event: GatewayPipeEvent) => void;
}

const handleRegister = async (
	stream: PipeStream,
	hostKey: string,
	registrar: PipeRegistrar
): Promise<void> => {
	const name = parseRegistrationRequest(decodeJson(await stream.receive()));
	if (!isValidRoomName(name)) {
		await stream.send(
			encodeJson({ message: ROOM_NAME_RULE, rejected: true } as const)
		);
		stream.close();
		return;
	}
	const claim = await registrar.ownership.claim(hostKey, name);
	const outcome: RegistrationOutcome =
		"accepted" in claim
			? {
					accepted: true,
					sshHost: registrar.door.sshHost,
					sshPort: registrar.door.sshPort,
				}
			: { message: claim.message, rejected: true };
	await stream.send(encodeJson(outcome));
	stream.close();
	if ("accepted" in claim) {
		registrar.attach(name, claim.ownerId);
		registrar.onEvent({ kind: "room-attached", room: name });
	}
};

/** Registration never throws upward: a malformed request costs that exchange
 * its stream, nothing more. */
const register = async (
	stream: PipeStream,
	hostKey: string,
	registrar: PipeRegistrar
): Promise<void> => {
	try {
		await handleRegister(stream, hostKey, registrar);
	} catch {
		stream.fail("Registration failed.");
	}
};

const acceptPipe = async (
	connection: TransportConnection,
	options: HostPipeServerOptions,
	registrar: Omit<PipeRegistrar, "attach"> & {
		readonly attach: (
			pipe: MultiplexPipe,
			name: string,
			ownerId: string
		) => void;
	}
): Promise<MultiplexPipe | undefined> => {
	const hello = parsePipeHello(await connection.receive());
	const version = negotiatePipeVersion(hello.versions);
	if (version === undefined) {
		await connection.send(
			encodePipeHandshakeOutcome({
				message: UNSUPPORTED_VERSION_MESSAGE,
				rejected: true,
			})
		);
		registrar.onEvent({
			kind: "pipe-refused",
			reason: UNSUPPORTED_VERSION_MESSAGE,
		});
		await connection.close();
		return undefined;
	}
	await connection.send(
		encodePipeHandshakeOutcome({ accepted: true, version })
	);
	const pipe: MultiplexPipe = new MultiplexPipe({
		connection,
		heartbeatIntervalMs: options.heartbeatIntervalMs,
		heartbeatMisses: options.heartbeatMisses,
		initiator: false,
		onClosed: () => {
			registrar.detach(pipe);
			registrar.onEvent({ hostKey: connection.remoteId, kind: "pipe-closed" });
		},
		onStream: (stream) => {
			if (stream.channel !== "register") {
				stream.fail(NOT_SERVED);
				return;
			}
			void register(stream, connection.remoteId, {
				...registrar,
				attach: (name, ownerId) => registrar.attach(pipe, name, ownerId),
			});
		},
	});
	registrar.onEvent({ hostKey: connection.remoteId, kind: "pipe-opened" });
	return pipe;
};

/**
 * Accepts Host pipes until closed. A dropped pipe — dead heartbeat, clean
 * shutdown, or a crashed Host — takes its live registrations with it, so no
 * name ever points at a pipe that is not there.
 */
export const serveHostPipes = (
	options: HostPipeServerOptions
): HostPipeServer => {
	const onEvent = options.onEvent ?? ((): void => undefined);
	const liveRooms = new Map<
		string,
		LiveRoom & { readonly pipe: MultiplexPipe; readonly fold: RoomFold }
	>();
	const pipes = new Set<MultiplexPipe>();
	let closing = false;

	const drop = (name: string, room: { readonly fold: RoomFold }): void => {
		liveRooms.delete(name);
		void room.fold.close();
	};

	const detach = (pipe: MultiplexPipe): void => {
		pipes.delete(pipe);
		const detached = [...liveRooms].filter(([, room]) => room.pipe === pipe);
		for (const [name, room] of detached) {
			drop(name, room);
			onEvent({ kind: "room-offline", room: name });
		}
	};

	const attach = (pipe: MultiplexPipe, name: string, ownerId: string): void => {
		// The same identity always supersedes its own live registration: a
		// crash-restart or a machine move re-points the name, it does not queue.
		const previous = liveRooms.get(name);
		if (previous !== undefined) {
			drop(name, previous);
		}
		const fold = createRoomFold({
			onEvent: (event) => {
				if (event.kind === "view-dropped") {
					onEvent({ kind: "view-dropped", room: name });
				}
			},
			sessionBudget: options.sessionBudget,
			source: roomSource(pipe, name),
		});
		liveRooms.set(name, {
			fold,
			hostKey: pipe.remoteId,
			name,
			openStore: () => fold.openView(),
			ownerId,
			pipe,
			views: () => fold.views(),
		});
	};

	const registrar = {
		attach,
		detach,
		door: options.door,
		onEvent,
		ownership: options.ownership,
	};

	const admit = async (connection: TransportConnection): Promise<void> => {
		let pipe: MultiplexPipe | undefined;
		try {
			pipe = await acceptPipe(connection, options, registrar);
		} catch {
			await closeQuietly(connection);
			return;
		}
		if (pipe === undefined) {
			return;
		}
		if (closing) {
			await pipe.close();
			return;
		}
		pipes.add(pipe);
	};

	const acceptLoop = (async (): Promise<void> => {
		for (;;) {
			let connection: TransportConnection;
			try {
				// oxlint-disable-next-line eslint/no-await-in-loop -- accepting pipe after pipe is the loop's purpose.
				connection = await options.listener.accept();
			} catch (error) {
				if (!(closing || error instanceof TransportListenerClosedError)) {
					onEvent({ kind: "pipe-refused", reason: "accept failed" });
				}
				return;
			}
			void admit(connection);
		}
	})();

	let closePromise: Promise<void> | undefined;
	return {
		close: () => {
			closePromise ??= (async (): Promise<void> => {
				closing = true;
				await options.listener.close();
				await acceptLoop;
				await Promise.all([...pipes].map((pipe) => pipe.close()));
				pipes.clear();
				await Promise.all(
					[...liveRooms.values()].map((room) => room.fold.close())
				);
				liveRooms.clear();
			})();
			return closePromise;
		},
		live: (name: string) => liveRooms.get(name),
		liveNames: () => [...liveRooms.keys()],
	};
};
