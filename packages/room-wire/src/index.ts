import { setTimeout as delay } from "node:timers/promises";

import { isRecord } from "@supervillain/core";
import type {
	Envelope,
	RoomCommand,
	RoomStore,
	RoomSubmission,
} from "@supervillain/core";

import {
	decodeJson,
	encodeJson,
	parseEnvelope,
	parseRoomCommand,
	parseRoomInfo,
	parseRoomSubmission,
	parseStreamCredit,
} from "./messages.js";
import type { RoomInfo } from "./messages.js";
import { TransportListenerClosedError } from "./seam.js";
import type {
	TransportConnection,
	TransportDialer,
	TransportListener,
} from "./seam.js";

export {
	chunkPayload,
	decodeFrame,
	encodeControlFrame,
	encodeFrame,
	encodePipeHandshakeOutcome,
	encodePipeHello,
	isControlFrame,
	isPipeChannel,
	MAX_FRAME_PAYLOAD_BYTES,
	negotiatePipeVersion,
	parsePipeHandshakeOutcome,
	parsePipeHello,
	PIPE_PROTOCOL_VERSION,
	PipeProtocolError,
	SUPPORTED_PIPE_PROTOCOL_VERSIONS,
	UNSUPPORTED_VERSION_MESSAGE,
} from "./frames.js";
export type {
	DecodedFrame,
	FrameKind,
	PipeChannel,
	PipeControlFrame,
	PipeFrame,
	PipeHandshakeOutcome,
	PipeHello,
} from "./frames.js";
export { serveHostPipes } from "./gateway-pipe.js";
export type {
	ClaimOutcome,
	GatewayPipeEvent,
	HostPipeServer,
	HostPipeServerOptions,
	KeyGraph,
	LiveRoom,
	PipeRoomStore,
	RoomOwnership,
} from "./gateway-pipe.js";
export { HostPipeRefusedError, openHostPipe } from "./host-pipe.js";
export type {
	HostedRoom,
	HostPipe,
	HostPipeAttachment,
	HostPipeEvent,
	HostPipeOptions,
} from "./host-pipe.js";
export { openGatewayLink } from "./link.js";
export type { GatewayLink, GatewayLinkOptions } from "./link.js";
export { isValidRoomName, LINK_ROOM, ROOM_NAME_RULE } from "./messages.js";
export type {
	ActorLink,
	LinkCodeOutcome,
	LinkRedemptionOutcome,
	LinkRequest,
	RegistrationOutcome,
	RoomInfo,
} from "./messages.js";
export {
	DEFAULT_HEARTBEAT_INTERVAL_MS,
	DEFAULT_HEARTBEAT_MISSES,
	PipeHeartbeatError,
	PipeStreamClosedError,
} from "./pipe.js";
export type { PipeStream } from "./pipe.js";
export { TransportListenerClosedError } from "./seam.js";
export type {
	TransportConnection,
	TransportDialer,
	TransportListener,
} from "./seam.js";

const CLOSED_ERROR = "Remote RoomStore is closed.";

export interface ServeRoomStoreOptions {
	readonly info: RoomInfo;
	/** Connection identities (64 lowercase hex chars) allowed to submit
	 * commands on behalf of actors other than themselves — the trusted
	 * gateway stamping proxied players (ADR-0003). */
	readonly trustedStampers?: readonly string[];
}

export interface RemoteRoomStoreOptions {
	/** Delay in ms before reconnect attempt `attempt` (1-based).
	 * Default: exponential 250ms doubling, capped at 4000ms. */
	readonly reconnectDelayMs?: (attempt: number) => number;
	/** Maximum time in ms for one queued submit send/receive exchange. */
	readonly submitTimeoutMs?: number;
}

export interface RemoteRoomStore extends RoomStore {
	readonly info: () => Promise<RoomInfo>;
	readonly close: () => Promise<void>;
}

type Hello =
	| { readonly channel: "info" }
	| { readonly channel: "submit" }
	| { readonly channel: "stream"; readonly fromSeq: number };

const parseHello = (value: unknown): Hello => {
	if (!isRecord(value)) {
		throw new TypeError("RoomStore hello must be an object.");
	}
	if (value.channel === "info") {
		return { channel: "info" };
	}
	if (value.channel === "submit") {
		return { channel: "submit" };
	}
	if (
		value.channel === "stream" &&
		typeof value.fromSeq === "number" &&
		Number.isSafeInteger(value.fromSeq) &&
		value.fromSeq >= 1
	) {
		return { channel: "stream", fromSeq: value.fromSeq };
	}
	throw new TypeError("RoomStore hello has an invalid channel.");
};

