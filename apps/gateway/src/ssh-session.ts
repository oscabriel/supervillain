import type { Session, TerminalSize } from "@supervillain/session";

/** The slice of an SSH channel the adapter needs — structural, so the session
 * contract stays untyped to ssh2 and tests use plain duplex fakes. */
export interface SshChannelStream extends NodeJS.ReadWriteStream {
	isTTY?: boolean;
}

export interface SshSessionOptions {
	readonly actor: string;
	readonly stream: SshChannelStream;
	readonly initialSize: TerminalSize;
}

export interface SshSession extends Session {
	/** Feed the gateway's window-change events into the table's resize path. */
	readonly resize: (size: TerminalSize) => void;
}

const FALLBACK_SIZE: TerminalSize = { columns: 80, rows: 24 };

const normalizeSize = (size: TerminalSize): TerminalSize =>
	size.columns > 0 && size.rows > 0 ? size : FALLBACK_SIZE;

/** Adapts one SSH channel to the session contract: the channel is both the
 * key stream in and the frame stream out; size changes arrive from the SSH
 * window-change request rather than a local TTY. */
export const attachSshChannel = (options: SshSessionOptions): SshSession => {
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
		actor: options.actor,
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
