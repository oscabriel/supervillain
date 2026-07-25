/* oxlint-disable eslint/max-classes-per-file -- the multiplexer and its streams are one mechanism; splitting them would only hide the private wiring they share. */
/**
 * The multiplexer: one transport connection carrying every Room and every
 * channel as tagged frames (ADR-0012, NQ-5). Both ends run this same engine —
 * the Host that dialed out and the gateway that accepted — because the pipe is
 * symmetric once the handshake is done. Which side is allowed to open which
 * channel is a policy of the halves above, not of this file.
 *
 * Fairness is per Room: outbound frames queue by room tag and the writer takes
 * one frame from each room in rotation, so a large map chunking into hundreds
 * of frames cannot starve another Room's chat line.
 */
import {
	chunkPayload,
	decodeFrame,
	encodeControlFrame,
	encodeFrame,
	isControlFrame,
} from "./frames.js";
import type { PipeChannel, PipeFrame } from "./frames.js";
import type { TransportConnection } from "./seam.js";

/** ~25 s between heartbeats, dead after 2 missed pongs (ADR-0012, NQ-4).
 * Tunable defaults: the shape is the decision, the numbers are not. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000;
export const DEFAULT_HEARTBEAT_MISSES = 2;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** The stream ended: the peer closed it, or the pipe under it died. */
export class PipeStreamClosedError extends Error {
	constructor(message = "Pipe stream closed.") {
		super(message);
		this.name = "PipeStreamClosedError";
	}
}

/** The heartbeat went unanswered: this pipe is dead, and any Room attached to
 * it is offline. */
export class PipeHeartbeatError extends Error {
	constructor() {
		super("Pipe heartbeat went unanswered.");
		this.name = "PipeHeartbeatError";
	}
}

/** One logical exchange on one (room, channel). Messages in, messages out;
 * chunking and reassembly are the pipe's business, never the caller's. */
export interface PipeStream {
	readonly room: string;
	readonly channel: PipeChannel;
	readonly send: (message: Uint8Array) => Promise<void>;
	/** Rejects with {@link PipeStreamClosedError} once the stream has ended. */
	readonly receive: () => Promise<Uint8Array>;
	/** Ends the stream with a metadata-only reason the peer can surface. */
	readonly fail: (reason: string) => void;
	readonly close: () => void;
}

export interface PipeOptions {
	readonly connection: TransportConnection;
	/** The dialing side owns odd stream ids, the accepting side even ones. */
	readonly initiator: boolean;
	/** Called once per stream the peer opens. */
	readonly onStream: (stream: PipeStream) => void;
	/** Called once when the pipe ends — `reason` is undefined for a local close
	 * and the failure otherwise. A gateway drops live registrations here. */
	readonly onClosed: (reason: unknown) => void;
	readonly heartbeatIntervalMs?: number;
	readonly heartbeatMisses?: number;
}

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

interface QueuedFrame {
	readonly bytes: Uint8Array;
	readonly sent?: Deferred<boolean>;
}

const closeQuietly = async (connection: TransportConnection): Promise<void> => {
	try {
		await connection.close();
	} catch {
		// The peer may already have dropped the connection.
	}
};

const concat = (chunks: readonly Uint8Array[]): Uint8Array => {
	if (chunks.length === 1) {
		return chunks[0] ?? new Uint8Array(0);
	}
	const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const joined = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		joined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return joined;
};

class MultiplexStream implements PipeStream {
	readonly room: string;
	readonly channel: PipeChannel;
	readonly id: number;
	readonly #pipe: MultiplexPipe;
	readonly #inbox: Uint8Array[] = [];
	readonly #partial: Uint8Array[] = [];
	readonly #receivers: Deferred<Uint8Array>[] = [];
	#ended: Error | undefined;
	#localClosed = false;

	constructor(
		pipe: MultiplexPipe,
		id: number,
		room: string,
		channel: PipeChannel
	) {
		this.#pipe = pipe;
		this.id = id;
		this.room = room;
		this.channel = channel;
	}