const closeQuietly = async (connection: TransportConnection): Promise<void> => {
	try {
		await connection.close();
	} catch {
		// A peer may already have closed the connection.
	}
};

const settleIteratorAfterPendingNext = async (
	iterator: AsyncIterator<Envelope>,
	pendingNext: Promise<IteratorResult<Envelope>>
): Promise<void> => {
	try {
		await pendingNext;
	} catch {
		// The pending read owns its error; cleanup only waits for it to settle.
	}
	try {
		await iterator.return?.();
	} catch {
		// The connection is already closing, so iterator cleanup is best-effort.
	}
};

const awaitStreamEnvelope = async (
	pendingNext: Promise<IteratorResult<Envelope>>
): Promise<{
	readonly kind: "envelope";
	readonly result: IteratorResult<Envelope>;
}> => ({ kind: "envelope", result: await pendingNext });

const awaitStreamInput = async (
	pendingInput: Promise<Uint8Array>
): Promise<{ readonly kind: "input"; readonly message: Uint8Array }> => ({
	kind: "input",
	message: await pendingInput,
});

const handleStream = async (
	connection: TransportConnection,
	store: RoomStore,
	fromSeq: number
): Promise<void> => {
	const iterator = store.stream(fromSeq)[Symbol.asyncIterator]();
	let pendingInput = connection.receive();
	let pendingNext: Promise<IteratorResult<Envelope>> | undefined;
	try {
		for (;;) {
			// oxlint-disable-next-line eslint/no-await-in-loop -- each credit requests exactly one streamed Envelope.
			parseStreamCredit(decodeJson(await pendingInput));
			pendingNext = iterator.next();
			pendingInput = connection.receive();
			// oxlint-disable-next-line eslint/no-await-in-loop -- each credit waits for either its Envelope or peer closure.
			const outcome = await Promise.race([
				awaitStreamEnvelope(pendingNext),
				awaitStreamInput(pendingInput),
			]);
			if (outcome.kind === "input") {
				throw new TypeError(
					"RoomStore stream received input before its Envelope."
				);
			}
			pendingNext = undefined;
			if (outcome.result.done === true) {
				return;
			}
			// oxlint-disable-next-line eslint/no-await-in-loop -- stream envelopes must be sent in Log order.
			await connection.send(encodeJson(outcome.result.value));
		}
	} finally {
		if (pendingNext === undefined) {
			await iterator.return?.();
		} else {
			// RoomHost's iterator cannot be returned while next() is pending.
			void settleIteratorAfterPendingNext(iterator, pendingNext);
		}
	}
};

const handleConnection = async (
	connection: TransportConnection,
	store: RoomStore,
	options: ServeRoomStoreOptions
): Promise<void> => {
	try {
		const hello = parseHello(decodeJson(await connection.receive()));
		if (hello.channel === "info") {
			await connection.send(encodeJson(options.info));
			return;
		}
		if (hello.channel === "stream") {
			await handleStream(connection, store, hello.fromSeq);
			return;
		}
		const trusted = options.trustedStampers?.includes(connection.remoteId);
		for (;;) {
			// oxlint-disable-next-line eslint/no-await-in-loop -- serving each lockstep request is the loop's purpose.
			const command = parseRoomCommand(decodeJson(await connection.receive()));
			const submission: RoomSubmission =
				command.actor === connection.remoteId || trusted === true
					? // oxlint-disable-next-line eslint/no-await-in-loop -- each response follows one submitted command.
						await store.submit(command)
					: {
							message: "Actor does not match the connection identity.",
							rejected: true,
						};
			// oxlint-disable-next-line eslint/no-await-in-loop -- submit is a sequential request/response channel.
			await connection.send(encodeJson(submission));
		}
	} catch {
		// Malformed messages and transport closure end only this connection.
	} finally {
		await closeQuietly(connection);
	}
};

const removeHandlerWhenSettled = async (
	handlers: Set<Promise<void>>,
	handler: Promise<void>
): Promise<void> => {
	await handler;
	handlers.delete(handler);
};

const isClosedAccept = (error: unknown): boolean =>
	error instanceof TransportListenerClosedError;

const serveConnections = (
	listener: TransportListener,
	handle: (connection: TransportConnection) => Promise<void>,
	failureMessage: string
): { readonly close: () => Promise<void> } => {
	const handlers = new Set<Promise<void>>();
	let closing = false;
	let acceptFailure: unknown;
	const acceptLoop = (async (): Promise<void> => {
		for (;;) {
			try {
				// oxlint-disable-next-line eslint/no-await-in-loop -- accepting continuously is the serving loop's purpose.
				const connection = await listener.accept();
				const handler = handle(connection);
				handlers.add(handler);
				void removeHandlerWhenSettled(handlers, handler);
			} catch (error) {
				if (!(closing || isClosedAccept(error))) {
					acceptFailure = error;
				}
				return;
			}
		}
	})();
	let closePromise: Promise<void> | undefined;
	return {
		close: () => {
			closePromise ??= (async (): Promise<void> => {
				closing = true;
				await listener.close();
				await acceptLoop;
				await Promise.allSettled(handlers);
				if (acceptFailure !== undefined) {
					throw new Error(failureMessage, { cause: acceptFailure });
				}
			})();
			return closePromise;
		},
	};
};

