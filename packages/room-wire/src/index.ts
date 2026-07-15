import { setTimeout as delay } from "node:timers/promises";

import type {
	Envelope,
	NamespacedType,
	RoomCommand,
	RoomStore,
	RoomSubmission,
} from "@supervillain/core";
import type {
	TransportAddress,
	TransportConnection,
	TransportEndpoint,
} from "@supervillain/transport-iroh";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CLOSED_ERROR = "Remote RoomStore is closed.";

export interface RoomInfo {
	readonly gameId: string;
	readonly label: string;
}

export interface ServeRoomStoreOptions {
	readonly info: RoomInfo;
	/** Connection identities (64 lowercase hex chars) allowed to submit
	 * commands on behalf of actors other than themselves — the trusted
	 * gateway stamping proxied players (ADR-0004). */
	readonly trustedStampers?: readonly string[];
}

export interface RemoteRoomStoreOptions {
	/** Delay in ms before reconnect attempt `attempt` (1-based).
	 * Default: exponential 250ms doubling, capped at 4000ms. */
	readonly reconnectDelayMs?: (attempt: number) => number;
}

export interface RemoteRoomStore extends RoomStore {
	readonly info: () => Promise<RoomInfo>;
	readonly close: () => Promise<void>;
}

type Hello =
	| { readonly channel: "info" }
	| { readonly channel: "submit" }
	| { readonly channel: "stream"; readonly fromSeq: number };

const encodeJson = (value: unknown): Uint8Array =>
	encoder.encode(JSON.stringify(value));

const decodeJson = (message: Uint8Array): unknown =>
	JSON.parse(decoder.decode(message)) as unknown;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

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

const parseRoomCommand = (value: unknown): RoomCommand => {
	if (
		!isRecord(value) ||
		typeof value.actor !== "string" ||
		!("command" in value)
	) {
		throw new TypeError("RoomStore command is invalid.");
	}
	return { actor: value.actor, command: value.command };
};

const parseEnvelope = (value: unknown): Envelope => {
	if (
		!isRecord(value) ||
		typeof value.actor !== "string" ||
		typeof value.seq !== "number" ||
		!Number.isSafeInteger(value.seq) ||
		typeof value.timestamp !== "string" ||
		typeof value.type !== "string" ||
		!value.type.includes(".") ||
		!("payload" in value)
	) {
		throw new TypeError("RoomStore envelope is invalid.");
	}
	return {
		actor: value.actor,
		payload: value.payload,
		seq: value.seq,
		timestamp: value.timestamp,
		type: value.type as NamespacedType,
	};
};

const parseRoomSubmission = (value: unknown): RoomSubmission => {
	if (!isRecord(value)) {
		throw new TypeError("RoomStore submission is invalid.");
	}
	if (value.accepted === true && Array.isArray(value.envelopes)) {
		return { accepted: true, envelopes: value.envelopes.map(parseEnvelope) };
	}
	if (value.rejected === true && typeof value.message === "string") {
		return { message: value.message, rejected: true };
	}
	throw new TypeError("RoomStore submission is invalid.");
};