	async send(message: Uint8Array): Promise<void> {
		if (this.#localClosed) {
			throw new PipeStreamClosedError();
		}
		if (this.#ended !== undefined) {
			throw this.#ended;
		}
		const chunks = chunkPayload(message);
		const sent = deferred<boolean>();
		for (const [index, chunk] of chunks.entries()) {
			this.#pipe.enqueue(this.room, {
				bytes: encodeFrame({
					channel: this.channel,
					kind: index === chunks.length - 1 ? "last" : "part",
					payload: chunk,
					room: this.room,
					stream: this.id,
				}),
				sent: index === chunks.length - 1 ? sent : undefined,
			});
		}
		await sent.promise;
	}

	receive(): Promise<Uint8Array> {
		const next = this.#inbox.shift();
		if (next !== undefined) {
			return Promise.resolve(next);
		}
		if (this.#ended !== undefined) {
			return Promise.reject(this.#ended);
		}
		const receiver = deferred<Uint8Array>();
		this.#receivers.push(receiver);
		return receiver.promise;
	}

	fail(reason: string): void {
		if (this.#localClosed) {
			return;
		}
		this.#localClosed = true;
		this.#pipe.sendStreamEnd(this, "error", reason);
		this.end(new PipeStreamClosedError(reason));
	}

	close(): void {
		if (this.#localClosed) {
			return;
		}
		this.#localClosed = true;
		this.#pipe.sendStreamEnd(this, "close");
		this.end(new PipeStreamClosedError());
	}

	deliver(frame: PipeFrame): void {
		if (frame.kind === "close") {
			this.end(new PipeStreamClosedError());
			return;
		}
		if (frame.kind === "error") {
			this.end(new PipeStreamClosedError(decoder.decode(frame.payload)));
			return;
		}
		if (frame.kind === "part") {
			this.#partial.push(Uint8Array.from(frame.payload));
			return;
		}
		const message = concat([...this.#partial, frame.payload]);
		this.#partial.length = 0;
		const receiver = this.#receivers.shift();
		if (receiver === undefined) {
			this.#inbox.push(message);
		} else {
			receiver.resolve(message);
		}
	}

	end(error: Error): void {
		if (this.#ended !== undefined) {
			return;
		}
		this.#ended = error;
		this.#pipe.forget(this.id);
		for (const receiver of this.#receivers.splice(0)) {
			receiver.reject(error);
		}
	}
}

export class MultiplexPipe {
	readonly remoteId: string;
	readonly #connection: TransportConnection;
	readonly #onStream: (stream: PipeStream) => void;
	readonly #onClosed: (reason: unknown) => void;
	readonly #streams = new Map<number, MultiplexStream>();
	readonly #queues = new Map<string, QueuedFrame[]>();
	readonly #control: QueuedFrame[] = [];
	readonly #rotation: string[] = [];
	readonly #heartbeatIntervalMs: number;
	readonly #heartbeatMisses: number;
	#cursor = 0;
	#nextStreamId: number;
	#pumping = false;
	#ended = false;
	#heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	#unansweredPings = 0;

	constructor(options: PipeOptions) {
		this.#connection = options.connection;
		this.remoteId = options.connection.remoteId;
		this.#onStream = options.onStream;
		this.#onClosed = options.onClosed;
		this.#nextStreamId = options.initiator ? 1 : 2;
		this.#heartbeatIntervalMs =
			options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
		this.#heartbeatMisses = options.heartbeatMisses ?? DEFAULT_HEARTBEAT_MISSES;
		void this.#read();
		this.#startHeartbeat();
	}

	/** Opens an exchange on (room, channel). The first message sent on it is
	 * what tells the peer the stream exists. */
	open(room: string, channel: PipeChannel): PipeStream {
		if (this.#ended) {
			throw new PipeStreamClosedError("Pipe is closed.");
		}
		const id = this.#nextStreamId;
		this.#nextStreamId += 2;
		const stream = new MultiplexStream(this, id, room, channel);
		this.#streams.set(id, stream);
		return stream;
	}

	enqueue(room: string, frame: QueuedFrame): void {
		if (this.#ended) {
			frame.sent?.reject(new PipeStreamClosedError("Pipe is closed."));
			return;
		}
		const queue = this.#queues.get(room);
		if (queue === undefined) {
			this.#queues.set(room, [frame]);
			this.#rotation.push(room);
		} else {
			queue.push(frame);
		}
		void this.#pump();
	}

	sendStreamEnd(
		stream: MultiplexStream,
		kind: "close" | "error",
		reason?: string
	): void {
		if (this.#ended) {
			return;
		}
		this.enqueue(stream.room, {
			bytes: encodeFrame({
				channel: stream.channel,
				kind,
				payload:
					reason === undefined ? new Uint8Array(0) : encoder.encode(reason),
				room: stream.room,
				stream: stream.id,
			}),
		});
	}

	forget(id: number): void {
		this.#streams.delete(id);
	}

	/** Ends the pipe from this side. Every stream on it ends too. */
	close(): Promise<void> {
		return this.#end();
	}

	get closed(): boolean {
		return this.#ended;
	}

	#startHeartbeat(): void {
		if (this.#heartbeatIntervalMs <= 0) {
			return;
		}
		const timer = setInterval(() => {
			if (this.#unansweredPings >= this.#heartbeatMisses) {
				void this.#end(new PipeHeartbeatError());
				return;
			}
			this.#unansweredPings += 1;
			this.#control.push({ bytes: encodeControlFrame("ping") });
			void this.#pump();
		}, this.#heartbeatIntervalMs);
		// A heartbeat should never be the reason a process refuses to exit.
		(timer as { unref?: () => void }).unref?.();
		this.#heartbeatTimer = timer;
	}

	async #read(): Promise<void> {
		try {
			for (;;) {
				// oxlint-disable-next-line eslint/no-await-in-loop -- reading frame after frame is the pipe's purpose.
				const message = await this.#connection.receive();
				this.#dispatch(message);
			}
		} catch (error) {
			if (!this.#ended) {
				void this.#end(error);
			}
		}
	}

	#dispatch(message: Uint8Array): void {
		const frame = decodeFrame(message);
		if (isControlFrame(frame)) {
			if (frame.control === "ping") {
				this.#control.push({ bytes: encodeControlFrame("pong") });
				void this.#pump();
			} else {
				this.#unansweredPings = 0;
			}
			return;
		}
		const existing = this.#streams.get(frame.stream);
		if (existing !== undefined) {
			existing.deliver(frame);
			return;
		}
		if (this.#isLocalStreamId(frame.stream)) {
			// A late frame for an exchange this side already finished.
			return;
		}
		if (frame.kind === "close" || frame.kind === "error") {
			// The end of a stream that never opened here; nothing to tell.
			return;
		}
		this.#accept(frame).deliver(frame);
	}

	#accept(frame: PipeFrame): MultiplexStream {
		const stream = new MultiplexStream(
			this,
			frame.stream,
			frame.room,
			frame.channel
		);
		this.#streams.set(frame.stream, stream);
		this.#onStream(stream);
		return stream;
	}

	#isLocalStreamId(id: number): boolean {
		return id % 2 === this.#nextStreamId % 2;
	}

	#nextQueued(): QueuedFrame | undefined {
		const control = this.#control.shift();
		if (control !== undefined) {
			return control;
		}
		for (let step = 0; step < this.#rotation.length; step += 1) {
			const index = (this.#cursor + step) % this.#rotation.length;
			const room = this.#rotation[index];
			const queue = room === undefined ? undefined : this.#queues.get(room);
			if (queue === undefined || queue.length === 0) {
				continue;
			}
			const frame = queue.shift();
			this.#cursor = (index + 1) % this.#rotation.length;
			return frame;
		}
		return undefined;
	}

	async #pump(): Promise<void> {
		if (this.#pumping) {
			return;
		}
		this.#pumping = true;
		try {
			for (;;) {
				const next = this.#nextQueued();
				if (next === undefined || this.#ended) {
					return;
				}
				// oxlint-disable-next-line eslint/no-await-in-loop -- frames leave in order; that ordering is the contract.
				await this.#connection.send(next.bytes);
				next.sent?.resolve(true);
			}
		} catch (error) {
			void this.#end(error);
		} finally {
			this.#pumping = false;
		}
	}

	#end(reason?: unknown): Promise<void> {
		if (this.#ended) {
			return Promise.resolve();
		}
		this.#ended = true;
		if (this.#heartbeatTimer !== undefined) {
			clearInterval(this.#heartbeatTimer);
		}
		const error =
			reason === undefined
				? new PipeStreamClosedError("Pipe is closed.")
				: new PipeStreamClosedError(
						reason instanceof Error ? reason.message : "Pipe failed."
					);
		const streams = [...this.#streams.values()];
		for (const stream of streams) {
			stream.end(error);
		}
		this.#streams.clear();
		for (const queue of this.#queues.values()) {
			for (const frame of queue) {
				frame.sent?.reject(error);
			}
		}
		this.#queues.clear();
		this.#rotation.length = 0;
		this.#control.length = 0;
		const closing = closeQuietly(this.#connection);
		this.#onClosed(reason);
		return closing;
	}
}
