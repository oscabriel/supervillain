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

interface RemoteRoomStore extends RoomStore {
	readonly close: () => Promise<void>;
}

type Hello =
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
		return {
			accepted: true,
			envelopes: value.envelopes.map(parseEnvelope),
		};
	}
	if (value.rejected === true && typeof value.message === "string") {
		return { message: value.message, rejected: true };
	}
	throw new TypeError("RoomStore submission is invalid.");
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

const handleConnection = async (
	connection: TransportConnection,
	store: RoomStore
): Promise<void> => {
	try {
		const hello = parseHello(decodeJson(await connection.receive()));
		if (hello.channel === "submit") {
			for (;;) {
				// oxlint-disable-next-line eslint/no-await-in-loop -- serving each lockstep request is the loop's purpose
				const message = await connection.receive();
				const command = parseRoomCommand(decodeJson(message));
				// oxlint-disable-next-line eslint/no-await-in-loop -- each response must follow its submitted command
				const submission = await store.submit(command);
				// oxlint-disable-next-line eslint/no-await-in-loop -- the submit channel is a sequential request/response protocol
				await connection.send(encodeJson(submission));
			}
		}

		const iterator = store.stream(hello.fromSeq)[Symbol.asyncIterator]();
		let pendingInput = connection.receive();
		let pendingNext: Promise<IteratorResult<Envelope>> | undefined;
		try {
			for (;;) {
				// A one-envelope credit keeps the server from pulling again while the
				// consumer is suspended at a yield, so generator cleanup can close cleanly.
				// oxlint-disable-next-line eslint/no-await-in-loop -- each credit requests exactly one streamed Envelope
				const credit = decodeJson(await pendingInput);
				if (!isRecord(credit) || credit.next !== true) {
					throw new TypeError("RoomStore stream credit is invalid.");
				}

				pendingNext = iterator.next();
				pendingInput = connection.receive();
				// The transport read rejects when the peer closes. Racing it against the
				// RoomStore read lets this handler settle even though RoomHost's latch is
				// not itself transport-cancellable.
				// oxlint-disable-next-line eslint/no-await-in-loop -- each credit waits for either its Envelope or peer closure
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
				// oxlint-disable-next-line eslint/no-await-in-loop -- stream envelopes must be sent in Log order
				await connection.send(encodeJson(outcome.result.value));
			}
		} finally {
			if (pendingNext === undefined) {
				await iterator.return?.();
			} else {
				// AsyncIterator.return cannot preempt RoomHost's pending next(). Let the
				// handler finish now and release the iterator after that read settles.
				void settleIteratorAfterPendingNext(iterator, pendingNext);
			}
		}
	} catch {
		// Closing an endpoint or either side of a connection ends its serving loop.
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

export const serveRoomStore = (
	endpoint: TransportEndpoint,
	store: RoomStore
): { readonly close: () => Promise<void> } => {
	const handlers = new Set<Promise<void>>();
	let closing = false;
	let acceptFailure: unknown;

	const acceptLoop = (async (): Promise<void> => {
		for (;;) {
			try {
				// oxlint-disable-next-line eslint/no-await-in-loop -- accepting connections continuously is the loop's purpose
				const connection = await endpoint.accept();
				const handler = handleConnection(connection, store);
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
	const close = (): Promise<void> => {
		closePromise ??= (async (): Promise<void> => {
			closing = true;
			await endpoint.close();
			await acceptLoop;
			if (acceptFailure !== undefined) {
				throw new Error("RoomStore server accept loop failed.", {
					cause: acceptFailure,
				});
			}
		})();
		return closePromise;
	};

	return { close };
};

class IrohRemoteRoomStore implements RemoteRoomStore {
	readonly #address: TransportAddress;
	readonly #dialer: TransportEndpoint;
	readonly #submitConnection: TransportConnection;
	readonly #streamConnections = new Set<TransportConnection>();
	readonly #pendingStreamConnections = new Set<Promise<TransportConnection>>();
	#closed = false;
	#closePromise: Promise<void> | undefined;
	#submitTail: Promise<unknown> = Promise.resolve();

	constructor(
		dialer: TransportEndpoint,
		address: TransportAddress,
		submitConnection: TransportConnection
	) {
		this.#address = address;
		this.#dialer = dialer;
		this.#submitConnection = submitConnection;
	}

	async submit(command: RoomCommand): Promise<RoomSubmission> {
		const previous = this.#submitTail;
		const turn = Promise.withResolvers<boolean>();
		this.#submitTail = turn.promise;
		try {
			await previous;
			if (this.#closed) {
				throw new Error("Remote RoomStore is closed.");
			}
			await this.#submitConnection.send(encodeJson(command));
			return parseRoomSubmission(
				decodeJson(await this.#submitConnection.receive())
			);
		} finally {
			turn.resolve(true);
		}
	}

	stream(fromSeq: number): AsyncIterable<Envelope> {
		return this.#stream(fromSeq);
	}

	close(): Promise<void> {
		this.#closePromise ??= (async (): Promise<void> => {
			this.#closed = true;
			await closeQuietly(this.#submitConnection);
			const pending = await Promise.allSettled(this.#pendingStreamConnections);
			for (const result of pending) {
				if (result.status === "fulfilled") {
					this.#streamConnections.add(result.value);
				}
			}
			await Promise.all([...this.#streamConnections].map(closeQuietly));
			this.#streamConnections.clear();
		})();
		return this.#closePromise;
	}

	async *#stream(fromSeq: number): AsyncGenerator<Envelope> {
		if (this.#closed) {
			throw new Error("Remote RoomStore is closed.");
		}

		const pending = this.#dialStream(fromSeq);
		this.#pendingStreamConnections.add(pending);
		let connection: TransportConnection | undefined;
		try {
			connection = await pending;
			if (this.#closed) {
				return;
			}
			this.#streamConnections.add(connection);
			for (;;) {
				try {
					// oxlint-disable-next-line eslint/no-await-in-loop -- each generator advance grants one envelope of stream credit
					await connection.send(encodeJson({ next: true }));
					// oxlint-disable-next-line eslint/no-await-in-loop -- yielding each received Envelope is the stream's purpose
					yield parseEnvelope(decodeJson(await connection.receive()));
				} catch (error) {
					if (this.#closed) {
						return;
					}
					throw error;
				}
			}
		} finally {
			this.#pendingStreamConnections.delete(pending);
			if (connection !== undefined) {
				this.#streamConnections.delete(connection);
				await closeQuietly(connection);
			}
		}
	}

	async #dialStream(fromSeq: number): Promise<TransportConnection> {
		const connection = await this.#dialer.dial(this.#address);
		try {
			await connection.send(encodeJson({ channel: "stream", fromSeq }));
			return connection;
		} catch (error) {
			await closeQuietly(connection);
			throw error;
		}
	}
}

export const connectRoomStore = async (
	dialer: TransportEndpoint,
	address: TransportAddress
): Promise<RemoteRoomStore> => {
	const submitConnection = await dialer.dial(address);
	try {
		await submitConnection.send(encodeJson({ channel: "submit" }));
		return new IrohRemoteRoomStore(dialer, address, submitConnection);
	} catch (error) {
		await closeQuietly(submitConnection);
		throw error;
	}
};