/** Serves a RoomStore over the transport seam. Accepts until closed. */
export const serveRoomStore = (
	listener: TransportListener,
	store: RoomStore,
	options: ServeRoomStoreOptions
): { readonly close: () => Promise<void> } =>
	serveConnections(
		listener,
		(connection) => handleConnection(connection, store, options),
		"RoomStore server accept loop failed."
	);

const defaultReconnectDelay = (attempt: number): number =>
	Math.min(250 * 2 ** (attempt - 1), 4000);

interface SubmitContext {
	connection?: TransportConnection;
	readonly error: Error;
	timedOut: boolean;
}

const submitFailure = (
	context: SubmitContext | undefined,
	error: unknown
): unknown => (context?.timedOut === true ? context.error : error);

class TransportRemoteRoomStore implements RemoteRoomStore {
	readonly #dialer: TransportDialer;
	readonly #reconnectDelayMs: (attempt: number) => number;
	readonly #submitTimeoutMs: number | undefined;
	readonly #connections = new Set<TransportConnection>();
	readonly #pendingConnections = new Set<Promise<TransportConnection>>();
	readonly #closedSignal = Promise.withResolvers<boolean>();
	#closed = false;
	#closePromise: Promise<void> | undefined;
	#submitConnection: TransportConnection | undefined;
	#submitTail: Promise<unknown> = Promise.resolve();

	constructor(
		dialer: TransportDialer,
		submitConnection: TransportConnection,
		options: RemoteRoomStoreOptions
	) {
		this.#dialer = dialer;
		this.#submitConnection = submitConnection;
		this.#connections.add(submitConnection);
		this.#reconnectDelayMs = options.reconnectDelayMs ?? defaultReconnectDelay;
		this.#submitTimeoutMs = options.submitTimeoutMs;
	}

