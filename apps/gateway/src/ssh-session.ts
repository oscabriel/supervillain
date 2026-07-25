import type {
	Session,
	TerminalConnection,
	TerminalSize,
} from "@supervillain/session";

/** The slice of an SSH channel the adapter needs — structural, so the session
 * contract stays untyped to ssh2 and tests use plain duplex fakes. */
export interface SshChannelStream extends NodeJS.ReadWriteStream {
	isTTY?: boolean;
	/** The channel's exit status, when the channel is a real ssh2 one. Without
	 * it an ordinary `ssh` client reports 255 for a perfectly clean goodbye,
	 * which `supervillain join` would then hand back as its own exit code. */
	exit?: (status: number) => void;
}

export interface SshConnectionOptions {
	readonly stream: SshChannelStream;
	readonly initialSize: TerminalSize;
}

export interface SshConnection extends TerminalConnection {
	/** Feed the gateway's window-change events into the surface's resize path. */
	readonly resize: (size: TerminalSize) => void;
}

export interface SshSession extends SshConnection, Session {}

const FALLBACK_SIZE: TerminalSize = { columns: 80, rows: 24 };

const normalizeSize = (size: TerminalSize): TerminalSize =>
	size.columns > 0 && size.rows > 0 ? size : FALLBACK_SIZE;

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
