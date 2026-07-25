/* oxlint-disable promise/prefer-await-to-callbacks -- a Writable's completion callback is the only "this byte landed" signal Node offers, and the per-session output budget is built on it. */
import type {
	Session,
	TerminalConnection,
	TerminalSize,
} from "@supervillain/session";

/** The slice of an SSH channel the adapter needs — structural, so the session
 * contract stays untyped to ssh2 and tests use plain duplex fakes. */
export interface SshChannelStream extends NodeJS.ReadWriteStream {
	isTTY?: boolean;
	/** Bytes written to this channel that the client has not taken yet — a real
	 * ssh2 channel is a Node Duplex, so this is its write buffer. */
	writableLength?: number;
	/** The channel's exit status, when the channel is a real ssh2 one. Without
	 * it an ordinary `ssh` client reports 255 for a perfectly clean goodbye,
	 * which `supervillain join` would then hand back as its own exit code. */
	exit?: (status: number) => void;
}

export interface SshConnectionOptions {
	readonly stream: SshChannelStream;
	readonly initialSize: TerminalSize;
	/**
	 * Bytes one session may leave unwritten before the gateway gives up on it —
	 * the *byte* half of ADR-0012's per-session output budgets (NQ-10).
	 *
	 * The fold's envelope budget (NQ-5) catches a view whose **consumer** falls
	 * behind. It cannot catch a seat that stops reading its socket: that seat's
	 * consumer is its renderer, which takes every envelope immediately, so its
	 * fold cursor never lags — it just renders frames nobody will ever see. The
	 * R9 benchmark measured one such seat costing a whole core of gateway CPU,
	 * which is why this exists. Omitted, nothing is capped.
	 */
	readonly outputBudgetBytes?: number;
	/**
	 * How long a write may sit unflushed before the seat is given up on. The
	 * byte budget alone does not catch the worst case: the renderer's output
	 * feed waits for each write's callback, so a client that reads *nothing*
	 * parks on one small chunk forever rather than growing a buffer. Time is
	 * the honest signal there. Omitted, nothing is timed.
	 */
	readonly outputStallMs?: number;
}

export interface SshConnection extends TerminalConnection {
	/** Feed the gateway's window-change events into the surface's resize path. */
	readonly resize: (size: TerminalSize) => void;
	/** Resolves when this session left more unread output than its budget
	 * allows. One seat's fact: the Room and every other seat are untouched. */
	readonly outputOverflowed: Promise<void>;
}

export interface SshSession extends SshConnection, Session {}

const FALLBACK_SIZE: TerminalSize = { columns: 80, rows: 24 };

const normalizeSize = (size: TerminalSize): TerminalSize =>
	size.columns > 0 && size.rows > 0 ? size : FALLBACK_SIZE;

const byteLengthOf = (chunk: unknown): number => {
	if (typeof chunk === "string") {
		return Buffer.byteLength(chunk);
	}
	return ArrayBuffer.isView(chunk) ? chunk.byteLength : 0;
};

/**
 * Enforces one seat's output budget by riding its writes: no per-session
 * timer runs while a seat is keeping up, which is the same clause that took
 * the ambient render loop out (ADR-0012, NQ-14). A stall timer is armed only
 * once a write has failed to flush, and cleared the moment the channel drains.
 */
const watchOutput = (
	stream: SshChannelStream,
	options: SshConnectionOptions,
	onOverflow: () => void
): void => {
	const budget = options.outputBudgetBytes;
	const stallMs = options.outputStallMs;
	if (budget === undefined && stallMs === undefined) {
		return;
	}
	const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
	let pending = 0;
	let stallTimer: ReturnType<typeof setTimeout> | undefined;
	const disarm = (): void => {
		if (stallTimer !== undefined) {
			clearTimeout(stallTimer);
			stallTimer = undefined;
		}
	};
	stream.write = ((
		chunk: unknown,
		encoding?: unknown,
		callback?: unknown
	): boolean => {
		// Node lets the callback take the encoding's place; the feed that writes
		// frames uses exactly that spelling.
		const done = typeof encoding === "function" ? encoding : callback;
		const size = byteLengthOf(chunk);
		pending += size;
		const settle = (...args: unknown[]): void => {
			pending -= size;
			if (pending <= 0) {
				pending = 0;
				disarm();
			}
			if (typeof done === "function") {
				(done as (...rest: unknown[]) => void)(...args);
			}
		};
		const flushed =
			typeof encoding === "function"
				? write(chunk, settle)
				: write(chunk, encoding, settle);
		if (budget !== undefined && pending > budget) {
			onOverflow();
			return flushed;
		}
		// Armed whenever anything is still unwritten, not only when the buffer
		// overflowed: the renderer's feed writes one chunk at a time and waits
		// for its callback, so a client that reads nothing parks on a single
		// small chunk and the buffer never grows at all. A healthy seat's
		// callback lands in microseconds and disarms this again.
		if (pending > 0 && stallMs !== undefined && stallTimer === undefined) {
			stallTimer = setTimeout(() => {
				stallTimer = undefined;
				onOverflow();
			}, stallMs);
			stallTimer.unref?.();
		}
		return flushed;
	}) as typeof stream.write;
};

/** Adapts one SSH channel to the terminal-connection contract: the channel is
 * both the key stream in and the frame stream out; size changes arrive from the
 * SSH window-change request rather than a local TTY. No actor: the lobby holds
 * this connection long before a guest has an identity (ADR-0008). */
export const attachSshChannel = (
	options: SshConnectionOptions
): SshConnection => {
	const { stream } = options;
	// An SSH PTY channel is already raw and screen-addressable; OpenTUI
	// duck-types setRawMode and reads isTTY, so mark the duplex as a TTY.
	stream.isTTY = true;
	let spent: (() => void) | undefined;
	// oxlint-disable-next-line promise/avoid-new -- a budget being spent is an event, not a promise-returning API.
	const outputOverflowed = new Promise<void>((resolve) => {
		spent = resolve;
	});
	watchOutput(stream, options, () => spent?.());
	let size = normalizeSize(options.initialSize);
	let closed = false;
	const resizeListeners = new Set<(next: TerminalSize) => void>();
	const closeListeners = new Set<() => void>();
	const notifyClose = (): void => {
		if (closed) {
			return;
		}
		closed = true;
		for (const listener of closeListeners) {
			listener();
		}
		closeListeners.clear();
		resizeListeners.clear();
	};
	stream.on("close", notifyClose);
	return {
		close() {
			notifyClose();
			stream.end();
		},
		input: stream as unknown as NodeJS.ReadStream,
		onClose(listener) {
			closeListeners.add(listener);
			return () => closeListeners.delete(listener);
		},
		onResize(listener) {
			resizeListeners.add(listener);
			return () => resizeListeners.delete(listener);
		},
		output: stream as unknown as NodeJS.WriteStream,
		outputOverflowed,
		resize(next) {
			size = normalizeSize(next);
			for (const listener of resizeListeners) {
				listener(size);
			}
		},
		size: () => size,
	};
};

/** Binds an actor to the connection, producing the session a table needs. The
 * connection outlives it: a guest hops rooms on one minted actor, and the same
 * terminal is handed back to the lobby afterwards. */
export const sessionForActor = (
	connection: SshConnection,
	actor: string
): SshSession => ({ ...connection, actor });