	async submit(command: RoomCommand): Promise<RoomSubmission> {
		const previous = this.#submitTail;
		const turn = Promise.withResolvers<boolean>();
		this.#submitTail = turn.promise;
		try {
			await previous;
			this.#assertOpen();
			if (this.#submitTimeoutMs === undefined) {
				return await this.#exchangeSubmit(command);
			}

			const context: SubmitContext = {
				error: new Error("RoomStore submit timed out."),
				timedOut: false,
			};
			const timeout = Promise.withResolvers<never>();
			const timer = setTimeout(() => {
				context.timedOut = true;
				if (context.connection !== undefined) {
					this.#discardSubmitConnection(context.connection);
					void closeQuietly(context.connection);
				}
				timeout.reject(context.error);
			}, this.#submitTimeoutMs);
			try {
				return await Promise.race([
					this.#exchangeSubmit(command, context),
					timeout.promise,
				]);
			} finally {
				clearTimeout(timer);
			}
		} finally {
			turn.resolve(true);
		}
	}

	stream(fromSeq: number): AsyncIterable<Envelope> {
		return this.#stream(fromSeq);
	}

	async info(): Promise<RoomInfo> {
		this.#assertOpen();
		const connection = await this.#dial({ channel: "info" });
		try {
			return parseRoomInfo(decodeJson(await connection.receive()));
		} finally {
			this.#connections.delete(connection);
			await closeQuietly(connection);
		}
	}

	close(): Promise<void> {
		this.#closePromise ??= (async (): Promise<void> => {
			this.#closed = true;
			this.#closedSignal.resolve(true);
			const pending = await Promise.allSettled(this.#pendingConnections);
			for (const result of pending) {
				if (result.status === "fulfilled") {
					this.#connections.add(result.value);
				}
			}
			await Promise.all([...this.#connections].map(closeQuietly));
			this.#connections.clear();
			this.#submitConnection = undefined;
		})();
		return this.#closePromise;
	}

	async *#stream(fromSeq: number): AsyncGenerator<Envelope> {
		this.#assertOpen();
		let last = fromSeq - 1;
		let attempt = 0;
		// oxlint-disable-next-line eslint/no-unreachable-loop -- transport failures continue this reconnect loop until close.
		while (!this.#closed) {
			let connection: TransportConnection | undefined;
			try {
				// oxlint-disable-next-line eslint/no-await-in-loop -- every reconnect iteration dials one fresh stream connection.
				connection = await this.#dial({ channel: "stream", fromSeq: last + 1 });
				if (this.#closed) {
					return;
				}
				for (;;) {
					// oxlint-disable-next-line eslint/no-await-in-loop -- each advance grants one stream credit.
					await connection.send(encodeJson({ next: true }));
					// oxlint-disable-next-line eslint/no-await-in-loop -- receiving ordered Envelopes is the stream's purpose.
					const message = await connection.receive();
					const envelope = parseEnvelope(decodeJson(message));
					if (envelope.seq <= last) {
						continue;
					}
					if (envelope.seq !== last + 1) {
						throw new Error("RoomStore stream sequence is not contiguous.");
					}
					last = envelope.seq;
					attempt = 0;
					yield envelope;
				}
			} catch {
				if (this.#closed) {
					return;
				}
				attempt += 1;
				const backoff = delay(this.#reconnectDelayMs(attempt));
				// oxlint-disable-next-line eslint/no-await-in-loop -- reconnect backoff occurs once per failed attempt.
				await Promise.race([backoff, this.#closedSignal.promise]);
			} finally {
				if (connection !== undefined) {
					this.#connections.delete(connection);
					// oxlint-disable-next-line eslint/no-await-in-loop -- each reconnect iteration closes its own failed connection.
					await closeQuietly(connection);
				}
			}
		}
	}

	async #exchangeSubmit(
		command: RoomCommand,
		context?: SubmitContext
	): Promise<RoomSubmission> {
		const existing = this.#submitConnection;
		let connection = await this.#ensureSubmitConnection();
		if (context !== undefined) {
			context.connection = connection;
		}
		await this.#stopTimedOutSubmit(context, connection);
		try {
			await connection.send(encodeJson(command));
		} catch (error) {
			this.#discardSubmitConnection(connection);
			await closeQuietly(connection);
			if (context?.timedOut === true) {
				throw context.error;
			}
			if (existing === undefined) {
				throw error;
			}
			connection = await this.#ensureSubmitConnection();
			if (context !== undefined) {
				context.connection = connection;
			}
			await this.#stopTimedOutSubmit(context, connection);
			try {
				await connection.send(encodeJson(command));
			} catch (redialError) {
				this.#discardSubmitConnection(connection);
				await closeQuietly(connection);
				throw submitFailure(context, redialError);
			}
		}
		await this.#stopTimedOutSubmit(context, connection);
		try {
			return parseRoomSubmission(decodeJson(await connection.receive()));
		} catch (error) {
			this.#discardSubmitConnection(connection);
			await closeQuietly(connection);
			throw submitFailure(context, error);
		}
	}

	async #stopTimedOutSubmit(
		context: SubmitContext | undefined,
		connection: TransportConnection
	): Promise<void> {
		if (context?.timedOut !== true) {
			return;
		}
		this.#discardSubmitConnection(connection);
		await closeQuietly(connection);
		throw context.error;
	}

	async #ensureSubmitConnection(): Promise<TransportConnection> {
		if (this.#submitConnection !== undefined) {
			return this.#submitConnection;
		}
		const connection = await this.#dial({ channel: "submit" });
		this.#submitConnection = connection;
		return connection;
	}

	#discardSubmitConnection(connection: TransportConnection): void {
		if (this.#submitConnection === connection) {
			this.#submitConnection = undefined;
		}
		this.#connections.delete(connection);
	}

	async #dial(hello: Hello): Promise<TransportConnection> {
		this.#assertOpen();
		const pending = this.#dialer.dial();
		this.#pendingConnections.add(pending);
		let connection: TransportConnection;
		try {
			connection = await pending;
		} finally {
			this.#pendingConnections.delete(pending);
		}
		if (this.#closed) {
			await closeQuietly(connection);
			throw new Error(CLOSED_ERROR);
		}
		this.#connections.add(connection);
		try {
			await connection.send(encodeJson(hello));
			return connection;
		} catch (error) {
			this.#connections.delete(connection);
			await closeQuietly(connection);
			throw error;
		}
	}

	#assertOpen(): void {
		if (this.#closed) {
			throw new Error(CLOSED_ERROR);
		}
	}
}

/** Dials a served RoomStore. The submit connection is dialed eagerly so an
 * unreachable host fails here, not on first use. */
export const connectRoomStore = async (
	dialer: TransportDialer,
	options: RemoteRoomStoreOptions = {}
): Promise<RemoteRoomStore> => {
	const connection = await dialer.dial();
	try {
		await connection.send(encodeJson({ channel: "submit" }));
		return new TransportRemoteRoomStore(dialer, connection, options);
	} catch (error) {
		await closeQuietly(connection);
		throw error;
	}
};
