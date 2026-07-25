/* oxlint-disable promise/avoid-new -- WebSocket lifecycle is event-shaped, so open/close need explicit promise wiring. */

/** The slice of the WebSocket API both halves use — the browser-shaped event
 * surface that Node's global `WebSocket` and `ws`'s server sockets both expose. */
export interface WebSocketLike {
	binaryType: string;
	readonly readyState: number;
	readonly send: (data: string | Uint8Array) => void;
	readonly close: (code?: number, reason?: string) => void;
	readonly addEventListener: (
		type: "close" | "error" | "message" | "open",
		listener: (event: { readonly data?: unknown }) => void
	) => void;
}

const OPEN = 1;
const CLOSED = 3;
const NORMAL_CLOSURE = 1000;

interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly reject: (error: unknown) => void;
	readonly resolve: (value: T) => void;
}

const deferred = <T>(): Deferred<T> => {
	const resolvers = Promise.withResolvers<T>();
	return {
		promise: resolvers.promise,
		reject: resolvers.reject,
		resolve: resolvers.resolve,
	};
};

const toMessage = (data: unknown): string | Uint8Array | undefined => {
	if (typeof data === "string") {
		return data;
	}
	if (data instanceof ArrayBuffer) {
		return new Uint8Array(data);
	}
	if (ArrayBuffer.isView(data)) {
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	}
	return undefined;
};

/**
 * A WebSocket read as an ordered message queue. Every inbound message is
 * buffered, so a handshake can consume the first frames and hand the same
 * socket to the connection without losing what arrived in between.
 */
export class WsChannel {
	readonly #socket: WebSocketLike;
	readonly #queue: (string | Uint8Array)[] = [];
	readonly #readers: Deferred<string | Uint8Array>[] = [];
	readonly #openWaiters: Deferred<boolean>[] = [];
	readonly #closed = deferred<boolean>();
	#failure: Error | undefined;
	#done = false;

	constructor(socket: WebSocketLike) {
		this.#socket = socket;
		socket.binaryType = "arraybuffer";
		socket.addEventListener("message", (event) => {
			const message = toMessage(event.data);
			if (message === undefined) {
				return;
			}
			const reader = this.#readers.shift();
			if (reader === undefined) {
				this.#queue.push(message);
			} else {
				reader.resolve(message);
			}
		});
		socket.addEventListener("close", () => {
			this.#fail(new Error("Transport connection is closed."));
		});
		socket.addEventListener("error", () => {
			this.#fail(new Error("Transport connection failed."));
		});
	}

	get isOpen(): boolean {
		return !this.#done && this.#socket.readyState === OPEN;
	}

	/** Resolves once the socket is open, rejects if it closes or errors first. */
	async whenOpen(): Promise<void> {
		if (this.#socket.readyState === OPEN) {
			return;
		}
		if (this.#done) {
			throw this.#failure ?? new Error("Transport connection is closed.");
		}
		const opened = deferred<boolean>();
		this.#openWaiters.push(opened);
		this.#socket.addEventListener("open", () => opened.resolve(true));
		await opened.promise;
	}

	next(): Promise<string | Uint8Array> {
		const queued = this.#queue.shift();
		if (queued !== undefined) {
			return Promise.resolve(queued);
		}
		if (this.#done) {
			return Promise.reject(
				this.#failure ?? new Error("Transport connection is closed.")
			);
		}
		const reader = deferred<string | Uint8Array>();
		this.#readers.push(reader);
		return reader.promise;
	}

	send(data: string | Uint8Array): void {
		if (!this.isOpen) {
			throw this.#failure ?? new Error("Transport connection is closed.");
		}
		this.#socket.send(data);
	}

	async close(): Promise<void> {
		if (this.#socket.readyState !== CLOSED) {
			this.#socket.close(NORMAL_CLOSURE, "closed");
		}
		this.#fail(new Error("Transport connection is closed."));
		await this.#closed.promise;
	}

	#fail(error: Error): void {
		if (this.#done) {
			return;
		}
		this.#done = true;
		this.#failure = error;
		for (const reader of this.#readers.splice(0)) {
			reader.reject(error);
		}
		for (const waiter of this.#openWaiters.splice(0)) {
			waiter.reject(error);
		}
		this.#closed.resolve(true);
	}
}