const parseRoomInfo = (value: unknown): RoomInfo => {
	if (
		!isRecord(value) ||
		typeof value.gameId !== "string" ||
		typeof value.label !== "string"
	) {
		throw new TypeError("RoomStore info is invalid.");
	}
	return { gameId: value.gameId, label: value.label };
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
			const credit = decodeJson(await pendingInput);
			if (!isRecord(credit) || credit.next !== true) {
				throw new TypeError("RoomStore stream credit is invalid.");
			}
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
	error instanceof Error &&
	error.message === "Transport endpoint closed while accepting";

const serveConnections = (
	endpoint: TransportEndpoint,
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
				const connection = await endpoint.accept();
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
				await endpoint.close();
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
	endpoint: TransportEndpoint,
	store: RoomStore,
	options: ServeRoomStoreOptions
): { readonly close: () => Promise<void> } =>
	serveConnections(
		endpoint,
		(connection) => handleConnection(connection, store, options),
		"RoomStore server accept loop failed."
	);

const defaultReconnectDelay = (attempt: number): number =>
	Math.min(250 * 2 ** (attempt - 1), 4000);

class TransportRemoteRoomStore implements RemoteRoomStore {
	readonly #address: TransportAddress;
	readonly #dialer: TransportEndpoint;
	readonly #reconnectDelayMs: (attempt: number) => number;
	readonly #connections = new Set<TransportConnection>();
	readonly #pendingConnections = new Set<Promise<TransportConnection>>();
	readonly #closedSignal = Promise.withResolvers<boolean>();
	#closed = false;
	#closePromise: Promise<void> | undefined;
	#submitConnection: TransportConnection | undefined;
	#submitTail: Promise<unknown> = Promise.resolve();

	constructor(
		dialer: TransportEndpoint,
		address: TransportAddress,
		submitConnection: TransportConnection,
		options: RemoteRoomStoreOptions
	) {
		this.#dialer = dialer;
		this.#address = address;
		this.#submitConnection = submitConnection;
		this.#connections.add(submitConnection);
		this.#reconnectDelayMs = options.reconnectDelayMs ?? defaultReconnectDelay;
	}

	async submit(command: RoomCommand): Promise<RoomSubmission> {
		const previous = this.#submitTail;
		const turn = Promise.withResolvers<boolean>();
		this.#submitTail = turn.promise;
		try {
			await previous;
			this.#assertOpen();
			const existing = this.#submitConnection;
			let connection = await this.#ensureSubmitConnection();
			try {
				await connection.send(encodeJson(command));
			} catch (error) {
				this.#discardSubmitConnection(connection);
				await closeQuietly(connection);
				if (existing === undefined) {
					throw error;
				}
				connection = await this.#ensureSubmitConnection();
				try {
					await connection.send(encodeJson(command));
				} catch (redialError) {
					this.#discardSubmitConnection(connection);
					await closeQuietly(connection);
					throw redialError;
				}
			}
			try {
				return parseRoomSubmission(decodeJson(await connection.receive()));
			} catch (error) {
				this.#discardSubmitConnection(connection);
				await closeQuietly(connection);
				throw error;
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
		const pending = this.#dialer.dial(this.#address);
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
	dialer: TransportEndpoint,
	address: TransportAddress,
	options: RemoteRoomStoreOptions = {}
): Promise<RemoteRoomStore> => {
	const connection = await dialer.dial(address);
	try {
		await connection.send(encodeJson({ channel: "submit" }));
		return new TransportRemoteRoomStore(dialer, address, connection, options);
	} catch (error) {
		await closeQuietly(connection);
		throw error;
	}
};

// --- room registration: how a GM-hosted room gets a name at the gateway (ADR-0004) ---

const ROOM_NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u;

/** Room names are 1–32 chars of lowercase a–z, 0–9, and interior hyphens. */
export const isValidRoomName = (name: string): boolean => ROOM_NAME.test(name);

export interface RoomRegistration {
	readonly name: string;
	/** The host endpoint's serialized transport address. */
	readonly address: string;
}

export type RegistrationOutcome =
	| {
			readonly accepted: true;
			/** Hostname players ssh to, for the GM's summon line. */
			readonly sshHost: string;
			readonly sshPort: number;
	  }
	| { readonly rejected: true; readonly message: string };

/** The gateway's registry seam: `owner` is the registering connection's
 * authenticated identity — name ownership is key-as-account. */
export interface RoomRegistry {
	readonly register: (
		owner: string,
		registration: RoomRegistration
	) => Promise<RegistrationOutcome>;
}

const parseRegisterHello = (value: unknown): RoomRegistration => {
	if (
		!isRecord(value) ||
		value.channel !== "register" ||
		typeof value.name !== "string" ||
		typeof value.address !== "string"
	) {
		throw new TypeError("Registration hello is invalid.");
	}
	return { address: value.address, name: value.name };
};

const parseRegistrationOutcome = (value: unknown): RegistrationOutcome => {
	if (isRecord(value)) {
		if (
			value.accepted === true &&
			typeof value.sshHost === "string" &&
			typeof value.sshPort === "number" &&
			Number.isSafeInteger(value.sshPort)
		) {
			return { accepted: true, sshHost: value.sshHost, sshPort: value.sshPort };
		}
		if (value.rejected === true && typeof value.message === "string") {
			return { message: value.message, rejected: true };
		}
	}
	throw new TypeError("Registration outcome is invalid.");
};

const handleRegistryConnection = async (
	connection: TransportConnection,
	registry: RoomRegistry
): Promise<void> => {
	try {
		const registration = parseRegisterHello(
			decodeJson(await connection.receive())
		);
		const outcome: RegistrationOutcome = isValidRoomName(registration.name)
			? await registry.register(connection.remoteId, registration)
			: {
					message:
						"Room names are 1-32 lowercase letters, digits, and hyphens.",
					rejected: true,
				};
		await connection.send(encodeJson(outcome));
	} catch {
		// Malformed messages and transport closure end only this connection.
	} finally {
		await closeQuietly(connection);
	}
};

/** Serves a RoomRegistry over the transport seam — the gateway's serving half. */
export const serveRoomRegistry = (
	endpoint: TransportEndpoint,
	registry: RoomRegistry
): { readonly close: () => Promise<void> } =>
	serveConnections(
		endpoint,
		(connection) => handleRegistryConnection(connection, registry),
		"Room registry accept loop failed."
	);

export interface RegistrationReceipt {
	/** The gateway's authenticated identity — the host passes it to
	 * `serveRoomStore` as a trusted stamper. */
	readonly gatewayId: string;
	readonly sshHost: string;
	readonly sshPort: number;
}

/** Registers a room name with a gateway. Throws on rejection — a room that
 * asked for a name should not open with silence where its door was meant to be. */
export const registerRoom = async (
	dialer: TransportEndpoint,
	gatewayAddress: TransportAddress,
	registration: RoomRegistration
): Promise<RegistrationReceipt> => {
	const connection = await dialer.dial(gatewayAddress);
	try {
		await connection.send(encodeJson({ channel: "register", ...registration }));
		const outcome = parseRegistrationOutcome(
			decodeJson(await connection.receive())
		);
		if ("rejected" in outcome) {
			throw new Error(outcome.message);
		}
		return {
			gatewayId: connection.remoteId,
			sshHost: outcome.sshHost,
			sshPort: outcome.sshPort,
		};
	} finally {
		await closeQuietly(connection);
	}
};
